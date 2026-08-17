import { readFile } from "node:fs/promises";

const allowedImports = new Map<string, ReadonlySet<string>>([
  ["site", new Set()],
  ["event", new Set()],
  ["traffic", new Set()],
  ["client", new Set(["posthog-js"])],
  ["react", new Set(["posthog-js", "react", "react/jsx-runtime"])],
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

const pureEntries = ["site", "event", "traffic"];
for (const entry of pureEntries) {
  const source = await readFile(`dist/${entry}.js`, "utf8");
  for (const forbidden of ["posthog-js", "posthog-node", "react", "next"]) {
    if (source.includes(forbidden)) {
      throw new Error(`${entry} is not provider-neutral: found ${forbidden}`);
    }
  }
}
