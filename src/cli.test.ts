import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTelemetry, noticeText, wireOs, wireVersion, type TelemetryConfig } from "./cli.ts";
import { parseWireEvent } from "./server.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(env: Record<string, string | undefined> = {}, zone = "America/New_York", extra: Partial<TelemetryConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "analytics-cli-"));
  dirs.push(dir);
  const sent: unknown[] = [];
  const notices: string[] = [];
  const telemetry = createTelemetry({
    siteId: "example",
    endpoint: "https://example.com/api/cli/event",
    envPrefix: "EXAMPLE",
    version: "1.4.0-beta.1",
    configDir: dir,
    offCommand: "example telemetry off",
    onCommand: "example telemetry on",
    privacyUrl: "https://example.com/privacy",
    name: "Example",
    env,
    zone,
    stderr: (text) => { notices.push(text); },
    fetch: ((_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch,
    ...extra,
  });
  return { dir, sent, notices, telemetry };
}

describe("CLI telemetry", () => {
  test("on by default outside Europe, with a notice the first time only", async () => {
    const { sent, notices, telemetry, dir } = await setup();
    expect(await telemetry.state()).toMatchObject({ enabled: true, reason: "default", regionGroup: "us" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("example telemetry off");
    telemetry.commandRun("publish", true, 1200);
    await telemetry.flush();
    expect(sent).toHaveLength(1);
    const batch = sent[0] as Record<string, unknown>[];
    expect(batch[0]).toMatchObject({ v: 1, event: "cli command run", app: "1.4.0", build: 0, region: "default", props: { command: "publish", ok: "true", duration_bucket: "1-5s", surface: "cli", region_group: "us", ci: "false" } });
    // The server parser accepts exactly this.
    expect(parseWireEvent(batch[0])).toBeDefined();
    const again = await setup();
    await writeFile(join(again.dir, "telemetry.json"), await readFile(join(dir, "telemetry.json"), "utf8"));
    await again.telemetry.state();
    expect(again.notices).toEqual([]);
  });

  test("DO_NOT_TRACK and the product switch send nothing and write nothing", async () => {
    for (const env of [{ DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: "true" }, { EXAMPLE_TELEMETRY_DISABLED: "1" }]) {
      const { sent, notices, telemetry, dir } = await setup(env);
      expect(await telemetry.state()).toMatchObject({ enabled: false, reason: "env" });
      telemetry.commandRun("publish", true, 10);
      await telemetry.flush();
      expect(sent).toEqual([]);
      expect(notices).toEqual([]);
      expect(readFile(join(dir, "telemetry.json"), "utf8")).rejects.toThrow();
    }
    const { telemetry } = await setup({ DO_NOT_TRACK: "0" });
    expect((await telemetry.state()).enabled).toBe(true);
  });

  test("the off command forgets the install ID and stops sending", async () => {
    const { sent, telemetry, dir } = await setup();
    const before = await telemetry.state();
    expect(before.installId).toMatch(/^[0-9a-f-]{36}$/u);
    telemetry.commandRun("publish", true, 10);
    expect(await telemetry.setEnabled(false)).toMatchObject({ enabled: false, reason: "config", installId: undefined });
    await telemetry.flush();
    expect(sent).toEqual([]);
    expect(await readFile(join(dir, "telemetry.json"), "utf8")).not.toContain(before.installId ?? "none");
    expect((await telemetry.setEnabled(true)).enabled).toBe(true);
  });

  test("in Europe it asks first: off until the on command", async () => {
    const { sent, notices, telemetry } = await setup({}, "Europe/Paris");
    expect(await telemetry.state()).toMatchObject({ enabled: false, reason: "ask", regionGroup: "eu" });
    expect(notices[0]).toContain("example telemetry on");
    telemetry.commandRun("publish", true, 10);
    await telemetry.flush();
    expect(sent).toEqual([]);
    expect(await telemetry.setEnabled(true)).toMatchObject({ enabled: true, reason: "on" });
    telemetry.commandRun("publish", true, 10);
    await telemetry.flush();
    expect((sent[0] as Record<string, unknown>[])[0]).toMatchObject({ region: "ask", props: { region_group: "eu" } });
  });

  test("CI is skipped unless asked for", async () => {
    expect(await (await setup({ CI: "true" })).telemetry.state()).toMatchObject({ enabled: false, reason: "ci" });
    expect((await (await setup({ CI: "true", EXAMPLE_TELEMETRY: "1" })).telemetry.state()).enabled).toBe(true);
  });

  test("never arguments, paths or content: only allowlisted label properties", async () => {
    const { sent, telemetry } = await setup({}, "America/New_York", { events: { "thing made": ["kind"] } });
    telemetry.commandRun("publish ./secret/path --token=abc", true, 10);
    telemetry.record("cli command run", { command: "publish", ok: true, duration_bucket: "<1s", path: "/Users/someone/secret" } as never);
    telemetry.record("thing made", { kind: "Some Free Text" });
    telemetry.record("not an event", { kind: "x" });
    await telemetry.flush();
    const body = JSON.stringify(sent);
    expect(body).not.toMatch(/secret|token|Some Free Text|not an event/u);
    const events = (sent[0] as Record<string, unknown>[]).map((event) => event.event);
    expect(events).toEqual(["cli command run", "thing made"]);
  });

  test("time() records the outcome and rethrows", async () => {
    const { sent, telemetry } = await setup();
    expect(await telemetry.time("build", () => Promise.resolve(3))).toBe(3);
    expect(telemetry.time("build", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await telemetry.flush();
    expect((sent[0] as { props: { ok: string } }[]).map((event) => event.props.ok)).toEqual(["true", "false"]);
  });

  test("a slow endpoint is abandoned after the limit", async () => {
    const { telemetry } = await setup({}, "America/New_York", {
      timeoutMs: 20,
      fetch: ((_url: string, init?: RequestInit) => new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => { reject(new Error("aborted")); });
      })) as unknown as typeof fetch,
    });
    telemetry.commandRun("publish", true, 10);
    const started = Date.now();
    await telemetry.flush();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("wire fields", () => {
    expect(wireVersion("v2.10.3-rc.1")).toBe("2.10.3");
    expect(wireVersion("nonsense")).toBe("0");
    expect(wireOs("25.5.0")).toBe("25.5");
    expect(wireOs("6.8.0-45-generic")).toBe("6.8");
    expect(noticeText({ name: "X", offCommand: "x off", onCommand: "x on", privacyUrl: "u", envPrefix: "X" }, false)).toContain("DO_NOT_TRACK=1");
  });
});
