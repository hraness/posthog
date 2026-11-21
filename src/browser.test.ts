/**
 * The browser client against a small fake page and a fake PostHog: private paths, the region fallback, an EU yes
 * in the page, Meta's address, and ads cookies.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

type Sent = { event: string; properties: Record<string, unknown> } | null;
type Fake = {
  name: string | undefined;
  options: Record<string, unknown>;
  sent: Sent[];
  identified: string[];
  config: Record<string, unknown>[];
  recording: boolean;
};
const instances: Fake[] = [];

function fakePostHog(name?: string): Record<string, unknown> {
  const fake: Fake = { name, options: {}, sent: [], identified: [], config: [], recording: true };
  const api: Record<string, unknown> = {
    init(_token: string, options: Record<string, unknown>, child?: string) {
      if (child !== undefined) {
        const made = fakePostHog(child);
        (made.init as (token: string, options: Record<string, unknown>) => void)(_token, options);
        return made;
      }
      fake.options = options;
      instances.push(fake);
      return api;
    },
    capture(event: string, properties: Record<string, unknown> = {}) {
      const before = fake.options.before_send as (event: { event: string; properties: Record<string, unknown> }) => Sent;
      fake.sent.push(before({ event, properties }));
    },
    identify(id: string) { fake.identified.push(id); },
    reset() {},
    get_distinct_id() {
      const boot = fake.options.bootstrap as { distinctID?: string } | undefined;
      return fake.options.cookieless_mode === "always" ? "$posthog_cookieless" : boot?.distinctID ?? "anonymous";
    },
    set_config(config: Record<string, unknown>) { fake.config.push(config); },
    stopSessionRecording() { fake.recording = false; },
  };
  return api;
}

const root = fakePostHog();
await mock.module("posthog-js/dist/module.no-external.js", () => ({ default: root }));
for (const part of ["exception-autocapture", "web-vitals", "web-vitals-with-attribution", "dead-clicks-autocapture", "posthog-recorder"]) {
  await mock.module(`posthog-js/dist/${part}.js`, () => ({}));
}
const { ARRIVAL_SCRIPT, assign, createAnalytics, snapshotArrival } = await import("./browser.js");

class Element {
  children: Element[] = [];
  parent: Element | undefined;
  textContent = "";
  className = "";
  type = "";
  href = "";
  append(...items: Element[]) {
    for (const item of items) {
      item.parent = this;
      this.children.push(item);
    }
  }
  remove() {
    const list = this.parent?.children;
    if (list) list.splice(list.indexOf(this), 1);
  }
  setAttribute() {}
  addEventListener() {}
}
const find = (from: Element, className: string): Element | undefined => {
  for (const child of from.children) {
    if (child.className === className) return child;
    const deeper = find(child, className);
    if (deeper) return deeper;
  }
  return undefined;
};

type PageOptions = {
  href: string;
  zone?: string | undefined;
  region?: unknown;
  regionUrl?: string | false;
  gpc?: boolean;
  body?: boolean;
  cookies?: string[];
  referrer?: string;
  local?: Record<string, string>;
  session?: Record<string, string>;
};
const saved = new Map<string, PropertyDescriptor | undefined>();
function setGlobal(name: string, value: unknown) {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  saved.clear();
  instances.length = 0;
  Reflect.deleteProperty(globalThis, "__hranessArrival");
  Reflect.deleteProperty(globalThis, "__hranessExperiments");
});

function page(options: PageOptions) {
  let url = new URL(options.href);
  const jar = new Map<string, string>();
  const cleared: string[] = [];
  for (const cookie of options.cookies ?? []) {
    const [name = "", value = ""] = cookie.split("=");
    jar.set(name, value);
  }
  const fetched: string[] = [];
  const domLoaded: (() => void)[] = [];
  const body = new Element();
  const doc = {
    readyState: "complete",
    referrer: options.referrer ?? "",
    body: options.body === false ? null : body,
    get cookie() {
      return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    set cookie(text: string) {
      const [pair = "", ...rest] = text.split(";").map((part) => part.trim());
      const [name = "", value = ""] = pair.split("=");
      if (rest.includes("max-age=0")) {
        jar.delete(name);
        cleared.push(name);
      } else jar.set(name, value);
    },
    createElement: () => new Element(),
    querySelector: (selector: string) => find(body, selector.replace(/^\./u, "")) ?? null,
    addEventListener(type: string, listener: () => void) {
      if (type === "DOMContentLoaded") domLoaded.push(listener);
    },
  };
  const store = (initial: Record<string, string> = {}) => {
    const map = new Map<string, string>(Object.entries(initial));
    return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
  };
  const location = {
    get href() { return url.href; },
    get pathname() { return url.pathname; },
    get search() { return url.search; },
    get hash() { return url.hash; },
    get hostname() { return url.hostname; },
  };
  const history = {
    state: null,
    pushState(_state: unknown, _title: string, next: string) { url = new URL(next, url); },
    replaceState(_state: unknown, _title: string, next: string) { url = new URL(next, url); },
  };
  const listeners = new Map<string, (() => void)[]>();
  const win = {
    __hranessRegion: options.region,
    addEventListener(type: string, listener: () => void) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    requestIdleCallback: (callback: () => void) => setTimeout(callback, 0),
  };
  setGlobal("window", win);
  setGlobal("requestIdleCallback", win.requestIdleCallback);
  setGlobal("document", doc);
  setGlobal("location", location);
  setGlobal("history", history);
  setGlobal("navigator", { webdriver: false, globalPrivacyControl: options.gpc === true });
  const local = store(options.local);
  const session = store(options.session);
  setGlobal("localStorage", local);
  setGlobal("sessionStorage", session);
  setGlobal("fetch", (address: string) => {
    fetched.push(address);
    return Promise.resolve(new Response(JSON.stringify({ country: null, region_group: "eu", gpc: false, policy: {} })));
  });
  setGlobal("Intl", { ...Intl, DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: options.zone }) }) });
  return { jar, cleared, fetched, body, domLoaded, location, history, local: local.map, session: session.map };
}

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const base = { token: "public-token", hosts: ["example.com"], siteId: "example", askDelayMs: 0 } as const;
const latest = () => {
  const fake = instances.at(-1);
  if (fake === undefined) throw new Error("PostHog never started");
  return fake;
};

describe("the browser client", () => {
  test("a literal private path is private, as are patterns", async () => {
    const tab = page({ href: "https://example.com/", zone: "America/New_York", regionUrl: false });
    createAnalytics({ ...base, preset: "marketing", regionUrl: false, privatePaths: ["/account", "/settings/billing", "/library/*", "/s/:id"] });
    await settle();
    const ph = latest();
    const capture = (root as { capture: (event: string, props: Record<string, unknown>) => void }).capture;
    for (const path of ["/account", "/settings/billing", "/library", "/library/a/b", "/s/abc"]) {
      tab.history.pushState(null, "", path);
      capture("$$heatmap", { $title: "Secret" });
      capture("$pageview", { $title: "Secret" });
      expect(ph.sent.at(-2)).toBeNull();
      expect(ph.sent.at(-1)?.properties).not.toHaveProperty("$title");
    }
    for (const path of ["/accounts", "/settings", "/libraries/a", "/s/abc/def"]) {
      tab.history.pushState(null, "", path);
      capture("$pageview", { $title: "Public" });
      expect(ph.sent.at(-1)?.properties.$title).toBe("Public");
    }
  });

  test("in-app navigation to a private path stops recording, heatmaps and free-text clicks", async () => {
    const tab = page({ href: "https://example.com/", zone: "America/New_York" });
    createAnalytics({ ...base, preset: "marketing", regionUrl: false, privatePaths: ["/account"] });
    await settle();
    const ph = latest();
    const capture = (root as { capture: (event: string, props: Record<string, unknown>) => void }).capture;
    capture("$$heatmap", {});
    expect(ph.sent.at(-1)).not.toBeNull();
    tab.history.pushState(null, "", "/account");
    expect(ph.recording).toBe(false);
    capture("$$heatmap", {});
    expect(ph.sent.at(-1)).toBeNull();
    capture("$autocapture", { $elements_chain: "div.card:text=\"Balance 120\"nth-child=\"1\"", $el_text: "Balance 120" });
    expect(ph.sent.at(-1)).toBeNull();
    capture("$autocapture", { $elements_chain: "button.save:text=\"Save Jane\"nth-child=\"1\";form", $el_text: "Save Jane" });
    const kept = ph.sent.at(-1)?.properties;
    expect(kept).not.toHaveProperty("$el_text");
    expect(JSON.stringify(kept)).not.toContain("Jane");
  });

  test("an unknown country falls back to this browser's zone, and the fetch carries it", async () => {
    const tab = page({ href: "https://example.com/", zone: "America/New_York" });
    const analytics = createAnalytics({ ...base, preset: "marketing" });
    await settle();
    expect(tab.fetched).toEqual(["/api/region?tz=America%2FNew_York"]);
    expect(analytics.policy()).toMatchObject({ region_group: "us", analytics: "persistent" });
  });

  test("an injected region without a country also defers to the zone; an unknown zone is the EU", async () => {
    page({ href: "https://example.com/", zone: "Asia/Tokyo", region: { country: null, region_group: "eu", gpc: false } });
    const tokyo = createAnalytics({ ...base, preset: "marketing" });
    await settle();
    expect(tokyo.policy()?.region_group).toBe("row");
    afterEachReset();
    page({ href: "https://example.com/", zone: undefined, region: { country: null, region_group: "us", gpc: false } });
    const unknown = createAnalytics({ ...base, preset: "marketing" });
    await settle();
    expect(unknown.policy()?.region_group).toBe("eu");
  });

  test("an EU yes switches the page to a persistent client without a reload", async () => {
    page({ href: "https://example.com/", zone: "Europe/Berlin", region: { country: "DE", region_group: "eu", gpc: false } });
    const analytics = createAnalytics({ ...base, preset: "marketing" });
    await settle();
    const first = latest();
    expect(first.options.cookieless_mode).toBe("always");
    expect(analytics.distinctId()).toBeUndefined();
    expect(analytics.identify("acct_0123456789")).toBe(false);
    analytics.choose("all", "yes");
    await settle();
    const second = latest();
    expect(second).not.toBe(first);
    expect(second.name).toBe("persistent");
    expect(second.options.cookieless_mode).toBeUndefined();
    expect(analytics.distinctId()).toMatch(/^[0-9a-f-]{36}$/u);
    expect(analytics.identify("acct_0123456789")).toBe(true);
    expect(second.identified).toEqual(["acct_0123456789"]);
    // The cookieless client goes quiet.
    expect(first.config.at(-1)).toMatchObject({ autocapture: false, capture_pageview: false });
    const before = first.options.before_send as (event: { event: string; properties: Record<string, unknown> }) => unknown;
    expect(before({ event: "$pageview", properties: {} })).toBeNull();
  });

  test("Meta gets the cleaned address on a tagged landing", async () => {
    const seen: string[] = [];
    page({ href: "https://example.com/?ref=hn&story=two&utm_source=meta&fbclid=abc#top", zone: "America/New_York", region: { country: "US", region_group: "us", gpc: false } });
    createAnalytics({ ...base, preset: "marketing", contentParams: ["story"], onAds: ({ href }) => { seen.push(href); } });
    await settle();
    expect(seen).toEqual(["https://example.com/?utm_source=meta&fbclid=abc"]);
    const { safeAddress } = await import("./meta.js");
    expect(safeAddress(seen[0] ?? "")).toBe(true);
  });

  test("an ads no, GPC and the privacy choices link clear Meta's cookies", async () => {
    const meta = ["_fbp=fb.1.1.1", "_fbc=fb.1.1.abc"];
    const us = { country: "US", region_group: "us", gpc: false };
    let tab = page({ href: "https://example.com/", zone: "America/New_York", region: us, cookies: meta });
    let analytics = createAnalytics({ ...base, preset: "marketing" });
    await settle();
    analytics.choose("ads", "no");
    expect(tab.jar.has("_fbp") || tab.jar.has("_fbc")).toBe(false);
    afterEachReset();

    tab = page({ href: "https://example.com/", zone: "America/New_York", region: us, cookies: meta });
    analytics = createAnalytics({ ...base, preset: "marketing" });
    await settle();
    analytics.privacyChoices();
    expect(tab.jar.has("_fbp") || tab.jar.has("_fbc")).toBe(false);
    afterEachReset();

    tab = page({ href: "https://example.com/", zone: "America/New_York", region: { ...us, gpc: true }, gpc: true, cookies: meta });
    createAnalytics({ ...base, preset: "marketing" });
    await settle();
    expect(tab.jar.has("_fbp") || tab.jar.has("_fbc")).toBe(false);
  });

  test("on a private path no title, link, label or text naming the content reaches PostHog", async () => {
    const tab = page({ href: "https://example.com/", zone: "America/New_York", region: { country: "US", region_group: "us", gpc: false } });
    createAnalytics({ ...base, preset: "marketing", privatePaths: ["/library/*"] });
    await settle();
    const ph = latest();
    const capture = (root as { capture: (event: string, props: Record<string, unknown>) => void }).capture;
    tab.history.pushState(null, "", "/library/secret-song");
    const start = ph.sent.length;
    const here = "https://example.com/library/secret-song";
    capture("$pageview", { $current_url: here, $pathname: "/library/secret-song", title: "Secret Song", $title: "Secret Song" });
    capture("$autocapture", {
      $current_url: here,
      $elements_chain: 'a.track:attr__href="/library/secret-song/2"attr__aria-label="Play Secret Song"attr__title="Secret Song"href="/library/secret-song/2"text="Secret Song"nth-child="1";li:attr__id="Secret Song"attr_id="Secret Song"',
      $elements: [{ tag_name: "a", attr__href: "/library/secret-song/2", "attr__aria-label": "Play Secret Song" }],
      $el_text: "Secret Song",
      $external_click_url: "https://other.example/secret-song",
    });
    capture("$autocapture", {
      $current_url: here,
      $elements_chain: 'button:attr__data-ph="save"attr__name="Secret Song"attr__value="Secret Song"attr__alt="Secret Song"nth-child="2"',
    });
    const sent = ph.sent.slice(start);
    expect(sent.every((event) => event !== null)).toBe(true);
    expect(sent[2]?.properties.$elements_chain).toContain('attr__data-ph="save"');
    const seen: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") seen.push(value);
      else if (Array.isArray(value)) for (const item of value) walk(item);
      else if (typeof value === "object" && value !== null) for (const [key, item] of Object.entries(value)) { seen.push(key); walk(item); }
    };
    walk(sent);
    for (const text of seen) {
      expect(text).not.toContain("Secret Song");
      expect(text).not.toContain("secret-song");
    }
  });

  test("clean.allowProps limits properties, never the event itself", async () => {
    page({ href: "https://example.com/", zone: "America/New_York", region: { country: "US", region_group: "us", gpc: false } });
    createAnalytics({ ...base, preset: "marketing", clean: { allowProps: ["cta"] } });
    await settle();
    const ph = latest();
    const capture = (root as { capture: (event: string, props: Record<string, unknown>) => void }).capture;
    capture("$pageview", { title: "x", cta: "hero", other: "drop me", $current_url: "https://example.com/" });
    const sent = ph.sent.at(-1);
    expect(sent?.event).toBe("$pageview");
    expect(sent?.properties).toMatchObject({ cta: "hero", site_id: "example", $current_url: "https://example.com/" });
    expect(sent?.properties).not.toHaveProperty("other");
    expect(sent?.properties).not.toHaveProperty("title");
  });

  test("no email, fragment or unlisted parameter reaches PostHog in any key or value", async () => {
    page({ href: "https://example.com/p?secret=1&ref=hn#frag", zone: "America/New_York", region: { country: "US", region_group: "us", gpc: false } });
    createAnalytics({ ...base, preset: "marketing" });
    await settle();
    const ph = latest();
    const capture = (root as { capture: (event: string, props: Record<string, unknown>) => void }).capture;
    const start = ph.sent.length;
    const probe = "probe@example.com";
    const dirty = "https://example.com/p?secret=1&ref=hn#frag";
    const point = { x: 1, y: 2, target_fixed: false, type: "click" };
    capture("$pageview", { $current_url: dirty, $pathname: "/p", $title: `Hello ${probe}`, $referrer: `https://other.example/?secret=1#frag`, $prev_pageview_url: dirty });
    capture("$autocapture", {
      $current_url: dirty,
      $elements_chain: `a.nav:attr__href="/p?secret=1&ref=hn#frag"href="/p?secret=1#frag"text="${probe}"nth-child="1"`,
      $elements: [{ tag_name: "a", attr__href: "/p?secret=1#frag", $el_text: probe }],
      $el_text: probe,
    });
    capture("$$heatmap", {
      $current_url: dirty,
      $heatmap_data: {
        [dirty]: [point],
        "https://example.com/p#other": [point],
        "https://example.com/p?secret=2": [point],
        [`https://example.com/u/${probe}?secret=3`]: [point],
      },
    });
    capture("$web_vitals", {
      $current_url: dirty,
      $web_vitals_LCP_value: 1200,
      $web_vitals_LCP_event: { name: "LCP", value: 1200, $current_url: dirty, attribution: { url: dirty, element: "img", navigationEntry: { name: dirty } } },
    });
    capture("$exception", {
      $current_url: dirty,
      $exception_list: [{
        type: "Error",
        value: `failed for ${probe} at ${dirty}`,
        stacktrace: { type: "raw", frames: [{ filename: dirty, abs_path: "https://example.com/app.js?secret=1#frag", function: "go", lineno: 1 }] },
      }],
    });
    const sent = ph.sent.slice(start);
    expect(sent).toHaveLength(5);
    const seen: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") seen.push(value);
      else if (Array.isArray(value)) for (const item of value) walk(item);
      else if (typeof value === "object" && value !== null) for (const [key, item] of Object.entries(value)) { seen.push(key); walk(item); }
    };
    walk(sent);
    for (const text of seen) {
      expect(text).not.toContain(probe);
      expect(text).not.toContain("#frag");
      expect(text).not.toContain("#other");
      expect(text).not.toContain("secret=");
    }
    // Heatmap entries whose addresses clean to the same page are merged, not lost.
    const heatmap = sent[2]?.properties.$heatmap_data as Record<string, unknown[]>;
    expect(heatmap["https://example.com/p"]).toHaveLength(2);
    expect(heatmap["https://example.com/p?ref=hn"]).toHaveLength(1);
    expect(Object.values(heatmap).flat()).toHaveLength(4);
  });

  test("first_landing is the landing's route pattern, never the private path, and old records are reduced too", async () => {
    const kinds: string[] = [];
    const tab = page({ href: "https://example.com/library/items/item-8c1f?utm_source=newsletter", zone: "America/New_York", regionUrl: false });
    createAnalytics({
      ...base,
      preset: "app",
      regionUrl: false,
      privatePaths: ["/library/items/:id"],
      clean: { routes: ["/s/:slug"] },
      landingKind: (path) => { kinds.push(path); return "library"; },
    });
    await settle();
    const ph = latest();
    const capture = (root as { capture: (event: string, props: Record<string, unknown>) => void }).capture;
    capture("$pageview", { $current_url: "https://example.com/library/items/item-8c1f" });
    const props = ph.sent.at(-1)?.properties;
    expect(props).toMatchObject({ first_landing: "/library/items/:id", first_landing_kind: "library", utm_source: "newsletter" });
    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds)).toEqual(new Set(["/library/items/:id"]));
    expect(JSON.stringify(props)).not.toContain("item-8c1f");
    expect([...tab.local.values()].join("")).not.toContain("item-8c1f");

    // A parameterised public route (`clean.routes`) is reduced as well.
    afterEachReset();
    page({ href: "https://example.com/s/private-share-slug", zone: "America/New_York", regionUrl: false });
    createAnalytics({ ...base, preset: "marketing", regionUrl: false, clean: { routes: ["/s/:slug"] } });
    await settle();
    capture("$pageview", {});
    expect(latest().sent.at(-1)?.properties.first_landing).toBe("/s/:slug");

    // A first-touch record kept by 1.0.2 still holds the raw path; it is reduced as it is read.
    afterEachReset();
    const old = {
      id: "0b8f7e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
      touch: { channel: "direct", source: "", landing: "/library/items/item-8c1f", clickKind: "none", week: "2026-11-09", days: 1, last: "2026-11-10" },
    };
    const again = page({ href: "https://example.com/", zone: "America/New_York", regionUrl: false, local: { "example-touch": JSON.stringify(old) } });
    createAnalytics({ ...base, preset: "app", regionUrl: false, privatePaths: ["/library/items/:id"] });
    await settle();
    capture("$pageview", {});
    expect(latest().sent.at(-1)?.properties).toMatchObject({ first_landing: "/library/items/:id", returning: true });
    expect(again.local.get("example-touch")).not.toContain("item-8c1f");
  });

  test("the arrival snapshot taken at load survives a router rewrite before the client is imported", async () => {
    const tab = page({ href: "https://example.com/launch?utm_source=newsletter&utm_campaign=fall&ref=hn&story=night", zone: "America/New_York", regionUrl: false, referrer: "https://news.ycombinator.com/item?id=1" });
    const snapshot = snapshotArrival();
    expect(snapshot).toEqual({ path: "/launch", search: "?utm_source=newsletter&utm_campaign=fall&ref=hn&story=night", referrer: "https://news.ycombinator.com/item?id=1" });
    // The app's router replaces the address long before analytics is loaded.
    tab.history.replaceState(null, "", "/app/home");
    expect(snapshotArrival()).toEqual(snapshot);
    createAnalytics({ ...base, preset: "marketing", regionUrl: false, contentParams: ["story"] });
    await settle();
    const capture = (root as { capture: (event: string, props: Record<string, unknown>) => void }).capture;
    capture("$pageview", {});
    expect(latest().sent.at(-1)?.properties).toMatchObject({
      first_landing: "/launch",
      first_source: "newsletter",
      first_campaign: "fall",
      first_ref: "hn",
      first_story: "night",
      first_referrer_host: "news.ycombinator.com",
      utm_source: "newsletter",
    });
  });

  test("the inline arrival script holds the same snapshot, and a bad one is ignored", async () => {
    page({ href: "https://example.com/from-head?utm_source=newsletter", zone: "America/New_York", regionUrl: false, referrer: "https://www.google.com/search?q=x" });
    // The `<head>` script runs against the page's own window; here, the global scope.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the published inline script exactly as a page would.
    const run = new Function("window", "location", "document", ARRIVAL_SCRIPT) as (scope: unknown, where: unknown, doc: unknown) => void;
    run(globalThis, location, document);
    history.replaceState(null, "", "/elsewhere");
    expect(snapshotArrival()).toEqual({ path: "/from-head", search: "?utm_source=newsletter", referrer: "https://www.google.com/search?q=x" });
    createAnalytics({ ...base, preset: "marketing", regionUrl: false });
    await settle();
    (root as { capture: (event: string, props: Record<string, unknown>) => void }).capture("$pageview", {});
    expect(latest().sent.at(-1)?.properties).toMatchObject({ first_landing: "/from-head", first_channel: "search", utm_source: "newsletter" });

    afterEachReset();
    page({ href: "https://example.com/now", zone: "America/New_York", regionUrl: false });
    for (const bad of [{ path: "no-slash", search: "", referrer: "" }, { path: "/x", search: "utm_source=a", referrer: "" }, { path: "/x", search: "", referrer: 5 }, "nope"]) {
      Object.assign(globalThis, { __hranessArrival: bad });
      expect(snapshotArrival()).toEqual({ path: "/now", search: "", referrer: "" });
      Reflect.deleteProperty(globalThis, "__hranessArrival");
  Reflect.deleteProperty(globalThis, "__hranessExperiments");
    }
  });

  test("a later yes overrides an earlier no: the privacy link and the banner both turn analytics back on", async () => {
    const eu = { country: "DE", region_group: "eu", gpc: false } as const;
    const tab = page({ href: "https://example.com/privacy?analytics=on", zone: "Europe/Berlin", region: eu, cookies: ["example-choice=a%3Dno%26d%3Dno"] });
    const linked = createAnalytics({ ...base, preset: "marketing" });
    await settle();
    // The link answered analytics only; the earlier ads no stands.
    expect(linked.policy()).toMatchObject({ analytics: "persistent", ads: false });
    expect(decodeURIComponent(tab.jar.get("example-choice") ?? "")).toMatch(/^a=yes&d=no&t=\d+$/u);

    // A stale no left in another store (session) gives way to the banner's yes.
    afterEachReset();
    page({ href: "https://example.com/", zone: "Europe/Berlin", region: eu, session: { "example-choice": "a=no&d=no" } });
    const asked = createAnalytics({ ...base, preset: "marketing" });
    await settle();
    expect(asked.policy()?.analytics).toBe("cookieless");
    asked.choose("all", "yes");
    await settle();
    expect(asked.policy()?.analytics).toBe("persistent");
    expect(asked.distinctId()).toMatch(/^[0-9a-f-]{36}$/u);

    // And a later no still wins over that yes.
    asked.choose("all", "no");
    expect(asked.policy()?.analytics).toBe("cookieless");
  });

  test("heatmap data keyed by private or parameterised pages is keyed by the pattern, relative keys too", async () => {
    page({ href: "https://example.com/", zone: "America/New_York", regionUrl: false });
    createAnalytics({ ...base, preset: "marketing", regionUrl: false, privatePaths: ["/library/*"], clean: { routes: ["/s/:slug"] } });
    await settle();
    const ph = latest();
    expect(ph.options.capture_heatmaps).toBe(true);
    const capture = (root as { capture: (event: string, props: Record<string, unknown>) => void }).capture;
    const point = { x: 4, y: 8, target_fixed: false, type: "click" };
    capture("$$heatmap", {
      $current_url: "https://example.com/",
      $heatmap_data: {
        "https://example.com/s/first-share?utm_source=newsletter": [point],
        "https://example.com/s/second-share#top": [point, point],
        "/s/third-share": [point],
        "https://example.com/library/items/a1/notes": [point],
        "https://example.com/pricing": [point],
      },
    });
    const sent = ph.sent.at(-1);
    expect(sent?.event).toBe("$$heatmap");
    const heatmap = sent?.properties.$heatmap_data as Record<string, unknown[]>;
    expect(Object.keys(heatmap).sort()).toEqual([
      "/s/:slug",
      "https://example.com/library/*",
      "https://example.com/pricing",
      "https://example.com/s/:slug",
      "https://example.com/s/:slug?utm_source=newsletter",
    ]);
    expect(heatmap["https://example.com/s/:slug"]).toHaveLength(2);
    expect(Object.values(heatmap).flat()).toHaveLength(6);
    expect(JSON.stringify(heatmap)).not.toMatch(/share|a1/u);
  });

  test("the app preset never turns heatmaps on, so no heatmap data is collected there", async () => {
    page({ href: "https://example.com/", zone: "America/New_York", regionUrl: false });
    createAnalytics({ ...base, preset: "app", regionUrl: false });
    await settle();
    expect(latest().options).toMatchObject({ capture_heatmaps: false, rageclick: false, capture_dead_clicks: false });
  });

  test("a message before the body exists waits for it instead of throwing", () => {
    const tab = page({ href: "https://example.com/?ads=off", zone: "America/New_York", body: false });
    expect(() => createAnalytics({ ...base, preset: "marketing" })).not.toThrow();
    expect(tab.domLoaded).toHaveLength(1);
  });

  test("an assignment made before the client is reported once: $feature/<key> on later events, one exposure", async () => {
    page({ href: "https://example.com/?exp-other=b", zone: "America/New_York", regionUrl: false });
    const header = { key: "header-cta", variants: ["control", "free"] } as const;
    const made = assign(header, { siteId: "example" });
    const forced = assign({ key: "other", variants: ["a", "b"] }, { siteId: "example" });
    expect(forced.source).toBe("override");
    const analytics = createAnalytics({ ...base, preset: "marketing", regionUrl: false, clean: { allowProps: ["cta"] } });
    analytics.expose(made);
    analytics.expose(forced);
    await settle();
    analytics.expose(assign(header, { siteId: "example" }));
    analytics.track("cta clicked", { cta: "download", placement: "header" });
    const sent = latest().sent.filter((event) => event !== null);
    const exposures = sent.filter((event) => event.event === "$feature_flag_called");
    expect(exposures).toHaveLength(1);
    expect(exposures[0]?.properties).toMatchObject({ $feature_flag: "header-cta", $feature_flag_response: made.variant, "$feature/header-cta": made.variant });
    expect(sent.at(-1)?.properties).toMatchObject({ "$feature/header-cta": made.variant, cta: "download" });
    // The override is never reported, so QA visits stay out of the results.
    expect(sent.some((event) => event.properties.$feature_flag === "other" || "$feature/other" in event.properties)).toBe(false);
  });

  test("the client adopts the page's experiment ID when it starts persistent analytics, so the variant holds", async () => {
    const tab = page({ href: "https://example.com/", zone: "America/New_York", regionUrl: false });
    const made = assign({ key: "header-cta", variants: ["control", "free"] }, { siteId: "example" });
    expect(made.source).toBe("page");
    createAnalytics({ ...base, preset: "marketing", regionUrl: false });
    await settle();
    const id = tab.jar.get("example-id");
    expect(id).toBe((globalThis as { __hranessExperiments?: { id?: string } }).__hranessExperiments?.id);
    Reflect.deleteProperty(globalThis, "__hranessExperiments");
    expect(assign({ key: "header-cta", variants: ["control", "free"] }, { siteId: "example" })).toEqual({ ...made, source: "id" });
  });

  test("a cookieless visit reports the exposure and stores nothing; an EU yes reports it again", async () => {
    const eu = { country: "DE", region_group: "eu", gpc: false } as const;
    const tab = page({ href: "https://example.com/", zone: "Europe/Berlin", region: eu });
    const made = assign({ key: "header-cta", variants: ["control", "free"] }, { siteId: "example" });
    const analytics = createAnalytics({ ...base, preset: "marketing" });
    await settle();
    expect(latest().options.cookieless_mode).toBe("always");
    expect(latest().sent.filter((event) => event?.event === "$feature_flag_called").at(-1)?.properties).toMatchObject({ $feature_flag_response: made.variant });
    expect(tab.jar.has("example-id")).toBe(false);
    expect(tab.local.size).toBe(0);

    // An EU yes: the persistent client reports the exposure again under its new ID, the page's experiment ID.
    analytics.choose("all", "yes");
    await settle();
    const second = latest();
    expect(second.name).toBe("persistent");
    expect(second.sent.filter((event) => event?.event === "$feature_flag_called").at(-1)?.properties).toMatchObject({ $feature_flag: "header-cta", $feature_flag_response: made.variant });
    expect(tab.jar.get("example-id")).toBe((globalThis as { __hranessExperiments?: { id?: string } }).__hranessExperiments?.id);
  });
});

function afterEachReset() {
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  saved.clear();
  Reflect.deleteProperty(globalThis, "__hranessArrival");
  Reflect.deleteProperty(globalThis, "__hranessExperiments");
}
