import { expect, test } from "bun:test";

import { POSTHOG_SCHEMA_VERSION, type PostHogSiteDefinition } from "./site";
import { classifyAnalyticsTraffic } from "./traffic";

const site = {
  id: "example",
  canonicalDomain: "example.com",
  allowedHosts: ["example.com", "www.example.com"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [],
  customEvents: [],
} satisfies PostHogSiteDefinition;

test("classifies direct, internal, search, AI, social, and referral sources", () => {
  expect(classifyAnalyticsTraffic(site, "")).toEqual({
    traffic_channel: "direct",
    traffic_source: "direct",
  });
  expect(classifyAnalyticsTraffic(site, "https://example.com/article").traffic_channel).toBe("internal");
  expect(classifyAnalyticsTraffic(site, "https://www.google.com/search?q=noise")).toMatchObject({
    traffic_channel: "organic_search",
    traffic_source: "google",
  });
  expect(classifyAnalyticsTraffic(site, "https://chatgpt.com/c/secret")).toMatchObject({
    traffic_channel: "ai_referral",
    traffic_source: "chatgpt",
    referrer_host: "chatgpt.com",
  });
  expect(classifyAnalyticsTraffic(site, "https://reddit.com/r/sleep").traffic_channel).toBe("social");
  expect(classifyAnalyticsTraffic(site, "https://example.org/private/path")).toEqual({
    traffic_channel: "referral",
    traffic_source: "example.org",
    referrer_host: "example.org",
  });
});

test("recognizes privacy-safe search and AI UTM attribution without a referrer", () => {
  expect(classifyAnalyticsTraffic(
    site,
    "",
    "https://example.com/research?utm_source=chatgpt.com&utm_term=private",
  )).toEqual({
    traffic_channel: "ai_referral",
    traffic_source: "chatgpt",
  });
  expect(classifyAnalyticsTraffic(
    site,
    "",
    "https://example.com/research?utm_source=google",
  )).toEqual({
    traffic_channel: "organic_search",
    traffic_source: "google",
  });
  expect(classifyAnalyticsTraffic(
    site,
    "",
    "https://example.com/research?utm_source=private-campaign",
  )).toEqual({
    traffic_channel: "direct",
    traffic_source: "direct",
  });
});
