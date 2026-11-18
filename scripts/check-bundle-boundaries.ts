import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { experimentScript as ExperimentScript } from "../src/experiment.ts";

// Static runtime imports each published entry may have. Everything else is inlined from src/.
const allowedImports = new Map<string, ReadonlySet<string>>([
  ["index", new Set()],
  ["policy", new Set()],
  ["events", new Set()],
  ["attribution", new Set()],
  ["browser", new Set()],
  ["experiment", new Set()],
  ["meta", new Set()],
  ["server", new Set()],
  ["cli", new Set(["node:fs/promises", "node:os", "node:path"])],
]);
// The browser entry loads PostHog only after the page has drawn, and only from the pinned package: never a remote script.
const browserDynamic = new Set([
  "posthog-js/dist/module.no-external.js",
  "posthog-js/dist/exception-autocapture.js",
  "posthog-js/dist/web-vitals.js",
  "posthog-js/dist/web-vitals-with-attribution.js",
  "posthog-js/dist/dead-clicks-autocapture.js",
  "posthog-js/dist/posthog-recorder.js",
]);

const staticImport = /(?:from\s+|^import\s*)["']([^"']+)["']/gmu;
const dynamicImport = /import\(\s*["']([^"']+)["']\s*\)/gu;

for (const [entry, allowed] of allowedImports) {
  const source = await readFile(`dist/${entry}.js`, "utf8");
  for (const match of source.matchAll(staticImport)) {
    const specifier = match[1];
    if (specifier === undefined || !allowed.has(specifier)) throw new Error(`${entry} has an unexpected runtime import: ${String(specifier)}`);
  }
  for (const match of source.matchAll(dynamicImport)) {
    const specifier = match[1];
    if (entry !== "browser" || specifier === undefined || !browserDynamic.has(specifier)) {
      throw new Error(`${entry} has an unexpected dynamic import: ${String(specifier)}`);
    }
  }
  if (entry !== "cli" && source.includes("node:")) throw new Error(`${entry} crosses into Node through node:`);
  if (entry !== "browser" && source.includes("posthog-js")) throw new Error(`${entry} is not provider-neutral: found posthog-js`);
}

const browser = await readFile("dist/browser.js", "utf8");
for (const required of ["disable_external_dependency_loading: true", 'persistence: "memory"', 'person_profiles: "identified_only"']) {
  if (!browser.includes(required)) throw new Error(`browser entry lost ${required}`);
}
if (/connect\.facebook\.net/u.test(browser)) throw new Error("browser entry must not load Meta itself; compose ./meta in onAds");

// `assign` runs before the page paints, inside a site's first script, so it stays small once a site minifies it.
const ASSIGN_LIMIT = 2560;
const SCRIPT_LIMIT = 4096;
const scratch = await mkdtemp(join(tmpdir(), "experiment-size-"));
try {
  const entry = join(scratch, "entry.js");
  await writeFile(entry, `import { assign } from ${JSON.stringify(resolve("dist/experiment.js"))};\nglobalThis.assigned = assign;\n`);
  const minified = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true });
  const output = minified.outputs[0];
  if (!minified.success || output === undefined) throw new Error("the experiment entry did not minify");
  const bytes = (await output.text()).length;
  if (bytes > ASSIGN_LIMIT) throw new Error(`assign is ${String(bytes)} bytes minified; keep it under ${String(ASSIGN_LIMIT)}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
const { experimentScript } = (await import(resolve("dist/experiment.js"))) as { experimentScript: typeof ExperimentScript };
const script = experimentScript([{ key: "header-cta", variants: ["control", "free"] }], { siteId: "example" });
if (script.length > SCRIPT_LIMIT) throw new Error(`the experiment script is ${String(script.length)} bytes; keep it under ${String(SCRIPT_LIMIT)}`);
if (/\bimport\b|__name|require\(/u.test(script)) throw new Error("the experiment script must stand alone");

const expected = new Set([...allowedImports.keys()].flatMap((entry) => [`${entry}.js`, `${entry}.js.map`]));
const unexpected = (await readdir("dist")).filter((artifact) => !expected.has(artifact));
if (unexpected.length > 0) throw new Error(`build emitted unexpected artifacts: ${unexpected.join(", ")}`);
