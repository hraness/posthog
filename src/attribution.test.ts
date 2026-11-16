import { describe, expect, test } from "bun:test";

import {
  afterFirstPageview,
  arrivalOf,
  arrivalProps,
  campaignLabel,
  carryRef,
  channelOf,
  cleanProps,
  cleanText,
  cleanUrl,
  clickKind,
  firstTouchProps,
  mondayOf,
  parseFirstTouch,
  refLabel,
  refOf,
  remember,
  routePattern,
  withoutTracking,
} from "./attribution.js";

const own = { ownHosts: ["example.com"] };

describe("how a visit arrived", () => {
  test("AI answers, search, community, social, paid, campaigns, other sites and nothing", () => {
    expect(channelOf("https://chatgpt.com/", "")).toEqual({ channel: "ai", source: "chatgpt.com" });
    expect(channelOf("", "?utm_source=chatgpt.com")).toEqual({ channel: "ai", source: "chatgpt.com" });
    expect(channelOf("", "?utm_source=perplexity").channel).toBe("ai");
    expect(channelOf("https://www.google.com/", "")).toEqual({ channel: "search", source: "google.com" });
    expect(channelOf("https://www.google.co.uk/", "").channel).toBe("search");
    expect(channelOf("https://duckduckgo.com/", "").channel).toBe("search");
    expect(channelOf("https://www.reddit.com/r/x", "").channel).toBe("community");
    expect(channelOf("https://t.co/abc", "").channel).toBe("social");
    expect(channelOf("", "?utm_source=x&utm_medium=social").channel).toBe("social");
    expect(channelOf("https://www.google.com/", "?gclid=1").channel).toBe("paid");
    expect(channelOf("", "?msclkid=1").channel).toBe("paid");
    expect(channelOf("", "?utm_source=newsletter&utm_medium=cpc").channel).toBe("paid");
    expect(channelOf("", "?utm_source=newsletter")).toEqual({ channel: "campaign", source: "newsletter" });
    expect(channelOf("https://example.org/post", "")).toEqual({ channel: "referral", source: "example.org" });
    expect(channelOf("", "")).toEqual({ channel: "direct", source: "" });
    expect(channelOf("not an address", "")).toEqual({ channel: "direct", source: "" });
  });

  test("AI answers are their own channel, by site or by label", () => {
    for (const referrer of ["https://chatgpt.com/", "https://claude.ai/chat/x", "https://www.perplexity.ai/search", "https://gemini.google.com/app", "https://copilot.microsoft.com/", "https://chat.deepseek.com/", "https://grok.com/"]) {
      expect(channelOf(referrer, "").channel).toBe("ai");
    }
  });

  test("a page of the product itself is not where a visit came from", () => {
    expect(channelOf("https://example.com/about", "", own)).toEqual({ channel: "direct", source: "" });
    expect(channelOf("https://docs.example.com/about", "", own)).toEqual({ channel: "direct", source: "" });
    expect(channelOf("https://notexample.com/", "", own).channel).toBe("referral");
  });

  test("a bare link from a discussion site is community", () => {
    for (const referrer of ["https://news.ycombinator.com/item?id=1", "https://www.producthunt.com/posts/x", "https://forums.macrumors.com/threads/x", "https://lobste.rs/s/x"]) {
      expect(channelOf(referrer, "").channel).toBe("community");
    }
    expect(channelOf("", "?utm_source=producthunt").channel).toBe("community");
    expect(channelOf("", "?utm_source=hackernews").channel).toBe("community");
  });
});

