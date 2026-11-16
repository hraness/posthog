/**
 * Arrival attribution and event cleaning: launch tags (`?ref=`), channels, the first-touch set, address-bar
 * tidying and the recursive property cleaner. Pure, with no browser or provider import, so the browser, the edge and
 * a server that counts a page view all use the same words. `snapshotArrival` alone reads the page, and only when called.
 */

/** UTM parameters, in the order they are read. */
export const CAMPAIGNS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
/** Launch tags. `ref` wins where both are present. */
export const REFS = ["ref", "via"] as const;
/** Ad click identifiers. Their presence is recorded (`first_click_kind`); the value goes only to the Meta adapter. */
export const CLICK_IDS = ["gclid", "fbclid", "msclkid"] as const;
/** What leaves the address bar once the first page view has read it. Content parameters (`story`, `ad`) stay. */
export const TRACKING = [...REFS, ...CAMPAIGNS, ...CLICK_IDS] as const;

export type Channel = "ai" | "community" | "search" | "social" | "paid" | "email" | "referral" | "direct" | "campaign";

const LABEL = /^[a-z0-9._-]+$/u;
/** A bounded campaign label (lower case letters, digits, `.`, `_`, `-`, at most 60), never an email, URL or text. */
export function campaignLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim().toLowerCase();
  return label.length > 0 && LABEL.test(label) ? label.slice(0, 60) : undefined;
}
/** A launch tag: `^[a-z0-9._-]{1,40}$` after lower-casing; anything else is not a tag. */
export function refLabel(value: unknown): string | undefined {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9._-]{1,40}$/u.test(label) ? label : undefined;
}
/** The link's tag: `ref`, or `via` when there is no valid `ref`. */
export function refOf(search: string): string | undefined {
  const params = new URLSearchParams(search);
  return refLabel(params.get("ref")) ?? refLabel(params.get("via"));
}
/** The origin of a referring page (`https://news.ycombinator.com/`), never its path, which can name a private chat. */
export function referrerSite(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}/`;
  } catch {
    // Not an address: no referring site.
  }
  return "";
}
/** The referring host without `www.`, or "". */
export function referrerHost(value: unknown): string {
  const site = referrerSite(value);
  return site === "" ? "" : new URL(site).hostname.replace(/^www\./u, "");
}

const AI = /(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|anthropic\.com|gemini\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com|poe\.com|meta\.ai|grok\.com|deepseek\.com|chat\.deepseek\.com|mistral\.ai|chat\.mistral\.ai|kagi\.com)$/u;
const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.[a-z.]+|baidu\.com|yandex\.[a-z.]+|ecosia\.org|search\.brave\.com|startpage\.com|naver\.com|qwant\.com)$/u;
const SOCIAL = /(^|\.)(x\.com|t\.co|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|linkedin\.com|lnkd\.in|threads\.(net|com)|pinterest\.[a-z.]+|discord\.com|bsky\.app|mastodon\.social)$/u;
/** Discussion sites whose links are posts about the product, not a feed. A bare link from one lands here. */
const COMMUNITY = /(^|\.)(news\.ycombinator\.com|reddit\.com|producthunt\.com|forums\.macrumors\.com|lobste\.rs|indiehackers\.com)$/u;
const AI_NAMES = /^(chatgpt|openai|perplexity|claude|anthropic|gemini|copilot|grok|deepseek|mistral|meta\.?ai|you\.com|phind|poe)(\.|$)/u;
const SOCIAL_NAMES = /^(x|twitter|facebook|instagram|tiktok|youtube|linkedin|threads|pinterest|discord|bluesky|mastodon)(\.|$)/u;
const COMMUNITY_NAMES = /^(reddit|hackernews|hn|producthunt|macrumors|lobsters|indiehackers)(\.|$)/u;
const PAID_MEDIUM = /^(cpc|ppc|paid|paidsocial|paid_social|display|ads?)$/u;

/** What launch tags mean (`<venue>` or `<venue>-<post>`). A product may add venues through `ChannelOptions`. */
export const REF_CHANNELS: Readonly<Record<string, Channel>> = {
  hn: "community",
  producthunt: "community",
  macrumors: "community",
  obsidian: "community",
  cursor: "community",
  ih: "community",
  kvr: "community",
  gearspace: "community",
  lines: "community",
  lobsters: "community",
  console: "email",
  newsletter: "email",
  dir: "referral",
};

export type ChannelOptions = Readonly<{
  /** The product's own hosts: a referrer from these is not an arrival. Subdomains count too. */
  ownHosts?: readonly string[];
  /** Extra launch venues, merged over `REF_CHANNELS`. */
  refChannels?: Readonly<Record<string, Channel>>;
}>;

function refChannel(ref: string, extra: Readonly<Record<string, Channel>> | undefined): Channel | undefined {
  if (/^r-./u.test(ref)) return "community";
  const venues = { ...REF_CHANNELS, ...extra };
  for (const [venue, channel] of Object.entries(venues)) if (ref === venue || ref.startsWith(`${venue}-`)) return channel;
  return undefined;
}

/**
 * How a visit arrived. A paid label wins, then the launch tag, then the linking site and the UTM source. The
 * source is the UTM source, then the tag, then the referring host.
 */
export function channelOf(referrer: string, search: string, options: ChannelOptions = {}): { channel: Channel; source: string } {
  const params = new URLSearchParams(search);
  const label = campaignLabel(params.get("utm_source")) ?? "";
  const ref = refOf(search) ?? "";
  const medium = (params.get("utm_medium") ?? "").toLowerCase();
  let host = referrerHost(referrer);
  const own = options.ownHosts ?? [];
  if (own.some((name) => host === name || host.endsWith(`.${name}`))) host = "";
  const source = label || ref || host;
  if (PAID_MEDIUM.test(medium) || params.has("gclid") || params.has("msclkid")) return { channel: "paid", source };
  const tagged = ref ? refChannel(ref, options.refChannels) : undefined;
  if (tagged) return { channel: tagged, source };
  if (AI.test(host) || AI_NAMES.test(label)) return { channel: "ai", source };
  if (SEARCH.test(host)) return { channel: "search", source };
  if (COMMUNITY.test(host) || COMMUNITY_NAMES.test(label)) return { channel: "community", source };
  if (SOCIAL.test(host) || SOCIAL_NAMES.test(label)) return { channel: "social", source };
  if (ref || label) return { channel: "campaign", source };
  if (host) return { channel: "referral", source };
  return { channel: "direct", source: "" };
}

/** The address without its tracking parameters (path, query and fragment), or null when there were none. */
export function withoutTracking(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  let changed = false;
  for (const name of TRACKING) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  // A path that starts with "//" would read as another host in history.replaceState.
  return changed ? url.pathname.replace(/^\/{2,}/u, "/") + url.search + url.hash : null;
}

/**
 * A same-origin link with the visit's tag carried forward, for a visit that keeps nothing on the device. Null when
 * unchanged: another origin, a file download, a link with its own tag, or a jump within the page.
 */
export function carryRef(href: string, ref: string | undefined, here: string, skipPrefixes: readonly string[] = ["/downloads/"]): string | null {
  if (ref === undefined || refLabel(ref) !== ref) return null;
  let url: URL;
  let from: URL;
  try {
    url = new URL(href, here);
    from = new URL(here);
  } catch {
    return null;
  }
  if (url.origin !== from.origin) return null;
  if (skipPrefixes.some((prefix) => url.pathname.startsWith(prefix))) return null;
  if (url.searchParams.has("ref") || url.searchParams.has("via")) return null;
  if (url.pathname === from.pathname && url.search === from.search && url.hash) return null;
  url.searchParams.set("ref", ref);
  return url.href;
}

/** Calls `then` once, when the first `$pageview` has been built. Never before: it must read the address first. */
export function afterFirstPageview(then: () => void): (event: string | undefined) => void {
  let done = false;
  return (event) => {
    if (done || event !== "$pageview") return;
    done = true;
    then();
  };
}

/** The safe facts of an arrival, read before anything rewrites the address. */
export type Arrival = Readonly<{
  path: string;
  /** Only valid campaign labels and tags, as a query string without `?`. `gclid`/`msclkid` only as presence. */
  search: string;
  referrer: string;
  /** Meta's click id, held for the Meta adapter only; never sent to PostHog. */
  fbclid?: string;
  /** Content labels the product names (`story`, `ad`), validated as campaign labels. */
  content: Readonly<Record<string, string>>;
}>;

/**
 * The safe facts of an arrival. With `routes`, a path that matches one (a private or parameterised page) is kept as
 * its pattern, so `first_landing` never names an item.
 */
export function arrivalOf(path: string, search: string, referrer: string, contentParams: readonly string[] = [], routes: readonly RoutePattern[] = []): Arrival {
  const input = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const name of CAMPAIGNS) {
    const value = campaignLabel(input.get(name));
    if (value !== undefined) kept.set(name, value);
  }
  for (const name of REFS) {
    const value = refLabel(input.get(name));
    if (value !== undefined) kept.set(name, value);
  }
  for (const name of ["gclid", "msclkid"]) if (input.has(name)) kept.set(name, "");
  const fbclid = input.get("fbclid");
  const content: Record<string, string> = {};
  for (const name of contentParams) {
    const value = campaignLabel(input.get(name));
    if (value !== undefined) content[name] = value;
  }
  return {
    path: routePattern(path.split(/[?#]/u, 1)[0] || "/", routes),
    search: kept.toString(),
    referrer: referrerSite(referrer),
    ...(fbclid !== null && /^[\w-]{1,400}$/u.test(fbclid) ? { fbclid } : {}),
    content,
  };
}

/** The address a visit arrived at, as the page first saw it: before a router or the client rewrote it. */
export type ArrivalSnapshot = Readonly<{ path: string; search: string; referrer: string }>;

/** Where the snapshot is held for the page's lifetime. */
export const ARRIVAL_GLOBAL = "__hranessArrival";

/**
 * An inline `<head>` script that takes the snapshot before any other script runs. The same as calling
 * `snapshotArrival()` from the page's first module.
 */
export const ARRIVAL_SCRIPT = `window.${ARRIVAL_GLOBAL}=window.${ARRIVAL_GLOBAL}||{path:location.pathname,search:location.search,referrer:document.referrer};`;

/** A held snapshot parsed from `unknown`, or undefined. */
export function parseArrivalSnapshot(value: unknown): ArrivalSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { path, search, referrer } = value as Record<string, unknown>;
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 2048) return undefined;
  if (typeof search !== "string" || (search !== "" && !search.startsWith("?")) || search.length > 4096) return undefined;
  if (typeof referrer !== "string" || referrer.length > 4096) return undefined;
  return { path, search, referrer };
}

/**
 * Takes the arrival snapshot once per page and returns it: the landing path, query (UTMs, launch tags) and referrer,
 * read synchronously. Call it (or inline `ARRIVAL_SCRIPT`) at load, and `createAnalytics` can then be imported later,
 * after the router has rewritten the address, without losing how the visit arrived. Undefined outside a browser.
 */
export function snapshotArrival(): ArrivalSnapshot | undefined {
  const scope = globalThis as typeof globalThis & { [ARRIVAL_GLOBAL]?: unknown };
  const held = parseArrivalSnapshot(scope[ARRIVAL_GLOBAL]);
  if (held !== undefined) return held;
  if (typeof location === "undefined" || typeof document === "undefined") return undefined;
  let made: ArrivalSnapshot;
  try {
    made = { path: location.pathname, search: location.search, referrer: document.referrer };
  } catch {
    return undefined;
  }
  const parsed = parseArrivalSnapshot(made);
  if (parsed === undefined) return undefined;
  try {
    scope[ARRIVAL_GLOBAL] = parsed;
  } catch {
    // A frozen global: the snapshot still serves this call.
  }
  return parsed;
}

/** Which ad click brought the visit, by presence only. */
export function clickKind(search: string, fbclid?: string): "gclid" | "fbclid" | "msclkid" | "none" {
  const params = new URLSearchParams(search);
  if (params.has("gclid")) return "gclid";
  if (fbclid !== undefined || params.has("fbclid")) return "fbclid";
  if (params.has("msclkid")) return "msclkid";
  return "none";
}

const day = (now: Date) => now.toISOString().slice(0, 10);
/** The ISO Monday of `now`'s week, `2026-11-16`. */
export function mondayOf(now: Date): string {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
  return day(at);
}

/** The first-touch record a remembered visitor keeps, and how many days they have come back. */
export type FirstTouch = {
  channel: Channel;
  source: string;
  medium?: string | undefined;
  campaign?: string | undefined;
  content?: string | undefined;
  landing: string;
  landingKind?: string | undefined;
  referrerHost?: string | undefined;
  clickKind: "gclid" | "fbclid" | "msclkid" | "none";
  week: string;
  surface?: string | undefined;
  /** The first launch tag seen, on whichever visit that was. */
  ref?: string | undefined;
  /** The latest launch tag. */
  lastRef?: string | undefined;
  /** Content labels from the landing (`first_story`, `first_ad`). */
  labels?: Readonly<Record<string, string>> | undefined;
  days: number;
  last: string;
};

export type TouchContext = Readonly<{ surface?: string; landingKind?: string; channel?: ChannelOptions }>;

/** The record after this visit: the first arrival stands, a new tag replaces only the latest, a new day counts once. */
export function remember(before: FirstTouch | undefined, now: Date, arrival: Arrival, context: TouchContext = {}): FirstTouch {
  const ref = refOf(arrival.search);
  if (before === undefined) {
    const params = new URLSearchParams(arrival.search);
    const { channel, source } = channelOf(arrival.referrer, arrival.search, context.channel);
    const host = referrerHost(arrival.referrer);
    return {
      channel,
      source,
      medium: campaignLabel(params.get("utm_medium")),
      campaign: campaignLabel(params.get("utm_campaign")),
      content: campaignLabel(params.get("utm_content")),
      landing: arrival.path,
      landingKind: context.landingKind,
      referrerHost: host === "" ? undefined : host,
      clickKind: clickKind(arrival.search, arrival.fbclid),
      week: mondayOf(now),
      surface: context.surface,
      ref,
      lastRef: ref,
      labels: { ...arrival.content },
      days: 1,
      last: day(now),
    };
  }
  const refs = ref === undefined ? {} : { ref: refLabel(before.ref) ?? ref, lastRef: ref };
  if (before.last === day(now)) return { ...before, ...refs };
  return { ...before, ...refs, days: before.days + 1, last: day(now) };
}

/** Parses a stored first-touch record from `unknown`, keeping only valid labels. */
export function parseFirstTouch(value: unknown): FirstTouch | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const channels: readonly Channel[] = ["ai", "community", "search", "social", "paid", "email", "referral", "direct", "campaign"];
  const channel = channels.find((name) => name === record.channel);
  const days = record.days;
  if (channel === undefined || typeof record.landing !== "string" || typeof record.week !== "string"
    || typeof record.last !== "string" || typeof days !== "number" || !Number.isSafeInteger(days) || days < 1) return undefined;
  const kinds = ["gclid", "fbclid", "msclkid", "none"] as const;
  const labels: Record<string, string> = {};
  if (typeof record.labels === "object" && record.labels !== null) {
    for (const [key, label] of Object.entries(record.labels as Record<string, unknown>)) {
      const safe = campaignLabel(label);
      if (/^[a-z][a-z0-9_]{0,30}$/u.test(key) && safe !== undefined) labels[key] = safe;
    }
  }
  const host = typeof record.referrerHost === "string" && /^[a-z0-9.-]{1,253}$/u.test(record.referrerHost) ? record.referrerHost : undefined;
  return {
    channel,
    source: campaignLabel(record.source) ?? referrerHostLabel(record.source),
    medium: campaignLabel(record.medium),
    campaign: campaignLabel(record.campaign),
    content: campaignLabel(record.content),
    landing: record.landing.slice(0, 200),
    landingKind: campaignLabel(record.landingKind),
    referrerHost: host,
    clickKind: kinds.find((kind) => kind === record.clickKind) ?? "none",
    week: /^\d{4}-\d{2}-\d{2}$/u.test(record.week) ? record.week : "",
    surface: campaignLabel(record.surface),
    ref: refLabel(record.ref),
    lastRef: refLabel(record.lastRef),
    labels,
    days,
    last: record.last.slice(0, 10),
  };
}
const referrerHostLabel = (value: unknown) => (typeof value === "string" && /^[a-z0-9.-]{1,253}$/u.test(value) ? value : "");

export type FirstTouchProps = Record<string, string | number | boolean | undefined>;

/** The first-touch set as event and person properties (`first_channel`, `first_ref`, ...). */
export function firstTouchProps(touch: FirstTouch): FirstTouchProps {
  const props: FirstTouchProps = {
    first_channel: touch.channel,
    first_source: touch.source === "" ? undefined : touch.source.slice(0, 60),
    first_medium: touch.medium,
    first_campaign: touch.campaign,
    first_content: touch.content,
    first_ref: refLabel(touch.ref),
    last_ref: refLabel(touch.lastRef),
    first_landing: touch.landing,
    first_landing_kind: touch.landingKind,
    first_referrer_host: touch.referrerHost,
    first_click_kind: touch.clickKind,
    first_week: touch.week,
    first_surface: touch.surface,
    active_days: touch.days,
    returning: touch.days > 1,
  };
  for (const [name, value] of Object.entries(touch.labels ?? {})) props[`first_${name}`] = value;
  return props;
}

/** The landing event's own labels: `channel`, `ref`, `utm_*` and content labels from this arrival. */
export function arrivalProps(arrival: Arrival, options: ChannelOptions = {}): FirstTouchProps {
  const params = new URLSearchParams(arrival.search);
  const props: FirstTouchProps = { channel: channelOf(arrival.referrer, arrival.search, options).channel, ref: refOf(arrival.search) };
  for (const name of CAMPAIGNS) props[name] = params.get(name) ?? undefined;
  for (const [name, value] of Object.entries(arrival.content)) props[name] = value;
  return props;
}

// --- Cleaning -------------------------------------------------------------------------------------------------

/** A route pattern such as `/@:handle/:slug` or `/library/*`. `:name` matches one segment, `*` the rest. */
export type RoutePattern = string;

