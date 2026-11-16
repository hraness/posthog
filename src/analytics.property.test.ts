import { expect, test } from "bun:test";
import * as fc from "fast-check";

import { campaignLabel, channelOf, cleanProps, cleanUrl, parseFirstTouch, refLabel, withoutTracking } from "./attribution.js";
import { parseChoices, formatChoices, mergeChoices } from "./browser-config.js";
import { regionPolicy, type Choice } from "./policy.js";
import { parseWireEvent } from "./server.js";

const choice = fc.constantFrom<Choice | undefined>("yes", "no", undefined);
const input = fc.record({
  country: fc.oneof(fc.constantFrom("US", "DE", "GB", "CH", "BR", "JP", "XX", "fr", "", null, undefined), fc.string({ maxLength: 4 })),
  zone: fc.oneof(fc.constantFrom("America/Chicago", "Europe/Paris", "Europe/London", "America/Sao_Paulo", "Asia/Tokyo", "UTC", "", null, undefined), fc.string({ maxLength: 30 })),
  gpc: fc.constantFrom(true, false, undefined),
  choices: fc.record({ analytics: choice, ads: choice }),
});

test("property: GPC never allows ads or replay, and never removes first-party analytics", () => {
  fc.assert(
    fc.property(input, (value) => {
      const withGpc = regionPolicy({ ...value, gpc: true });
      const without = regionPolicy({ ...value, gpc: false });
      expect(withGpc.ads).toBe(false);
      expect(withGpc.replay).toBe(false);
      expect(withGpc.analytics).toBe(without.analytics);
      expect(withGpc.autocapture).toBe(without.autocapture);
    }),
  );
});

test("property: an analytics no is cookieless with nothing extra, anywhere", () => {
  fc.assert(
    fc.property(input, (value) => {
      const policy = regionPolicy({ ...value, choices: { ...value.choices, analytics: "no" } });
      expect(policy).toMatchObject({ analytics: "cookieless", autocapture: false, replay: false, ads: false });
    }),
  );
});

test("property: an ads no turns off ads and replay, anywhere", () => {
  fc.assert(
    fc.property(input, (value) => {
      const policy = regionPolicy({ ...value, choices: { ...value.choices, ads: "no" } });
      expect(policy.ads).toBe(false);
      expect(policy.replay).toBe(false);
    }),
  );
});

test("property: in Europe nothing beyond cookieless analytics happens before a yes", () => {
  fc.assert(
    fc.property(input, (value) => {
      const policy = regionPolicy({ ...value, country: "DE", choices: {} });
      expect(policy).toMatchObject({ analytics: "cookieless", autocapture: false, replay: false, ads: false, ask: "all" });
    }),
  );
});

test("property: replay never runs without ads permission", () => {
  fc.assert(fc.property(input, (value) => {
    const policy = regionPolicy(value);
    if (policy.replay) expect(policy.ads).toBe(true);
  }));
});

test("property: labels are lower-case tokens or nothing", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      const ref = refLabel(value);
      if (ref !== undefined) expect(ref).toMatch(/^[a-z0-9._-]{1,40}$/u);
      const label = campaignLabel(value);
      if (label !== undefined) expect(label).toMatch(/^[a-z0-9._-]{1,60}$/u);
    }),
  );
});

test("property: cleaned properties never carry an email, a click ID, a fragment or a query beyond labels", () => {
  const email = fc.tuple(fc.stringMatching(/^[a-z0-9.]{1,10}$/u), fc.stringMatching(/^[a-z]{1,10}$/u)).map(([user, host]) => `${user}@${host}.com`);
  const url = fc.tuple(fc.webUrl({ withQueryParameters: true, withFragments: true }), email).map(([href, mail]) => `${href}${href.includes("?") ? "&" : "?"}gclid=abc&email=${mail}&utm_source=Hn`);
  const value = fc.oneof(fc.string(), email, url, fc.integer(), fc.boolean(), fc.constant(null));
  const props = fc.dictionary(fc.constantFrom("$current_url", "$referrer", "note", "gclid", "fbclid", "utm_source", "ref", "nested"), fc.oneof(value, fc.dictionary(fc.string({ maxLength: 8 }), value, { maxKeys: 3 })), { maxKeys: 8 });
  fc.assert(
    fc.property(props, (raw) => {
      const cleaned = cleanProps(raw);
      const text = JSON.stringify(cleaned);
      expect(text).not.toMatch(/[a-z0-9.]+@[a-z]+\.com/u);
      expect(cleaned).not.toHaveProperty("gclid");
      expect(cleaned).not.toHaveProperty("fbclid");
      expect(text).not.toContain("gclid=");
    }),
  );
});

