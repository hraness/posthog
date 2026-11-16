import { rm } from "node:fs/promises";

type BuildGroup = Readonly<{ entrypoints: readonly string[]; target: "browser" | "node" }>;

// Each entry is built on its own so shared helpers are inlined rather than split into unstable chunks.
const groups: readonly BuildGroup[] = [
  { entrypoints: ["src/index.ts"], target: "browser" },
  { entrypoints: ["src/policy.ts"], target: "browser" },
  { entrypoints: ["src/events.ts"], target: "browser" },
  { entrypoints: ["src/attribution.ts"], target: "browser" },
  { entrypoints: ["src/browser.ts"], target: "browser" },
  { entrypoints: ["src/meta.ts"], target: "browser" },
  { entrypoints: ["src/server.ts"], target: "browser" },
  { entrypoints: ["src/cli.ts"], target: "node" },
];

await rm("dist", { recursive: true, force: true });
for (const group of groups) {
  const result = await Bun.build({
    entrypoints: [...group.entrypoints],
    outdir: "dist",
    root: "src",
    target: group.target,
    format: "esm",
    packages: "external",
    sourcemap: "external",
    minify: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
