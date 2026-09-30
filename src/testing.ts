// `@hraness/posthog/testing`: the shared test-contract harness from the
// portfolio observability standard. `runPostHogHarness` loads the pinned
// posthog-js in a child process, initializes it with the package's production
// browser config, captures events, and returns the decoded outgoing request
// bodies. `checkPostHogContract` runs the standard scenarios and returns every
// contract violation, so a site test is one `expect(violations).toEqual([])`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { createPostHogBeforeSend } from "./client.js";
import { isStandardAnalyticsEventName } from "./event.js";
import { isAllowedAnalyticsPath, type PostHogSiteDefinition } from "./site.js";

export type PostHogHarnessCapture = Readonly<{
  event: string;
  uuid?: string;
  properties?: Record<string, unknown>;
  /** Captured through `posthog.captureException` instead of `posthog.capture`. */
  error?: Readonly<{ name?: string; message: string; stack?: string }>;
}>;

export type PostHogHarnessScenario = Readonly<{
  href: string;
  referrer?: string;
  title?: string;
  doNotTrack?: string | null;
  captures: readonly PostHogHarnessCapture[];
}>;

export type PostHogHarnessOptions = Readonly<{
  site: PostHogSiteDefinition;
  /** A syntactically valid public token; the stubbed fetch never sends it. */
  apiKey?: string;
  apiHost?: string;
  userAgent?: string;
  doNotTrack?: string | null;
  scenarios: readonly PostHogHarnessScenario[];
  /** Runtime for the child process. Defaults to the current executable (bun or node). */
  runtime?: string;
  timeoutMs?: number;
}>;

export type PostHogSentEvent = Readonly<{
  event: string;
  properties: Record<string, unknown>;
  [key: string]: unknown;
}>;

export type PostHogHarnessResult = Readonly<{
  /** Events decoded from the request bodies posthog-js handed to fetch. */
  sent: readonly PostHogSentEvent[];
  /** Event objects posthog-js passed to before_send. */
  received: readonly unknown[];
  /** What the production before_send returned for each. */
  returned: readonly unknown[];
}>;

export const HARNESS_API_KEY = "phc_harness";
export const HARNESS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function harnessPath(): string {
  for (const candidate of ["./testing-harness.js", "./testing-harness.ts"]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) {
      return path;
    }
  }
  throw new Error("@hraness/posthog/testing: harness entry is missing from the package");
}

function decodeBody(base64: string): PostHogSentEvent[] {
  let bytes: Uint8Array = Buffer.from(base64, "base64");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = gunzipSync(bytes);
  }
  let text = new TextDecoder().decode(bytes);
  if (text.startsWith("data=")) {
    text = Buffer.from(decodeURIComponent(text.slice(5)), "base64").toString("utf8");
  }
  const parsed = JSON.parse(text) as unknown;
  const batch = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { batch?: unknown }).batch)
      ? (parsed as { batch: unknown[] }).batch
      : [parsed];
  return batch as PostHogSentEvent[];
}

