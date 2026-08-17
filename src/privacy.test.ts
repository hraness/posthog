import { expect, test } from "bun:test";

import { createPostHogBeforeSend } from "./client";
import { POSTHOG_SCHEMA_VERSION, type PostHogSiteDefinition } from "./site";

const site = {
  id: "privacy-safe-example",
  canonicalDomain: "example.com",
  allowedHosts: ["example.com"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [{ match: "exact", path: "/", pageKind: "home" }],
  customEvents: [],
  stripQueryAttribution: true,
  unknownCanonicalPath: "/not-found",
} satisfies PostHogSiteDefinition;

test("before-send collapses every provider pathname and removes query attribution", () => {
  const beforeSend = createPostHogBeforeSend(site, () => ({
    href: "https://example.com/private-fallback-value?utm_campaign=private",
    referrer: "",
  }));
  const capture = beforeSend({
    uuid: "provider-shaped",
    event: "$pageview",
    properties: {
      $current_url: "https://example.com/private-current-value?utm_term=private",
      $pathname: "/private-current-value",
      $prev_pageview_pathname: "/private-previous-value",
      $session_entry_pathname: "/private-session-value",
      $session_entry_utm_campaign: "private-session-campaign",
      token: "phc_public",
      utm_campaign: "private-current-campaign",
    },
  });

  expect(capture?.properties).toMatchObject({
    $current_url: "https://example.com/not-found",
    $pathname: "/not-found",
    $prev_pageview_pathname: "/not-found",
    $session_entry_pathname: "/not-found",
    canonical_path: "/not-found",
    page_kind: "other",
  });
  expect(capture?.properties).not.toHaveProperty("utm_campaign");
  expect(capture?.properties).not.toHaveProperty("$session_entry_utm_campaign");
});
