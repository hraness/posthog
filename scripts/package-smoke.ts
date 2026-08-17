import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const packageName = "@hraness/posthog";
const specifiers = [
  packageName,
  `${packageName}/site`,
  `${packageName}/client`,
  `${packageName}/event`,
  `${packageName}/next-config`,
  `${packageName}/react`,
  `${packageName}/server`,
  `${packageName}/traffic`,
];
const verifiedNextVersions = ["16.2.12", "16.3.0"] as const;
const verificationPackages = [
  "@types/node@^24.10.0",
  "@types/react@^19.2.14",
  "@types/react-dom@^19.2.3",
  "react@19.2.3",
  "react-dom@19.2.3",
  "typescript@^6.0.3",
];

const repository = process.cwd();
const work = await mkdtemp(join(tmpdir(), "hraness-posthog-smoke-"));
const cache = join(work, "cache");
const temporary = join(work, "tmp");
const environment = {
  ...process.env,
  BUN_INSTALL_CACHE_DIR: cache,
  BUN_TMPDIR: temporary,
  NEXT_TELEMETRY_DISABLED: "1",
  TMPDIR: temporary,
};

async function run(
  command: string[],
  cwd: string,
  additionalEnvironment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...environment, ...additionalEnvironment },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
  }
}

function resolveGenuineNodeExecutable(): string {
  const executableName = process.platform === "win32" ? "node.exe" : "node";
  const identityProbe = [
    "if (typeof Bun !== 'undefined'",
    "|| process.versions.bun !== undefined",
    "|| !process.versions.node?.startsWith('24.')) process.exit(1)",
  ].join(" ");
  const candidates = [...new Set(
    (process.env.PATH ?? "")
      .split(delimiter)
      .filter((directory) => directory.length > 0)
      .map((directory) => resolve(directory, executableName)),
  )];

  for (const executable of candidates) {
    try {
      const probe = Bun.spawnSync([
        executable,
        "--input-type=commonjs",
        "-e",
        identityProbe,
      ], {
        env: environment,
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      });
      if (probe.exitCode === 0) return executable;
    } catch {
      // Continue past absent, inaccessible, or incompatible PATH candidates.
    }
  }

  throw new Error("package smoke requires a genuine Node 24 executable on PATH");
}

try {
  const archive = join(work, "package.tgz");
  await mkdir(cache, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  const nodeExecutable = resolveGenuineNodeExecutable();

  await run([
    process.execPath,
    "pm",
    "pack",
    "--filename",
    archive,
    "--ignore-scripts",
    "--quiet",
  ], repository);

  const commonCompilerOptions = {
    target: "ES2024",
    lib: ["ES2024", "DOM", "DOM.Iterable"],
    jsx: "react-jsx",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ["node"],
  } as const;

  for (const nextVersion of verifiedNextVersions) {
    const consumer = join(work, `consumer-next-${nextVersion}`);
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await run([
      process.execPath,
      "add",
      archive,
      `next@${nextVersion}`,
      ...verificationPackages,
      "--ignore-scripts",
    ], consumer);

    await run([
      nodeExecutable,
      "--input-type=module",
      "-e",
      `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier)))`,
    ], consumer);
    await run([
      nodeExecutable,
      "--input-type=commonjs",
      "-e",
      `for (const specifier of ${JSON.stringify(specifiers)}) require(specifier)`,
    ], consumer);

    const installedRoot = join(
      consumer,
      "node_modules",
      "@hraness",
      "posthog",
    );
    if (await Bun.file(join(installedRoot, "src", "client.test.ts")).exists()) {
      throw new Error("installed package must not contain source tests");
    }

    await writeFile(join(consumer, "runtime-smoke.mjs"), `
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const client = await import("@hraness/posthog/client");
const event = await import("@hraness/posthog/event");
const site = {
  id: "installed-consumer",
  canonicalDomain: "example.com",
  allowedHosts: ["example.com"],
  schemaVersion: 1,
  routes: [{ match: "exact", path: "/", pageKind: "home" }],
  customEvents: [],
};
globalThis.window = {
  location: { hostname: "example.com", href: "https://example.com/" },
};
globalThis.document = { referrer: "" };
if (!client.isPostHogBrowserEligible({ site, apiKey: "phc_public" })) {
  throw new Error("installed production client was constant-folded out");
}
if (client.readDelegatedAnalyticsEvent(site, null) !== null) {
  throw new Error("installed delegated parser is not DOM-safe");
}
if ("readDelegatedAnalyticsEvent" in event) {
  throw new Error("provider-neutral event surface exposes DOM behavior");
}

const clientPath = fileURLToPath(import.meta.resolve("@hraness/posthog/client"));
const reactPath = fileURLToPath(import.meta.resolve("@hraness/posthog/react"));
const [clientSource, reactSource] = await Promise.all([
  readFile(clientPath, "utf8"),
  readFile(reactPath, "utf8"),
]);
if (!clientSource.includes('process.env["NODE_ENV"] === "production"')) {
  throw new Error("installed client does not evaluate production at runtime");
}
if (!reactSource.includes('from "./client.js"') || reactSource.includes("activeSiteId")) {
  throw new Error("installed React export does not share client singleton state");
}
`);
    await run(
      [nodeExecutable, "./runtime-smoke.mjs"],
      consumer,
      { NODE_ENV: "production" },
    );

    const imports = specifiers
      .map((specifier, index) => (
        `import * as surface${String(index)} from ${JSON.stringify(specifier)};`
      ))
      .join("\n");
    await writeFile(
      join(consumer, "index.ts"),
      `${imports}\nvoid [${specifiers.map((_, index) => `surface${String(index)}`).join(", ")}];\n`,
    );
    await writeFile(
      join(consumer, "tsconfig.bundler.json"),
      JSON.stringify({
        compilerOptions: {
          ...commonCompilerOptions,
          module: "Preserve",
          moduleResolution: "Bundler",
        },
        include: ["index.ts"],
      }, null, 2),
    );
    await writeFile(
      join(consumer, "tsconfig.nodenext.json"),
      JSON.stringify({
        compilerOptions: {
          ...commonCompilerOptions,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          verbatimModuleSyntax: true,
        },
        include: ["index.ts"],
      }, null, 2),
    );
    await run(
      [process.execPath, "x", "tsc", "-p", "./tsconfig.bundler.json"],
      consumer,
    );
    await run(
      [process.execPath, "x", "tsc", "-p", "./tsconfig.nodenext.json"],
      consumer,
    );

    await mkdir(join(consumer, "app"));
    await writeFile(
      join(consumer, "next.config.ts"),
      [
        'import { withPostHogSourceMaps } from "@hraness/posthog/next-config";',
        "export default withPostHogSourceMaps({ output: \"export\" }, {",
        "  environment: {},",
        '  siteId: "package-smoke",',
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(consumer, "app", "layout.js"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
    );
    await writeFile(
      join(consumer, "app", "page.js"),
      "export default function Page() { return <main>PostHog package smoke</main>; }\n",
    );
    await run([
      nodeExecutable,
      join(consumer, "node_modules", "next", "dist", "bin", "next"),
      "build",
      "--webpack",
    ], consumer);
  }
} finally {
  await rm(work, { force: true, recursive: true });
}
