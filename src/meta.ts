/**
 * Meta's Pixel and Conversions API, gated by the region policy. The Pixel starts only when the policy allows ads
 * (`policy.ads`: never in Europe before a yes, never with Global Privacy Control) and sends only the events the
 * product names, only from an address with nothing private in it. The Conversions API helpers build the server's
 * copy of a browser event with the same event ID, so Meta counts it once, and hash an email the way Meta expects.
 */
import { bag, count, decimalsOf, later, sha256Hex, UUID, type Bag } from "./internal.ts";
import type { RegionPolicy } from "./policy.ts";

export const SCRIPT = "https://connect.facebook.net/en_US/fbevents.js";
export const GRAPH = "https://graph.facebook.com/v26.0";
/** How long `_fbp` and `_fbc` are kept, as Meta's own Pixel keeps them. */
export const COOKIE_DAYS = 90;

export type StandardEvent = "PageView" | "ViewContent" | "Lead" | "InitiateCheckout" | "CompleteRegistration" | "Subscribe" | "StartTrial" | "Purchase";

export const FBC = /^fb\.\d\.\d{10,16}\.[\w.-]{1,450}$/u;
export const FBP = /^fb\.\d\.\d{10,16}\.[\w.-]{1,64}$/u;

/** Meta's click ID as an ad link carries it (`fbclid=`); anything else is not one. */
export const clickId = (value: unknown): string | undefined => (typeof value === "string" && /^[\w-]{1,400}$/u.test(value) ? value : undefined);
/** The `_fbc` value Meta expects: `fb.1.<ms>.<fbclid>`. */
export const fbcFor = (fbclid: string, at: number) => `fb.1.${String(at)}.${fbclid}`;
/** A new `_fbp` value: `fb.1.<ms>.<random>`. */
export const fbpFor = (at: number, random: number) => `fb.1.${String(at)}.${String(Math.floor(random * 2 ** 31))}`;
const clickOf = (fbc: string | undefined) => fbc?.split(".").slice(3).join(".");

/** Whether the browser may talk to Meta: the policy allows ads and nothing has said no since. */
export function adsAllowed(input: Readonly<{ policy: RegionPolicy | undefined; gpc?: boolean; optedOut?: boolean }>): boolean {
  return input.policy?.ads === true && input.gpc !== true && input.optedOut !== true;
}

export const DEFAULT_KEPT = ["fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
/** Whether Meta may see this address: no `#` part and no query parameter but the kept ones (`check` vets values). */
export function safeAddress(href: string, kept: readonly string[] = DEFAULT_KEPT, check?: (name: string, value: string) => boolean): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (href.includes("#")) return false;
  for (const [key, value] of url.searchParams) {
    if (!kept.includes(key)) return false;
    if (check && !check(key, value)) return false;
  }
  return true;
}

export type PixelConfig = Readonly<{
  pixelId: string;
  /** Custom events (`trackCustom`), each sent at most once a day per browser. */
  customEvents?: readonly string[];
  /** Query parameters Meta may see besides click IDs and UTM labels. */
  keptParams?: readonly string[];
  keptCheck?: (name: string, value: string) => boolean;
  /** Storage key for the days custom events were last sent. */
  dayKey?: string;
  /** Whether the Pixel's own page view is sent on start. Default true. */
  pageView?: boolean;
}>;
export type AdIdentity = { fbp?: string; fbc?: string };
export type Pixel = {
  track(name: StandardEvent | (string & {}), params?: Record<string, string | number>, eventId?: string): void;
  identity(): AdIdentity;
  allowed(): boolean;
};

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push: unknown;
  loaded: boolean;
  version: string;
  disablePushState?: boolean;
  disableConfigLoading?: boolean;
};
export type Page = {
  document: Pick<Document, "cookie" | "createElement" | "head">;
  window: { fbq?: Fbq; _fbq?: Fbq };
  location: { href: string; hostname: string };
  now(): number;
  random(): number;
  storage?(): Pick<Storage, "getItem" | "setItem"> | undefined;
};

const readCookie = (page: Page, name: string) => {
  try {
    const part = page.document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
    return part === undefined ? undefined : decodeURIComponent(part.slice(name.length + 1));
  } catch {
    return undefined;
  }
};
const writeCookie = (page: Page, name: string, value: string) => {
  try {
    page.document.cookie = `${name}=${value}; max-age=${String(COOKIE_DAYS * 86400)}; path=/; domain=${page.location.hostname}; secure; samesite=lax`;
  } catch {
    // Blocked: the Pixel still counts this page.
  }
};

/** Meta's standard loader, written out so the page's policy needs no inline script. */
function stub(page: Page): Fbq {
  const existing = page.window.fbq;
  if (existing) return existing;
  const fbq = ((...args: unknown[]) => {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue.push(args);
  }) as Fbq;
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.queue = [];
  // Page views are the client's to send: an app rewriting its address is not a visit.
  fbq.disablePushState = true;
  // The remote configuration turns on automatic advanced matching, which reads form fields.
  fbq.disableConfigLoading = true;
  page.window.fbq = page.window._fbq = fbq;
  const script = page.document.createElement("script");
  script.async = true;
  script.fetchPriority = "low";
  script.src = SCRIPT;
  page.document.head.append(script);
  return fbq;
}

