/**
 * The pure half of the browser client: configuration types, surface presets, the PostHog options each preset and
 * policy produce, and the parsers for what the browser stores. No browser or provider import, so it is unit-tested
 * directly.
 */
import type { CleanOptions, ChannelOptions, RoutePattern } from "./attribution.js";
import type { Choice, Choices, RegionPolicy } from "./policy.js";

/** Which surface a page belongs to (section 3.3 of the standard). */
export type Preset = "marketing" | "docs" | "app" | "traffic";

export type ConsentWords = Readonly<{
  /** The European question (one choice covering analytics, recordings and ads). */
  allBody: string;
  /** The UK, Swiss and Brazilian question (ads and recordings only). */
  adsBody: string;
  allow: string;
  decline: string;
  privacy: string;
  /** Said back after `?analytics=on|off` or the "Your Privacy Choices" link. */
  on: string;
  off: string;
  adsOff: string;
}>;

export const ENGLISH: ConsentWords = {
  allBody: "May we count your visit with a cookie, record how pages are used (never what you type) and measure our ads?",
  adsBody: "May we record how pages are used (never what you type) and measure our ads?",
  allow: "Yes",
  decline: "No",
  privacy: "Privacy",
  on: "Analytics is on for this browser.",
  off: "Analytics is off for this browser. Visits are still counted without cookies.",
  adsOff: "Ads measurement and recordings are off for this browser.",
};

export type BrowserConfig = Readonly<{
  /** The PostHog project's public token. Empty: nothing runs. */
  token: string;
  /** Same-origin proxy path or URL. Default `/ph`. */
  apiHost?: string;
  uiHost?: string;
  /** Hosts this client may run on (exact match). */
  hosts: readonly string[];
  /** The `site_id` super property. */
  siteId: string;
  preset: Preset;
  /** The `surface` super property. Default `site` for marketing and traffic, `docs` for docs, `web_app` for app. */
  surface?: string;
  /** The `page_kind` super property. */
  pageKind?: string;
  /** Cookie and storage name prefix. Default `siteId`. */
  storagePrefix?: string;
  /**
   * Where the region comes from: a same-origin URL serving `regionResponse` JSON (default `/api/region`), a global
   * the edge injected (`window.__hranessRegion`), or neither, in which case the time zone decides.
   */
  regionUrl?: string | false;
  /** Query parameters that change what a page shows and are recorded as `first_<name>` (`story`, `ad`). */
  contentParams?: readonly string[];
  /** `first_landing_kind` from the landing path (its route pattern when it matches `privatePaths` or `clean.routes`). */
  landingKind?: (path: string) => string | undefined;
  channel?: ChannelOptions;
  /** Paths where nothing is recorded or heat-mapped and only allowlisted clicks are captured. */
  privatePaths?: readonly RoutePattern[];
  clean?: CleanOptions;
  /** Elements whose text replay masks and whose clicks autocapture drops. */
  privateSelector?: string;
  /** Share of replay-eligible sessions recorded, 0 to 1. Unset: the PostHog project's setting. Minimum duration is a project setting. */
  replaySampleRate?: number;
  /** Inside a native app shell: nothing runs. */
  native?: () => boolean;
  words?: ConsentWords;
  privacyHref?: string;
  /**
   * Called once when the policy allows ads (and again after an ads yes). Compose `@hraness/analytics/meta` here, with
   * `startPixel(browserPage(href), ...)`: `href` is this page's address with launch tags and content parameters cut.
   */
  onAds?: (context: { fbclid: string | undefined; href: string; allowed: () => boolean }) => void;
  /** Called when ads must stop (an ads no, GPC, an analytics no). */
  onAdsOff?: () => void;
  /** Milliseconds before the banner appears. Default 2500. */
  askDelayMs?: number;
}>;

export const DEFAULT_PRIVATE_SELECTOR = "[data-private], .ph-no-capture";

export type Capabilities = Readonly<{
  autocapture: boolean;
  heatmaps: boolean;
  replay: boolean;
  vitalsAttribution: boolean;
}>;

/** What this page may turn on: the policy, narrowed by the preset and private paths. */
export function capabilities(policy: RegionPolicy, preset: Preset, privatePath: boolean): Capabilities {
  if (preset === "traffic") return { autocapture: false, heatmaps: false, replay: false, vitalsAttribution: false };
  const publicPage = preset !== "app" && !privatePath;
  return {
    autocapture: policy.autocapture,
    heatmaps: policy.autocapture && publicPage,
    replay: policy.replay && publicPage,
    vitalsAttribution: policy.autocapture && publicPage,
  };
}

/**
 * The PostHog options for a page. Identity stays the package's: the SDK keeps everything in memory and is
 * bootstrapped with the first-party ID, so no SDK cookie ever holds a raw referrer or campaign.
 */
