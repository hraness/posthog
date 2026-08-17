import { expect, test } from "bun:test";

import {
  analyticsErrorFingerprint,
  ExceptionBudget,
  normalizeAnalyticsProperties,
  sanitizeAnalyticsError,
  sanitizeProviderProperties,
} from "./event";
import { POSTHOG_SCHEMA_VERSION, type PostHogSiteDefinition } from "./site";

const site = {
  id: "example",
  canonicalDomain: "example.com",
  allowedHosts: ["example.com"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [],
  customEvents: [],
} satisfies PostHogSiteDefinition;

test("keeps only bounded explicit primitive properties", () => {
  expect(normalizeAnalyticsProperties({
    mode: "sleep",
    count: 2,
    okay: true,
    nested: { secret: true },
    BadKey: "ignored",
    invalid: Number.NaN,
  })).toEqual({ mode: "sleep", count: 2, okay: true });
});

test("redacts queries and referrer paths while preserving provider payload shape", () => {
  expect(sanitizeProviderProperties(site, {
    $current_url: "https://example.com/research/sleep?email=a@example.com#private",
    $referrer: "https://chatgpt.com/c/private?token=secret",
    campaign: "launch for a@example.com with api_key=private",
    nested: {
      canonical: { href: "https://example.com/public?q=private" },
      external: { href: "https://example.org/public?q=private" },
    },
  })).toEqual({
    $current_url: "https://example.com/research/sleep",
    $referrer: "https://chatgpt.com",
    campaign: "launch for [email] with api_key=[redacted]",
    nested: {
      canonical: { href: "https://example.com/public" },
      external: { href: "https://example.org" },
    },
  });
});

test("collapses unknown owned provider URLs when the site requires it", () => {
  const privacySafeSite = {
    ...site,
    stripQueryAttribution: true,
    unknownCanonicalPath: "/not-found",
  } satisfies PostHogSiteDefinition;

  const attributionKeys = [
    "_kx",
    "dclid",
    "epik",
    "fbclid",
    "gad_source",
    "gbraid",
    "gclid",
    "gclsrc",
    "igshid",
    "irclid",
    "li_fat_id",
    "mc_cid",
    "msclkid",
    "qclid",
    "rdt_cid",
    "sccid",
    "ttclid",
    "twclid",
    "utm_campaign",
    "utm_content",
    "utm_medium",
    "utm_source",
    "utm_term",
    "wbraid",
  ] as const;
  const sanitized = sanitizeProviderProperties(privacySafeSite, {
    ...Object.fromEntries(attributionKeys.map((key) => [key, `private-${key}`])),
    $current_url: "https://example.com/private/alice@example.com?token=secret",
    $initial_current_url: "https://example.com/another/private-value",
    $initial_campaign_params: { utm_campaign: "private-initial-value" },
    $initial_pathname: "/private-initial-value",
    $pathname: "/private-current-value",
    $prev_pageview_pathname: "/private-previous-value",
    $session_entry_pathname: "/private-session-value",
    $session_entry_utm_source: "private-session-source",
    safe_count: 2,
  });
  expect(sanitized).toEqual({
    $current_url: "https://example.com/not-found",
    $initial_current_url: "https://example.com/not-found",
    $initial_pathname: "/not-found",
    $pathname: "/not-found",
    $prev_pageview_pathname: "/not-found",
    $session_entry_pathname: "/not-found",
    safe_count: 2,
  });
  for (const key of attributionKeys) {
    expect(sanitized).not.toHaveProperty(key);
  }
});

test("keeps explicit attribution for sites that do not opt out", () => {
  expect(sanitizeProviderProperties(site, {
    $session_entry_utm_source: "release-notes",
    utm_campaign: "public-launch",
  })).toEqual({
    $session_entry_utm_source: "release-notes",
    utm_campaign: "public-launch",
  });
});

test("bounds generic provider strings before transmission", () => {
  expect(String(sanitizeProviderProperties(site, {
    campaign: "x".repeat(3_000),
  }).campaign)).toHaveLength(2_048);
});

test("sanitizes errors and fingerprints equivalent failures", () => {
  const first = new Error("Failed for a@example.com at https://example.com/path?token=secret");
  const sanitized = sanitizeAnalyticsError(first);
  expect(sanitized.message).toBe("Failed for [email] at https://example.com/path");
  expect(analyticsErrorFingerprint(sanitized)).toBe(analyticsErrorFingerprint(sanitized));
  expect(sanitizeAnalyticsError({ private: "value" }).message).toBe("Non-Error rejection");
});

test("exception budget preserves first occurrences and bounds repeats", () => {
  const budget = new ExceptionBudget({ totalLimit: 3, perFingerprintLimit: 2, windowMs: 100 });
  expect(budget.allow("a", 0)).toBe(true);
  expect(budget.allow("a", 1)).toBe(true);
  expect(budget.allow("a", 2)).toBe(false);
  expect(budget.allow("b", 2)).toBe(true);
  expect(budget.allow("c", 2)).toBe(false);
  expect(budget.allow("a", 101)).toBe(true);
});
