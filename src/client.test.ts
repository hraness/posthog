import { expect, test } from "bun:test";

import {
  createPostHogBeforeSend,
  createPostHogBrowserConfig,
  isPostHogBrowserEligible,
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
