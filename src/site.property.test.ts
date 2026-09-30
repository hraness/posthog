import { expect, test } from "bun:test";
import * as fc from "fast-check";
import { isAllowedAnalyticsPath } from "./site";

test("property: private subtree exclusions override even a universal allowlist", () => {
  fc.assert(fc.property(fc.string(), suffix => {
    const site = {
      id: "private", canonicalDomain: "example.com", allowedHosts: ["example.com"],
      schemaVersion: 2, routes: [], customEvents: [],
      allowedPaths: [{ match: "prefix" as const, path: "/" }],
      excludedPaths: [{ match: "prefix" as const, path: "/p" }],
    };
    expect(isAllowedAnalyticsPath(site, `/p/${encodeURIComponent(suffix)}`)).toBe(false);
    expect(isAllowedAnalyticsPath(site, `/privacy/${encodeURIComponent(suffix)}`)).toBe(true);
  }));
});
