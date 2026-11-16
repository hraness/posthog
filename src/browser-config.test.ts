import { describe, expect, test } from "bun:test";

import {
  accountId,
  capabilities,
  formatChoices,
  fromPrivateElement,
  ID_MAX_AGE_SECONDS,
  linkChoice,
  mergeChoices,
  parseChoices,
  posthogOptions,
  sessionFor,
  visitId,
  type BrowserConfig,
  type Preset,
} from "./browser-config.js";
import { policyForGroup, type RegionGroup } from "./policy.js";

const config = (preset: Preset): BrowserConfig => ({ token: "public-token", hosts: ["example.com"], siteId: "example", preset });
const options = (preset: Preset, group: RegionGroup, privatePath = false, gpc = false) => {
  const policy = policyForGroup(group, gpc, {});
  const caps = capabilities(policy, preset, privatePath);
  return posthogOptions({ config: config(preset), policy, caps, distinctId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", identified: false, sessionId: undefined });
};

describe("surface presets", () => {
  test("marketing in the US: autocapture, heat maps, masked replay, vitals with attribution", () => {
    const sent = options("marketing", "us");
    expect(sent).toMatchObject({
      autocapture: true,
      capture_heatmaps: true,
      rageclick: true,
      capture_dead_clicks: true,
      disable_session_recording: false,
      mask_all_text: false,
      person_profiles: "identified_only",
      persistence: "memory",
      disable_external_dependency_loading: true,
      capture_pageview: "history_change",
      capture_pageleave: true,
    });
    expect(sent.session_recording).toMatchObject({ maskAllInputs: true, recordBody: false, recordHeaders: false });
    expect(String((sent.session_recording as Record<string, unknown>).maskTextSelector)).toContain("[data-private]");
    expect(sent.capture_performance).toEqual({ web_vitals: true, network_timing: false, web_vitals_attribution: true });
    expect(sent.cookieless_mode).toBeUndefined();
  });

  test("the app preset never records or heat-maps, and captures only allowlisted clicks with text masked", () => {
    for (const group of ["us", "row", "uk_ch", "br"] as const) {
      const sent = options("app", group);
      expect(sent).toMatchObject({ disable_session_recording: true, capture_heatmaps: false, rageclick: false, capture_dead_clicks: false, mask_all_text: true, mask_all_element_attributes: true });
      expect(sent.autocapture).toEqual({ element_allowlist: ["button", "a"], css_selector_allowlist: ["[data-ph]"] });
      expect(sent.capture_performance).toMatchObject({ web_vitals_attribution: false });
    }
  });

  test("a private path on a public site gets the app's limits", () => {
    expect(capabilities(policyForGroup("us", false, {}), "marketing", true)).toEqual({ autocapture: true, heatmaps: false, replay: false, vitalsAttribution: false });
    expect(capabilities(policyForGroup("us", false, {}), "docs", false)).toEqual({ autocapture: true, heatmaps: true, replay: true, vitalsAttribution: true });
  });

  test("Europe before a yes: cookieless, no autocapture, no replay", () => {
    const sent = options("marketing", "eu");
    expect(sent).toMatchObject({ cookieless_mode: "always", autocapture: false, capture_heatmaps: false, disable_session_recording: true });
  });

  test("UK, Switzerland and Brazil: analytics and autocapture, replay only after the ads yes; GPC never records", () => {
    expect(options("marketing", "uk_ch")).toMatchObject({ autocapture: true, capture_heatmaps: true, disable_session_recording: true });
    expect(options("marketing", "br")).toMatchObject({ autocapture: true, disable_session_recording: true });
    expect(options("marketing", "us", false, true)).toMatchObject({ autocapture: true, disable_session_recording: true });
  });
});

describe("stored answers and identity", () => {
  test("choices round-trip, and a no in any copy wins", () => {
    expect(parseChoices(formatChoices({ analytics: "yes", ads: "no" }))).toEqual({ analytics: "yes", ads: "no" });
    expect(parseChoices("a=maybe&d=yes")).toEqual({ analytics: undefined, ads: "yes" });
    expect(parseChoices(undefined)).toEqual({});
    expect(mergeChoices({ analytics: "yes" }, { analytics: "no" }, {})).toEqual({ analytics: "no", ads: undefined });
    expect(mergeChoices({ ads: "yes" }, {})).toEqual({ analytics: undefined, ads: "yes" });
  });

  test("the privacy page's links", () => {
    expect(linkChoice("?analytics=off")).toEqual({ analytics: "no", ads: "no" });
    expect(linkChoice("?analytics=on")).toEqual({ analytics: "yes" });
    expect(linkChoice("?ads=off")).toEqual({ ads: "no" });
    expect(linkChoice("?x=1")).toBeUndefined();
  });

  test("only random UUIDs and opaque account IDs are identities", () => {
    const id = "019abcde-1234-7890-abcd-123456789abc";
    expect(visitId(id.toUpperCase())).toBe(id);
    for (const value of ["person@example.com", "account_123", "https://example.com/private", null]) expect(visitId(value)).toBeUndefined();
    expect(accountId("acct_0123456789abcdef")).toBe("acct_0123456789abcdef");
    for (const value of ["person@example.com", "short", "has space here", "x".repeat(129), 5]) expect(accountId(value)).toBeUndefined();
    expect(ID_MAX_AGE_SECONDS).toBeLessThanOrEqual(396 * 86400);
  });

  test("a session lasts 30 idle minutes and one day at most", () => {
    const id = "019abcde-1234-7890-abcd-123456789abc";
    const now = new Date("2026-11-14T12:00:00Z").getTime();
    const session = { id, started: now - 10_000, last: now - 1000 };
    expect(sessionFor(session, now)).toEqual(session);
    expect(sessionFor({ ...session, last: now - 30 * 60_000 }, now)).toBeUndefined();
    expect(sessionFor({ ...session, started: now - 24 * 3600_000 }, now)).toBeUndefined();
    expect(sessionFor({ ...session, last: now + 1 }, now)).toBeUndefined();
    expect(sessionFor({ ...session, id: "PRIVATE" }, now)).toBeUndefined();
  });

  test("clicks inside private elements are recognised", () => {
    expect(fromPrivateElement({ $elements_chain: 'button:attr__data-private="";nth-child="1"' })).toBe(true);
    expect(fromPrivateElement({ $elements_chain: "a.nav" })).toBe(false);
    expect(fromPrivateElement(undefined)).toBe(false);
  });
});

test("replay sampling is clamped and only set when asked", () => {
  const policy = policyForGroup("us", false, {});
  const caps = capabilities(policy, "marketing", false);
  const recording = (replaySampleRate?: number) => posthogOptions({ config: { ...config("marketing"), ...(replaySampleRate === undefined ? {} : { replaySampleRate }) }, policy, caps, distinctId: undefined, identified: false, sessionId: undefined }).session_recording as Record<string, unknown>;
  expect(recording()).not.toHaveProperty("sampleRate");
  expect(recording(0.25).sampleRate).toBe(0.25);
  expect(recording(7).sampleRate).toBe(1);
  expect(recording(Number.NaN)).not.toHaveProperty("sampleRate");
});

describe("region address, ads address and private paths", () => {
  test("the region fetch carries a valid zone only", async () => {
    const { regionAddress } = await import("./browser-config.js");
    expect(regionAddress("/api/region", "Europe/Berlin")).toBe("/api/region?tz=Europe%2FBerlin");
    expect(regionAddress("/api/region?x=1", "Asia/Tokyo")).toBe("/api/region?x=1&tz=Asia%2FTokyo");
    expect(regionAddress("/api/region", undefined)).toBe("/api/region");
    expect(regionAddress("/api/region", "bad zone<")).toBe("/api/region");
  });

  test("Meta's address keeps only click IDs and UTM labels", async () => {
    const { adsAddress } = await import("./browser-config.js");
    expect(adsAddress("https://example.com/p?ref=hn&via=x&story=2&utm_campaign=c&fbclid=f#h")).toBe("https://example.com/p?utm_campaign=c&fbclid=f");
    expect(adsAddress("https://example.com/")).toBe("https://example.com/");
  });

  test("a private path drops heatmaps and unlisted clicks and cuts titles and text", async () => {
    const { onPrivatePath } = await import("./browser-config.js");
    for (const event of ["$$heatmap", "$rageclick", "$dead_click"]) expect(onPrivatePath({ event, properties: {} })).toBeNull();
    expect(onPrivatePath({ event: "$autocapture", properties: { $elements_chain: "div.card;body" } })).toBeNull();
    expect(onPrivatePath({ event: "$autocapture", properties: {} })).toBeNull();
    const kept = onPrivatePath({ event: "$autocapture", properties: { $elements_chain: 'span:text="Jane";a.nav:attr__href="/x"', $el_text: "Jane", $title: "Jane's account" } });
    expect(kept?.properties).toEqual({ $elements_chain: "span:;a.nav:" });
    expect(onPrivatePath({ event: "$pageview", properties: { title: "Jane", $title: "Jane", $page_title: "Jane" } })?.properties).toEqual({});
    expect(onPrivatePath({ event: "$autocapture", properties: { $elements_chain: 'div:attr__data-ph="save"' } })).not.toBeNull();
    expect(onPrivatePath({ event: "$pageview", properties: { $title: "Secret", $current_url: "/account" } })?.properties).toEqual({ $current_url: "/account" });
  });
});