describe("launch tags", () => {
  test("a tag is short, lower case letters, digits, dot, underscore and dash; anything else is none", () => {
    for (const ok of ["hn", "r-macapps", "producthunt", "macrumors-mac", "console.weekly", "dir_1", "x".repeat(40)]) expect(refLabel(ok)).toBe(ok);
    expect(refLabel("HN")).toBe("hn");
    for (const bad of ["", "x".repeat(41), "person@example.com", "https://example.com", "a b", "a/b", "ü", null, undefined, 3]) expect(refLabel(bad)).toBeUndefined();
    expect(refOf("?ref=hn&via=ignored")).toBe("hn");
    expect(refOf("?via=newsletter")).toBe("newsletter");
    expect(refOf("?ref=bad%20label&via=dir")).toBe("dir");
    expect(refOf("")).toBeUndefined();
    expect(campaignLabel("x".repeat(80))).toBe("x".repeat(60));
  });

  test("a venue tag decides the channel before the referring site", () => {
    for (const ref of ["hn", "hn-show", "r-macapps", "r-sideproject-launch", "producthunt", "macrumors", "macrumors-mac", "obsidian", "cursor-forum", "ih", "kvr", "gearspace", "lines"]) {
      expect(channelOf("https://www.google.com/", `?ref=${ref}`)).toEqual({ channel: "community", source: ref });
    }
    for (const ref of ["console", "newsletter", "console-2026-11"]) expect(channelOf("", `?ref=${ref}`).channel).toBe("email");
    for (const ref of ["dir", "dir-saashub"]) expect(channelOf("https://chatgpt.com/", `?ref=${ref}`).channel).toBe("referral");
    expect(channelOf("", "?via=hn").channel).toBe("community");
    expect(channelOf("", "?ref=someblog")).toEqual({ channel: "campaign", source: "someblog" });
    expect(channelOf("https://www.google.com/", "?ref=someblog").channel).toBe("search");
    expect(channelOf("", "?ref=hn&gclid=1").channel).toBe("paid");
    expect(channelOf("", "?utm_source=download-email&utm_medium=email&ref=hn")).toEqual({ channel: "community", source: "download-email" });
    expect(channelOf("", "?ref=podcast", { refChannels: { podcast: "referral" } }).channel).toBe("referral");
    // "hnx" is not the "hn" venue.
    expect(channelOf("", "?ref=hnx").channel).toBe("campaign");
  });

  test("tracking parameters leave the address once read; what drives the page stays", () => {
    expect(withoutTracking("https://example.com/?ref=hn")).toBe("/");
    expect(withoutTracking("https://example.com/p?story=goose&ref=hn&utm_source=meta&utm_medium=paid_social&utm_campaign=1&utm_content=2&utm_term=x&fbclid=abc&gclid=def&msclkid=g&via=x#top")).toBe("/p?story=goose#top");
    expect(withoutTracking("https://example.com/?c=abc&ad=y5&utm_source=x")).toBe("/?c=abc&ad=y5");
    expect(withoutTracking("https://example.com/?story=t5")).toBeNull();
    expect(withoutTracking("https://example.com/?refs=1&ref=x")).toBe("/?refs=1");
    expect(withoutTracking("not a url")).toBeNull();
  });

  test("the address is tidied only after the first page view", () => {
    let calls = 0;
    const tidy = afterFirstPageview(() => { calls += 1; });
    tidy(undefined);
    tidy("$autocapture");
    expect(calls).toBe(0);
    tidy("$pageview");
    tidy("$pageview");
    expect(calls).toBe(1);
  });

  test("a cookieless visit carries its tag to same-origin pages only", () => {
    const here = "https://example.com/?ref=hn";
    expect(carryRef("/pricing", "hn", here)).toBe("https://example.com/pricing?ref=hn");
    expect(carryRef("https://other.example/", "hn", here)).toBeNull();
    expect(carryRef("/downloads/app.zip", "hn", here)).toBeNull();
    expect(carryRef("/pricing?ref=dir", "hn", here)).toBeNull();
    expect(carryRef("#faq", "hn", here)).toBeNull();
    expect(carryRef("/pricing", undefined, here)).toBeNull();
    expect(carryRef("/pricing", "Bad Tag", here)).toBeNull();
  });
});

