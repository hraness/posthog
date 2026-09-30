import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

import {
  createPostHogBeforeSend,
  createPostHogBrowserConfig,
  isPostHogBrowserEligible,
  readDelegatedAnalyticsEvent,
} from "./client";
import { POSTHOG_SCHEMA_VERSION, type PostHogSiteDefinition } from "./site";

const site = {
  id: "example",
  canonicalDomain: "example.com",
  allowedHosts: ["example.com"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [{ match: "exact", path: "/", pageKind: "home" }],
  customEvents: ["cta opened"],
} satisfies PostHogSiteDefinition;

const evidence = {
  hostname: "example.com",
  href: "https://example.com/?secret=value",
  referrer: "https://www.google.com/search?q=private",
  production: true,
};

test("browser configuration disables replay, autocapture, identity, flags, and persistence", () => {
  const config = createPostHogBrowserConfig(site, evidence);
  expect(config).toMatchObject({
    autocapture: false,
    rageclick: false,
    capture_exceptions: false,
    enable_recording_console_log: false,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_flags: true,
    person_profiles: "never",
    persistence: "memory",
    cookieless_mode: "always",
    respect_dnt: true,
  });
});

test("Web Vitals callbacks are available before eligible browser initialization", () => {
  // Isolate the browser global from Bun's already-imported server modules.
  // Importing alone must register callbacks without starting any observers.
  const registration = execFileSync(process.execPath, ["--eval", `
    globalThis.window = globalThis;
    await import(${JSON.stringify(import.meta.dir + "/client.ts")});
    const callbacks = window.__PosthogExtensions__?.postHogWebVitalsCallbacksByFlavor?.["web-vitals"];
    console.log(JSON.stringify(Object.entries(callbacks ?? {}).map(([name, fn]) => [name, typeof fn]).sort()));
  `], { encoding: "utf8", timeout: 10_000 });
  expect(JSON.parse(registration)).toEqual([
    ["onCLS", "function"], ["onFCP", "function"],
    ["onINP", "function"], ["onLCP", "function"],
  ]);
  expect(createPostHogBrowserConfig(site, evidence).capture_performance).toEqual({
    network_timing: false,
    web_vitals: true,
    web_vitals_allowed_metrics: ["LCP", "CLS", "FCP", "INP"],
    web_vitals_attribution: false,
  });
});

test("browser eligibility requires a canonical production host and public project key", () => {
  expect(isPostHogBrowserEligible({ site, apiKey: "phc_public", evidence })).toBe(true);
  expect(isPostHogBrowserEligible({
    site,
    apiKey: "phc_public",
    evidence: { ...evidence, hostname: "preview.vercel.app" },
  })).toBe(false);
  expect(isPostHogBrowserEligible({
    site,
    apiKey: "phx_secret",
    evidence,
  })).toBe(false);
});

test("before-send drops unknown events and decorates approved events for SEO analysis", () => {
  const beforeSend = createPostHogBeforeSend(site, () => evidence);
  expect(beforeSend({
    uuid: "1",
    event: "unknown event",
    properties: { token: "phc_public" },
  })).toBeNull();
  expect(beforeSend({
    uuid: "2",
    event: "$pageview",
    properties: {
      $current_url: evidence.href,
      token: "phc_public",
      campaign: "phc_redact_me",
    },
  })?.properties).toMatchObject({
    $current_url: "https://example.com/",
    token: "phc_public",
    campaign: "[credential]",
    canonical_path: "/",
    page_kind: "home",
    traffic_channel: "organic_search",
    traffic_source: "google",
    $process_person_profile: false,
  });
  expect(beforeSend({
    uuid: "3",
    event: "$pageview",
    properties: { $current_url: evidence.href },
  })).toBeNull();
});

test("attributes ChatGPT UTM pageviews when the referrer is unavailable", () => {
  const href = "https://example.com/?utm_source=chatgpt.com&utm_term=private";
  const beforeSend = createPostHogBeforeSend(site, () => ({
    href,
    referrer: "",
  }));

  const capture = beforeSend({
    uuid: "ai-referral",
    event: "$pageview",
    properties: {
      $current_url: href,
      $utm_source: "chatgpt.com",
      token: "phc_public",
      utm_term: "private",
    },
  });

  expect(capture?.properties).toMatchObject({
    $current_url: "https://example.com/?utm_source=chatgpt.com&utm_term=private",
    $host: "example.com",
    canonical_path: "/",
    traffic_channel: "ai_referral",
    traffic_source: "chatgpt",
    utm_term: "private",
  });
});

test("delegated links collapse owned routes and omit foreign paths", () => {
  const descriptors = new Map(
    ["Element", "HTMLElement", "HTMLAnchorElement", "window"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  class FakeElement {
    constructor(readonly matched: FakeHTMLElement | null = null) {}
    closest(): FakeHTMLElement | null {
      return this.matched;
    }
  }
  class FakeHTMLElement extends FakeElement {
    constructor(
      readonly dataset: Record<string, string>,
      matched: FakeHTMLElement | null = null,
    ) {
      super(matched);
    }
  }
  class FakeAnchorElement extends FakeHTMLElement {
    constructor(dataset: Record<string, string>, readonly href: string) {
      super(dataset);
    }
  }
  const setGlobal = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  };

  try {
    setGlobal("Element", FakeElement);
    setGlobal("HTMLElement", FakeHTMLElement);
    setGlobal("HTMLAnchorElement", FakeAnchorElement);
    setGlobal("window", { location: { href: "https://example.com/" } });
    const delegatedSite = {
      ...site,
      delegatedEvents: ["cta opened"],
      unknownCanonicalPath: "/not-found",
    } satisfies PostHogSiteDefinition;
    const owned = new FakeAnchorElement(
      {
        analyticsEvent: "cta opened",
        analyticsId: "  primary\u0000cta  ",
        analyticsKind: "navigation",
      },
      "https://example.com/private/alice?token=secret",
    );
    const foreign = new FakeAnchorElement(
      { analyticsEvent: "cta opened" },
      "https://outside.example/private/alice?token=secret",
    );

    expect(readDelegatedAnalyticsEvent(
      delegatedSite,
      new FakeElement(owned) as unknown as EventTarget,
    )).toEqual({
      eventName: "cta opened",
      properties: {
        target_kind: "navigation",
        target_id: "primary cta",
        target_host: "example.com",
        target_path: "/not-found",
      },
    });
    expect(readDelegatedAnalyticsEvent(
      delegatedSite,
      new FakeElement(foreign) as unknown as EventTarget,
    )).toEqual({
      eventName: "cta opened",
      properties: { target_host: "outside.example" },
    });
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});

test("delegated parsing is a no-op without a DOM", () => {
  expect(readDelegatedAnalyticsEvent(site, null)).toBeNull();
});

test("SDK entry points send no analytics before regional permission and stop after refusal", () => {
  const result = execFileSync(process.execPath, ["--eval", `
    import { posthog } from "posthog-js";
    const events = new EventTarget();
    let choice = null;
    let resolveRegion;
    const requests = [];
    globalThis.window = {
      localStorage: { getItem: () => choice },
      addEventListener: (...args) => events.addEventListener(...args),
      removeEventListener: (...args) => events.removeEventListener(...args),
    };
    globalThis.fetch = (url, options) => {
      requests.push({ url, credentials: options.credentials });
      return new Promise(resolve => { resolveRegion = resolve; });
    };
    let initialized = 0, captured = 0, ready = 0, cleaned = 0;
    posthog.init = () => { initialized++; };
    posthog.capture = () => { captured++; };
    const client = await import(${JSON.stringify(import.meta.dir + "/client.ts")});
    const site = ${JSON.stringify(site)};
    const evidence = ${JSON.stringify(evidence)};
    const options = { site, evidence, apiKey: "phc_public" };
    const before = client.initializePostHogBrowser(options);
    const dispose = client.observePostHogBrowser(options, () => { ready++; return () => { cleaned++; }; });
    const blocked = client.capturePostHogEvent(site, "cta opened");
    const pending = { initialized, captured, ready, before, blocked };
    resolveRegion(new Response(JSON.stringify({ required: false })));
    await new Promise(resolve => setTimeout(resolve, 0));
    const allowed = client.capturePostHogEvent(site, "cta opened");
    const config = client.createPostHogBrowserConfig(site, evidence);
    const event = { uuid: "1", event: "$pageview", properties: { token: "phc_public" } };
    const sends = config.before_send(event) !== null;
    choice = "declined";
    const storage = new Event("storage");
    Object.defineProperty(storage, "key", { value: "hraness-consent-cookies-v1" });
    events.dispatchEvent(storage);
    const denied = client.capturePostHogEvent(site, "cta opened");
    const deniedSend = config.before_send(event);
    dispose();
    console.log(JSON.stringify({ pending, initialized, captured, ready, cleaned, allowed, sends, denied, deniedSend, requests }));
  `], { encoding: "utf8", timeout: 10_000 });
  expect(JSON.parse(result)).toEqual({
    pending: { initialized: 0, captured: 0, ready: 0, before: false, blocked: false },
    initialized: 1, captured: 1, ready: 1, cleaned: 1,
    allowed: true, sends: true, denied: false, deniedSend: null,
    requests: [{ url: "https://account.hraness.com/api/consent/region", credentials: "omit" }],
  });
});

test("a departing-page URL controls host and path while referrer paths remain private", () => {
  const beforeSend = createPostHogBeforeSend(site, () => ({ href: "https://example.com/new", referrer: "" }));
  const result = beforeSend({ uuid: "old-page", event: "cta opened", properties: {
    token: "phc_public", $host: "spoofed.example", $current_url: "https://example.com/old",
    $pathname: "/new", $session_entry_referrer: "https://outside.example/private?q=secret",
  } });
  expect(result?.properties).toMatchObject({
    $host: "example.com", $pathname: "/old", canonical_path: "/old",
    $session_entry_referrer: "https://outside.example",
  });
});