/** The first pattern a path matches, or undefined when none does. A literal pattern (`/account`) matches itself. */
export function matchRoute(path: string, patterns: readonly RoutePattern[]): RoutePattern | undefined {
  const segments = path.split("/").filter(Boolean);
  for (const pattern of patterns) {
    const parts = pattern.split("/").filter(Boolean);
    let matched = true;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      if (part === "*") return pattern;
      const segment = segments[index];
      if (segment === undefined) { matched = false; break; }
      if (part.includes(":")) {
        const [prefix = ""] = part.split(":", 1);
        if (!segment.startsWith(prefix)) { matched = false; break; }
        continue;
      }
      if (part !== segment) { matched = false; break; }
    }
    if (matched && parts.length === segments.length) return pattern;
  }
  return undefined;
}

/** The pattern a path matches, or the path itself when none does. */
export function routePattern(path: string, patterns: readonly RoutePattern[]): string {
  return matchRoute(path, patterns) ?? path;
}

export type CleanOptions = Readonly<{
  /** Route patterns for private or parameterised paths; a matching path is replaced by its pattern. */
  routes?: readonly RoutePattern[];
  /**
   * Custom (non-`$`) property keys allowed through. When set, any other non-`$` key is dropped. PostHog's own `$`
   * properties are always kept and cleaned.
   */
  allowProps?: readonly string[];
}>;