describe("arrival before anything rewrites the address", () => {
  test("keeps only safe campaign labels, tags, ad presence and named content labels", () => {
    const arrival = arrivalOf("/s#PRIVATE_SHARED", "?utm_source=ChatGPT.com&utm_medium=CPC&gclid=PRIVATE_AD&email=PRIVATE_EMAIL&token=PRIVATE_TOKEN&story=Goose&ref=HN", "https://chatgpt.com/c/PRIVATE_CHAT?token=PRIVATE_REFERRER", ["story"]);
    expect(channelOf(arrival.referrer, arrival.search)).toEqual({ channel: "paid", source: "chatgpt.com" });
    expect(arrival.path).toBe("/s");
    expect([...new URLSearchParams(arrival.search).keys()]).toEqual(["utm_source", "utm_medium", "ref", "gclid"]);
    expect(arrival.content).toEqual({ story: "goose" });
    expect(JSON.stringify(arrival)).not.toContain("PRIVATE");
    for (const value of ["person@example.com", "https://example.com/private", "arbitrary text", "data:image/png;base64,AAAA"]) {
      const unsafe = arrivalOf("/", `?utm_source=${encodeURIComponent(value)}&ref=${encodeURIComponent(value)}`, "not an address");
      expect(unsafe).toEqual({ path: "/", search: "", referrer: "", content: {} });
    }
  });

  test("Meta's click ID is held apart for the Meta adapter, and only its presence is a label", () => {
    const arrival = arrivalOf("/", "?fbclid=IwAR0abc&utm_source=meta", "");
    expect(arrival.fbclid).toBe("IwAR0abc");
    expect(arrival.search).toBe("utm_source=meta");
    expect(clickKind(arrival.search, arrival.fbclid)).toBe("fbclid");
    expect(clickKind("gclid=")).toBe("gclid");
    expect(clickKind("")).toBe("none");
    expect(arrivalOf("/", "?fbclid=<script>", "").fbclid).toBeUndefined();
  });

  test("the landing's own labels", () => {
    const arrival = arrivalOf("/", "?ref=hn&utm_campaign=launch&ad=y5", "", ["ad"]);
    expect(arrivalProps(arrival)).toMatchObject({ channel: "community", ref: "hn", utm_campaign: "launch", ad: "y5" });
  });
});

describe("a remembered visitor", () => {
  const day1 = new Date("2026-11-13T10:00:00Z");
  test("keeps how they first arrived, the first tag and the latest, and counts each day once", () => {
    const first = remember(undefined, day1, arrivalOf("/mac", "?ref=hn&utm_medium=post", "https://news.ycombinator.com/item?id=1", ["story"]), { surface: "site", landingKind: "product" });
    expect(first).toMatchObject({ channel: "community", source: "hn", ref: "hn", lastRef: "hn", landing: "/mac", landingKind: "product", referrerHost: "news.ycombinator.com", clickKind: "none", week: "2026-11-09", days: 1, last: "2026-11-13", medium: "post", surface: "site" });
    const sameDay = remember(first, new Date("2026-11-13T12:00:00Z"), arrivalOf("/", "?ref=r-macapps", ""));
    expect(sameDay).toMatchObject({ ref: "hn", lastRef: "r-macapps", days: 1, channel: "community" });
    const later = remember(sameDay, new Date("2026-11-20T12:00:00Z"), arrivalOf("/", "", "https://www.google.com/"));
    expect(later).toMatchObject({ ref: "hn", lastRef: "r-macapps", days: 2, last: "2026-11-20", channel: "community" });
    expect(firstTouchProps(later)).toMatchObject({ first_channel: "community", first_source: "hn", first_ref: "hn", last_ref: "r-macapps", first_landing: "/mac", first_landing_kind: "product", first_referrer_host: "news.ycombinator.com", first_click_kind: "none", first_week: "2026-11-09", first_surface: "site", active_days: 2, returning: true });
  });

  test("a first visit without a tag: the first tag seen later is still the first", () => {
    const plain = remember(undefined, day1, arrivalOf("/", "", ""));
    expect(firstTouchProps(plain).first_ref).toBeUndefined();
    expect(remember(plain, new Date("2026-11-14T10:00:00Z"), arrivalOf("/", "?ref=producthunt", ""))).toMatchObject({ ref: "producthunt", lastRef: "producthunt", channel: "direct" });
  });

  test("content labels become first_<name>", () => {
    const touch = remember(undefined, day1, arrivalOf("/", "?story=goose&ad=y5", "", ["story", "ad"]));
    expect(firstTouchProps(touch)).toMatchObject({ first_story: "goose", first_ad: "y5" });
  });

  test("a week starts on Monday", () => {
    expect(mondayOf(new Date("2026-11-15T12:00:00Z"))).toBe("2026-11-09");
    expect(mondayOf(new Date("2026-11-16T00:00:00Z"))).toBe("2026-11-16");
  });

  test("a stored record is parsed from unknown and keeps only labels", () => {
    const touch = remember(undefined, day1, arrivalOf("/", "?ref=hn&story=goose", "https://www.google.com/", ["story"]));
    expect(parseFirstTouch(JSON.parse(JSON.stringify(touch)))).toEqual(touch);
    expect(parseFirstTouch({ ...touch, ref: "person@example.com", labels: { story: "a b", "Bad Key": "x" } })).toMatchObject({ ref: undefined, labels: {} });
    for (const bad of [null, 1, {}, { ...touch, days: 0 }, { ...touch, channel: "mars" }]) expect(parseFirstTouch(bad)).toBeUndefined();
  });
});

