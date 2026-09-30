import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

// PostHog snapshots browser globals at import. A child keeps this real-provider
// regression isolated from the application's and other tests' module state.
test("real PostHog retries and pagehide cannot revive a withdrawn capture", () => {
  const output = execFileSync(process.execPath, ["--eval", `
    const events = new EventTarget();
    const listeners = { addEventListener: (...args) => events.addEventListener(...args), removeEventListener: (...args) => events.removeEventListener(...args) };
    let choice = "accepted", changed = () => {}, calls = 0, beacons = 0;
    const location = new URL("https://example.com/");
    const document = { ...listeners, body: null, cookie: "", createElement: () => ({ ...listeners, setAttribute() {}, style: {} }), documentElement: {}, getElementsByTagName: () => [], location, URL: location.href, querySelector: () => null, querySelectorAll: () => [], readyState: "complete", referrer: "", title: "", visibilityState: "visible" };
    const globals = { ...listeners, document, location, window: globalThis, navigator: { onLine: true, language: "en-US", languages: ["en-US"], userAgent: "Mozilla/5.0", sendBeacon: () => { beacons++; return true; } }, screen: { width: 1440, height: 900 }, innerWidth: 1440, innerHeight: 900, fetch: async () => { calls++; return new Response("{}", { status: 503 }); } };
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    const { posthog } = await import("posthog-js");
    const { AnalyticsConsent, installConsentTransport } = await import(${JSON.stringify(import.meta.dir + "/consent.ts")});
    const consent = new AnalyticsConsent({ readChoice: () => choice, requestRegion: async () => ({ ok: true, json: async () => ({ required: false }) }), listen: cb => { changed = cb; return () => {}; } });
    consent.start();
    if (!installConsentTransport(posthog, consent)) throw Error("guard unavailable");
    posthog.init("phc_fixture", { api_host: "https://capture.example.com", request_batching: false, autocapture: false, capture_pageview: false, capture_pageleave: false, persistence: "memory", cookieless_mode: "always", person_profiles: "never", disable_session_recording: true, advanced_disable_feature_flags: true, advanced_disable_decide: true, disable_external_dependency_loading: true, __preview_remote_config: false, capture_performance: false, enable_heatmaps: false, enable_surveys: false, before_send: event => consent.allowed() ? event : null });
    const delay = () => new Promise(resolve => setTimeout(resolve, 5));
    const queue = Object.values(posthog).find(value => value && typeof value.retriableRequest === "function");
    const entries = Object.values(queue).find(Array.isArray);
    const queued = async () => { for (let i = 0; i < 100; i++) { if (queue.length) return; await delay(); } throw Error("provider did not enqueue failure"); };
    const choose = value => { choice = value; changed(); };
    const flush = () => { for (const entry of entries.splice(0)) queue.retriableRequest(entry.requestOptions); };
    posthog.capture("first"); await queued(); const initial = calls;
    choose("declined"); flush(); await delay(); const withdrawn = calls;
    choose("accepted"); posthog.capture("second"); await queued(); const resumed = calls;
    choose("declined"); choose("accepted"); flush(); await delay(); const stale = calls;
    posthog.capture("leaving"); await queued(); const beforeLeave = calls;
    choose("declined"); events.dispatchEvent(new Event("pagehide")); await delay();
    console.log(JSON.stringify({ initial, withdrawn, resumed, stale, beforeLeave, afterLeave: calls, beacons }));
    process.exit(0);
  `], { encoding: "utf8", timeout: 10_000 });
  expect(JSON.parse(output.trim().split("\n").at(-1) ?? "null")).toEqual({ initial: 1, withdrawn: 1, resumed: 2, stale: 2, beforeLeave: 3, afterLeave: 3, beacons: 0 });
});
