import { describe, expect, test } from "bun:test";

import {
  adsAllowed,
  adsFromMetadata,
  adsMetadata,
  capiBody,
  capiEvent,
  fbcFor,
  hashEmail,
  metaValue,
  readAds,
  safeAddress,
  SCRIPT,
  sendCapi,
  sourceUrl,
  stableEventId,
  startPixel,
  trackForServer,
  type Page,
} from "./meta.js";
import { policyForGroup } from "./policy.js";

const PIXEL = "1234567890";

/** A page with a cookie jar, a head that records scripts and Meta's queue. */
function fakePage(href = "https://example.com/") {
  const jar = new Map<string, string>();
  const scripts: { src: string; async: boolean; fetchPriority?: string }[] = [];
  const store = new Map<string, string>();
  const page: Page & { scripts: typeof scripts; jar: typeof jar } = {
    scripts,
    jar,
    document: {
      get cookie() {
        return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
      },
      set cookie(line: string) {
        const [pair = ""] = line.split(";");
        const [name = "", value = ""] = pair.split("=");
        if (/max-age=0\b/u.test(line)) jar.delete(name.trim());
        else jar.set(name.trim(), value);
      },
      createElement: () => ({ async: false, src: "" }) as never,
      head: { append: (script: { src: string; async: boolean; fetchPriority?: string }) => void scripts.push(script) } as never,
    } as Page["document"],
    window: {},
    location: { href, hostname: "example.com" },
    now: () => 1763200000000,
    random: () => 0.5,
    storage: () => ({ getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) }),
  };
  return page;
}
const queue = (page: Page) => page.window.fbq?.queue ?? [];

describe("the policy gates Meta", () => {
  test("only where ads are allowed, never with GPC or a no", () => {
    expect(adsAllowed({ policy: policyForGroup("us", false, {}) })).toBe(true);
    expect(adsAllowed({ policy: policyForGroup("row", false, {}) })).toBe(true);
    expect(adsAllowed({ policy: policyForGroup("us", true, {}) })).toBe(false);
    expect(adsAllowed({ policy: policyForGroup("us", false, {}), gpc: true })).toBe(false);
    expect(adsAllowed({ policy: policyForGroup("us", false, { ads: "no" }) })).toBe(false);
    expect(adsAllowed({ policy: policyForGroup("eu", false, {}) })).toBe(false);
    expect(adsAllowed({ policy: policyForGroup("eu", false, { analytics: "yes" }) })).toBe(true);
    expect(adsAllowed({ policy: policyForGroup("uk_ch", false, {}) })).toBe(false);
    expect(adsAllowed({ policy: policyForGroup("uk_ch", false, { ads: "yes" }) })).toBe(true);
    expect(adsAllowed({ policy: policyForGroup("br", false, {}) })).toBe(false);
    expect(adsAllowed({ policy: undefined })).toBe(false);
    expect(adsAllowed({ policy: policyForGroup("us", false, {}), optedOut: true })).toBe(false);
  });
});

