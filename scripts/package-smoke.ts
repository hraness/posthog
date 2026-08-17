import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const specifiers = [
  "@hraness/posthog",
  "@hraness/posthog/site",
  "@hraness/posthog/client",
  "@hraness/posthog/event",
  "@hraness/posthog/next-config",
  "@hraness/posthog/react",
  "@hraness/posthog/server",
  "@hraness/posthog/traffic",
];

async function run(
  command: string[],
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...environment, TMPDIR: work },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
  }
}

const repository = process.cwd();
const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? "/tmp", "hraness-posthog-smoke-"));
try {
  const archive = join(work, "package.tgz");
  const consumer = join(work, "consumer");
  await mkdir(consumer);
  await run([process.execPath, "pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet"], repository);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run([
    process.execPath,
    "add",
    archive,
    "next@16.2.12",
    "react@19.2.3",
    "react-dom@19.2.3",
    "typescript@6.0.3",
    "@types/node@24.10.0",
    "@types/react@19.2.14",
    "@types/react-dom@19.2.3",
    "--ignore-scripts",
  ], consumer);
  await run(["node", "--input-type=module", "-e", "if (Number(process.versions.node.split('.')[0]) !== 24) process.exit(1)"], consumer);
  await run(["node", "--input-type=module", "-e", `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier)))`], consumer);
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
  await run(["node", "./runtime-smoke.mjs"], consumer, { NODE_ENV: "production" });
  const imports = specifiers
    .map((specifier, index) => `import * as surface${String(index)} from ${JSON.stringify(specifier)};`)
    .join("\n");
  await writeFile(join(consumer, "index.ts"), `${imports}\nvoid [${specifiers.map((_, index) => `surface${String(index)}`).join(", ")}];\n`);
  const commonCompilerOptions = {
    target: "ES2023",
    lib: ["ES2023", "DOM", "DOM.Iterable"],
    jsx: "react-jsx",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  } as const;
  await writeFile(join(consumer, "tsconfig.bundler.json"), JSON.stringify({
    compilerOptions: {
      ...commonCompilerOptions,
      module: "Preserve",
      moduleResolution: "Bundler",
    },
    include: ["index.ts"],
  }, null, 2));
  await writeFile(join(consumer, "tsconfig.nodenext.json"), JSON.stringify({
    compilerOptions: {
      ...commonCompilerOptions,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      verbatimModuleSyntax: true,
    },
    include: ["index.ts"],
  }, null, 2));
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.bundler.json"], consumer);
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.nodenext.json"], consumer);
} finally {
  await rm(work, { recursive: true, force: true });
}