export function posthogOptions(input: Readonly<{
  config: BrowserConfig;
  policy: RegionPolicy;
  caps: Capabilities;
  distinctId: string | undefined;
  identified: boolean;
  sessionId: string | undefined;
}>): Record<string, unknown> {
  const { config, policy, caps } = input;
  const cookieless = policy.analytics === "cookieless";
  const privateSelector = config.privateSelector ?? DEFAULT_PRIVATE_SELECTOR;
  const rate = config.replaySampleRate;
  const sampleRate = typeof rate === "number" && Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : undefined;
  const app = config.preset === "app";
  const trafficOnly = config.preset === "traffic";
  return {
    api_host: config.apiHost ?? "/ph",
    ui_host: config.uiHost ?? "https://us.posthog.com",
    defaults: "2025-05-24",
    disable_external_dependency_loading: true,
    ...(cookieless ? { cookieless_mode: "always" } : {}),
    person_profiles: "identified_only",
    save_referrer: false,
    save_campaign_params: false,
    custom_campaign_params: ["ref", "via"],
    persistence: "memory",
    disable_persistence: true,
    ...(input.distinctId === undefined
      ? {}
      : { bootstrap: { distinctID: input.distinctId, isIdentifiedID: input.identified, ...(input.sessionId === undefined ? {} : { sessionID: input.sessionId }) } }),
    autocapture: caps.autocapture
      ? app
        ? { element_allowlist: ["button", "a"], css_selector_allowlist: ["[data-ph]"] }
        : true
      : false,
    mask_all_text: app,
    mask_all_element_attributes: app,
    rageclick: caps.heatmaps,
    capture_dead_clicks: caps.heatmaps,
    capture_heatmaps: caps.heatmaps,
    capture_pageview: trafficOnly ? true : "history_change",
    capture_pageleave: !trafficOnly,
    capture_exceptions: !trafficOnly,
    capture_performance: trafficOnly ? false : { web_vitals: true, network_timing: false, web_vitals_attribution: caps.vitalsAttribution },
    disable_session_recording: !caps.replay,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: `${privateSelector}, input, textarea`,
      blockSelector: privateSelector,
      recordCrossOriginIframes: false,
      recordHeaders: false,
      recordBody: false,
      ...(sampleRate === undefined ? {} : { sampleRate }),
    },
    disable_surveys: true,
    advanced_disable_feature_flags: true,
    // Remote config carries the replay settings; without replay nothing needs it.
    advanced_disable_flags: !caps.replay,
  };
}

// --- Stored answers and identity --------------------------------------------------------------------------------

/** 13 months, the CNIL ceiling for an audience-measurement tracker; renewed on each visit. */
export const ID_MAX_AGE_SECONDS = 396 * 86400;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
/** A random browser UUID, or undefined. */
export const visitId = (value: unknown): string | undefined => (typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined);

/** An opaque account distinct ID: no email, no spaces, bounded. */
export function accountId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_:.-]{8,128}$/u.test(value) && !value.includes("@") ? value : undefined;
}

/** Choices with when they were made (`at`, milliseconds since 1970), so a later answer can win over an earlier one. */
export type DatedChoices = Choices & Readonly<{ at?: number | undefined }>;

const moment = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Choices as stored in one cookie: `a=yes&d=no&t=1763251200000` (`a` analytics, `d` ads and recordings, `t` when). */
export function formatChoices(choices: DatedChoices): string {
  const parts: string[] = [];
  if (choices.analytics !== undefined) parts.push(`a=${choices.analytics}`);
  if (choices.ads !== undefined) parts.push(`d=${choices.ads}`);
  const at = moment(choices.at);
  if (parts.length > 0 && at !== undefined) parts.push(`t=${String(at)}`);
  return parts.join("&");
}
export function parseChoices(value: unknown): DatedChoices {
  if (typeof value !== "string") return {};
  const params = new URLSearchParams(value);
  const choice = (raw: string | null): Choice | undefined => (raw === "yes" || raw === "no" ? raw : undefined);
  const t = params.get("t");
  const at = t !== null && /^\d{1,16}$/u.test(t) ? moment(Number(t)) : undefined;
  return { analytics: choice(params.get("a")), ads: choice(params.get("d")), ...(at === undefined ? {} : { at }) };
}
/**
 * Merge answers, per category. The latest answer wins: an explicit later yes overrides an earlier no. "Later" means
 * a later `at`; copies with the same or no `at` (two stores holding one answer, or records from before 1.0.3) keep the
 * old rule that a no wins, because a blocked store can leave an old yes behind.
 */
