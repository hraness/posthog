import { expect, test } from "bun:test";

import {
  classifyAnalyticsRoute,
  normalizeAnalyticsPathname,
  isSensitiveAnalyticsPath,
  POSTHOG_SCHEMA_VERSION,
  type PostHogSiteDefinition,
} from "./site";

const site = {
  id: "example",
  canonicalDomain: "example.com",
  allowedHosts: ["example.com", "www.example.com"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [
    { match: "exact", path: "/", pageKind: "home" },
    {
      match: "prefix",
      path: "/research",
      pageKind: "article",
      contentGroup: "research",
      captureSlug: true,
    },
  ],
  customEvents: [],
} satisfies PostHogSiteDefinition;

test("classifies canonical routes without query strings or fragments", () => {
  expect(classifyAnalyticsRoute(site, "https://www.example.com/research/sleep?q=secret#notes"))
    .toEqual({
      analytics_schema_version: 2,
      site_id: "example",
      canonical_domain: "example.com",
      canonical_path: "/research/sleep",
      page_kind: "article",
      content_group: "research",
      content_slug: "sleep",
    });
});

test("rejects foreign hosts and retains unknown canonical paths as other", () => {
  expect(classifyAnalyticsRoute(site, "https://attacker.example/research/sleep")).toBeNull();
  expect(classifyAnalyticsRoute(site, "https://example.com/missing")?.page_kind).toBe("other");
});

test("optionally collapses unknown owned paths without inferring a category", () => {
  const privacySafeSite = {
    ...site,
    unknownCanonicalPath: "/not-found",
  } satisfies PostHogSiteDefinition;

  expect(classifyAnalyticsRoute(
    privacySafeSite,
    "https://example.com/missing/private-value?secret=yes",
  )).toMatchObject({
    canonical_path: "/not-found",
    page_kind: "other",
  });
});

test("normalizes path shape", () => {
  expect(normalizeAnalyticsPathname("research//sleep/?q=1#x")).toBe("/research/sleep");
});


test("normalizes long slash runs with a bounded canonical result", () => {
  const separators = "/".repeat(100_000);
  expect(normalizeAnalyticsPathname(separators)).toBe("/");
  expect(normalizeAnalyticsPathname(`${separators}research${separators}sleep${separators}?secret=yes`)).toBe("/research/sleep");
  expect(normalizeAnalyticsPathname(`research${separators}sleep`)).toBe("/research/sleep");
});

test("route permissions are segment-aware, allowlisted, and exclusion wins", () => {
  const policy = { ...site,
    allowedPaths: [{ match: "prefix" as const, path: "/eds" }],
    excludedPaths: [{ match: "prefix" as const, path: "/eds/private" }],
  };
  expect(classifyAnalyticsRoute(policy, "https://example.com/eds")).not.toBeNull();
  expect(classifyAnalyticsRoute(policy, "https://example.com/eds/docs")).not.toBeNull();
  for (const path of ["/", "/edss", "/eds/private", "/eds/private/user", "/eds/%70rivate/user", "/eds/%ZZ"]) {
    expect(classifyAnalyticsRoute(policy, `https://example.com${path}`)).toBeNull();
  }
  expect(classifyAnalyticsRoute({ ...site, allowedPaths: [] }, "https://example.com/")).toBeNull();
  const privatePolicy = { ...site, excludedPaths: [{ match: "prefix" as const, path: "/p" }] };
  expect(classifyAnalyticsRoute(privatePolicy, "https://example.com/privacy")).not.toBeNull();
  expect(classifyAnalyticsRoute(privatePolicy, "https://example.com/p/person")).toBeNull();
  expect(classifyAnalyticsRoute(privatePolicy, "https://example.com/%70/person")).toBeNull();
  expect(isSensitiveAnalyticsPath({ ...site, sensitivePaths: [{ match: "prefix", path: "/auth" }] }, "/%61uth/callback")).toBe(true);
});
