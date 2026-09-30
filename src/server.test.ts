import { expect, spyOn, test } from "bun:test";
import { PostHog } from "posthog-node";

import { capturePostHogEvent } from "./server";
import { POSTHOG_SCHEMA_VERSION, type PostHogSiteDefinition } from "./site";

const site: PostHogSiteDefinition = {
  id: "server-example",
  canonicalDomain: "example.com",
  allowedHosts: ["example.com"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [{ match: "exact", path: "/", pageKind: "home" }],
  customEvents: ["purchase completed"],
};
const options = { site, apiKey: "phc_public", production: true };
const input = { event: "purchase completed", hostname: "example.com" };

test("server events enforce production, host, token and event allowlists before sending", async () => {
  const capture = spyOn(PostHog.prototype, "captureImmediate").mockResolvedValue(undefined);
  try {
    expect(await capturePostHogEvent({ ...options, production: false }, input)).toBe(false);
    expect(await capturePostHogEvent({ ...options, apiKey: "phx_private" }, input)).toBe(false);
    expect(await capturePostHogEvent(options, { ...input, hostname: "preview.vercel.app" })).toBe(false);
    expect(await capturePostHogEvent(options, { ...input, event: "unknown event" })).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(await capturePostHogEvent(options, { ...input, properties: {
      product: "example", email: "person@example.com", token: "private",
      site_id: "spoofed", analytics_schema_version: 1,
    } })).toBe(true);
    expect(capture).toHaveBeenCalledWith({
      distinctId: "server:server-example", event: "purchase completed", disableGeoip: true,
      properties: {
        product: "example", email: "[redacted]", token: "[redacted]",
        site_id: site.id, analytics_schema_version: 2, canonical_domain: "example.com",
        canonical_path: "/", page_kind: "home", $process_person_profile: false,
      },
    });
    expect(await capturePostHogEvent({ ...options, site: {
      ...site, sensitivePaths: [{ match: "prefix", path: "/account" }],
    } }, { ...input, pathname: "/account", properties: { utm_source: "private" } })).toBe(true);
    expect(capture.mock.calls.at(-1)?.[0].properties).not.toHaveProperty("utm_source");
    capture.mockRejectedValueOnce(new Error("offline"));
    expect(await capturePostHogEvent(options, input)).toBe(false);
  } finally {
    capture.mockRestore();
  }
});
