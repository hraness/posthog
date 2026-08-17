import { expect, test } from "bun:test";
import * as fc from "fast-check";

import { sanitizeAnalyticsError, sanitizeProviderProperties } from "./event";
import { POSTHOG_SCHEMA_VERSION, type PostHogSiteDefinition } from "./site";

const site = {
  id: "example",
  canonicalDomain: "example.com",
  allowedHosts: ["example.com"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [],
  customEvents: [],
} satisfies PostHogSiteDefinition;

test("property: current URLs never retain queries or fragments", () => {
  fc.assert(fc.property(fc.string(), fc.string(), (query, fragment) => {
    const properties = sanitizeProviderProperties(site, {
      $current_url: `https://example.com/article?${encodeURIComponent(query)}#${encodeURIComponent(fragment)}`,
    });
    expect(properties.$current_url).toBe("https://example.com/article");
  }));
});

test("property: error sanitization is total over arbitrary values", () => {
  fc.assert(fc.property(fc.anything(), (value) => {
    expect(sanitizeAnalyticsError(value)).toBeInstanceOf(Error);
  }));
});
