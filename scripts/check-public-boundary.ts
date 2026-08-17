import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const repository = process.cwd();
const excluded = new Set([".git", "node_modules"]);
const prohibited = [
  "/Users/" + "benguo",
  "@jun" + "gle/",
  "sleepy" + "land",
  "rough" + "day",
  "act" + "60",
  "sp" + "onge",
];
const credential = /\b(?:phc|phx|phs|pha|phr)_[A-Za-z0-9_-]{20,}\b/gu;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested: string[] = [];
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) nested.push(...await files(path));
    else if (entry.isFile()) nested.push(path);
  }
  return nested;
}

for (const path of await files(repository)) {
  const content = await readFile(path, "utf8").catch(() => null);
  if (content === null) continue;
  for (const value of prohibited) {
    if (content.includes(value)) {
      throw new Error(`${relative(repository, path)} contains private provenance`);
    }
  }
  if (credential.test(content)) {
    throw new Error(`${relative(repository, path)} contains a credential-like value`);
  }
  credential.lastIndex = 0;
}
