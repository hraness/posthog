import { expect, test } from "bun:test";

import {
  ctaClickedProperties,
  installCommandCopiedProperties,
  isStandardAnalyticsEventName,
  outboundLinkOpenedProperties,
  pageNotFoundProperties,
} from "./event";
import { POSTHOG_SCHEMA_VERSION, type PostHogSiteDefinition } from "./site";
import { checkPostHogContract, runPostHogHarness } from "./testing";

const site = {
  id: "contract-example",
  canonicalDomain: "example.com",
  allowedHosts: ["example.com", "www.example.com"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [
    { match: "exact", path: "/", pageKind: "home" },
    { match: "exact", path: "/pricing", pageKind: "pricing" },
    { match: "prefix", path: "/auth", pageKind: "auth" },
  ],
  customEvents: ["cta clicked", "install command copied"],
  sensitivePaths: [{ match: "prefix", path: "/auth" }],
  unknownCanonicalPath: "/not-found",
} satisfies PostHogSiteDefinition;

test("real posthog-js requests meet the observability test contract", () => {
  const report = checkPostHogContract({
    site,
    publicPath: "/pricing",
    sensitivePath: "/auth/callback",
    customEvents: [
      { event: "cta clicked", properties: { cta: "start_trial", placement: "hero" } },
      { event: "install command copied", properties: { install_method: "brew", placement: "hero" } },
    ],
  });
  expect(report.violations).toEqual([]);
  const pageview = report.result.sent.find((event) => event.event === "$pageview");
  expect(pageview?.properties).toMatchObject({
    $host: "example.com",
    $current_url: "https://example.com/pricing?utm_source=contract&gclid=contractclick",
    $pathname: "/pricing",
    $referrer: "https://news.example.org",
    $cookieless_mode: true,
    analytics_schema_version: 2,
    site_id: "contract-example",
  });
}, 30_000);

test("the contract reports a site that leaks or drops required properties", () => {
  const report = checkPostHogContract({
    site: { ...site, customEvents: ["Clicked CTA"], sensitivePaths: [] },
    sensitivePath: "/auth/callback",
  });
  expect(report.violations).toContain("Clicked CTA: custom event name breaks the lowercase object-verb rule");
  expect(report.violations.some((violation) => violation.includes("/auth/callback: kept"))).toBe(true);
}, 30_000);

test("the harness returns what before_send received and returned", () => {
  const result = runPostHogHarness({
    site,
    scenarios: [{ href: "https://example.com/", captures: [{ event: "not allowed" }] }],
  });
  expect(result.received).toHaveLength(1);
  expect(result.returned).toEqual([null]);
  expect(result.sent).toEqual([]);
}, 30_000);

test("standard event helpers accept the vocabulary and reject everything else", () => {
  expect(pageNotFoundProperties({
    requestedPath: "/Docs//missing/?email=a@example.com#x",
    referrer: "https://www.google.com/search?q=private",
  })).toEqual({ requested_path: "/Docs/missing", referrer_host: "google.com" });
  expect(pageNotFoundProperties({ requestedPath: "/u/a@example.com", referrer: "$direct" }))
    .toEqual({ requested_path: "/u/[email]" });
  expect(pageNotFoundProperties({ requestedPath: 3 })).toBeNull();

  expect(ctaClickedProperties({ cta: "start_trial", placement: "hero", targetHost: "https://www.github.com/x" }))
    .toEqual({ cta: "start_trial", placement: "hero", target_host: "github.com" });
  expect(ctaClickedProperties({ cta: "Start Trial", placement: "hero" })).toBeNull();
  expect(ctaClickedProperties({ cta: "start_trial", placement: "sidebar" })).toBeNull();

  expect(outboundLinkOpenedProperties({ targetHost: "github.com", placement: "footer", linkKind: "github" }))
    .toEqual({ target_host: "github.com", placement: "footer", link_kind: "github" });
  expect(outboundLinkOpenedProperties({ targetHost: "github.com", placement: "footer", linkKind: "repo" }))
    .toBeNull();

  expect(installCommandCopiedProperties({ installMethod: "brew", placement: "hero" }))
    .toEqual({ install_method: "brew", placement: "hero" });
  expect(installCommandCopiedProperties({ installMethod: "brew install x", placement: "hero" })).toBeNull();

  expect(isStandardAnalyticsEventName("conversion targets viewed")).toBe(true);
  expect(isStandardAnalyticsEventName("footer_experiment_exposed")).toBe(false);
  expect(isStandardAnalyticsEventName("CTA Clicked")).toBe(false);
});

test("sensitive navigation cannot persist attribution into later public events", () => {
  for (const startPublic of [false, true]) {
    const hrefs = [
      ...(startPublic ? ["https://example.com/?utm_source=public&gclid=publicclick"] : []),
      "https://example.com/auth/callback?utm_source=private&gclid=privateclick",
      "https://example.com/pricing?utm_source=later&gclid=laterclick",
    ];
    const result = runPostHogHarness({
      site,
      scenarios: hrefs.map((href) => ({ href, captures: [{ event: "$pageview" }] })),
    });
    expect(result.sent).toHaveLength(hrefs.length);
    for (const event of result.sent.slice(startPublic ? 1 : 0)) {
      const serialized = JSON.stringify(event.properties);
      expect(serialized).not.toContain("utm_source");
      expect(serialized).not.toContain("gclid");
      expect(serialized).not.toContain("privateclick");
    }
  }
}, 30_000);

test("real SDK drops excluded SPA routes and queued URLs, then resumes public capture", () => {
  const result = runPostHogHarness({
    site: { ...site, excludedPaths: [{ match: "prefix", path: "/p" }] },
    scenarios: [
      { href: "https://example.com/?utm_source=public", captures: [{ event: "$pageview" }] },
      { href: "https://example.com/p/private?utm_source=private", captures: [
        { event: "$pageview" }, { event: "$pageleave", properties: { $current_url: "https://example.com/" } },
      ] },
      { href: "https://example.com/%70/private?utm_source=private", captures: [{ event: "$pageview" }] },
      { href: "https://example.com/pricing", captures: [
        { event: "$pageview", properties: { $current_url: "https://example.com/%70/private" } },
        { event: "$pageview", properties: { $current_url: "https://example.com/p/private" } },
        { event: "$pageview" },
      ] },
    ],
  });
  expect(result.sent.map(event => event.properties.$current_url)).toEqual([
    "https://example.com/?utm_source=public", "https://example.com/pricing",
  ]);
  expect(JSON.stringify(result.sent)).not.toContain("private");
});

test("contract accepts excluded private routes only when no request is sent", () => {
  expect(checkPostHogContract({
    site: { ...site, excludedPaths: [{ match: "prefix", path: "/auth" }] },
    publicPath: "/pricing", sensitivePath: "/auth/callback",
  }).violations).toEqual([]);
});

test("real SDK honors minimal privacy with the production contract checker", () => {
  const report = checkPostHogContract({ site: { ...site, privacyMode: "minimal" }, sensitivePath: "/auth/callback" });
  expect(report.violations).toEqual([]);
});

test("real SDK honors referrer-only attribution on every route", () => {
  const report = checkPostHogContract({ site: { ...site, attributionMode: "referrer_only" }, sensitivePath: "/auth/callback" });
  expect(report.violations).toEqual([]);
  for (const event of report.result.sent) {
    expect(String(event.properties.$current_url)).not.toContain("?");
    expect(event.properties.traffic_source).toBe("news.example.org");
    expect(JSON.stringify(event.properties)).not.toMatch(/utm_source|gclid|contractclick/);
  }
});

test("stable UUIDs reach actual SDK wire events across independent page loads", () => {
  const uuid = "01234567-89ab-4def-abcd-0123456789ab";
  const options = { site, scenarios: [{ href: "https://example.com/", captures: [{ event: "cta clicked", uuid }] }] };
  const first = runPostHogHarness(options).sent;
  const reloaded = runPostHogHarness(options).sent;
  expect(first).toHaveLength(1);
  expect(reloaded).toHaveLength(1);
  expect(first[0]?.uuid).toBe(uuid);
  expect(reloaded[0]?.uuid).toBe(uuid);
});