describe("the Pixel", () => {
  test("before it starts, the page has no Meta script and no Meta cookie", () => {
    const page = fakePage();
    expect(page.scripts).toEqual([]);
    expect(page.jar.size).toBe(0);
  });

  test("once started: one script, automatic events and remote configuration off, then the page view", () => {
    const page = fakePage();
    startPixel({ pixelId: PIXEL }, page, undefined, () => true);
    expect(page.scripts).toEqual([{ src: SCRIPT, async: true, fetchPriority: "low" }]);
    expect(page.window.fbq?.disableConfigLoading).toBe(true);
    expect(page.window.fbq?.disablePushState).toBe(true);
    expect(queue(page)).toEqual([["set", "autoConfig", false, PIXEL], ["init", PIXEL], ["track", "PageView", {}]]);
    expect(page.jar.get("_fbp")).toBe("fb.1.1763200000000.1073741824");
    expect(page.jar.has("_fbc")).toBe(false);
    startPixel({ pixelId: PIXEL }, page, undefined, () => true);
    expect(page.scripts).toHaveLength(1);
  });

  test("an ad click becomes _fbc", () => {
    const page = fakePage("https://example.com/?fbclid=IwAR0abc");
    startPixel({ pixelId: PIXEL }, page, "IwAR0abc", () => true);
    expect(page.jar.get("_fbc")).toBe(fbcFor("IwAR0abc", 1763200000000));
    expect(startPixel({ pixelId: PIXEL }, page, undefined, () => true).identity()).toEqual({ fbp: "fb.1.1763200000000.1073741824", fbc: "fb.1.1763200000000.IwAR0abc" });
  });

  test("a no after it starts stops every later event", () => {
    const page = fakePage();
    let allowed = true;
    const pixel = startPixel({ pixelId: PIXEL }, page, undefined, () => allowed);
    allowed = false;
    pixel.track("Lead");
    expect(queue(page).filter((call) => call[1] === "Lead")).toEqual([]);
    expect(trackForServer(pixel, "Lead")).toBeUndefined();
  });

  test("nothing from an address with a private part", () => {
    const page = fakePage("https://example.com/s#secret");
    const pixel = startPixel({ pixelId: PIXEL }, page, undefined, () => true);
    pixel.track("Lead");
    expect(queue(page).filter((call) => call[0] === "track")).toEqual([]);
    expect(safeAddress("https://example.com/?utm_source=x&fbclid=1")).toBe(true);
    expect(safeAddress("https://example.com/?c=abc")).toBe(false);
    expect(safeAddress("https://example.com/?c=abc", ["c"], (_, value) => /^[a-z0-9]{1,40}$/u.test(value))).toBe(true);
    expect(safeAddress("https://example.com/?c=a%20b", ["c"], (_, value) => /^[a-z0-9]{1,40}$/u.test(value))).toBe(false);
    expect(safeAddress("not a url")).toBe(false);
  });

  test("custom events go out once a day per browser, with an event ID", () => {
    const page = fakePage();
    const pixel = startPixel({ pixelId: PIXEL, customEvents: ["ThingMade"], pageView: false }, page, undefined, () => true);
    pixel.track("ThingMade");
    pixel.track("ThingMade");
    const sent = queue(page).filter((call) => call[0] === "trackCustom");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[1]).toBe("ThingMade");
    expect(sent[0]?.[3]).toMatchObject({ eventID: expect.any(String) as unknown as string });
  });

  test("a browser event and its server copy share an event ID", () => {
    const page = fakePage();
    const pixel = startPixel({ pixelId: PIXEL }, page, undefined, () => true);
    const ads = trackForServer(pixel, "InitiateCheckout", { value: 5 });
    expect(ads?.event_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(queue(page).at(-1)).toEqual(["track", "InitiateCheckout", { value: 5 }, { eventID: ads?.event_id }]);
    expect(readAds(JSON.parse(JSON.stringify(ads)))).toEqual(ads);
  });
});

