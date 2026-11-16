/**
 * Server helpers for Workers and Node: the region endpoint, capture after the response, the opaque account ID that
 * joins billing to the signed-in person, Stripe billing events, the app and CLI wire format, served downloads and
 * erasure. Nothing here reads a request body it was not handed, logs, or sends an email address.
 */
import { refLabel } from "./attribution.js";
import { SCHEMA, SERVER_EVENTS, type Props, type ServerEvent } from "./events.js";
import { bag, count, decimalsOf, hmacHex, later, sha256Hex, UUID, uuidV5, type Bag } from "./internal.js";
import { REGION_TABLE, regionResponse, type RegionGroup, type RegionResponse } from "./policy.js";

export { SERVER_EVENTS, type ServerEvent };

/** The edge's country header, in the order hosts set them. */
export const COUNTRY_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country", "x-country-code"] as const;

type HeaderSource = Readonly<{ headers: Pick<Headers, "get"> }> | Pick<Headers, "get">;
const headersOf = (source: HeaderSource): Pick<Headers, "get"> => ("headers" in source ? source.headers : source);

/** The visitor's region and policy from the edge's headers. `zone` is the browser's time zone, when it sent one. */
export function regionOf(source: HeaderSource, zone?: string): RegionResponse {
  const headers = headersOf(source);
  const country = COUNTRY_HEADERS.map((name) => headers.get(name)).find((value) => typeof value === "string" && value !== "") ?? null;
  return regionResponse({ country, zone, gpc: headers.get("sec-gpc") === "1" });
}

/** `GET /api/region`: the region as JSON, never cached by anyone. `?tz=` carries the browser's time zone. */
export function regionHandler(request: Request): Response {
  let zone: string | undefined;
  try {
    const tz = new URL(request.url).searchParams.get("tz");
    zone = tz !== null && /^[A-Za-z0-9_+/-]{1,64}$/u.test(tz) ? tz : undefined;
  } catch {
    zone = undefined;
  }
  return new Response(JSON.stringify(regionOf(request, zone)), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", vary: "*" },
  });
}

/** A script for the page's `<head>` that sets `window.__hranessRegion`, so the browser never waits on a fetch. */
export function regionScript(region: RegionResponse): string {
  return `window.__hranessRegion=${JSON.stringify(region).replace(/</gu, "\\u003c")};`;
}

// --- Capture ---------------------------------------------------------------------------------------------------

export type ServerConfig = Readonly<{
  /** The project's public token. Empty or missing: nothing is sent. */
  token: string | undefined;
  siteId: string;
  /** Namespaces event UUIDs and install hashes so two products never collide. Default `siteId`. */
  namespace?: string;
  host?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}>;

export type Capture = Readonly<{
  event: string;
  distinctId: string;
  props?: Props;
  /** Names the logical event: a redelivery with the same key is the same PostHog event. Default: random. */
  key?: string;
  /** Unix seconds. Default now. */
  at?: number;
  /** Whether the event may create or update a person. Default false. */
  person?: boolean;
  surface?: string;
  /** Person properties to set once (`$set_once`), only when `person` is true. */
  setOnce?: Props;
  set?: Props;
}>;

export const CAPTURE_PATH = "/i/v0/e/";

