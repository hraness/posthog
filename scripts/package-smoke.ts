import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const manifest = (await Bun.file(join(repository, "package.json")).json()) as { name: string; exports: Record<string, unknown> };
const packageName = manifest.name;
const specifiers = Object.keys(manifest.exports).map((path) => (path === "." ? packageName : `${packageName}${path.slice(1)}`));
const verificationPackages = ["@types/node@24.13.3", "typescript@6.0.3"];

const work = await mkdtemp(join(tmpdir(), "hraness-analytics-smoke-"));
const cache = join(work, "cache");
const temporary = join(work, "tmp");
const environment = { ...process.env, BUN_INSTALL_CACHE_DIR: cache, BUN_TMPDIR: temporary, TMPDIR: temporary, DO_NOT_TRACK: "1" };

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, env: environment, stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
}

function resolveGenuineNodeExecutable(): string {
  const executableName = process.platform === "win32" ? "node.exe" : "node";
  const identityProbe = "if (typeof Bun !== 'undefined' || process.versions.bun !== undefined || !process.versions.node?.startsWith('24.')) process.exit(1)";
  const candidates = [...new Set((process.env.PATH ?? "").split(delimiter).filter((directory) => directory.length > 0).map((directory) => resolve(directory, executableName)))];
  for (const executable of candidates) {
    try {
      const probe = Bun.spawnSync([executable, "--input-type=commonjs", "-e", identityProbe], { env: environment, stderr: "ignore", stdin: "ignore", stdout: "ignore" });
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
  const node = resolveGenuineNodeExecutable();

  await run([process.execPath, "pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet"], repository);

  const consumer = join(work, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run([process.execPath, "add", archive, ...verificationPackages, "--ignore-scripts"], consumer);

  const installed = join(consumer, "node_modules", ...packageName.split("/"));
  const shipped = await readdir(join(installed, "src"));
  if (shipped.some((file) => file.includes(".test."))) throw new Error("installed package must not contain tests");
  if (!shipped.includes("internal.ts")) throw new Error("installed package must ship the sources its types import");

  // Every export imports under genuine Node 24.
  await run([node, "--input-type=module", "-e", `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier)))`], consumer);

  // The installed pure modules behave, and the CLI honours DO_NOT_TRACK without touching the disk.
  await writeFile(join(consumer, "runtime-smoke.mjs"), `
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regionPolicy } from "${packageName}/policy";
import { cleanProps } from "${packageName}/attribution";
import { adsAllowed } from "${packageName}/meta";
import { createTelemetry } from "${packageName}/cli";
import { parseWireEvent } from "${packageName}/server";

const us = regionPolicy({ country: "US" });
if (!us.ads || !us.replay) throw new Error("installed policy lost the US defaults");
if (regionPolicy({ country: "DE" }).analytics !== "cookieless") throw new Error("installed policy is not cookieless in the EU");
if (adsAllowed({ policy: regionPolicy({ country: "US", gpc: true }) })) throw new Error("installed Meta gate ignores GPC");
if (JSON.stringify(cleanProps({ note: "write to person@example.com" })).includes("@")) throw new Error("installed cleaning kept an email");
if (parseWireEvent({ v: 2 }) !== undefined) throw new Error("installed wire parser accepted a bad event");
const dir = await mkdtemp(join(tmpdir(), "telemetry-"));
const telemetry = createTelemetry({ siteId: "smoke", endpoint: "https://example.invalid/", envPrefix: "SMOKE", version: "1.0.0", configDir: dir, offCommand: "smoke off", onCommand: "smoke on", privacyUrl: "https://example.invalid/privacy", name: "Smoke", fetch: () => { throw new Error("sent with DO_NOT_TRACK"); } });
if ((await telemetry.state()).enabled) throw new Error("installed CLI telemetry ignored DO_NOT_TRACK");
telemetry.commandRun("x", true, 1);
await telemetry.flush();
if ((await readdir(dir)).length !== 0) throw new Error("installed CLI telemetry wrote with DO_NOT_TRACK");
`);
  await run([node, "./runtime-smoke.mjs"], consumer);

  // The types check for bundler and NodeNext consumers.
  const imports = specifiers.map((specifier, index) => `import * as surface${String(index)} from ${JSON.stringify(specifier)};`).join("\n");
  await writeFile(join(consumer, "index.ts"), `${imports}\nvoid [${specifiers.map((_, index) => `surface${String(index)}`).join(", ")}];\n`);
  const common = { target: "ES2023", lib: ["ES2023", "DOM", "DOM.Iterable"], strict: true, noEmit: true, skipLibCheck: true, types: ["node"] };
  await writeFile(join(consumer, "tsconfig.bundler.json"), JSON.stringify({ compilerOptions: { ...common, module: "Preserve", moduleResolution: "Bundler" }, include: ["index.ts"] }));
  await writeFile(join(consumer, "tsconfig.nodenext.json"), JSON.stringify({ compilerOptions: { ...common, module: "NodeNext", moduleResolution: "NodeNext", verbatimModuleSyntax: true }, include: ["index.ts"] }));
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.bundler.json"], consumer);
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.nodenext.json"], consumer);
  console.log(`package smoke passed for ${String(specifiers.length)} exports`);
} finally {
  await rm(work, { force: true, recursive: true });
}
