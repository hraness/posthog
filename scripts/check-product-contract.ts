import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { REGION_TABLE, type RegionGroup } from "../src/policy.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return field;
}

function arrayField(value: Record<string, unknown>, key: string, label: string): unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    throw new Error(`${label}.${key} must be an array`);
  }
  return field;
}

function requireText(content: string, expected: string, label: string): void {
  if (!content.includes(expected)) {
    throw new Error(`${label} must contain ${JSON.stringify(expected)}`);
  }
}

const repositoryRoot = resolve(import.meta.dir, "..");
const [readme, packageBytes, inventoryBytes, releaseWorkflow] = await Promise.all([
  readFile(resolve(repositoryRoot, "README.md"), "utf8"),
  readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  readFile(resolve(repositoryRoot, "portfolio-inventory.json"), "utf8"),
  readFile(resolve(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
]);
const packageManifest = record(JSON.parse(packageBytes) as unknown, "package.json");
const inventory = record(JSON.parse(inventoryBytes) as unknown, "portfolio-inventory.json");
const packageName = stringField(packageManifest, "name", "package.json");
const packageVersion = stringField(packageManifest, "version", "package.json");
const packageDescription = stringField(packageManifest, "description", "package.json");
const repositorySlug = stringField(inventory, "repository", "portfolio-inventory.json");
const tarballStem = packageName.replace(/^@/u, "").replace("/", "-");
for (const fact of ["PostHog", "Meta", "CLI"]) {
  if (!packageDescription.includes(fact)) {
    throw new Error(`package.json description must name ${fact}`);
  }
}
if (packageDescription.includes("—")) {
  throw new Error("package.json description must not contain em dashes");
}
const localReferences = [
  "CONTRIBUTING.md",
  "LICENSE",
  "SECURITY.md",
  "Package.swift",
  "src/attribution.ts",
  "src/browser.ts",
  "src/cli.ts",
  "src/events.ts",
  "src/experiment.ts",
  "src/meta.ts",
  "src/policy.ts",
  "src/server.ts",
] as const;
for (const localReference of localReferences) {
  requireText(readme, `(${localReference})`, "README.md");
}
await Promise.all(
  localReferences.map((localReference) =>
    readFile(resolve(repositoryRoot, localReference))
  ),
);
requireText(
  readme,
  `https://github.com/${repositorySlug}/releases/download/v${packageVersion}/${tarballStem}-${packageVersion}.tgz`,
  "README.md",
);
requireText(readme, "does not publish the package to npm", "README.md");
if (readme.includes("—")) {
  throw new Error("README.md must not contain em dashes");
}

// The README's region table is the policy table, row for row.
const LABELS: Readonly<Record<RegionGroup, string>> = {
  eu: "EU, EEA and unknown",
  uk_ch: "UK and Switzerland",
  br: "Brazil",
  us: "United States",
  row: "Rest of the world",
};
const yesNo = (value: boolean) => (value ? "on" : "off");
for (const [group, rule] of Object.entries(REGION_TABLE) as [RegionGroup, (typeof REGION_TABLE)[RegionGroup]][]) {
  const row = `| ${LABELS[group]} | ${rule.analytics} | ${yesNo(rule.autocapture)} | ${yesNo(rule.replay)} | ${yesNo(rule.ads)} | ${rule.ask} |`;
  requireText(readme, row, "README.md region table");
}

const exportsRecord = record(packageManifest.exports, "package.json exports");
for (const exportPath of Object.keys(exportsRecord)) {
  const specifier = exportPath === "."
    ? packageName
    : `${packageName}${exportPath.slice(1)}`;
  requireText(readme, `\`${specifier}\``, "README.md");
}

const components = arrayField(inventory, "components", "portfolio-inventory.json")
  .map((component, index) => record(component, `portfolio-inventory.json components[${String(index)}]`));
const packageComponent = components.find((component) => component.name === packageName);
if (!packageComponent) {
  throw new Error(`portfolio-inventory.json must contain ${packageName}`);
}
if (packageComponent.version !== packageVersion) {
  throw new Error("portfolio package version must match package.json");
}

requireText(releaseWorkflow, 'gh release create "$GITHUB_REF_NAME"', "release workflow");
requireText(releaseWorkflow, ".isImmutable", "release workflow");
for (const required of [
  "bun pm pack --ignore-scripts --filename",
  `${tarballStem}-\${GITHUB_REF_NAME#v}.tgz`,
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "sha256sum --check SHA256SUMS",
  '"release/$package_file" release/SHA256SUMS',
  'gh release edit "$GITHUB_REF_NAME" --draft=false --latest',
  "\\tfalse\\tfalse\\ttrue\\t2",
  'cmp release/SHA256SUMS "$published_dir/SHA256SUMS"',
]) requireText(releaseWorkflow, required, "canonical release artifact workflow");
if (releaseWorkflow.indexOf("sha256sum --check SHA256SUMS") > releaseWorkflow.indexOf("gh release create")
  || releaseWorkflow.indexOf("gh release edit") < releaseWorkflow.indexOf("gh release create")) {
  throw new Error("release artifacts must be verified before draft creation and published only after upload");
}
if (/\b(?:bun|npm)\s+publish\b/u.test(releaseWorkflow)) {
  throw new Error("release workflow must not publish to a package registry");
}