describe("the Conversions API", () => {
  test("emails are normalized before hashing, and anything else is not an email", async () => {
    const expected = await hashEmail("payer@example.com");
    expect(expected).toMatch(/^[0-9a-f]{64}$/u);
    expect(await hashEmail("  Payer@Example.COM ")).toBe(expected ?? "");
    for (const value of ["", "not an email", "a@b", 5, null, undefined]) expect(await hashEmail(value)).toBeUndefined();
  });

  test("browser IDs are checked before they reach Stripe or Meta", () => {
    const event_id = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
    expect(readAds({ event_id, fbp: "fb.1.1763200000000.1234567890", fbc: "fb.1.1763200000000.IwAR0abc" })).toEqual({ event_id, fbp: "fb.1.1763200000000.1234567890", fbc: "fb.1.1763200000000.IwAR0abc" });
    expect(readAds({ event_id, fbp: "fb.1.x.1", fbc: "fb.1.1763200000000.<script>" })).toEqual({ event_id });
    expect(readAds({ event_id: "x" })).toBeUndefined();
    expect(adsMetadata({ event_id })).toEqual({ "metadata[meta]": "1" });
    expect(adsMetadata({ event_id, fbp: "fb.1.1763200000000.1" })).toEqual({ "metadata[meta]": "1", "metadata[meta_fbp]": "fb.1.1763200000000.1" });
    expect(adsFromMetadata({ meta: "1", meta_fbp: "fb.1.1763200000000.1", meta_fbc: "bad" })).toEqual({ fbp: "fb.1.1763200000000.1" });
    expect(adsFromMetadata({ meta_fbp: "fb.1.1763200000000.1" })).toBeUndefined();
  });

  test("one stable event ID per logical event, never the ID itself", async () => {
    const id = await stableEventId("subscribe", "cs_live_abc");
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    expect(await stableEventId("subscribe", "cs_live_abc")).toBe(id);
    expect(await stableEventId("subscribe", "cs_live_abd")).not.toBe(id);
    expect(id).not.toContain("cs_live");
  });

  test("values in currency units, and pages without query or fragment", () => {
    expect(metaValue(500, "usd")).toEqual({ value: 5, currency: "USD" });
    expect(metaValue(500, "JPY")).toEqual({ value: 500, currency: "JPY" });
    expect(metaValue(-1, "usd")).toEqual({});
    expect(sourceUrl("https://example.com", "/pricing?x=1#y")).toBe("https://example.com/pricing");
    expect(sourceUrl("https://example.com", "https://evil.example/")).toBe("https://example.com/");
  });

  test("a server event carries hashes and identifiers, never the email", async () => {
    const event = await capiEvent({ name: "Subscribe", eventId: "abc", at: 1, url: "https://example.com/", ads: { fbp: "fb.1.1763200000000.1" }, email: "Payer@example.com", ip: "203.0.113.5", userAgent: "UA" });
    expect(event).toEqual({ event_name: "Subscribe", event_time: 1, event_id: "abc", action_source: "website", event_source_url: "https://example.com/", user_data: { em: [await hashEmail("payer@example.com") ?? ""], fbp: "fb.1.1763200000000.1", client_ip_address: "203.0.113.5", client_user_agent: "UA" } });
    expect(JSON.stringify(event)).not.toContain("payer@");
    expect((await capiEvent({ name: "Lead", eventId: "x", ip: "not an ip" })).user_data).toEqual({});
  });

  test("the body carries the token and, only when set, the test code", () => {
    expect(JSON.parse(capiBody({ pixelId: PIXEL, token: "EAAx" }, []))).toEqual({ data: [], access_token: "EAAx" });
    expect((JSON.parse(capiBody({ pixelId: PIXEL, token: "EAAx", testEventCode: "TEST1" }, [])) as { test_event_code: string }).test_event_code).toBe("TEST1");
  });

  test("without a token nothing is sent; a failure never throws", async () => {
    const calls: string[] = [];
    const fake = ((url: string) => {
      calls.push(url);
      return Promise.reject(new Error("down"));
    }) as unknown as typeof fetch;
    await sendCapi({ pixelId: PIXEL, token: undefined }, () => capiEvent({ name: "Lead", eventId: "x" }), { fetch: fake });
    expect(calls).toEqual([]);
    await sendCapi({ pixelId: PIXEL, token: "EAAx" }, () => capiEvent({ name: "Lead", eventId: "x" }), { fetch: fake });
    expect(calls).toEqual([`https://graph.facebook.com/v26.0/${PIXEL}/events`]);
    await sendCapi({ pixelId: PIXEL, token: "EAAx" }, () => undefined, { fetch: fake });
    expect(calls).toHaveLength(1);
  });
});