/** Runs real posthog-js with the production config and returns the decoded requests. */
export function runPostHogHarness(options: PostHogHarnessOptions): PostHogHarnessResult {
  const input = JSON.stringify({
    site: options.site,
    apiKey: options.apiKey ?? HARNESS_API_KEY,
    apiHost: options.apiHost,
    userAgent: options.userAgent ?? HARNESS_USER_AGENT,
    doNotTrack: options.doNotTrack,
    scenarios: options.scenarios,
  });
  const child = spawnSync(options.runtime ?? process.execPath, [harnessPath()], {
    input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(
      `@hraness/posthog/testing: harness exited ${String(child.status ?? child.signal)}\n${child.stderr}`,
    );
  }
  const output = JSON.parse(child.stdout) as {
    sent: string[];
    received: unknown[];
    returned: unknown[];
  };
  return {
    sent: output.sent.flatMap(decodeBody),
    received: output.received,
    returned: output.returned,
  };
}

/**
 * Properties the standard requires on every sent event. `$session_id` and
 * `$window_id` are in PRESERVED_CONTRACT_PROPERTIES instead: posthog-js omits
 * them in `cookieless_mode: "always"`, where PostHog derives sessions during
 * ingestion.
 */
export const REQUIRED_CONTRACT_PROPERTIES = [
  "$host",
  "$raw_user_agent",
  "$current_url",
  "$pathname",
  "$referrer",
  "$referring_domain",
  "token",
  "site_id",
  "analytics_schema_version",
  "canonical_path",
  "page_kind",
  "$cookieless_mode",
  "distinct_id",
] as const;

/** Provider properties that must survive before_send whenever posthog-js sets them. */
export const PRESERVED_CONTRACT_PROPERTIES = [
  "$session_id",
  "$window_id",
  "$pageview_id",
  "$prev_pageview_id",
  "$lib",
  "$lib_version",
  "$browser",
  "$os",
  "$device_type",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
] as const;

export type PostHogContractOptions = Readonly<{
  site: PostHogSiteDefinition;
  /** A public route with no query of its own. Defaults to `/`. */
  publicPath?: string;
  /** A route listed in `sensitivePaths`. Required: every site has one. */
  sensitivePath: string;
  /** Custom events to capture, with representative properties. */
  customEvents?: readonly PostHogHarnessCapture[];
  /** Hosts `before_send` must reject. Defaults cover preview, vercel.app, and localhost. */
  rejectedHosts?: readonly string[];
  runtime?: string;
}>;

export type PostHogContractReport = Readonly<{
  violations: readonly string[];
  result: PostHogHarnessResult;
}>;

const LEAK_EMAIL = "person.contract@example.com";
const LEAK_CODE = "oauthcontractcode123";
const LEAK_PARAM = "private_contract_param";

function propertyOf(event: PostHogSentEvent, key: string): unknown {
  return event.properties[key] ?? (key === "distinct_id" ? event["distinct_id"] : undefined);
}

/**
 * Runs the test-contract scenarios from the observability standard through
 * real posthog-js and returns every violation found in the outgoing requests.
 */
export function checkPostHogContract(options: PostHogContractOptions): PostHogContractReport {
  const { site } = options;
  const origin = `https://${site.canonicalDomain}`;
  const publicPath = options.publicPath ?? "/";
  const publicHref = `${origin}${publicPath}?utm_source=contract&gclid=contractclick&email=${
    encodeURIComponent(LEAK_EMAIL)
  }&code=${LEAK_CODE}&${LEAK_PARAM}=1#fragment`;
  const sensitiveHref = `${origin}${options.sensitivePath}?utm_source=contract&gclid=contractclick&code=${LEAK_CODE}`;
  const referrer = "https://news.example.org/some/article/path?ref=contract";
  const standard: PostHogHarnessCapture[] = [
    { event: "$pageview" },
    { event: "$pageleave" },
    {
      event: "$web_vitals",
      properties: { $web_vitals_LCP_value: 1200, $web_vitals_LCP_event: { name: "LCP", value: 1200 } },
    },
    { event: "$exception", error: { name: "TypeError", message: `failed for ${LEAK_EMAIL}` } },
  ];
  const customEvents = options.customEvents ?? [];
  const result = runPostHogHarness({
    site,
    ...(options.runtime ? { runtime: options.runtime } : {}),
    scenarios: [
      { href: publicHref, referrer, captures: [...standard, ...customEvents] },
      { href: sensitiveHref, referrer, captures: [{ event: "$pageview" }] },
    ],
  });

  const violations: string[] = [];
  const receivedByUuid = new Map<unknown, Record<string, unknown>>();
  for (const value of result.received) {
    if (value && typeof value === "object") {
      const received = value as { uuid?: unknown; properties?: Record<string, unknown> };
      receivedByUuid.set(received.uuid, received.properties ?? {});
    }
  }
  const publicEvents = result.sent.filter((event) => {
    const url = receivedByUuid.get(event["uuid"])?.["$current_url"] ?? propertyOf(event, "$current_url");
    return typeof url === "string" && !url.includes(options.sensitivePath);
  });
  const sensitiveEvents = result.sent.filter((event) => !publicEvents.includes(event));
  for (const expected of [...standard, ...customEvents]) {
    if (!publicEvents.some((event) => event.event === expected.event)) {
      violations.push(`${expected.event}: no request was sent`);
    }
  }
  if (isAllowedAnalyticsPath(site, options.sensitivePath)) {
    if (sensitiveEvents.length === 0) violations.push(`${options.sensitivePath}: no sensitive-path $pageview was sent`);
  } else if (sensitiveEvents.length > 0) {
    violations.push(`${options.sensitivePath}: excluded route sent events`);
  }

  for (const event of result.sent) {
    const label = event.event;
    const received = receivedByUuid.get(event["uuid"]) ?? {};
    for (const key of PRESERVED_CONTRACT_PROPERTIES) {
      if (received[key] !== undefined && received[key] !== null && propertyOf(event, key) !== received[key]) {
        violations.push(`${label}: changed or dropped ${key}`);
      }
    }
    for (const key of REQUIRED_CONTRACT_PROPERTIES) {
      const value = propertyOf(event, key);
      if (value === undefined || value === null || value === "") {
        violations.push(`${label}: missing ${key}`);
      }
    }
    if (propertyOf(event, "$cookieless_mode") !== true) {
      violations.push(`${label}: $cookieless_mode is not true`);
    }
    if (propertyOf(event, "site_id") !== site.id) {
      violations.push(`${label}: site_id is not ${site.id}`);
    }
    if (propertyOf(event, "analytics_schema_version") !== site.schemaVersion) {
      violations.push(`${label}: analytics_schema_version is not ${String(site.schemaVersion)}`);
    }
    const serialized = JSON.stringify(event);
    for (const [leak, name] of [
      [LEAK_EMAIL, "email"],
      [LEAK_CODE, "OAuth code"],
      [LEAK_PARAM, "non-attribution query parameter"],
      ["#fragment", "fragment"],
      ["/some/article/path", "third-party referrer path"],
    ] as const) {
      if (serialized.includes(leak)) {
        violations.push(`${label}: leaked the ${name}`);
      }
    }
  }

  for (const event of publicEvents) {
    const label = event.event;
    const currentUrl = String(propertyOf(event, "$current_url"));
    let params: string[] = [];
    try {
      params = [...new URL(currentUrl).searchParams.keys()].sort();
    } catch {
      violations.push(`${label}: $current_url is not a URL`);
    }
    const expectedParams = (site.attributionMode === "referrer_only" || site.privacyMode === "minimal") ? "" : "gclid,utm_source";
    if (params.join(",") !== expectedParams) {
      violations.push(`${label}: $current_url query is [${params.join(",")}], want [${expectedParams}]`);
    }
    if ((site.attributionMode === "referrer_only" || site.privacyMode === "minimal")) {
      const serialized = JSON.stringify(event.properties);
      if (serialized.includes("contractclick") || serialized.includes('"utm_source"')) {
        violations.push(`${label}: referrer-only site kept attribution`);
      }
      continue;
    }
    if (propertyOf(event, "utm_source") !== "contract") {
      violations.push(`${label}: utm_source was not kept`);
    }
    if (propertyOf(event, "gclid") !== "contractclick") {
      violations.push(`${label}: gclid was not kept`);
    }
  }

  for (const event of sensitiveEvents) {
    const serialized = JSON.stringify(event.properties);
    if (String(propertyOf(event, "$current_url")).includes("?")) {
      violations.push(`${event.event} on ${options.sensitivePath}: kept a query`);
    }
    if (serialized.includes("contractclick") || serialized.includes('"utm_source"')) {
      violations.push(`${event.event} on ${options.sensitivePath}: kept attribution`);
    }
  }

  for (const eventName of [...site.customEvents, ...(site.delegatedEvents ?? [])]) {
    if (!isStandardAnalyticsEventName(eventName)) {
      violations.push(`${eventName}: custom event name breaks the lowercase object-verb rule`);
    }
  }
  for (const capture of customEvents) {
    if (!site.customEvents.includes(capture.event) && !site.delegatedEvents?.includes(capture.event)) {
      violations.push(`${capture.event}: not in the site's customEvents allowlist`);
    }
  }

  const rejectedHosts = options.rejectedHosts ?? [
    `preview.${site.canonicalDomain}`,
    `${site.id.replace(/[^a-z0-9-]/gu, "-")}-git-branch.vercel.app`,
    "localhost",
  ];
  for (const host of rejectedHosts) {
    const href = `https://${host}${publicPath}`;
    const beforeSend = createPostHogBeforeSend(site, () => ({ href, referrer: "" }));
    const sample = beforeSend({
      uuid: "00000000-0000-4000-8000-000000000000",
      event: "$pageview",
      properties: { token: HARNESS_API_KEY, $current_url: href, $host: host },
    });
    if (sample !== null) {
      violations.push(`${host}: before_send did not return null`);
    }
  }

  return { violations, result };
}
