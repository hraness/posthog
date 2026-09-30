import { expect, test } from "bun:test";
import type { CaptureResult } from "posthog-js";

import { createPostHogBeforeSend, createPostHogBrowserConfig } from "./client";
import { analyticsAttributionQuery } from "./event";
import type { PostHogSiteDefinition } from "./site";

// Recorded from the immutable 0.2.0 implementation, not this sanitizer.
const baseline = await Bun.file(new URL("./fixtures/minimal-privacy-v0.2.0.json", import.meta.url)).json() as {
  site: PostHogSiteDefinition;
  config: Record<string, unknown>;
  cases: { name: string; capture: CaptureResult; sent: CaptureResult }[];
};
const site = { ...baseline.site, privacyMode: "minimal" as const };

for (const sample of baseline.cases) {
  test(`minimal privacy preserves 0.2 payload limits: ${sample.name}`, () => {
    const beforeSend = createPostHogBeforeSend(site, () => ({
      href: String(sample.capture.properties.$current_url),
      referrer: String(sample.capture.properties.$referrer),
    }));
    const sent = beforeSend(sample.capture);
    expect(sent).toMatchObject(sample.sent);
    expect(JSON.stringify(sent)).not.toMatch(/utm_|gclid|private@example\.com|oauth-code|private-token/u);
    expect(sent?.properties.$referrer).toBe("https://example.com");
    expect(sent?.properties.nested).toEqual(sample.sent.properties.nested);
  });
}

test("minimal privacy retains the 0.2 provider controls and removes deferred batching", () => {
  expect(createPostHogBrowserConfig(site, { href: "https://example.com/", referrer: "" }))
    .toMatchObject({ ...baseline.config, request_batching: false });
});

test("minimal privacy removes standalone attribution; standard callers keep 0.3 behavior", () => {
  const url = new URL("https://example.com/?utm_source=newsletter&gclid=click&secret=private");
  expect(analyticsAttributionQuery(site, url)).toBe("");
  expect(analyticsAttributionQuery(baseline.site, url)).toBe("?utm_source=newsletter&gclid=click");
  expect(createPostHogBrowserConfig(baseline.site, { href: url.href, referrer: "" }))
    .toMatchObject({ mask_personal_data_properties: false, request_batching: false });
});
