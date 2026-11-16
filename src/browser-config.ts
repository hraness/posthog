/**
 * The pure half of the browser client: configuration types, surface presets, the PostHog options each preset and
 * policy produce, and the parsers for what the browser stores. No browser or provider import, so it is unit-tested
 * directly.
 */
import type { CleanOptions, ChannelOptions, RoutePattern } from "./attribution.js";
import type { Choice, Choices, RegionPolicy } from "./policy.js";

/** Which surface a page belongs to (section 3.3 of the standard). */
export type Preset = "marketing" | "docs" | "app";

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
  /** The `surface` super property. Default `site` for marketing, `docs` for docs, `web_app` for app. */
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
  /** `first_landing_kind` from the landing path. */
  landingKind?: (path: string) => string | undefined;
  channel?: ChannelOptions;
  /** Paths where nothing is recorded or heat-mapped and only allowlisted clicks are captured. */
  privatePaths?: readonly RoutePattern[];
  clean?: CleanOptions;
  /** Elements whose text replay masks and whose clicks autocapture drops. */
  privateSelector?: string;
  /** Replay sampling (0 to 1) and minimum duration. */
  replaySampleRate?: number;
  replayMinimumMs?: number;
  /** Inside a native app shell: nothing runs. */
  native?: () => boolean;
  words?: ConsentWords;
  privacyHref?: string;
  /** Called once when the policy allows ads (and again after an ads yes). Compose `@hraness/analytics/meta` here. */
  onAds?: (context: { fbclid: string | undefined; allowed: () => boolean }) => void;
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
  const app = config.preset === "app";
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
    capture_pageview: "history_change",
    capture_pageleave: true,
    capture_exceptions: true,
    capture_performance: { web_vitals: true, network_timing: false, web_vitals_attribution: caps.vitalsAttribution },
    disable_session_recording: !caps.replay,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: `${privateSelector}, input, textarea`,
      blockSelector: privateSelector,
      recordCrossOriginIframes: false,
      recordHeaders: false,
      recordBody: false,
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

/** Choices as stored in one cookie: `a=yes&d=no` (`a` analytics, `d` ads and recordings). */
export function formatChoices(choices: Choices): string {
  const parts: string[] = [];
  if (choices.analytics !== undefined) parts.push(`a=${choices.analytics}`);
  if (choices.ads !== undefined) parts.push(`d=${choices.ads}`);
  return parts.join("&");
}
export function parseChoices(value: unknown): Choices {
  if (typeof value !== "string") return {};
  const params = new URLSearchParams(value);
  const choice = (raw: string | null): Choice | undefined => (raw === "yes" || raw === "no" ? raw : undefined);
  return { analytics: choice(params.get("a")), ads: choice(params.get("d")) };
}
/** Merge answers; an explicit no in any copy wins over a yes in another (a blocked store can leave an old yes). */
export function mergeChoices(...all: readonly Choices[]): Choices {
  const pick = (values: readonly (Choice | undefined)[]): Choice | undefined =>
    values.includes("no") ? "no" : values.includes("yes") ? "yes" : undefined;
  return { analytics: pick(all.map((item) => item.analytics)), ads: pick(all.map((item) => item.ads)) };
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