const eventIdFor = (page: Page) => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${String(page.now())}-${String(Math.floor(page.random() * 2 ** 31))}`;
  }
};

/**
 * Starts the Pixel: `_fbp`, `_fbc` from the ad click, Meta's script and the page view. `allowed` is asked before
 * every event, so a no in another tab stops this one too.
 */
export function startPixel(config: PixelConfig, page: Page, fbclid: string | undefined, allowed: () => boolean): Pixel {
  const at = page.now();
  if (!FBP.test(readCookie(page, "_fbp") ?? "")) writeCookie(page, "_fbp", fbpFor(at, page.random()));
  const click = clickId(fbclid);
  if (click !== undefined && clickOf(readCookie(page, "_fbc")) !== click) writeCookie(page, "_fbc", fbcFor(click, at));
  const fbq = stub(page);
  fbq("set", "autoConfig", false, config.pixelId);
  fbq("init", config.pixelId);
  const custom = new Set(config.customEvents ?? []);
  const kept = [...DEFAULT_KEPT, ...(config.keptParams ?? [])];
  const dayKey = config.dayKey ?? "hra-meta-days";
  const sentHere: Record<string, string> = {};
  const readDays = (): Record<string, string> => {
    try {
      const days: unknown = JSON.parse(page.storage?.()?.getItem(dayKey) ?? "{}");
      return bag(days) as Record<string, string> | undefined ?? {};
    } catch {
      return {};
    }
  };
  const pixel: Pixel = {
    allowed,
    track(name, params = {}, eventId) {
      if (!allowed() || !safeAddress(page.location.href, kept, config.keptCheck)) return;
      if (!custom.has(name)) {
        fbq("track", name, params, ...(eventId === undefined ? [] : [{ eventID: eventId }]));
        return;
      }
      const day = new Date(page.now()).toISOString().slice(0, 10);
      const days = readDays();
      if (days[name] === day || sentHere[name] === day) return;
      sentHere[name] = days[name] = day;
      try {
        page.storage?.()?.setItem(dayKey, JSON.stringify(days));
      } catch {
        // Blocked: this page still remembers.
      }
      fbq("trackCustom", name, params, { eventID: eventId ?? eventIdFor(page) });
    },
    identity() {
      const fbp = readCookie(page, "_fbp");
      const fbc = readCookie(page, "_fbc");
      return { ...(fbp !== undefined && FBP.test(fbp) ? { fbp } : {}), ...(fbc !== undefined && FBC.test(fbc) ? { fbc } : {}) };
    },
  };
  if (config.pageView !== false) pixel.track("PageView");
  return pixel;
}

/** The page itself, for `startPixel`. */
export const browserPage = (): Page => ({
  document,
  window: window as unknown as Page["window"],
  location,
  now: () => Date.now(),
  random: Math.random,
  storage: () => localStorage,
});

/**
 * Tracks an event in the browser and returns what the server needs to send its copy (`event_id`, `_fbp`, `_fbc`),
 * or undefined when ads are off.
 */
export function trackForServer(pixel: Pixel | undefined, name: StandardEvent | (string & {}), params: Record<string, string | number> = {}): Ads | undefined {
  if (pixel === undefined || !pixel.allowed()) return undefined;
  const eventId = crypto.randomUUID();
  pixel.track(name, params, eventId);
  return { event_id: eventId, ...pixel.identity() };
}

// --- Conversions API -------------------------------------------------------------------------------------------

/** What a consented browser hands the server (`trackForServer`), checked. */
export type Ads = { event_id: string; fbp?: string; fbc?: string };
export function readAds(value: unknown): Ads | undefined {
  const input = bag(value);
  if (input === undefined || typeof input.event_id !== "string" || !UUID.test(input.event_id)) return undefined;
  const fbp = typeof input.fbp === "string" && FBP.test(input.fbp) ? input.fbp : undefined;
  const fbc = typeof input.fbc === "string" && FBC.test(input.fbc) ? input.fbc : undefined;
  return { event_id: input.event_id.toLowerCase(), ...(fbp === undefined ? {} : { fbp }), ...(fbc === undefined ? {} : { fbc }) };
}
/** Checkout Session metadata that carries the consent and identifiers to the webhook. */
export function adsMetadata(ads: Ads): Record<string, string> {
  return { "metadata[meta]": "1", ...(ads.fbp === undefined ? {} : { "metadata[meta_fbp]": ads.fbp }), ...(ads.fbc === undefined ? {} : { "metadata[meta_fbc]": ads.fbc }) };
}
/** The identifiers back out of a webhook's metadata, or undefined when the browser never allowed ads. */
export function adsFromMetadata(metadata: unknown): Omit<Ads, "event_id"> | undefined {
  const input = bag(metadata);
  if (input?.meta !== "1") return undefined;
  const fbp = typeof input.meta_fbp === "string" && FBP.test(input.meta_fbp) ? input.meta_fbp : undefined;
  const fbc = typeof input.meta_fbc === "string" && FBC.test(input.meta_fbc) ? input.meta_fbc : undefined;
  return { ...(fbp === undefined ? {} : { fbp }), ...(fbc === undefined ? {} : { fbc }) };
}

/** Meta's normalization for `em`: trimmed and lower-cased, then SHA-256 in hex. */
export async function hashEmail(value: unknown): Promise<string | undefined> {
  if (typeof value !== "string") return undefined;
  const email = value.normalize("NFC").trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/u.test(email) && email.length <= 254 ? sha256Hex(email) : undefined;
}
/** A stable 32-hex event ID from a namespace and parts, so redeliveries count once. Never the parts themselves. */
export async function stableEventId(namespace: string, ...parts: readonly string[]): Promise<string> {
  return (await sha256Hex([namespace, ...parts].join("\0"))).slice(0, 32);
}

/** Minor units as Meta's `value` and `currency`. */
export function metaValue(amount: unknown, currency: unknown): { value?: number; currency?: string } {
  const minor = count(amount);
  if (typeof currency !== "string" || !/^[a-z]{3}$/iu.test(currency) || minor === undefined) return {};
  const code = currency.toLowerCase();
  return { value: minor / 10 ** decimalsOf(code), currency: code.toUpperCase() };
}

export type CapiEvent = {
  event_name: StandardEvent | (string & {});
  event_time: number;
  event_id: string;
  action_source: "website" | "app";
  event_source_url?: string;
  user_data: { em?: string[]; external_id?: string[]; fbp?: string; fbc?: string; client_ip_address?: string; client_user_agent?: string };
  custom_data?: Bag;
};

const ipAddress = (value: string | null | undefined) =>
  typeof value === "string" && /^[0-9a-f:.]{3,45}$/iu.test(value) && /[.:]/u.test(value) ? value : undefined;

/** A page as Meta should see it: the origin and path, no query, no `#`. Off-origin values fall back to the origin. */
export function sourceUrl(origin: string, path: unknown): string {
  try {
    const url = new URL(typeof path === "string" ? path : "/", origin);
    if (url.origin === new URL(origin).origin) return url.origin + url.pathname;
  } catch {
    // The site itself, then.
  }
  return `${origin.replace(/\/$/u, "")}/`;
}

