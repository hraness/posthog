import { rm } from "node:fs/promises";

const entrypoints = [
  "src/site.ts",
  "src/event.ts",
  "src/traffic.ts",
  "src/client.ts",
  "src/react.tsx",
  "src/server.ts",
  "src/next-config.ts",
];

await rm("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints,
  outdir: "dist",
  root: "src",
  target: "browser",
  format: "esm",
  packages: "external",
  sourcemap: "external",
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
