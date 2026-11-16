/**
 * The browser client: region policy, consent banner, first-party identity, first-touch attribution, address-bar
 * tidying, surface presets, identify and reset. PostHog loads after the page has drawn, from the site's own origin,
 * with every extension bundled from the pinned package so nothing PostHog hosts runs in the page.
 */
import {
  afterFirstPageview,
  arrivalOf,
  arrivalProps,
  cleanProps,
  firstTouchProps,
  parseFirstTouch,
  refOf,
  remember,
  routePattern,
  withoutTracking,
  type Arrival,
  type FirstTouch,
} from "./attribution.ts";
import {
  accountId,
  capabilities,
  ENGLISH,
  formatChoices,
  fromPrivateElement,
  ID_MAX_AGE_SECONDS,
  linkChoice,
  mergeChoices,
  parseChoices,
  posthogOptions,
  sessionFor,
  visitId,
  type BrowserConfig,
  type ConsentWords,
} from "./browser-config.ts";
import { MILESTONES, SCHEMA, type EventName, type Props, type PropsOf } from "./events.ts";
import { GROUP_COUNTRY, parseRegionResponse, regionPolicy, type Choices, type RegionPolicy } from "./policy.ts";

export * from "./browser-config.ts";
export {
  afterFirstPageview,
  arrivalOf,
  carryRef,
  channelOf,
  cleanProps,
  cleanUrl,
  firstTouchProps,
  refLabel,
  refOf,
  withoutTracking,
  type Channel,
} from "./attribution.ts";

type PostHogLike = {
  init(token: string, options: Record<string, unknown>): unknown;
  capture(event: string, props?: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  identify(id: string, set?: Record<string, unknown>, setOnce?: Record<string, unknown>): void;
  alias?(alias: string): void;
  reset(): void;
  get_distinct_id(): string;
  set_config(config: Record<string, unknown>): void;
  startSessionRecording?(): void;
  stopSessionRecording(): void;
  opt_out_capturing?(): void;
};

export type Analytics<Extra extends string = never> = Readonly<{
  /** Reports an event. Safe anywhere: where analytics is off it does nothing. Queued until PostHog loads. */
  track<E extends EventName<Extra>>(event: E, props?: PropsOf<E>): void;
  /** Reports the 1st, 3rd, 10th, 30th and 100th of something on this page, with `nth`. */
  trackNth<E extends EventName<Extra>>(event: E, props?: PropsOf<E>): void;
  /** Facts that ride on every later event on this page (`plan`, say). */
  describe(props: Props): void;
  /**
   * Links this browser to a signed-in account by an opaque ID (an HMAC of the account ID, never an email). Sets the
   * first-touch set on the person once. Only in persistent mode; returns whether it did.
   */
  identify(account: string, person?: Props): boolean;
  /** Sign-out: a new anonymous ID; the first-touch record stays. */
  reset(): void;
  /** The European banner's or a settings toggle's answer. */
  choose(scope: "all" | "ads", choice: "yes" | "no"): void;
  /** The "Your Privacy Choices" link: turns off ads and recordings for this browser. */
  privacyChoices(): void;
  /** The distinct ID to hand to checkout or a download link, in persistent mode only. */
  distinctId(): string | undefined;
  /** The visitor's first launch tag, or this page's own in cookieless mode. */
  firstRef(): string | undefined;
  /** The first-touch labels to carry into checkout metadata or an emailed link. */
  carry(): Readonly<{ ref?: string; first_source?: string }>;
  policy(): RegionPolicy | undefined;
  /** Whether this page counts anything at all. */
  counting(): boolean;
}>;

const OFF: Analytics<string> = {
  track() {},
  trackNth() {},
  describe() {},
  identify: () => false,
  reset() {},
  choose() {},
  privacyChoices() {},
  distinctId: () => undefined,
  firstRef: () => undefined,
  carry: () => ({}),
  policy: () => undefined,
  counting: () => false,
};

// --- Small storage helpers: every access can throw in a locked-down browser. --------------------------------------
function readCookie(name: string): string | undefined {
  try {
    const part = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
    return part === undefined ? undefined : decodeURIComponent(part.slice(name.length + 1));
  } catch {
    return undefined;
  }
}
function writeCookie(name: string, value: string | undefined, maxAge = ID_MAX_AGE_SECONDS) {
  try {
    document.cookie = `${name}=${value === undefined ? "" : encodeURIComponent(value)}; max-age=${String(value === undefined ? 0 : maxAge)}; path=/; secure; samesite=lax`;
  } catch {
    // Blocked: this page still works.
  }
}
function readLocal(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeLocal(key: string, value: string | undefined) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Blocked.
  }
}

