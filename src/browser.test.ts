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
const { createAnalytics } = await import("./browser.js");

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

type PageOptions = { href: string; zone?: string | undefined; region?: unknown; regionUrl?: string | false; gpc?: boolean; body?: boolean; cookies?: string[] };
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
    referrer: "",
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
  const store = () => {
    const map = new Map<string, string>();
    return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
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
  setGlobal("localStorage", store());
  setGlobal("sessionStorage", store());
  setGlobal("fetch", (address: string) => {
    fetched.push(address);
    return Promise.resolve(new Response(JSON.stringify({ country: null, region_group: "eu", gpc: false, policy: {} })));
  });
  const realFormat = Intl.DateTimeFormat;
  setGlobal("Intl", { ...Intl, DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: options.zone }) }) });
  void realFormat;
  return { jar, cleared, fetched, body, domLoaded, location, history };
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

  test("a message before the body exists waits for it instead of throwing", () => {
    const tab = page({ href: "https://example.com/?ads=off", zone: "America/New_York", body: false });
    expect(() => createAnalytics({ ...base, preset: "marketing" })).not.toThrow();
    expect(tab.domLoaded).toHaveLength(1);
  });
});

function afterEachReset() {
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  saved.clear();
}
