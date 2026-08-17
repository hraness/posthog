import { expect, test } from "bun:test";

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
  const privacySafeSite = {
    ...site,
    stripQueryAttribution: true,
  } satisfies PostHogSiteDefinition;
  const beforeSend = createPostHogBeforeSend(privacySafeSite, () => ({
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
    $current_url: "https://example.com/",
    canonical_path: "/",
    traffic_channel: "ai_referral",
    traffic_source: "chatgpt",
  });
  expect(capture?.properties).not.toHaveProperty("$utm_source");
  expect(capture?.properties).not.toHaveProperty("utm_term");
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
