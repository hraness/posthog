import { readdir, readFile } from "node:fs/promises";

// Static runtime imports each published entry may have. Everything else is inlined from src/.
const allowedImports = new Map<string, ReadonlySet<string>>([
  ["index", new Set()],
  ["policy", new Set()],
  ["events", new Set()],
  ["attribution", new Set()],
  ["browser", new Set()],
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

const expected = new Set([...allowedImports.keys()].flatMap((entry) => [`${entry}.js`, `${entry}.js.map`]));
const unexpected = (await readdir("dist")).filter((artifact) => !expected.has(artifact));
if (unexpected.length > 0) throw new Error(`build emitted unexpected artifacts: ${unexpected.join(", ")}`);
