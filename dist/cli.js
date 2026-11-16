// src/cli.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { dirname, join } from "node:path";

// src/events.ts
var MARKETING_EVENTS = [
  "cta clicked",
  "outbound link opened",
  "demo played",
  "download started",
  "install command copied",
  "store link opened",
  "download link emailed",
  "download link failed",
  "analytics choice made"
];
var LIFECYCLE_EVENTS = [
  "app installed",
  "app opened",
  "cli command run",
  "mcp tool called",
  "account created",
  "signed in",
  "activated",
  "upgrade offered",
  "checkout started"
];
var SERVER_EVENTS = [
  "download served",
  "checkout completed",
  "subscription started",
  "subscription renewed",
  "subscription canceled",
  "payment failed",
  "refund issued",
  "checkout session created"
];
var SHARED_EVENTS = [...MARKETING_EVENTS, ...LIFECYCLE_EVENTS, ...SERVER_EVENTS];
function durationBucket(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 1000)
    return "<1s";
  if (milliseconds < 5000)
    return "1-5s";
  if (milliseconds < 30000)
    return "5-30s";
  return "30s+";
}

// src/internal.ts
var encoder = new TextEncoder;
var NAMESPACE = Uint8Array.from([107, 167, 184, 17, 157, 173, 17, 209, 128, 180, 0, 192, 79, 212, 48, 200]);
var ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf"]);
var THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
var UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

// src/policy.ts
var EU_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  "IS",
  "LI",
  "NO",
  "AX",
  "GF",
  "GP",
  "MQ",
  "RE",
  "YT",
  "MF",
  "GG",
  "JE",
  "IM",
  "GI"
];
var UK_CH_COUNTRIES = ["GB", "CH"];
var BR_COUNTRIES = ["BR"];
var US_COUNTRIES = ["US", "PR", "GU", "VI", "AS", "MP", "UM"];
var PLACELESS_ZONE = /^(?:UTC|UCT|GMT|GMT0|GMT[+-]0|Greenwich|Universal|Zulu|Factory|Etc\/.*)$/u;
var UK_CH_ZONE = /^(?:Europe\/(?:London|Belfast|Zurich)|GB|GB-Eire)$/u;
var EU_ZONE = /^(?:Europe\/.*|Arctic\/.*|Atlantic\/(?:Reykjavik|Canary|Madeira|Azores|Faroe|Faeroe|Jan_Mayen)|Asia\/(?:Nicosia|Famagusta)|Africa\/Ceuta|Indian\/(?:Reunion|Mayotte)|America\/(?:Guadeloupe|Martinique|Cayenne|Marigot|St_Barthelemy)|Eire|Iceland|Portugal|Poland|CET|MET|EET|WET)$/u;
var BR_ZONE = /^(?:America\/(?:Sao_Paulo|Rio_Branco|Manaus|Cuiaba|Campo_Grande|Belem|Fortaleza|Recife|Araguaina|Maceio|Bahia|Santarem|Porto_Velho|Boa_Vista|Eirunepe|Noronha|Porto_Acre)|Brazil\/.*)$/u;
var US_ZONE = /^(?:America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak|Boise|Detroit|Menominee|Indiana\/.*|Kentucky\/.*|North_Dakota\/.*|Indianapolis|Louisville|Puerto_Rico|St_Thomas)|Pacific\/(?:Honolulu|Guam|Saipan|Pago_Pago|Midway|Wake)|US\/.*|EST|MST|HST|EST5EDT|CST6CDT|MST7MDT|PST8PDT|Navajo)$/u;
var EU_SET = new Set(EU_COUNTRIES);
var UK_CH_SET = new Set(UK_CH_COUNTRIES);
var BR_SET = new Set(BR_COUNTRIES);
var US_SET = new Set(US_COUNTRIES);
function groupOfZone(zone) {
  if (typeof zone !== "string")
    return "eu";
  const name = zone.trim();
  if (name === "" || PLACELESS_ZONE.test(name))
    return "eu";
  if (UK_CH_ZONE.test(name))
    return "uk_ch";
  if (EU_ZONE.test(name))
    return "eu";
  if (BR_ZONE.test(name))
    return "br";
  if (US_ZONE.test(name))
    return "us";
  return "row";
}
function telemetryDefault(group) {
  return group === "eu" ? "ask" : "on";
}

