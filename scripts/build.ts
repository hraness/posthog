import { rm } from "node:fs/promises";

// Bun can retain source directives after bundled imports. Emit this boundary
// only as a banner so each published client entry has one valid prologue.
const CLIENT_DIRECTIVE = '"use client";';

type BuildGroup = Readonly<{
  entrypoints: readonly string[];
  target: "browser" | "node";
  banner?: string;
  external?: readonly string[];
}>;

const groups: readonly BuildGroup[] = [
  {
    entrypoints: ["src/site.ts", "src/event.ts", "src/traffic.ts"],
    target: "browser",
  },
  {
    entrypoints: ["src/client.ts"],
    target: "browser",
    banner: CLIENT_DIRECTIVE,
  },
  {
    entrypoints: ["src/react.tsx"],
    target: "browser",
    banner: CLIENT_DIRECTIVE,
    external: ["./client*"],
  },
  {
    entrypoints: ["src/server.ts", "src/next-config.ts"],
    target: "node",
  },
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
    ...(group.banner ? { banner: group.banner } : {}),
    ...(group.external ? { external: [...group.external] } : {}),
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}