describe("what never leaves", () => {
  test("whatever follows #, private query parts and private routes", () => {
    expect(cleanUrl("https://example.com/s#eJxSECRET")).toBe("https://example.com/s");
    expect(cleanUrl("https://example.com/?paid=cs_live_abc&x=1#h")).toBe("https://example.com/");
    expect(cleanUrl("https://example.com/?paid=cs_live_SECRET&c=abc123&utm_source=x&ref=hn&token=t")).toBe("https://example.com/?utm_source=x&ref=hn");
    expect(cleanUrl("/about")).toBe("/about");
    expect(cleanUrl("https://example.com/@bg/secret-note?x=1", ["/@:handle/:slug"])).toBe("https://example.com/@:handle/:slug");
    expect(cleanText("Failed to parse https://example.com/s#SECRET now")).toBe("Failed to parse https://example.com/s now");
    expect(cleanText("img blob:https://example.com/1b2c and data:image/png;base64,AAAA")).toBe("img blob: and data:");
  });

  test("route patterns", () => {
    expect(routePattern("/library/a/b", ["/library/*"])).toBe("/library/*");
    expect(routePattern("/@bg/note", ["/@:handle/:slug"])).toBe("/@:handle/:slug");
    expect(routePattern("/about", ["/@:handle/:slug"])).toBe("/about");
    expect(routePattern("/x/y/z", ["/x/:id"])).toBe("/x/y/z");
  });

  test("SDK referrers, campaigns and ad IDs cannot bypass the allowlist", () => {
    const timestamp = new Date("2026-11-14T12:00:00Z");
    const sent = cleanProps({
      $referrer: "https://chatgpt.com/c/PRIVATE_CHAT?token=PRIVATE_TOKEN#PRIVATE_FRAGMENT",
      $current_url: "https://example.com/about?utm_source=person%40example.com&utm_campaign=launch&gclid=PRIVATE_AD&query=PRIVATE_QUERY",
      $session_entry_utm_source: "person@example.com",
      $session_entry_gclid: "PRIVATE_SESSION_AD",
      utm_source: "person@example.com",
      gclid: "PRIVATE_AD",
      msclkid: "PRIVATE_AD",
      first_source: "https://example.com/PRIVATE_SOURCE",
      $set_once: { $initial_referrer: "https://search.example/private/PRIVATE_SEARCH", $initial_utm_source: "person@example.com", $initial_fbclid: "PRIVATE_CLICK" },
      timestamp,
    });
    expect(sent.$referrer).toBe("https://chatgpt.com/");
    expect(sent.$current_url).toBe("https://example.com/about?utm_campaign=launch");
    expect(sent.$set_once as unknown).toEqual({ $initial_referrer: "https://search.example/" });
    expect(sent.utm_source).toBeUndefined();
    expect(sent.first_source).toBeUndefined();
    expect(sent.gclid).toBeUndefined();
    expect(JSON.stringify(sent)).not.toMatch(/PRIVATE|person%40|person@/u);
    expect(sent.timestamp).toBe(timestamp);
  });

  test("every link an event carries is cleaned, whatever the property is called, at any depth", () => {
    const sent = cleanProps({
      $current_url: "https://example.com/s#SECRET",
      $pathname: "/s",
      $prev_pageview_url: "https://example.com/s#SECRET",
      nth: 3,
      $web_vitals_FCP_event: { navigationURL: "https://example.com/s#SECRET", $current_url: "https://example.com/s#SECRET", value: 412 },
      $exception_list: [{ stacktrace: { frames: [{ filename: "https://example.com/assets/main.js", source: "https://example.com/s#SECRET" }] } }],
      message: "SecurityError at 'https://example.com/s#SECRET' again for person@example.com",
      timestamp: new Date("2026-11-13T10:00:00Z"),
    });
    expect(JSON.stringify(sent)).not.toMatch(/SECRET|person@/u);
    expect(sent.nth).toBe(3);
    expect(sent.timestamp).toBeInstanceOf(Date);
    expect(sent.$web_vitals_FCP_event).toEqual({ navigationURL: "https://example.com/s", $current_url: "https://example.com/s", value: 412 });
    expect(sent.message).toBe("SecurityError at 'https://example.com/s' again for [email]");
  });

  test("a label property never carries more than a label", () => {
    const sent: Record<string, unknown> = cleanProps({ ref: "person@example.com", via: "dir", first_ref: "HN", last_ref: "https://x.example/PRIVATE", $session_entry_ref: "a b", $set_once: { $initial_ref: "PRIVATE text" } });
    expect(sent).toEqual({ via: "dir", first_ref: "hn", $set_once: {} });
  });

  test("an allowlist drops the product's unknown properties but keeps PostHog's", () => {
    expect(cleanProps({ $current_url: "/", plan: "pro", prompt: "secret" }, { allowProps: ["plan"] }) as unknown).toEqual({ $current_url: "/", plan: "pro" });
  });
});

