import { readdir, readFile } from "node:fs/promises";

const allowedImports = new Map<string, ReadonlySet<string>>([
  ["site", new Set()],
  ["event", new Set()],
  ["traffic", new Set()],
  ["client", new Set(["posthog-js"])],
  ["react", new Set(["./client.js", "react", "react/jsx-runtime"])],
  ["server", new Set(["posthog-node"])],
  ["next-config", new Set(["@posthog/nextjs-config"])],
]);

const staticImport = /(?:from\s+|import\s*)["']([^"']+)["']/gu;
for (const [entry, allowed] of allowedImports) {
  const source = await readFile(`dist/${entry}.js`, "utf8");
  const imports = [...source.matchAll(staticImport)].map((match) => match[1]);
  for (const specifier of imports) {
    if (specifier === undefined || !allowed.has(specifier)) {
      throw new Error(`${entry} has an unexpected runtime import: ${String(specifier)}`);
    }
  }
}

const browserEntries = ["site", "event", "traffic", "client", "react"];
for (const entry of browserEntries) {
  const source = await readFile(`dist/${entry}.js`, "utf8");
  for (const forbidden of ["posthog-node", "@posthog/nextjs-config", "node:"]) {
    if (source.includes(forbidden)) {
      throw new Error(`${entry} crosses the browser boundary through ${forbidden}`);
    }
  }
}

for (const entry of ["client", "react"]) {
  const source = await readFile(`dist/${entry}.js`, "utf8");
  if (!source.startsWith('"use client";')) {
    throw new Error(`${entry} does not preserve its Next.js client boundary`);
  }
}

const clientSource = await readFile("dist/client.js", "utf8");
const reactSource = await readFile("dist/react.js", "utf8");
if (!clientSource.includes('process.env["NODE_ENV"] === "production"')) {
  throw new Error("client does not preserve the runtime production eligibility check");
}
if (!reactSource.includes('from "./client.js"')) {
  throw new Error("react does not reuse the client entry singleton");
}
if (!clientSource.includes("activeSiteId") || reactSource.includes("activeSiteId")) {
  throw new Error("client and react do not have exactly one active-site state owner");
}

const expectedArtifacts = new Set(
  [...allowedImports.keys()].flatMap((entry) => [`${entry}.js`, `${entry}.js.map`]),
);
const unexpectedArtifacts = (await readdir("dist"))
  .filter((artifact) => !expectedArtifacts.has(artifact));
if (unexpectedArtifacts.length > 0) {
  throw new Error(`build emitted unstable shared artifacts: ${unexpectedArtifacts.join(", ")}`);
}

const pureEntries = ["site", "event", "traffic"];
for (const entry of pureEntries) {
  const source = await readFile(`dist/${entry}.js`, "utf8");
  for (const forbidden of ["posthog-js", "posthog-node", "react", "next"]) {
    if (source.includes(forbidden)) {
      throw new Error(`${entry} is not provider-neutral: found ${forbidden}`);
    }
  }
}

const eventSource = await readFile("dist/event.js", "utf8");
for (const forbidden of ["HTMLAnchorElement", "HTMLElement", "instanceof Element"]) {
  if (eventSource.includes(forbidden)) {
    throw new Error(`event retains browser-only delegated parsing: ${forbidden}`);
  }
}
