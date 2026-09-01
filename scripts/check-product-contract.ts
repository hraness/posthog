import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  classifyAnalyticsRoute,
  POSTHOG_SCHEMA_VERSION,
  type PostHogSiteDefinition,
} from "../src/site.js";

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
const expectedDescription =
  "Privacy-bounded PostHog routing, capture, and source-map primitives for Next.js applications.";

if (packageDescription !== expectedDescription) {
  throw new Error(`package.json description must be ${JSON.stringify(expectedDescription)}`);
}

for (const heading of [
  "## Smallest useful action",
  "## Choose the integration boundary",
  "## Operator and package responsibilities",
  "## Privacy contract",
  "## Implement without widening the boundary",
  "## Questions",
]) {
  requireText(readme, heading, "README.md");
}
const localReferences = [
  "CONTRIBUTING.md",
  "LICENSE",
  "SECURITY.md",
  "src/client.ts",
  "src/event.ts",
  "src/next-config.ts",
  "src/server.ts",
  "src/site.ts",
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
  `github:hraness/posthog#v${packageVersion}`,
  "README.md",
);
requireText(readme, "does not publish the package to npm", "README.md");
if (readme.includes("—")) {
  throw new Error("README.md must not contain em dashes");
}

const proofSite = {
  id: "docs",
  canonicalDomain: "docs.example.com",
  allowedHosts: ["docs.example.com"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [
    { match: "exact", path: "/", pageKind: "home" },
    {
      match: "prefix",
      path: "/guides",
      pageKind: "guide",
      contentGroup: "documentation",
      captureSlug: true,
    },
  ],
  customEvents: ["guide_opened"],
  delegatedEvents: ["guide_opened"],
  stripQueryAttribution: true,
  unknownCanonicalPath: "/not-found",
} satisfies PostHogSiteDefinition;
const proofOutput = classifyAnalyticsRoute(
  proofSite,
  "https://docs.example.com/guides/install?token=private#step",
);
requireText(readme, JSON.stringify(proofOutput, null, 2), "README.md route proof");

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
if (/\b(?:bun|npm)\s+publish\b/u.test(releaseWorkflow)) {
  throw new Error("release workflow must not publish to a package registry");
}