export function mergeChoices(...all: readonly DatedChoices[]): DatedChoices {
  const pick = (category: "analytics" | "ads"): Choice | undefined => {
    let best: Choice | undefined;
    let bestAt = -1;
    for (const item of all) {
      const value = item[category];
      if (value === undefined) continue;
      const at = moment(item.at) ?? 0;
      if (at > bestAt || (at === bestAt && value === "no")) {
        best = value;
        bestAt = at;
      }
    }
    return best;
  };
  const at = Math.max(0, ...all.map((item) => moment(item.at) ?? 0));
  return { analytics: pick("analytics"), ads: pick("ads"), ...(at > 0 ? { at } : {}) };
}

export type VisitSession = Readonly<{ id: string; started: number; last: number }>;
/** A session continues after 30 minutes idle at most, and for one day at most. */
export function sessionFor(value: unknown, now: number): VisitSession | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = visitId(record.id);
  const started = record.started;
  const last = record.last;
  if (id === undefined || typeof started !== "number" || typeof last !== "number") return undefined;
  if (!Number.isSafeInteger(started) || !Number.isSafeInteger(last) || started < 0 || last < started) return undefined;
  if (now < last || now - last >= 30 * 60_000 || now - started >= 24 * 3_600_000) return undefined;
  return { id, started, last };
}

/** The `?analytics=` and `?ads=` links on a privacy page. */
export function linkChoice(search: string): Readonly<{ analytics?: Choice; ads?: Choice }> | undefined {
  const params = new URLSearchParams(search);
  const analytics = params.get("analytics");
  const ads = params.get("ads");
  const out: { analytics?: Choice; ads?: Choice } = {};
  if (analytics === "on") out.analytics = "yes";
  if (analytics === "off") { out.analytics = "no"; out.ads = "no"; }
  if (ads === "off") out.ads = "no";
  if (ads === "on") out.ads = "yes";
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Whether a captured click came from a private element (its chain names `data-private`). */
export function fromPrivateElement(properties: Record<string, unknown> | undefined): boolean {
  const chain = properties?.$elements_chain;
  return typeof chain === "string" && /data-private|ph-no-capture/u.test(chain);
}

// --- Region, ads address and private paths ----------------------------------------------------------------------

/** The region endpoint with `?tz=` added, so a request that reaches the edge without a country still lands right. */
export function regionAddress(base: string, zone: string | undefined): string {
  if (zone === undefined || !/^[A-Za-z0-9_+/-]{1,64}$/u.test(zone)) return base;
  return `${base}${base.includes("?") ? "&" : "?"}tz=${encodeURIComponent(zone)}`;
}

/**
 * The address Meta may see: only `fbclid` and `utm_*` kept, nothing after `#`. Launch tags (`ref`, `via`) and content
 * parameters are cut, so a tagged landing still sends its PageView without handing Meta the tag.
 */
export function adsAddress(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) {
    if (name !== "fbclid" && !name.startsWith("utm_")) url.searchParams.delete(name);
  }
  return url.toString();
}

/** Page title properties dropped on private paths. */
const PAGE_NAMES = ["$title", "title", "$page_title", "page_title", "$document_title"] as const;
/**
 * Chain parts that can name private content: text, links, ids and every attribute (`aria-label`, `title`, `alt`,
 * `name`, `value`, ...) except `data-ph`, the allowlist marker.
 */
const PRIVATE_CHAIN_ATTRIBUTE = /(?:attr__(?!data-ph=)[\w:-]+|attr_id|href|text)="(?:[^"\\]|\\.)*"/gu;

const ALLOWLISTED_ELEMENT = /(?:^|;)(?:a|button)(?=[.:;]|$)|attr__data-ph=/u;

/**
 * An event as kept on a private path, or null when it is dropped: no heatmaps, rage or dead clicks, clicks only on
 * links, buttons and `[data-ph]` elements with their text, links and attributes cut, and no page title.
 */
export function onPrivatePath(event: Readonly<{ event?: string; properties?: Record<string, unknown> }>): { event?: string; properties: Record<string, unknown> } | null {
  const name = event.event;
  if (name === "$$heatmap" || name === "$rageclick" || name === "$dead_click") return null;
  const properties: Record<string, unknown> = { ...(event.properties ?? {}) };
  if (name === "$autocapture") {
    const chain = properties.$elements_chain;
    if (typeof chain !== "string" || !ALLOWLISTED_ELEMENT.test(chain)) return null;
    properties.$elements_chain = chain.replace(PRIVATE_CHAIN_ATTRIBUTE, "");
    delete properties.$el_text;
    delete properties.$elements;
    delete properties.$external_click_url;
  }
  // posthog-js sends the page title as `$title` and, on the first pageview, as plain `title`.
  for (const name of PAGE_NAMES) Reflect.deleteProperty(properties, name);
  return { ...event, properties };
}