// src/cli.ts
var truthy = (value) => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
var LABEL = /^[a-z0-9._-]{1,40}$/u;
var SHARED = {
  "cli command run": ["command", "ok", "duration_bucket"],
  "mcp tool called": ["tool", "client", "ok"]
};
function wireVersion(version) {
  const core = /^(\d{1,4}(?:\.\d{1,4}){0,3})/u.exec(version.replace(/^v/u, ""));
  return core?.[1] ?? "0";
}
function wireOs(kernel) {
  const match = /^(\d{1,3})\.(\d{1,3})/u.exec(kernel);
  return match === null ? "0.0" : `${match[1] ?? "0"}.${match[2] ?? "0"}`;
}
var platformOf = (name) => name === "darwin" ? "mac" : name === "win32" ? "windows" : "linux";
function noticeText(config, asks) {
  return asks ? `${config.name} can send anonymous usage counts (command names and whether they worked, never arguments or files). It is off until you run \`${config.onCommand}\`. ${config.privacyUrl}
` : `${config.name} sends anonymous usage counts: command names, whether they worked and how long they took, never arguments or files. Turn it off with \`${config.offCommand}\`, DO_NOT_TRACK=1 or ${config.envPrefix}_TELEMETRY_DISABLED=1. ${config.privacyUrl}
`;
}
function createTelemetry(config) {
  const env = config.env ?? process.env;
  const dir = config.configDir ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), config.siteId);
  const file = join(dir, "telemetry.json");
  const now = config.now ?? Date.now;
  const prefix = config.envPrefix.toUpperCase();
  const events = { ...SHARED, ...config.events };
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
  let queue = [];
  let cached;
  async function read() {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (typeof value !== "object" || value === null)
        return {};
      const record = value;
      return {
        ...typeof record.enabled === "boolean" ? { enabled: record.enabled } : {},
        ...typeof record.install === "string" && UUID.test(record.install) ? { install: record.install.toLowerCase() } : {},
        ...typeof record.notice === "string" ? { notice: record.notice.slice(0, 40) } : {}
      };
    } catch {
      return {};
    }
  }
  async function write(stored) {
    try {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${String(process.pid)}.tmp`;
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}
`, { mode: 384 });
      await rename(temporary, file);
    } catch {}
  }
  async function load() {
    const base = { regionGroup: group, file };
    if (truthy(env.DO_NOT_TRACK) || truthy(env[`${prefix}_TELEMETRY_DISABLED`]))
      return { ...base, enabled: false, reason: "env", installId: undefined };
    const stored = await read();
    if (stored.enabled === false)
      return { ...base, enabled: false, reason: "config", installId: undefined };
    const forced = truthy(env[`${prefix}_TELEMETRY`]);
    if (ci && !forced && stored.enabled !== true)
      return { ...base, enabled: false, reason: "ci", installId: undefined };
    if (asks && stored.enabled !== true && !forced) {
      if (stored.notice === undefined) {
        (config.stderr ?? ((text) => process.stderr.write(text)))(noticeText(config, true));
        await write({ ...stored, notice: new Date(now()).toISOString().slice(0, 10) });
      }
      return { ...base, enabled: false, reason: "ask", installId: undefined };
    }
    const next = { ...stored, install: stored.install ?? crypto.randomUUID() };
    if (stored.notice === undefined) {
      (config.stderr ?? ((text) => process.stderr.write(text)))(noticeText(config, false));
      next.notice = new Date(now()).toISOString().slice(0, 10);
    }
    if (next.install !== stored.install || next.notice !== stored.notice)
      await write(next);
    const kept = (await read()).install;
    return { ...base, enabled: kept !== undefined, reason: stored.enabled === true || forced ? "on" : "default", installId: kept };
  }
  const state = () => cached ??= load();
  const api = {
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
      if (allowed === undefined)
        return;
      const clean = {};
      for (const [key, value] of Object.entries(props)) {
        if (!allowed.includes(key))
          continue;
        const text = typeof value === "boolean" ? String(value) : value;
        if (LABEL.test(text) || /^(<1s|1-5s|5-30s|30s\+)$/u.test(text))
          clean[key] = text;
      }
      if (queue.length >= 50)
        return;
      queue.push({
        v: 1,
        event,
        id: crypto.randomUUID(),
        at: Math.floor(now() / 1000),
        app: wireVersion(config.version),
        build: 0,
        os: wireOs(release()),
        region: asks ? "ask" : "default",
        props: { ...clean, surface: config.surface ?? "cli", platform: platformOf(process.platform), region_group: group, ci: String(ci) }
      });
    },
    commandRun(command, ok, milliseconds) {
      const bucket = durationBucket(milliseconds);
      if (!LABEL.test(command))
        return;
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
      if (queue.length === 0)
        return;
      const current = await state().catch(() => {
        return;
      });
      if (current?.enabled !== true || current.installId === undefined) {
        queue = [];
        return;
      }
      const controller = new AbortController;
      const timer = setTimeout(() => {
        controller.abort();
      }, config.timeoutMs ?? 1000);
      const expired = new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => {
          resolve();
        }, { once: true });
      });
      try {
        while (queue.length > 0 && !controller.signal.aborted) {
          const batch = queue.splice(0, 20);
          const body = JSON.stringify(batch.map((event) => ({ ...event, install: current.installId })));
          const sent = Promise.resolve().then(() => (config.fetch ?? fetch)(config.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, signal: controller.signal })).catch(() => {
            return;
          });
          await Promise.race([sent, expired]);
        }
      } finally {
        clearTimeout(timer);
        queue = [];
      }
    }
  };
  return api;
}
export {
  wireVersion,
  wireOs,
  noticeText,
  createTelemetry
};

//# debugId=960C0FDF5871FC2264756E2164756E21
