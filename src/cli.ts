/**
 * Usage counts for a command-line tool or MCP server on Node. Opt-out outside Europe and opt-in inside it, with a
 * one-time notice on standard error, `DO_NOT_TRACK=1`, `<PREFIX>_TELEMETRY_DISABLED=1` and an off switch kept in the
 * tool's config. It sends verbs, outcomes and coarse durations: never arguments, paths, file contents, prompts or
 * errors. Events use the same wire format as the Swift package and are sent in batches with a one-second limit.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { dirname, join } from "node:path";

import { durationBucket, type DurationBucket } from "./events.js";
import { UUID } from "./internal.js";
import { groupOfZone, telemetryDefault, type RegionGroup } from "./policy.js";

export type TelemetryConfig = Readonly<{
  /** The product's site ID, for the config directory default. */
  siteId: string;
  /** Where events go: the product's own `/api/cli/event`, served by `wireHandler` from `@hraness/analytics/server`. */
  endpoint: string;
  /** Upper-case prefix for the environment switch: `FOO` reads `FOO_TELEMETRY_DISABLED` and `FOO_TELEMETRY`. */
  envPrefix: string;
  /** The tool's version (`1.2.3`; anything after `-` or `+` is dropped). */
  version: string;
  /** Where `telemetry.json` lives. Default `$XDG_CONFIG_HOME/<siteId>` or `~/.config/<siteId>`. */
  configDir?: string;
  /** The command that turns counting off, shown in the notice (`foo telemetry off`). */
  offCommand: string;
  /** The command that turns it on, shown to European users (`foo telemetry on`). */
  onCommand: string;
  privacyUrl: string;
  /** The tool's name in the notice. */
  name: string;
  surface?: "cli" | "mcp";
  /** Product events beyond `cli command run` and `mcp tool called`, each with its allowed property names. */
  events?: Readonly<Record<string, readonly string[]>>;
  timeoutMs?: number;
  /** For tests. */
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  stderr?: (text: string) => void;
  zone?: string;
  now?: () => number;
}>;

export type TelemetryState = Readonly<{
  enabled: boolean;
  /** Why: `env` (DO_NOT_TRACK or the product switch), `config` (the off command), `ask` (Europe, no answer yet), `ci`, `default`. */
  reason: "env" | "config" | "ask" | "ci" | "default" | "on";
  regionGroup: RegionGroup;
  installId: string | undefined;
  file: string;
}>;

export type Telemetry = Readonly<{
  state(): Promise<TelemetryState>;
  /** The on and off commands. Off forgets the install ID and anything queued. */
  setEnabled(enabled: boolean): Promise<TelemetryState>;
  /** Queues one event. Unknown events and unknown or non-label properties are dropped, never sent. */
  record(event: string, props?: Readonly<Record<string, string | boolean>>): void;
  /** `cli command run` for a verb (`publish`, never its arguments). */
  commandRun(command: string, ok: boolean, milliseconds: number): void;
  /** Runs `work` and records its verb, outcome and duration bucket. */
  time<T>(command: string, work: () => Promise<T>): Promise<T>;
  /** Sends what is queued, waiting at most `timeoutMs` (default 1000). Never throws. */
  flush(): Promise<void>;
}>;

type Stored = { enabled?: boolean; install?: string; notice?: string };

const truthy = (value: string | undefined) => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
const LABEL = /^[a-z0-9._-]{1,40}$/u;
const SHARED: Readonly<Record<string, readonly string[]>> = {
  "cli command run": ["command", "ok", "duration_bucket"],
  "mcp tool called": ["tool", "client", "ok"],
};

/** The wire `app` field: the numeric part of a version. */
export function wireVersion(version: string): string {
  const core = /^(\d{1,4}(?:\.\d{1,4}){0,3})/u.exec(version.replace(/^v/u, ""));
  return core?.[1] ?? "0";
}
/** The wire `os` field: the kernel release's major and minor. */
export function wireOs(kernel: string): string {
  const match = /^(\d{1,3})\.(\d{1,3})/u.exec(kernel);
  return match === null ? "0.0" : `${match[1] ?? "0"}.${match[2] ?? "0"}`;
}
const platformOf = (name: string) => (name === "darwin" ? "mac" : name === "win32" ? "windows" : "linux");

/** The notice printed once, on the first run that could count anything. */
export function noticeText(config: Pick<TelemetryConfig, "name" | "offCommand" | "onCommand" | "privacyUrl" | "envPrefix">, asks: boolean): string {
  return asks
    ? `${config.name} can send anonymous usage counts (command names and whether they worked, never arguments or files). It is off until you run \`${config.onCommand}\`. ${config.privacyUrl}\n`
    : `${config.name} sends anonymous usage counts: command names, whether they worked and how long they took, never arguments or files. Turn it off with \`${config.offCommand}\`, DO_NOT_TRACK=1 or ${config.envPrefix}_TELEMETRY_DISABLED=1. ${config.privacyUrl}\n`;
}

