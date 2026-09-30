import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")) as {
  jobs: { publish: { steps: Array<{ name?: string; run?: string }> } };
};
const script = workflow.jobs.publish.steps.find(step => step.name === "Publish verified GitHub Release")?.run;
if (!script) throw new Error("Missing publication script");
const publicationScript = script;

function publicationFixture(corrupt = false, mismatchedTag = false) {
  const root = mkdtempSync(join(tmpdir(), "posthog-release-test-"));
  try {
    mkdirSync(join(root, "release"));
    mkdirSync(join(root, "bin"));
    const packageFile = "hraness-posthog-0.1.0.tgz";
    const bytes = "verified package fixture";
    writeFileSync(join(root, "release", packageFile), corrupt ? "changed bytes" : bytes);
    writeFileSync(join(root, "release/SHA256SUMS"), `${createHash("sha256").update(bytes).digest("hex")}  ${packageFile}\n`);
    const log = join(root, "calls.log");
    writeFileSync(log, "");
    writeFileSync(join(root, "bin/gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_TEST_LOG"
case "$2" in
  view) printf '%s\\tfalse\\tfalse\\ttrue\\t2\\n' "$GITHUB_REF_NAME" ;;
  download) cp release/* "$RUNNER_TEMP/posthog-published/" ;;
esac
`, { mode: 0o755 });
    const result = spawnSync("bash", ["-c", publicationScript], {
      cwd: root,
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, RUNNER_TEMP: root,
        GH_TEST_LOG: log, GITHUB_REF_NAME: "v0.1.0", VERIFIED_TAG: mismatchedTag ? "v0.2.0" : "v0.1.0" },
    });
    return { status: result.status, calls: readFileSync(log, "utf8"), stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("release uploads a verified package to a draft before immutable publication and downloads it for verification", () => {
  const result = publicationFixture();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const calls = result.calls.trim().split("\n");
  expect(calls).toHaveLength(4);
  expect(calls[0]).toContain("release create v0.1.0 release/hraness-posthog-0.1.0.tgz release/SHA256SUMS");
  expect(calls[0]).toContain("--draft");
  expect(calls[1]).toBe("release edit v0.1.0 --draft=false --latest");
  expect(calls[2]).toStartWith("release view ");
  expect(calls[3]).toStartWith("release download ");
});

test("changed artifact bytes and mismatched release identities fail before any GitHub mutation", () => {
  for (const result of [publicationFixture(true), publicationFixture(false, true)]) {
    expect(result.status).not.toBe(0);
    expect(result.calls).toBe("");
  }
});