test("property: a cleaned URL keeps no fragment and only label parameters", () => {
  fc.assert(
    fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (href) => {
      const cleaned = cleanUrl(href);
      expect(cleaned).not.toContain("#");
      const query = cleaned.split("?")[1];
      if (query !== undefined) for (const key of new URLSearchParams(query).keys()) expect(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "via"]).toContain(key);
    }),
  );
});

test("property: removing tracking leaves no tracking parameter and is idempotent", () => {
  fc.assert(
    fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), fc.constantFrom("utm_source=x", "gclid=1", "ref=hn", "fbclid=2"), (href, extra) => {
      const url = new URL(href);
      url.search = url.search === "" ? `?${extra}` : `${url.search}&${extra}`;
      const tidy = withoutTracking(url.href);
      if (tidy === null) return;
      const query = new URL(tidy, url.origin).searchParams;
      for (const key of ["utm_source", "gclid", "ref", "fbclid"]) expect(query.has(key)).toBe(false);
      expect(withoutTracking(new URL(tidy, url.origin).href)).toBeNull();
    }),
  );
});

test("property: a channel is always known and its source is a host or label", () => {
  fc.assert(
    fc.property(fc.oneof(fc.webUrl(), fc.string()), fc.string(), (referrer, search) => {
      const { channel, source } = channelOf(referrer, search.startsWith("?") ? search : `?${search}`);
      expect(["ai", "community", "search", "social", "paid", "email", "referral", "direct", "campaign"]).toContain(channel);
      expect(source).not.toMatch(/[/?#@\s]/u);
    }),
  );
});

test("property: stored values never throw and never invent answers", () => {
  fc.assert(
    fc.property(fc.anything(), (value) => {
      expect(() => parseFirstTouch(value)).not.toThrow();
      expect(() => parseWireEvent(value)).not.toThrow();
      const parsed = parseChoices(typeof value === "string" ? value : undefined);
      expect(["yes", "no", undefined]).toContain(parsed.analytics);
      expect(["yes", "no", undefined]).toContain(parsed.ads);
      expect(parsed.at === undefined || (Number.isSafeInteger(parsed.at) && parsed.at > 0)).toBe(true);
    }),
  );
  fc.assert(fc.property(choice, choice, (analytics, ads) => {
    expect(parseChoices(formatChoices({ analytics, ads }))).toEqual({ analytics, ads });
    expect(mergeChoices({ analytics, ads }, { analytics: "no" }).analytics).toBe("no");
  }));
});

const dated = fc.record({ analytics: choice, ads: choice, at: fc.option(fc.integer({ min: 1, max: 2 ** 45 }), { nil: undefined }) });
test("property: the latest dated answer wins per category, ties go to no, and order never matters", () => {
  fc.assert(
    fc.property(fc.array(dated, { maxLength: 6 }), (copies) => {
      const merged = mergeChoices(...copies);
      expect(mergeChoices(...[...copies].reverse())).toEqual(merged);
      for (const category of ["analytics", "ads"] as const) {
        const answered = copies.filter((item) => item[category] !== undefined);
        if (answered.length === 0) {
          expect(merged[category]).toBeUndefined();
          continue;
        }
        const latest = Math.max(...answered.map((item) => item.at ?? 0));
        const atLatest = answered.filter((item) => (item.at ?? 0) === latest).map((item) => item[category]);
        expect(merged[category]).toBe(atLatest.includes("no") ? "no" : "yes");
      }
      // Whatever was stored, a newer explicit answer is what is read back.
      const now = Math.max(0, ...copies.map((item) => item.at ?? 0)) + 1;
      expect(mergeChoices(...copies, { analytics: "yes", at: now }).analytics).toBe("yes");
      const answered = merged.analytics !== undefined || merged.ads !== undefined;
      const stored = Object.fromEntries(Object.entries(merged).filter(([key, value]) => value !== undefined && (answered || key !== "at")));
      expect(parseChoices(formatChoices(merged))).toEqual(stored);
    }),
  );
});

test("property: URL-keyed bags keep no fragment or unlisted parameter in any key, and lose no entries", () => {
  fc.assert(
    fc.property(fc.array(fc.webUrl({ withQueryParameters: true, withFragments: true }), { minLength: 1, maxLength: 6 }), (hrefs) => {
      const data: Record<string, unknown[]> = {};
      for (const href of hrefs) data[href] = [...(data[href] ?? []), { x: 1 }];
      const cleaned = cleanProps({ $heatmap_data: data }).$heatmap_data as Record<string, unknown[]>;
      for (const key of Object.keys(cleaned)) {
        expect(key).not.toContain("#");
        expect(key).toBe(cleanUrl(key));
      }
      expect(Object.values(cleaned).flat()).toHaveLength(hrefs.length);
    }),
  );
});