describe("route matching", () => {
  test("a literal pattern matches itself; no match is undefined", async () => {
    const { matchRoute, routePattern } = await import("./attribution.js");
    const patterns = ["/account", "/settings/billing", "/library/*", "/s/:id"];
    expect(matchRoute("/account", patterns)).toBe("/account");
    expect(matchRoute("/settings/billing", patterns)).toBe("/settings/billing");
    expect(matchRoute("/library/a/b", patterns)).toBe("/library/*");
    expect(matchRoute("/s/abc", patterns)).toBe("/s/:id");
    for (const path of ["/accounts", "/settings", "/s/abc/def", "/"]) expect(matchRoute(path, patterns)).toBeUndefined();
    expect(routePattern("/accounts", patterns)).toBe("/accounts");
  });
});

describe("keys that carry addresses", () => {
  test("heatmap data is keyed by the cleaned address, merging collapsed keys", async () => {
    const { cleanProps } = await import("./attribution.js");
    const input: Record<string, unknown> = {
      $heatmap_data: {
        "https://example.com/p?secret=1#a": [{ x: 1 }],
        "https://example.com/p#b": [{ x: 2 }],
        "/u/probe@example.com?ref=hn": [{ x: 3 }],
      },
      plain_key: 1,
    };
    const cleaned = cleanProps(input);
    expect(cleaned).toEqual({
      $heatmap_data: { "https://example.com/p": [{ x: 1 }, { x: 2 }], "[email]?ref=hn": [{ x: 3 }] },
      plain_key: 1,
    });
  });
});

describe("whole events", () => {
  test("allowProps applies to properties only; the event's own fields stay", async () => {
    const { cleanEvent } = await import("./attribution.js");
    const event = { event: "$pageview", uuid: "u-1", timestamp: "2026-11-16T00:00:00Z", properties: { title: "x", cta: "hero", $current_url: "https://example.com/?secret=1#f" } };
    expect(cleanEvent(event, { allowProps: ["cta"] })).toEqual({
      event: "$pageview",
      uuid: "u-1",
      timestamp: "2026-11-16T00:00:00Z",
      properties: { cta: "hero", $current_url: "https://example.com/" },
    });
  });
});