export function createTelemetry(config: TelemetryConfig): Telemetry {
  const env = config.env ?? process.env;
  const dir = config.configDir ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), config.siteId);
  const file = join(dir, "telemetry.json");
  const now = config.now ?? Date.now;
  const prefix = config.envPrefix.toUpperCase();
  const events: Readonly<Record<string, readonly string[]>> = { ...SHARED, ...config.events };
  let zone = config.zone;
  if (zone === undefined) {
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      zone = undefined;
    }
  }
  const group = groupOfZone(zone);
  const asks = telemetryDefault(group) === "ask";
  const ci = truthy(env.CI);
  let queue: Record<string, unknown>[] = [];
  let cached: Promise<TelemetryState> | undefined;

  async function read(): Promise<Stored> {
    try {
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof value !== "object" || value === null) return {};
      const record = value as Record<string, unknown>;
      return {
        ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
        ...(typeof record.install === "string" && UUID.test(record.install) ? { install: record.install.toLowerCase() } : {}),
        ...(typeof record.notice === "string" ? { notice: record.notice.slice(0, 40) } : {}),
      };
    } catch {
      return {};
    }
  }
  async function write(stored: Stored): Promise<void> {
    try {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${String(process.pid)}.tmp`;
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    } catch {
      // A read-only home: counting simply stays off for want of an install ID.
    }
  }

  async function load(): Promise<TelemetryState> {
    const base = { regionGroup: group, file };
    if (truthy(env.DO_NOT_TRACK) || truthy(env[`${prefix}_TELEMETRY_DISABLED`])) return { ...base, enabled: false, reason: "env", installId: undefined };
    const stored = await read();
    if (stored.enabled === false) return { ...base, enabled: false, reason: "config", installId: undefined };
    const forced = truthy(env[`${prefix}_TELEMETRY`]);
    if (ci && !forced && stored.enabled !== true) return { ...base, enabled: false, reason: "ci", installId: undefined };
    if (asks && stored.enabled !== true && !forced) {
      if (stored.notice === undefined) {
        (config.stderr ?? ((text) => process.stderr.write(text)))(noticeText(config, true));
        await write({ ...stored, notice: new Date(now()).toISOString().slice(0, 10) });
      }
      return { ...base, enabled: false, reason: "ask", installId: undefined };
    }
    const next: Stored = { ...stored, install: stored.install ?? crypto.randomUUID() };
    if (stored.notice === undefined) {
      (config.stderr ?? ((text) => process.stderr.write(text)))(noticeText(config, false));
      next.notice = new Date(now()).toISOString().slice(0, 10);
    }
    if (next.install !== stored.install || next.notice !== stored.notice) await write(next);
    // Without a stored install ID (a read-only home), nothing is sent: a fresh ID per run would inflate installs.
    const kept = (await read()).install;
    return { ...base, enabled: kept !== undefined, reason: stored.enabled === true || forced ? "on" : "default", installId: kept };
  }
  const state = () => (cached ??= load());

  const api: Telemetry = {
    state,
    async setEnabled(enabled) {
      const stored = await read();
      queue = [];
      await write(enabled ? { ...stored, enabled: true, install: stored.install ?? crypto.randomUUID(), notice: stored.notice ?? new Date(now()).toISOString().slice(0, 10) } : { enabled: false, notice: stored.notice ?? new Date(now()).toISOString().slice(0, 10) });
      cached = undefined;
      return state();
    },
    record(event, props = {}) {
      const allowed = Object.hasOwn(events, event) ? events[event] : undefined;
      if (allowed === undefined) return;
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(props)) {
        if (!allowed.includes(key)) continue;
        const text = typeof value === "boolean" ? String(value) : value;
        if (LABEL.test(text) || /^(<1s|1-5s|5-30s|30s\+)$/u.test(text)) clean[key] = text;
      }
      if (queue.length >= 50) return;
      queue.push({
        v: 1,
        event,
        id: crypto.randomUUID(),
        at: Math.floor(now() / 1000),
        app: wireVersion(config.version),
        build: 0,
        os: wireOs(release()),
        region: asks ? "ask" : "default",
        props: { ...clean, surface: config.surface ?? "cli", platform: platformOf(process.platform), region_group: group, ci: String(ci) },
      });
    },
    commandRun(command, ok, milliseconds) {
      const bucket: DurationBucket = durationBucket(milliseconds);
      if (!LABEL.test(command)) return;
      api.record("cli command run", { command, ok, duration_bucket: bucket });
    },
    async time(command, work) {
      const started = now();
      try {
        const result = await work();
        api.commandRun(command, true, now() - started);
        return result;
      } catch (error) {
        api.commandRun(command, false, now() - started);
        throw error;
      }
    },
    async flush() {
      if (queue.length === 0) return;
      const batch = queue.splice(0, 20);
      const current = await state().catch(() => undefined);
      if (current?.enabled !== true || current.installId === undefined) {
        queue = [];
        return;
      }
      const body = JSON.stringify(batch.map((event) => ({ ...event, install: current.installId })));
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, config.timeoutMs ?? 1000);
      try {
        await (config.fetch ?? fetch)(config.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, signal: controller.signal });
      } catch {
        // Offline or slow: the counts are dropped, never retried into a later command's time.
      } finally {
        clearTimeout(timer);
      }
      if (queue.length > 0) await api.flush();
    },
  };
  return api;
}
