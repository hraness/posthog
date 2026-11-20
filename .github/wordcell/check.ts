// The unchanged Wordcell check API does not load its optional support command.
// Install this directory's frozen public dependencies with scripts disabled.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const digest = "89d8f1c7c74362ae923b0eedb25c00638917c4351f1e1b1f7aa5958b97d0f0c9";
const url = "https://github.com/hraness/wordcell/releases/download/v0.24.0/hraness-wordcell-0.24.0.tgz";
const args = process.argv.slice(2);
if (!(args[0] === "check" || args[0] === "agents" && args[1] === "check")) {
  throw new Error("This CI entry point supports only Wordcell check and agents check.");
}
const cache = join(root, ".cache");
mkdirSync(cache, { recursive: true });
const archive = join(cache, digest + ".tgz");
const verify = (bytes: Uint8Array) => {
  if (bytes.length > 16 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error("The published Wordcell archive does not match its admitted SHA-256.");
  }
};
if (!existsSync(archive)) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("The published Wordcell archive is unavailable.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (!response.body) throw new Error("The published Wordcell response has no body.");
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > 16 * 1024 * 1024) throw new Error("The published Wordcell archive exceeds its size limit.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  verify(bytes);
  writeFileSync(archive, bytes, { flag: "wx" });
}
verify(readFileSync(archive));
const source = join(cache, "check-" + randomUUID());
mkdirSync(source);
try {
  const extract = spawnSync("python3", ["-c", `
from pathlib import Path, PurePosixPath
import sys, tarfile
root = Path(sys.argv[2])
with tarfile.open(sys.argv[1]) as archive:
    selected = [m for m in archive.getmembers() if m.name.startswith("package/dist/") or m.name in ("package/package.json", "package/LICENSE")]
    if len(selected) > 1000 or sum(m.size for m in selected) > 32 * 1024 * 1024:
        raise ValueError("Wordcell payload exceeds its admission limits")
    for member in selected:
        relative = PurePosixPath(member.name)
        if relative.is_absolute() or ".." in relative.parts or not (member.isdir() or member.isfile()):
            raise ValueError("Unsafe Wordcell payload entry")
        if member.isdir():
            continue
        target = root.joinpath(*relative.parts[1:])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.extractfile(member).read())
`, archive, source], { encoding: "utf8" });
  if (extract.error || extract.status !== 0) throw new Error("The admitted Wordcell payload could not be extracted safely.");
  const published: unknown = await import(pathToFileURL(join(source, "dist/cli.js")).href);
  if (typeof published !== "object" || published === null || !("runExecutable" in published) || typeof published.runExecutable !== "function") {
    throw new Error("The admitted Wordcell archive has no executable API.");
  }
  const runExecutable = published.runExecutable as (args: string[]) => unknown;
  const status: unknown = await runExecutable(args);
  if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 255) {
    throw new Error("The published Wordcell check returned an invalid exit status.");
  }
  process.exitCode = status;
} finally {
  rmSync(source, { recursive: true, force: true });
}