/** A link with only safe campaign labels and tags kept in its query, nothing after `#`, and its path as a pattern. */
export function cleanUrl(value: string, routes: readonly RoutePattern[] = []): string {
  const cut = value.indexOf("#");
  const whole = cut < 0 ? value : value.slice(0, cut);
  const at = whole.indexOf("?");
  let base = at < 0 ? whole : whole.slice(0, at);
  if (routes.length > 0) {
    const match = /^(https?:\/\/[^/]+)?(\/[^?]*)?$/u.exec(base);
    if (match) base = (match[1] ?? "") + routePattern(match[2] ?? "/", routes);
  }
  if (at < 0) return base;
  const input = new URLSearchParams(whole.slice(at + 1));
  const kept = new URLSearchParams();
  for (const name of CAMPAIGNS) {
    const label = campaignLabel(input.get(name));
    if (label !== undefined) kept.set(name, label);
  }
  for (const name of REFS) {
    const label = refLabel(input.get(name));
    if (label !== undefined) kept.set(name, label);
  }
  const search = kept.toString();
  return base + (search ? `?${search}` : "");
}

/** Text with each address in it cleaned, and any `data:` or `blob:` value (a picture) cut to its scheme. */
export function cleanText(value: string, routes: readonly RoutePattern[] = []): string {
  return value
    .replace(/\b(data|blob):[^\s"')]+/giu, "$1:")
    .replace(/https?:\/\/[^\s"')]+/giu, (url) => cleanUrl(url, routes));
}

const LINKISH = /url|referrer|href|pathname/iu;
const CAMPAIGN_FIELD = /^(?:\$(?:initial_|session_entry_)?)?utm_(source|medium|campaign|term|content)$/iu;
const REF_FIELD = /^(?:(?:\$(?:initial_|session_entry_)?)?(?:ref|via)|(?:first|last)_ref)$/iu;
const CLICK_FIELD = /^(?:\$(?:initial_|session_entry_)?)?(gclid|gclsrc|dclid|fbclid|msclkid|twclid|ttclid|li_fat_id|igshid|wbraid|gbraid|gad_source|mc_cid|mc_eid)$/iu;
const EMAIL = /[^\s@<>()"',;:]{1,64}@[^\s@<>()"',;:]{1,255}\.[a-z]{2,}/giu;

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** An autocapture chain with each `href` cleaned like an address (relative ones too) and emails cut. */
function cleanChain(chain: string, routes: readonly RoutePattern[]): string {
  return cleanText(chain.replace(/((?:attr__)?href=")([^"]*)"/gu, (_whole, name: string, href: string) => `${name}${cleanUrl(href, routes)}"`), routes)
    .replace(EMAIL, "[email]");
}

function cleanValue(key: string, value: unknown, options: CleanOptions, depth: number): unknown {
  if (CLICK_FIELD.test(key)) return undefined;
  if (key === "first_source" || CAMPAIGN_FIELD.test(key)) return campaignLabel(value);
  if (REF_FIELD.test(key)) return refLabel(value);
  const routes = options.routes ?? [];
  if (typeof value === "string") {
    // A host (`first_referrer_host`) is already only a host; read as an address it would come out empty.
    if (/referrer_host$/iu.test(key)) return /^[a-z0-9.-]{1,253}$/u.test(value) ? value : referrerHost(value) || undefined;
    if (/referrer/iu.test(key)) return value === "$direct" ? value : referrerSite(value);
    if (key === "$elements_chain") return cleanChain(value, routes);
    const text = LINKISH.test(key) && !/\s/u.test(value)
      ? (key.toLowerCase().includes("pathname") ? routePattern(value, routes) : cleanText(cleanUrl(value, routes), routes))
      : cleanText(value, routes);
    return text.replace(EMAIL, "[email]");
  }
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value.map((item) => cleanValue(key, item, options, depth + 1));
  return plain(value) ? cleanBag(value, options, depth + 1, false) : value;
}

/**
 * A key as kept. Plain names pass; a key that is an address (PostHog keys `$heatmap_data` by the page URL) is cleaned
 * like `$current_url`, and any other key loses emails and addresses in it.
 */
function cleanKey(key: string, routes: readonly RoutePattern[]): string {
  if (/^[\w$.:-]*$/u.test(key)) return key;
  const text = /^(?:https?:\/\/|\/)\S*$/iu.test(key) ? cleanUrl(key, routes) : cleanText(key, routes);
  return text.replace(EMAIL, "[email]");
}

/** Two values whose keys cleaned to the same key: lists join, bags merge, otherwise the first stays. */
function mergeValues(first: unknown, second: unknown): unknown {
  if (Array.isArray(first) && Array.isArray(second)) return [...(first as unknown[]), ...(second as unknown[])];
  if (plain(first) && plain(second)) {
    const out: Record<string, unknown> = { ...first };
    for (const [key, value] of Object.entries(second)) out[key] = Object.hasOwn(out, key) ? mergeValues(out[key], value) : value;
    return out;
  }
  return first;
}

function cleanBag(props: Record<string, unknown>, options: CleanOptions, depth: number, top: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allow = options.allowProps === undefined ? undefined : new Set(options.allowProps);
  for (const [raw, value] of Object.entries(props)) {
    if (top && allow !== undefined && !raw.startsWith("$") && !allow.has(raw)) continue;
    const key = cleanKey(raw, options.routes ?? []);
    const cleaned = cleanValue(key, value, options, depth);
    if (cleaned === undefined) continue;
    out[key] = Object.hasOwn(out, key) ? mergeValues(out[key], cleaned) : cleaned;
  }
  return out;
}

/**
 * A whole event cleaned. `allowProps` applies to its `properties` only, so the event's own fields (`event`, `uuid`,
 * `timestamp`) always stay; everything else is cleaned as `cleanProps` cleans it.
 */
export function cleanEvent(event: Readonly<{ properties?: Record<string, unknown> }> & Readonly<Record<string, unknown>>, options: CleanOptions = {}): Record<string, unknown> & { properties: Record<string, unknown> } {
  const { properties, ...rest } = event;
  const fields = cleanBag(rest, options.routes === undefined ? {} : { routes: options.routes }, 0, false);
  return { ...fields, properties: cleanBag(properties ?? {}, options, 0, true) };
}

/** Every property at any depth cleaned: addresses, referrers, labels, click IDs and emails. */
export function cleanProps<T extends Record<string, unknown>>(props: T, options: CleanOptions = {}): Partial<T> {
  return cleanBag(props, options, 0, true) as Partial<T>;
}
