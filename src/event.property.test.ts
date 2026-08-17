import { expect, test } from "bun:test";
import * as fc from "fast-check";

import {
  ExceptionBudget,
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

test("property: URI userinfo never survives error sanitization", () => {
  const credentialPart = fc.stringMatching(/^[A-Za-z0-9:_-]{1,32}$/u);
  fc.assert(fc.property(
    fc.constantFrom("https", "redis", "postgresql", "mongodb+srv"),
    credentialPart,
    (scheme, userinfo) => {
      const error = sanitizeAnalyticsError(
        new Error(`Connect ${scheme}://${userinfo}@internal.example:6379/path`),
      );
      expect(error.message).toBe(
        `Connect ${scheme}://[credential]@internal.example:6379/path`,
      );
    },
  ));
});

test("property: expired exception fingerprints do not accumulate", () => {
  fc.assert(fc.property(
    fc.array(fc.string(), { minLength: 1, maxLength: 100 }),
    (fingerprints) => {
      const budget = new ExceptionBudget({
        totalLimit: fingerprints.length,
        perFingerprintLimit: fingerprints.length,
        windowMs: 10,
      });
      for (const fingerprint of fingerprints) {
        budget.allow(fingerprint, 0);
      }
      expect(budget.allow("current", 11)).toBe(true);
      expect(budget.activeFingerprintCount).toBe(1);
    },
  ));
});