/** Starts the client for this page. Returns a no-op client where nothing may run. */
export function createAnalytics<Extra extends string = never>(config: BrowserConfig): Analytics<Extra> {
  if (typeof window === "undefined" || typeof document === "undefined") return OFF;
  const prefix = config.storagePrefix ?? config.siteId;
  const keys = { id: `${prefix}-id`, choice: `${prefix}-choice`, touch: `${prefix}-touch` };
  const words: ConsentWords = config.words ?? ENGLISH;

  // The privacy page's links work even where nothing else runs, so a no given early still holds.
  const linked = linkChoice(location.search);
  if (linked !== undefined) {
    store(mergeChoices(storedChoices(), linked));
    const rest = new URLSearchParams(location.search);
    rest.delete("analytics");
    rest.delete("ads");
    const query = rest.toString();
    history.replaceState(history.state, "", location.pathname + (query ? `?${query}` : "") + location.hash);
    if (linked.analytics === "no") forget();
  }

  const native = config.native?.() ?? false;
  const runs = config.token !== "" && !native && !navigator.webdriver && config.hosts.includes(location.hostname);
  if (!runs) return OFF;

  const arrival: Arrival = arrivalOf(location.pathname, location.search, document.referrer, config.contentParams ?? []);
  let on = true;
  let client: PostHogLike | undefined;
  let policy: RegionPolicy | undefined;
  let queue: [string, Props][] = [];
  let facts: Props = {};
  let touch: FirstTouch | undefined;
  let distinct: string | undefined;
  let identified: string | undefined;
  const counts = new Map<string, number>();
  let adsStarted = false;

  function storedChoices(): Choices {
    let session: string | undefined;
    try {
      session = sessionStorage.getItem(keys.choice) ?? undefined;
    } catch {
      // Blocked.
    }
    return mergeChoices(parseChoices(readLocal(keys.choice)), parseChoices(readCookie(keys.choice)), parseChoices(session));
  }
  function store(choices: Choices) {
    const value = formatChoices(choices);
    writeLocal(keys.choice, value === "" ? undefined : value);
    writeCookie(keys.choice, value === "" ? undefined : value);
  }
  function forget() {
    writeCookie(keys.id, undefined);
    writeLocal(keys.touch, undefined);
    try {
      sessionStorage.removeItem(keys.touch);
    } catch {
      // Blocked.
    }
    for (const name of ["_fbp", "_fbc"]) {
      for (const domain of ["", `; domain=${location.hostname}`, `; domain=.${location.hostname}`]) {
        try {
          document.cookie = `${name}=; max-age=0; path=/${domain}`;
        } catch {
          // Blocked.
        }
      }
    }
    config.onAdsOff?.();
  }
  const gpc = () => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  const zone = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  };
  const isPrivate = (path: string) => {
    const patterns = config.privatePaths ?? [];
    return patterns.length > 0 && routePattern(path, patterns) !== path;
  };

  async function region(): Promise<{ country: string | null }> {
    const injected = parseRegionResponse((window as { __hranessRegion?: unknown }).__hranessRegion);
    if (injected) return { country: injected.country ?? GROUP_COUNTRY[injected.region_group] };
    if (config.regionUrl === false) return { country: null };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, 1500);
      const response = await fetch(config.regionUrl ?? "/api/region", { credentials: "omit", signal: controller.signal });
      clearTimeout(timer);
      const parsed = parseRegionResponse(response.ok ? await response.json() : undefined);
      return { country: parsed === undefined ? null : parsed.country ?? GROUP_COUNTRY[parsed.region_group] };
    } catch {
      return { country: null };
    }
  }

  const currentPolicy = (country: string | null) => regionPolicy({ country, zone: zone(), gpc: gpc(), choices: storedChoices() });

  function startAds() {
    if (adsStarted || policy?.ads !== true) return;
    adsStarted = true;
    config.onAds?.({ fbclid: arrival.fbclid, allowed: () => policy?.ads === true });
  }

  async function load() {
    const { country } = await region();
    policy = currentPolicy(country);
    if (policy.analytics !== "persistent") forget();
    const caps = capabilities(policy, config.preset, isPrivate(location.pathname));
    const base: Record<string, unknown> = {
      site_id: config.siteId,
      surface: config.surface ?? (config.preset === "marketing" ? "site" : config.preset === "docs" ? "docs" : "web_app"),
      schema: SCHEMA,
      page_kind: config.pageKind,
      consent_mode: policy.analytics,
      region_group: policy.region_group,
    };
    let session: ReturnType<typeof sessionFor>;
    if (policy.analytics === "persistent") {
      const now = Date.now();
      let stored: Record<string, unknown> | undefined;
      try {
        stored = JSON.parse(readLocal(keys.touch) ?? "null") as Record<string, unknown> | undefined;
      } catch {
        stored = undefined;
      }
      const before = parseFirstTouch(stored?.touch);
      session = sessionFor(stored?.session, now);
      distinct = visitId(stored?.id) ?? visitId(readCookie(keys.id)) ?? crypto.randomUUID();
      identified = accountId(stored?.account);
      touch = remember(before, new Date(now), arrival, {
        surface: String(base.surface),
        ...(config.landingKind?.(arrival.path) === undefined ? {} : { landingKind: config.landingKind(arrival.path) ?? "" }),
        ...(config.channel === undefined ? {} : { channel: config.channel }),
      });
      writeCookie(keys.id, distinct);
      saveRecord(session);
      Object.assign(base, firstTouchProps(touch));
    } else {
      // Nothing is kept: how this one visit arrived is all there is.
      const one = remember(undefined, new Date(), arrival, config.channel === undefined ? {} : { channel: config.channel });
      Object.assign(base, firstTouchProps(one));
      delete base.active_days;
      delete base.returning;
    }
    Object.assign(base, arrivalProps(arrival, config.channel ?? {}));

    const [{ default: posthog }] = await Promise.all([
      import("posthog-js/dist/module.no-external"),
      import("posthog-js/dist/exception-autocapture"),
      caps.vitalsAttribution ? import("posthog-js/dist/web-vitals-with-attribution") : import("posthog-js/dist/web-vitals"),
      caps.heatmaps ? import("posthog-js/dist/dead-clicks-autocapture") : Promise.resolve(),
      caps.replay ? import("posthog-js/dist/posthog-recorder") : Promise.resolve(),
    ]);
    if (!on) return;
    const ph = posthog as unknown as PostHogLike;
    facts = { ...base, ...facts } as Props;
    const tidy = afterFirstPageview(() => {
      const clean = withoutTracking(location.href);
      if (clean !== null) history.replaceState(history.state, "", clean);
    });
    let errors = 0;
    ph.init(config.token, {
      ...posthogOptions({ config, policy, caps, distinctId: identified ?? distinct, identified: identified !== undefined, sessionId: session?.id }),
      before_send: (event: { event?: string; properties?: Record<string, unknown> } | null) => {
        if (event === null || !on) return null;
        if (policy?.analytics === "persistent") touchSession(event.properties?.$session_id);
        if (event.event === "$exception" && ++errors > 5) return null;
        if (event.event !== undefined && ["$autocapture", "$rageclick", "$dead_click"].includes(event.event)) {
          if (fromPrivateElement(event.properties) || (config.preset !== "app" && isPrivate(location.pathname) && event.event !== "$autocapture")) return null;
        }
        const own = config.clean?.allowProps === undefined ? event.properties : cleanProps(event.properties ?? {}, { allowProps: [...config.clean.allowProps, ...Object.keys(facts)] });
        const cleaned = cleanProps({ ...event, properties: { ...own, ...facts } }, { routes: [...(config.clean?.routes ?? []), ...(config.privatePaths ?? [])] });
        queueMicrotask(() => { tidy(event.event); });
        return cleaned;
      },
    });
    client = ph;
    if (identified !== undefined) ph.identify(identified);
    for (const [event, props] of queue) send(event, props);
    queue = [];
    watchNavigation(ph);
    startAds();
    if (policy.ask !== "none") setTimeout(() => { ask(policy?.ask ?? "none"); }, config.askDelayMs ?? 2500);
  }

  function saveRecord(session: ReturnType<typeof sessionFor>) {
    if (distinct === undefined || touch === undefined) return;
    writeLocal(keys.touch, JSON.stringify({ id: distinct, account: identified, session, touch }));
  }
  let sessionRecord: ReturnType<typeof sessionFor>;
  function touchSession(id: unknown) {
    const now = Date.now();
    const current = visitId(id);
    if (current === undefined) return;
    sessionRecord = sessionRecord?.id === current ? { ...sessionRecord, last: now } : { id: current, started: now, last: now };
    saveRecord(sessionRecord);
  }

  function watchNavigation(ph: PostHogLike) {
    let last = location.pathname;
    const check = () => {
      if (location.pathname === last) return;
      last = location.pathname;
      if (isPrivate(last)) ph.stopSessionRecording();
    };
    window.addEventListener("popstate", check);
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method].bind(history);
      history[method] = (...args: Parameters<History["pushState"]>) => {
        original(...args);
        check();
      };
    }
  }

  function send(event: string, props: Props) {
    if (!client || !on) return;
    void client.capture(event, props, { send_instantly: true });
  }

  function say(text: string) {
    const bar = banner();
    const line = document.createElement("p");
    line.textContent = text;
    bar.append(line);
    document.body.append(bar);
    setTimeout(() => { bar.remove(); }, 6000);
  }
  function banner() {
    document.querySelector(".hra-consent")?.remove();
    const made = document.createElement("aside");
    made.className = "hra-consent";
    made.setAttribute("role", "region");
    made.setAttribute("aria-label", words.privacy);
    return made;
  }
  /** One layer, equal-weight answers; either answer is remembered for 13 months. */
  function ask(scope: "ads" | "all" | "none") {
    if (scope === "none" || document.querySelector(".hra-consent")) return;
    const bar = banner();
    const text = document.createElement("p");
    text.textContent = `${scope === "all" ? words.allBody : words.adsBody} `;
    const link = document.createElement("a");
    link.href = config.privacyHref ?? "/privacy";
    link.textContent = words.privacy;
    text.append(link);
    const buttons = document.createElement("div");
    for (const choice of ["no", "yes"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `hra-consent-${choice}`;
      button.textContent = choice === "yes" ? words.allow : words.decline;
      button.addEventListener("click", () => {
        api.choose(scope, choice);
        bar.remove();
      });
      buttons.append(button);
    }
    bar.append(text, buttons);
    document.body.append(bar);
  }

  const api: Analytics<Extra> = {
    track(event, props) {
      if (!on) return;
      const sent = { ...(props ?? {}) } as Props;
      if (client) send(event, sent);
      else if (queue.length < 50) queue.push([event, sent]);
    },
    trackNth(event, props) {
      if (!on) return;
      const kind = (props as Props | undefined)?.kind;
      const key = `${event}:${typeof kind === "string" ? kind : ""}`;
      const nth = (counts.get(key) ?? 0) + 1;
      counts.set(key, nth);
      if (MILESTONES.includes(nth)) api.track(event, { ...(props ?? {}), nth } as unknown as PropsOf<typeof event>);
    },
    describe(props) {
      facts = { ...facts, ...props };
    },
    identify(account, person = {}) {
      const id = accountId(account);
      if (id === undefined || policy?.analytics !== "persistent" || !client) return false;
      identified = id;
      saveRecord(sessionRecord);
      const once = touch === undefined ? {} : firstTouchProps(touch);
      client.identify(id, { ...person }, once);
      return true;
    },
    reset() {
      identified = undefined;
      if (!client || policy?.analytics !== "persistent") return;
      client.reset();
      distinct = crypto.randomUUID();
      writeCookie(keys.id, distinct);
      saveRecord(sessionRecord);
    },
    choose(scope, choice) {
      const before = storedChoices();
      const next = scope === "all" ? { analytics: choice, ads: choice } : { ...before, ads: choice };
      store(next);
      send("analytics choice made", { choice, scope });
      const was = policy;
      policy = currentPolicy(was === undefined ? null : GROUP_COUNTRY[was.region_group]);
      if (choice === "no") {
        client?.stopSessionRecording();
        if (scope === "all") forget();
        else config.onAdsOff?.();
      } else {
        startAds();
      }
    },
    privacyChoices() {
      store({ ...storedChoices(), ads: "no" });
      client?.stopSessionRecording();
      config.onAdsOff?.();
      if (policy) policy = { ...policy, ads: false, replay: false };
      say(words.adsOff);
    },
    distinctId: () => (policy?.analytics === "persistent" && client ? client.get_distinct_id() : undefined),
    firstRef: () => (touch === undefined ? refOf(arrival.search) : touch.ref),
    carry() {
      const ref = touch === undefined ? refOf(arrival.search) : touch.ref;
      const source = touch?.source;
      return { ...(ref === undefined ? {} : { ref }), ...(source === undefined || source === "" ? {} : { first_source: source }) };
    },
    policy: () => policy,
    counting: () => on,
  };

  const stop = () => {
    on = false;
    queue = [];
  };
  const begin = () => void load().catch(stop);
  const idle = () => {
    if ("requestIdleCallback" in window) requestIdleCallback(begin, { timeout: 4000 });
    else setTimeout(begin, 1500);
  };
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
  if (linked !== undefined) say(linked.analytics === "no" ? words.off : linked.ads === "no" ? words.adsOff : words.on);
  return api;
}