/** Builds one server event from checked parts. The email is hashed here; it is never sent in the clear. */
export async function capiEvent(input: Readonly<{
  name: CapiEvent["event_name"];
  eventId: string;
  at?: number;
  source?: "website" | "app";
  url?: string;
  ads?: Omit<Ads, "event_id">;
  email?: unknown;
  externalId?: string;
  ip?: string | null;
  userAgent?: string | null;
  custom?: Bag;
}>): Promise<CapiEvent> {
  const em = await hashEmail(input.email);
  const agent = input.userAgent?.slice(0, 512);
  const address = ipAddress(input.ip);
  return {
    event_name: input.name,
    event_time: input.at ?? Math.floor(Date.now() / 1000),
    event_id: input.eventId,
    action_source: input.source ?? "website",
    ...(input.url === undefined ? {} : { event_source_url: input.url }),
    user_data: {
      ...(em === undefined ? {} : { em: [em] }),
      ...(input.externalId === undefined ? {} : { external_id: [input.externalId] }),
      ...(input.ads?.fbp === undefined ? {} : { fbp: input.ads.fbp }),
      ...(input.ads?.fbc === undefined ? {} : { fbc: input.ads.fbc }),
      ...(address === undefined ? {} : { client_ip_address: address }),
      ...(agent === undefined || agent === "" ? {} : { client_user_agent: agent }),
    },
    ...(input.custom === undefined ? {} : { custom_data: input.custom }),
  };
}

export type CapiConfig = Readonly<{ pixelId: string; token: string | undefined; testEventCode?: string; graph?: string; timeoutMs?: number }>;
/** The request body, with the token in it rather than in the address. */
export const capiBody = (config: CapiConfig, events: readonly CapiEvent[]) =>
  JSON.stringify({ data: events, access_token: config.token, ...(config.testEventCode === undefined || config.testEventCode === "" ? {} : { test_event_code: config.testEventCode }) });

/**
 * Sends after the response. No token, an event the browser never allowed, a slow Meta or a failure never touches
 * the request. `make` may return undefined to send nothing.
 */
export function sendCapi(
  config: CapiConfig,
  make: () => Promise<CapiEvent | undefined> | CapiEvent | undefined,
  options: Readonly<{ waitUntil?: (job: Promise<unknown>) => void; fetch?: typeof fetch }> = {},
): Promise<void> {
  if (config.token === undefined || config.token === "") return Promise.resolve();
  const send = options.fetch ?? fetch;
  return later(options.waitUntil, config.timeoutMs ?? 3000, async (signal) => {
    const event = await make();
    if (event === undefined) return;
    await send(`${config.graph ?? GRAPH}/${config.pixelId}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: capiBody(config, [event]), signal });
  });
}