/** The PostHog capture body for one event. */
export async function captureBody(config: ServerConfig, input: Capture): Promise<Record<string, unknown>> {
  const namespace = config.namespace ?? config.siteId;
  const key = input.key ?? crypto.randomUUID();
  const uuid = await uuidV5(`${namespace}\0${key}`);
  const person = input.person === true;
  return {
    api_key: config.token,
    uuid,
    event: input.event,
    distinct_id: input.distinctId,
    timestamp: new Date((input.at ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    properties: {
      ...input.props,
      site_id: config.siteId,
      surface: input.surface ?? "server",
      schema: SCHEMA,
      $process_person_profile: person,
      $geoip_disable: true,
      $ip: null,
      $insert_id: uuid,
      ...(person && input.setOnce !== undefined ? { $set_once: input.setOnce } : {}),
      ...(person && input.set !== undefined ? { $set: input.set } : {}),
    },
  };
}

/**
 * Sends one event after the response (`waitUntil`), with a deadline; a failure is silent. Pass a function to build
 * the event only when it will be sent: anything it throws is caught with the rest.
 */
export function capture(
  config: ServerConfig,
  input: Capture | Promise<Capture | undefined> | (() => Capture | Promise<Capture | undefined> | undefined),
  waitUntil?: (job: Promise<unknown>) => void,
): Promise<void> {
  if (config.token === undefined || config.token === "") {
    // A promise the caller already started must not reject unobserved.
    if (input instanceof Promise) input.catch(() => undefined);
    return Promise.resolve();
  }
  const send = config.fetch ?? fetch;
  return later(waitUntil, config.timeoutMs ?? 3000, async (signal) => {
    const event = await (typeof input === "function" ? input() : input);
    if (event === undefined) return;
    await send(`${(config.host ?? "https://us.i.posthog.com").replace(/\/$/u, "")}${CAPTURE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await captureBody(config, event)),
      signal,
    });
  });
}

/**
 * The distinct ID for a signed-in account: `acct_` and an HMAC of the account ID under a server secret. The browser's
 * `identify` and every billing event use it, so billing joins the person without PostHog ever seeing the account
 * ID or an email.
 */
export async function accountDistinctId(secret: string, account: string): Promise<string> {
  if (secret.length < 16) throw new Error("accountDistinctId needs a secret of at least 16 characters");
  return `acct_${(await hmacHex(secret, `account\0${account}`)).slice(0, 40)}`;
}

// --- Billing ---------------------------------------------------------------------------------------------------

/** Minor units as an amount and a lower-case currency. */
export function money(amount: unknown, currency: unknown): { amount?: number; currency?: string } {
  if (typeof currency !== "string" || !/^[a-z]{3}$/iu.test(currency)) return {};
  const code = currency.toLowerCase();
  const minor = count(amount);
  return { currency: code, ...(minor === undefined ? {} : { amount: minor / 10 ** decimalsOf(code) }) };
}

const plainId = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= 255 ? value : undefined);
/** A Stripe ID, given either as the ID or as the expanded object carrying it. */
const id = (value: unknown): string | undefined => plainId(value) ?? plainId(bag(value)?.id);
const interval = (value: unknown) => (value === "day" || value === "week" || value === "month" || value === "year" ? value : undefined);
function recurring(object: Bag): string | undefined {
  const items = bag(object.items)?.data;
  const first = Array.isArray(items) ? bag(items[0]) : undefined;
  const price = bag(first?.price) ?? bag(object.plan);
  return interval(bag(price?.recurring)?.interval ?? price?.interval);
}
const invoiceSubscription = (invoice: Bag) => id(invoice.subscription) ?? id(bag(bag(invoice.parent)?.subscription_details)?.subscription);
const invoiceMetadata = (invoice: Bag): Bag | undefined => bag(bag(bag(invoice.parent)?.subscription_details)?.metadata) ?? bag(bag(invoice.subscription_details)?.metadata);

/** What a Stripe object refers to, for the product to find the account that owns it. */
export type BillingRef = Readonly<{ kind: "subscription" | "payment" | "session" | "customer"; id: string }>;

export type BillingOptions = Readonly<{
  /**
   * The account ID that owns a Stripe object, or undefined for objects the product does not own (another product,
   * a deleted account). Only owned objects are reported.
   */
  resolve: (ref: BillingRef) => Promise<string | undefined>;
  /** Whether a completed Checkout Session is this product's. Default: every session. */
  accept?: (session: Bag) => boolean;
  /** A refund's invoice when the charge does not carry it (one Stripe API call), for refunds of subscriptions. */
  invoiceOf?: (charge: Bag) => Promise<Bag | undefined>;
}>;

export type BillingEvent = Readonly<{
  event: Extract<ServerEvent, "checkout completed" | "subscription started" | "subscription renewed" | "subscription canceled" | "payment failed" | "refund issued">;
  /** Names the logical event across Stripe's redeliveries and its two success events. */
  key: string;
  at: number;
  account: string;
  props: Props;
}>;

const metadataProps = (metadata: Bag | undefined): Props => {
  const ref = refLabel(metadata?.first_ref);
  const source = typeof metadata?.first_source === "string" && /^[a-z0-9._-]{1,60}$/u.test(metadata.first_source) ? metadata.first_source : undefined;
  const plan = typeof metadata?.plan === "string" && /^[a-z0-9._-]{1,40}$/u.test(metadata.plan) ? metadata.plan : undefined;
  const platform = typeof metadata?.platform === "string" && /^(mac|windows|linux|ios|web)$/u.test(metadata.platform) ? metadata.platform : undefined;
  return { first_ref: ref, first_source: source, plan, platform };
};

/** Maps a Stripe webhook event to the taxonomy, or undefined for anything else or anything not owned. */
export async function billingEvent(stripe: unknown, options: BillingOptions): Promise<BillingEvent | undefined> {
  const input = bag(stripe);
  const object = bag(bag(input?.data)?.object);
  const eventId = id(input?.id);
  const at = count(input?.created);
  if (input === undefined || object === undefined || eventId === undefined || at === undefined || typeof input.livemode !== "boolean") return undefined;
  const type = input.type;
  const previous = bag(bag(input.data)?.previous_attributes);
  const base: Props = { store: "stripe", livemode: input.livemode };
  let metadata = bag(object.metadata);
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    if (object.payment_status !== "paid" && object.payment_status !== "no_payment_required") return undefined;
    if (options.accept && !options.accept(object)) return undefined;
    const subscription = object.mode === "subscription";
    const external = subscription ? id(object.subscription) : id(object.payment_intent) ?? id(object.id);
    if (external === undefined) return undefined;
    const account = await options.resolve({ kind: subscription ? "subscription" : "payment", id: external });
    if (account === undefined) return undefined;
    const event = subscription ? "subscription started" : "checkout completed";
    return {
      event,
      key: `${event}:${external}`,
      at,
      account,
      props: { ...base, ...metadataProps(metadata), ...money(object.amount_total, object.currency), ...(subscription ? { interval: interval(metadata?.interval) ?? "month" } : {}) },
    };
  }
  if (type === "invoice.paid" || type === "invoice.payment_failed") {
    const subscription = invoiceSubscription(object);
    if (subscription === undefined) return undefined;
    const account = await options.resolve({ kind: "subscription", id: subscription });
    if (account === undefined) return undefined;
    metadata = invoiceMetadata(object) ?? metadata;
    const lines = bag(object.lines)?.data;
    const every = Array.isArray(lines) ? interval(bag(bag(bag(lines[0])?.price)?.recurring)?.interval ?? bag(bag(bag(lines[0])?.pricing)?.price_details)?.interval) : undefined;
    if (type === "invoice.paid") {
      const invoice = id(object.id);
      if (object.billing_reason !== "subscription_cycle" || invoice === undefined) return undefined;
      return {
        event: "subscription renewed",
        key: `subscription renewed:${invoice}`,
        at: count(bag(object.status_transitions)?.paid_at) ?? at,
        account,
        props: { ...base, ...metadataProps(metadata), interval: every, ...money(object.amount_paid, object.currency) },
      };
    }
    return { event: "payment failed", key: eventId, at, account, props: { ...base, ...metadataProps(metadata), interval: every, ...money(object.amount_due, object.currency) } };
  }
  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const cancelAt = count(object.cancel_at);
    const scheduled = object.cancel_at_period_end === true || (cancelAt !== undefined && cancelAt > at);
    const changed = previous !== undefined && ((object.cancel_at_period_end === true && previous.cancel_at_period_end === false)
      || (cancelAt !== undefined && Object.hasOwn(previous, "cancel_at") && previous.cancel_at !== cancelAt));
    if (type !== "customer.subscription.deleted" && !(scheduled && changed)) return undefined;
    const subscription = id(object.id);
    if (subscription === undefined) return undefined;
    const account = await options.resolve({ kind: "subscription", id: subscription });
    if (account === undefined) return undefined;
    const items = bag(object.items)?.data;
    const ends = [object.current_period_end, ...(Array.isArray(items) ? items.map((item) => bag(item)?.current_period_end) : [])].map(count);
    const atPeriodEnd = object.cancel_at_period_end === true || (cancelAt !== undefined && ends.includes(cancelAt));
    // canceled_at is the request time even when the subscription ends later: count that cancellation once.
    const time = count(object.canceled_at) ?? at;
    return {
      event: "subscription canceled",
      key: `subscription canceled:${subscription}:${String(time)}`,
      at: time,
      account,
      props: { ...base, ...metadataProps(metadata), interval: recurring(object), at_period_end: atPeriodEnd },
    };
  }
  if (type === "charge.refunded") {
    let account: string | undefined;
    const payment = id(object.payment_intent);
    if (payment !== undefined) account = await options.resolve({ kind: "payment", id: payment });
    if (account === undefined) {
      const invoice = bag(object.invoice) ?? (await options.invoiceOf?.(object));
      const subscription = invoice === undefined ? undefined : invoiceSubscription(invoice);
      if (subscription !== undefined) account = await options.resolve({ kind: "subscription", id: subscription });
      if (invoice !== undefined) metadata = invoiceMetadata(invoice) ?? metadata;
    }
    if (account === undefined) return undefined;
    const total = count(object.amount_refunded);
    const before = count(previous?.amount_refunded);
    const refunds = bag(object.refunds)?.data;
    // amount_refunded is cumulative; a partial refund is the difference.
    const amount = total !== undefined && before !== undefined && total >= before ? total - before
      : Array.isArray(refunds) && refunds.length === 1 ? count(bag(refunds[0])?.amount) : total;
    return { event: "refund issued", key: eventId, at, account, props: { ...base, ...metadataProps(metadata), ...money(amount, object.currency), full: object.refunded === true } };
  }
  return undefined;
}

/**
 * Reports a Stripe webhook event after the response, under the account's distinct ID, so revenue joins the person
 * the browser identified.
 */
export function captureBilling(config: ServerConfig & Readonly<{ secret: string }>, stripe: unknown, options: BillingOptions, waitUntil?: (job: Promise<unknown>) => void): Promise<void> {
  return capture(config, async () => {
    const mapped = await billingEvent(stripe, options);
    if (mapped === undefined) return undefined;
    return { event: mapped.event, key: mapped.key, at: mapped.at, distinctId: await accountDistinctId(config.secret, mapped.account), props: mapped.props, person: true };
  }, waitUntil);
}

/** Checkout Session metadata that carries the first-touch labels to the webhook (`first_ref`, `first_source`, `plan`). */
export function checkoutMetadata(input: Readonly<{ firstRef?: unknown; firstSource?: unknown; plan?: string; platform?: string; interval?: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  const ref = refLabel(input.firstRef);
  if (ref !== undefined) out["metadata[first_ref]"] = ref;
  if (typeof input.firstSource === "string" && /^[a-z0-9._-]{1,60}$/u.test(input.firstSource)) out["metadata[first_source]"] = input.firstSource;
  if (input.plan !== undefined && /^[a-z0-9._-]{1,40}$/u.test(input.plan)) out["metadata[plan]"] = input.plan;
  if (input.platform !== undefined && /^(mac|windows|linux|ios|web)$/u.test(input.platform)) out["metadata[platform]"] = input.platform;
  if (interval(input.interval) !== undefined) out["metadata[interval]"] = input.interval ?? "";
  return out;
}

// --- App and CLI wire format (v1) --------------------------------------------------------------------------------

/** The top-level keys an app or CLI event may have. Anything else rejects the whole event. */
export const WIRE_FIELDS: ReadonlySet<string> = new Set(["v", "event", "install", "id", "at", "app", "build", "os", "region", "props"]);

/** An allowed property: a closed list of values, or a checker. */
export type PropRule = readonly string[] | ((value: string) => boolean);
export type WireEvents = Readonly<Record<string, Readonly<Record<string, PropRule>>>>;

const label = (value: string) => /^[a-z0-9._-]{1,40}$/u.test(value);
const PLATFORMS = ["mac", "windows", "linux", "ios", "web"] as const;
/** Properties any event may carry, added by the Swift package and the CLI helper. */
export const COMMON_PROPS: Readonly<Record<string, PropRule>> = {
  region_group: Object.keys(REGION_TABLE),
  surface: ["mac", "ios", "cli", "mcp", "extension", "web_app"],
  platform: PLATFORMS,
  ci: ["true", "false"],
};
/** The shared lifecycle events every product accepts. */
export const LIFECYCLE_WIRE: WireEvents = {
  "app installed": { channel: ["direct", "app_store", "npm", "brew"], ref: (value) => refLabel(value) === value, visit: (value) => UUID.test(value) },
  "app opened": { days_since_install_bucket: ["0", "1", "2-6", "7-29", "30+"] },
  "cli command run": { command: label, ok: ["true", "false"], duration_bucket: ["<1s", "1-5s", "5-30s", "30s+"] },
  "mcp tool called": { tool: label, client: ["claude", "cursor", "codex", "other"], ok: ["true", "false"] },
};

export type WireEvent = Readonly<{
  event: string;
  install: string;
  id: string;
  at: number;
  app: string;
  build: number;
  os: string;
  region: "ask" | "default";
  props: Readonly<Record<string, string>>;
}>;

const allows = (rule: PropRule | undefined, value: string) => (rule === undefined ? false : typeof rule === "function" ? rule(value) : rule.includes(value));

/** The event as sent, or undefined when any part is not exactly what the clients send. `events` adds the product's own. */
export function parseWireEvent(value: unknown, events: WireEvents = {}, now = Math.floor(Date.now() / 1000)): WireEvent | undefined {
  const input = bag(value);
  if (input === undefined || input.v !== 1 || Object.keys(input).some((key) => !WIRE_FIELDS.has(key))) return undefined;
  const name = input.event;
  if (typeof name !== "string") return undefined;
  const allowed = Object.hasOwn(events, name) ? events[name] : Object.hasOwn(LIFECYCLE_WIRE, name) ? LIFECYCLE_WIRE[name] : undefined;
  if (allowed === undefined) return undefined;
  if (typeof input.install !== "string" || !UUID.test(input.install) || typeof input.id !== "string" || !UUID.test(input.id)) return undefined;
  if (typeof input.app !== "string" || !/^\d{1,4}(\.\d{1,4}){0,3}$/u.test(input.app)) return undefined;
  if (typeof input.build !== "number" || !Number.isSafeInteger(input.build) || input.build < 0 || input.build > 10_000_000) return undefined;
  if (typeof input.os !== "string" || !/^\d{1,3}\.\d{1,3}$/u.test(input.os)) return undefined;
  if (input.region !== "ask" && input.region !== "default") return undefined;
  const raw = input.props ?? {};
  const bagged = bag(raw);
  if (bagged === undefined) return undefined;
  const props: Record<string, string> = {};
  for (const [key, item] of Object.entries(bagged)) {
    if (typeof item !== "string") return undefined;
    const rule = Object.hasOwn(allowed, key) ? allowed[key] : COMMON_PROPS[key];
    if (!allows(rule, item)) {
      // An MCP client this version does not know yet is left out; the event still counts.
      if (key === "client" && rule !== undefined) continue;
      return undefined;
    }
    props[key] = item;
  }
  // A clock that is off, or an event queued while offline: kept within a month, else now.
  const at = typeof input.at === "number" && Number.isSafeInteger(input.at) && input.at > now - 30 * 86400 && input.at < now + 600 ? input.at : now;
  return { event: name, install: input.install.toLowerCase(), id: input.id.toLowerCase(), at, app: input.app, build: input.build, os: input.os, region: input.region, props };
}

/** The install's distinct ID: `<site>:install:<hash>`, never the install ID itself. */
export async function installDistinctId(config: Pick<ServerConfig, "siteId" | "namespace">, install: string): Promise<string> {
  return `${config.siteId}:install:${(await sha256Hex(`${config.namespace ?? config.siteId}\0install\0${install}`)).slice(0, 40)}`;
}

/** The capture for a parsed wire event. `once` names events counted once per install (redeliveries collapse). */
export async function wireCapture(config: ServerConfig, event: WireEvent, once: ReadonlySet<string> = new Set(["app installed"])): Promise<Capture> {
  const { surface, ...props } = event.props;
  return {
    event: event.event,
    distinctId: await installDistinctId(config, event.install),
    key: once.has(event.event) ? `app\0${event.event}\0${event.install}` : `app\0${event.event}\0${event.install}\0${event.id}`,
    at: event.at,
    surface: surface ?? "mac",
    props: {
      ...Object.fromEntries(Object.entries(props).map(([key, value]) => [key, value === "true" ? true : value === "false" ? false : value])),
      identity_scope: "install",
      app_version: event.app,
      app_build: event.build,
      os_version: event.os,
      consent_region: event.region,
    },
  };
}

const WIRE_LIMIT = 16_384;

/** The body as text, or undefined once it passes `limit` bytes (read in chunks, whatever `content-length` says). */
async function readCapped(request: Request, limit: number): Promise<string | undefined> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** `POST /api/app/event` or `/api/cli/event`: parse, capture after the response, and answer 204 either way. */
export async function wireHandler(config: ServerConfig, request: Request, events: WireEvents = {}, waitUntil?: (job: Promise<unknown>) => void): Promise<Response> {
  const empty = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > WIRE_LIMIT) return new Response(null, { status: 413 });
  let body: unknown;
  try {
    const text = await readCapped(request, WIRE_LIMIT);
    if (text === undefined) return new Response(null, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const list = Array.isArray(body) ? body.slice(0, 20) : [body];
  // A bad event is dropped on its own; the batch fails only when nothing in it is good.
  const parsed = list.map((item) => parseWireEvent(item, events)).filter((item) => item !== undefined);
  if (parsed.length === 0) return new Response(null, { status: 400 });
  for (const event of parsed) void capture(config, () => wireCapture(config, event), waitUntil);
  return empty();
}

// --- Downloads and erasure -------------------------------------------------------------------------------------

/** `download served`, from the server that served the file, under an anonymous one-off distinct ID. */
export function downloadServed(
  config: ServerConfig,
  input: Readonly<{ platform: "mac" | "windows" | "linux" | "ios" | "web"; artifact: "zip" | "dmg" | "pkg" | "script"; version?: string; ref?: unknown; visit?: unknown }>,
  waitUntil?: (job: Promise<unknown>) => void,
): Promise<void> {
  const ref = refLabel(input.ref);
  const visit = typeof input.visit === "string" && UUID.test(input.visit) ? input.visit.toLowerCase() : undefined;
  const version = input.version !== undefined && /^[0-9A-Za-z.+-]{1,40}$/u.test(input.version) ? input.version : undefined;
  return capture(config, {
    event: "download served",
    distinctId: visit ?? `download:${crypto.randomUUID()}`,
    props: { platform: input.platform, artifact: input.artifact, version, ref },
  }, waitUntil);
}

export type ErasureConfig = Readonly<{ personalApiKey: string; projectId: string | number; host?: string; fetch?: typeof fetch }>;

/** Deletes the person behind a distinct ID and their events. Returns whether PostHog confirmed it (true when none existed). */
export async function deletePerson(config: ErasureConfig, distinctId: string): Promise<boolean> {
  const send = config.fetch ?? fetch;
  const host = (config.host ?? "https://us.posthog.com").replace(/\/$/u, "");
  const headers = { authorization: `Bearer ${config.personalApiKey}` };
  const base = `${host}/api/projects/${encodeURIComponent(String(config.projectId))}/persons`;
  const found = await send(`${base}/?distinct_id=${encodeURIComponent(distinctId)}`, { headers });
  if (!found.ok) return false;
  const results = bag(await found.json())?.results;
  const people = Array.isArray(results) ? results.map((item) => id(bag(item)?.uuid)).filter((item) => item !== undefined) : [];
  for (const person of people) {
    const removed = await send(`${base}/${encodeURIComponent(person)}/?delete_events=true`, { method: "DELETE", headers });
    if (!removed.ok && removed.status !== 404) return false;
  }
  return true;
}

export type { RegionGroup, RegionResponse };
