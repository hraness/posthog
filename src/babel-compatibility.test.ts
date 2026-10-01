import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("published privacy exports compile with Next Babel and preserve Unicode redaction", () => {
  const probe = spawnSync("node", ["--input-type=commonjs", "-e", `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const vm = require("node:vm");
    const babel = require("next/dist/compiled/babel/core");
    for (const entry of ["site", "client", "event"]) {
      const output = babel.transformSync(fs.readFileSync("dist/" + entry + ".js", "utf8"), {
        filename: process.cwd() + "/dist/" + entry + ".js",
        envName: "production", babelrc: false, configFile: false,
        presets: [require.resolve("next/babel")],
        caller: {
          name: "babel-loader", isServer: false, isDev: false,
          supportsStaticESM: entry !== "event", supportsDynamicImport: entry !== "event",
        },
      });
      assert.ok(output?.code);
      if (entry === "event") {
        const context = { exports: {}, require };
        vm.runInNewContext(output.code, context);
        for (const [input, expected] of [
          ["é@例子.测试", "[email]"],
          ["用户%40例子.测试", "[email]"],
          ["+@a.aa", "[email]"],
          ["a@b.co+c@d.co", "[email]+[email]"],
          ["/café/%2F/%zz/keep", "/café/%2F/%zz/keep"],
        ]) assert.equal(context.exports.redactSensitiveText(input), expected);
      }
    }
  `], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 15_000 });
  expect(probe.error).toBeUndefined();
  expect(probe.status, probe.stderr).toBe(0);
}, 20_000);
