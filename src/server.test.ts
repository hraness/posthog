import { describe, expect, test } from "bun:test";

import {
  accountDistinctId,
  billingEvent,
  capture,
  captureBilling,
  captureBody,
  checkoutMetadata,
  deletePerson,
  downloadServed,
  installDistinctId,
  money,
  parseWireEvent,
  regionHandler,
  regionOf,
  regionScript,
  wireCapture,
  wireHandler,
  type BillingRef,
} from "./server.js";

const config = { token: "public-token", siteId: "example" } as const;
const recorder = () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? "null")) as Record<string, unknown> });
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

describe("the region endpoint", () => {
  test("reads the edge's country and GPC", () => {
    expect(regionOf(new Headers({ "cf-ipcountry": "FR" })).region_group).toBe("eu");
    expect(regionOf(new Headers({ "x-vercel-ip-country": "us", "sec-gpc": "1" }))).toMatchObject({ country: "US", region_group: "us", gpc: true, policy: { ads: false, replay: false, autocapture: true } });
    expect(regionOf(new Headers({ "cf-ipcountry": "XX" }), "America/Chicago").region_group).toBe("us");
    expect(regionOf(new Headers()).region_group).toBe("eu");
  });

  test("is never cached and takes the browser's time zone", async () => {
    const response = regionHandler(new Request("https://example.com/api/region?tz=Asia/Tokyo"));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ country: null, region_group: "row" });
    expect(((await regionHandler(new Request("https://example.com/api/region?tz=%3Cx%3E")).json()) as { region_group: string }).region_group).toBe("eu");
  });

  test("the inline script cannot close its tag", () => {
    expect(regionScript({ ...regionOf(new Headers({ "cf-ipcountry": "US" })), country: "</script>" as never })).not.toContain("</script>");
  });
});

describe("capture", () => {
  test("a stable UUID per key, no person, no IP or GeoIP", async () => {
    const body = await captureBody(config, { event: "download served", distinctId: "d", key: "k", at: 1763200000, props: { platform: "mac" } });
    const again = await captureBody(config, { event: "download served", distinctId: "d", key: "k", at: 1763200000 });
    expect(body.uuid).toBe(again.uuid);
    expect(body.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(body).toMatchObject({ api_key: "public-token", event: "download served", distinct_id: "d", timestamp: "2025-11-15T09:46:40.000Z" });
    expect(body.properties).toMatchObject({ platform: "mac", site_id: "example", surface: "server", schema: 2, $process_person_profile: false, $geoip_disable: true, $ip: null, $insert_id: body.uuid });
    const other = await captureBody({ ...config, siteId: "other" }, { event: "x", distinctId: "d", key: "k" });
    expect(other.uuid).not.toBe(body.uuid);
  });

  test("no token, nothing sent; a failure never throws", async () => {
    const { calls, fetcher } = recorder();
    await capture({ ...config, token: "", fetch: fetcher }, { event: "x", distinctId: "d" });
    expect(calls).toEqual([]);
    const failing = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    await capture({ ...config, fetch: failing }, { event: "x", distinctId: "d" });
    let waited: Promise<unknown> | undefined;
    await capture({ ...config, fetch: fetcher }, { event: "x", distinctId: "d" }, (job) => { waited = job; });
    expect(waited).toBeInstanceOf(Promise);
    expect(calls[0]?.url).toBe("https://us.i.posthog.com/i/v0/e/");
  });

  test("the account's distinct ID is an HMAC, stable, and needs a real secret", async () => {
    const secret = "0123456789abcdef0123";
    const id = await accountDistinctId(secret, "account-1");
    expect(id).toMatch(/^acct_[0-9a-f]{40}$/u);
    expect(await accountDistinctId(secret, "account-1")).toBe(id);
    expect(await accountDistinctId(`${secret}x`, "account-1")).not.toBe(id);
    expect(accountDistinctId("short", "account-1")).rejects.toThrow();
  });
});

describe("billing", () => {
  test("Stripe amounts in payment units, including zero and three-decimal currencies", () => {
    expect(money(500, "USD")).toEqual({ amount: 5, currency: "usd" });
    expect(money(500, "JPY")).toEqual({ amount: 500, currency: "jpy" });
    expect(money(1230, "KWD")).toEqual({ amount: 1.23, currency: "kwd" });
    expect(money(500, "ISK")).toEqual({ amount: 5, currency: "isk" });
    expect(money(0, "usd")).toEqual({ amount: 0, currency: "usd" });
    expect(money(-1, "usd")).toEqual({ currency: "usd" });
    expect(money(5.5, "usd")).toEqual({ currency: "usd" });
    expect(money(500, "not a currency")).toEqual({});
  });

  const owned = (ids: Record<string, string>) => ({ resolve: (ref: BillingRef) => Promise.resolve(ids[`${ref.kind}:${ref.id}`]) });
  const stripe = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: "evt_1", type, created: 1763200000, livemode: true, data: { object, ...extra } });

  test("a paid subscription checkout starts a subscription with its first-touch labels", async () => {
    const event = await billingEvent(stripe("checkout.session.completed", { mode: "subscription", payment_status: "paid", subscription: "sub_1", amount_total: 500, currency: "usd", metadata: { first_ref: "HN", first_source: "news.ycombinator.com", plan: "pro", email: "x@example.com" } }), owned({ "subscription:sub_1": "account-1" }));
    expect(event).toEqual({ event: "subscription started", key: "subscription started:sub_1", at: 1763200000, account: "account-1", props: { store: "stripe", livemode: true, first_ref: "hn", first_source: "news.ycombinator.com", plan: "pro", platform: undefined, amount: 5, currency: "usd", interval: "month" } });
    expect(JSON.stringify(event)).not.toContain("example.com");
  });

  test("a one-time purchase completes a checkout; an unowned or unpaid one is nothing", async () => {
    expect((await billingEvent(stripe("checkout.session.completed", { mode: "payment", payment_status: "paid", payment_intent: "pi_1" }), owned({ "payment:pi_1": "a" })))?.event).toBe("checkout completed");
    expect(await billingEvent(stripe("checkout.session.completed", { mode: "payment", payment_status: "paid", payment_intent: "pi_1" }), owned({}))).toBeUndefined();
    expect(await billingEvent(stripe("checkout.session.completed", { mode: "payment", payment_status: "unpaid", payment_intent: "pi_1" }), owned({ "payment:pi_1": "a" }))).toBeUndefined();
    expect(await billingEvent(stripe("checkout.session.completed", { mode: "payment", payment_status: "paid", payment_intent: "pi_1" }), { ...owned({ "payment:pi_1": "a" }), accept: () => false })).toBeUndefined();
  });

  test("renewals, failures, cancellations and refunds", async () => {
    const ids = owned({ "subscription:sub_1": "a", "payment:pi_9": "b" });
    expect(await billingEvent(stripe("invoice.paid", { id: "in_1", billing_reason: "subscription_cycle", subscription: "sub_1", amount_paid: 500, currency: "usd" }), ids)).toMatchObject({ event: "subscription renewed", key: "subscription renewed:in_1", props: { amount: 5 } });
    expect(await billingEvent(stripe("invoice.paid", { id: "in_1", billing_reason: "subscription_create", subscription: "sub_1" }), ids)).toBeUndefined();
    expect(await billingEvent(stripe("invoice.payment_failed", { id: "in_2", parent: { subscription_details: { subscription: "sub_1", metadata: { first_ref: "dir" } } }, amount_due: 500, currency: "usd" }), ids)).toMatchObject({ event: "payment failed", props: { first_ref: "dir" } });
    expect(await billingEvent(stripe("customer.subscription.updated", { id: "sub_1", cancel_at_period_end: true, canceled_at: 1763100000, current_period_end: 1764000000 }, { previous_attributes: { cancel_at_period_end: false } }), ids)).toMatchObject({ event: "subscription canceled", at: 1763100000, props: { at_period_end: true } });
    expect(await billingEvent(stripe("customer.subscription.updated", { id: "sub_1", cancel_at_period_end: false }, { previous_attributes: { metadata: {} } }), ids)).toBeUndefined();
    expect(await billingEvent(stripe("customer.subscription.deleted", { id: "sub_1" }), ids)).toMatchObject({ event: "subscription canceled" });
    expect(await billingEvent(stripe("charge.refunded", { payment_intent: "pi_9", amount_refunded: 300, currency: "usd", refunded: false }, { previous_attributes: { amount_refunded: 100 } }), ids)).toMatchObject({ event: "refund issued", account: "b", props: { amount: 2, full: false } });
    expect(await billingEvent(stripe("charge.refunded", { payment_intent: "pi_x", invoice: { subscription: "sub_1" }, amount_refunded: 500, currency: "usd", refunded: true }), ids)).toMatchObject({ event: "refund issued", account: "a", props: { amount: 5, full: true } });
    expect(await billingEvent(stripe("customer.created", {}), ids)).toBeUndefined();
    expect(await billingEvent({ type: "invoice.paid" }, ids)).toBeUndefined();
  });

  test("billing is captured under the account's distinct ID, so it joins the signed-in person", async () => {
    const { calls, fetcher } = recorder();
    const secret = "0123456789abcdef0123";
    await captureBilling({ ...config, secret, fetch: fetcher }, stripe("checkout.session.completed", { mode: "subscription", payment_status: "paid", subscription: "sub_1" }), owned({ "subscription:sub_1": "account-1" }));
    expect(calls[0]?.body.distinct_id).toBe(await accountDistinctId(secret, "account-1"));
    expect(calls[0]?.body.properties).toMatchObject({ $process_person_profile: true, store: "stripe" });
  });

  test("checkout metadata carries only labels", () => {
    expect(checkoutMetadata({ firstRef: "HN", firstSource: "google.com", plan: "pro", platform: "mac", interval: "year" })).toEqual({ "metadata[first_ref]": "hn", "metadata[first_source]": "google.com", "metadata[plan]": "pro", "metadata[platform]": "mac", "metadata[interval]": "year" });
    expect(checkoutMetadata({ firstRef: "person@example.com", firstSource: "a b", plan: "Pro Plan", platform: "amiga" })).toEqual({});
  });
});

describe("the app and CLI wire format", () => {
  const install = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
  const id = "1f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
  const now = 1763200000;
  const valid = { v: 1, event: "app installed", install, id, at: now - 60, app: "1.2", build: 42, os: "26.1", region: "default", props: { region_group: "us", surface: "mac", ref: "hn", visit: install } };

  test("accepts exactly what the Swift package sends", () => {
    expect(parseWireEvent(valid, {}, now)).toEqual({ event: "app installed", install, id, at: now - 60, app: "1.2", build: 42, os: "26.1", region: "default", props: { region_group: "us", surface: "mac", ref: "hn", visit: install } });
    expect(parseWireEvent({ ...valid, event: "app opened", props: { days_since_install_bucket: "2-6", region_group: "eu", surface: "ios" } }, {}, now)).toBeDefined();
  });

  test("rejects anything else in the event", () => {
    for (const bad of [
      { ...valid, v: 2 },
      { ...valid, extra: 1 },
      { ...valid, event: "something else" },
      { ...valid, install: "x" },
      { ...valid, id: "x" },
      { ...valid, app: "1.2-beta" },
      { ...valid, build: -1 },
      { ...valid, build: 1.5 },
      { ...valid, os: "26" },
      { ...valid, region: "eu" },
      { ...valid, props: [] },
      { ...valid, props: { ref: "person@example.com" } },
      { ...valid, props: { region_group: "mars" } },
      { ...valid, props: { prompt: "hello" } },
      { ...valid, props: { ref: 5 } },
      null,
      "x",
    ]) expect(parseWireEvent(bad, {}, now)).toBeUndefined();
  });

  test("a product adds its own events and properties", () => {
    const events = { "export completed": { export_count_bucket: ["1", "2", "3", "4-9", "10-24", "25+"] } };
    const exported = { ...valid, event: "export completed", props: { export_count_bucket: "1" } };
    expect(parseWireEvent(exported, {}, now)).toBeUndefined();
    expect(parseWireEvent(exported, events, now)?.props).toEqual({ export_count_bucket: "1" });
    expect(parseWireEvent({ ...exported, props: { export_count_bucket: "7" } }, events, now)).toBeUndefined();
  });

  test("a clock that is off is replaced by now", () => {
    expect(parseWireEvent({ ...valid, at: now + 3600 }, {}, now)?.at).toBe(now);
    expect(parseWireEvent({ ...valid, at: now - 31 * 86400 }, {}, now)?.at).toBe(now);
  });

  test("an install is a hashed distinct ID, and once-only events collapse", async () => {
    const event = parseWireEvent(valid, {}, now);
    if (event === undefined) throw new Error("valid event rejected");
    const first = await wireCapture(config, event);
    expect(first.distinctId).toBe(await installDistinctId(config, install));
    expect(first.distinctId).toMatch(/^example:install:[0-9a-f]{40}$/u);
    expect(first.distinctId).not.toContain(install);
    expect(first).toMatchObject({ surface: "mac", props: { ref: "hn", identity_scope: "install", app_version: "1.2", app_build: 42, os_version: "26.1", consent_region: "default", region_group: "us" } });
    const again = await wireCapture(config, { ...event, id: "2f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0" });
    expect(again.key).toBe(first.key);
    const cli = parseWireEvent({ ...valid, event: "cli command run", props: { command: "publish", ok: "true", duration_bucket: "<1s", ci: "false", surface: "cli", platform: "mac" } }, {}, now);
    if (cli === undefined) throw new Error("cli event rejected");
    expect((await wireCapture(config, cli)).props).toMatchObject({ ok: true, ci: false, command: "publish" });
  });

  test("the handler answers 204 for good batches and 400 for bad ones", async () => {
    const { calls, fetcher } = recorder();
    const post = (body: unknown) => new Request("https://example.com/api/cli/event", { method: "POST", body: JSON.stringify(body) });
    const fresh = { ...valid, at: Math.floor(Date.now() / 1000) };
    const jobs: Promise<unknown>[] = [];
    expect((await wireHandler({ ...config, fetch: fetcher }, post([fresh, fresh]), {}, (job) => { jobs.push(job); })).status).toBe(204);
    await Promise.all(jobs);
    expect(calls).toHaveLength(2);
    expect((await wireHandler({ ...config, fetch: fetcher }, post({ ...fresh, extra: 1 }))).status).toBe(400);
    expect((await wireHandler({ ...config, fetch: fetcher }, new Request("https://example.com/", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await wireHandler({ ...config, fetch: fetcher }, new Request("https://example.com/"))).status).toBe(405);
  });
});

describe("downloads and erasure", () => {
  test("a served download carries labels only", async () => {
    const { calls, fetcher } = recorder();
    await downloadServed({ ...config, fetch: fetcher }, { platform: "mac", artifact: "zip", version: "1.2.3", ref: "HN", visit: "nope" });
    expect(calls[0]?.body).toMatchObject({ event: "download served", properties: { platform: "mac", artifact: "zip", version: "1.2.3", ref: "hn" } });
    expect(String(calls[0]?.body.distinct_id)).toMatch(/^download:/u);
  });

  test("erasure finds the person by distinct ID and deletes them with their events", async () => {
    const seen: string[] = [];
    const fetcher = ((url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("distinct_id")) return Promise.resolve(Response.json({ results: [{ uuid: "p1" }] }));
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as unknown as typeof fetch;
    expect(await deletePerson({ personalApiKey: "k", projectId: 1, fetch: fetcher }, "acct_1")).toBe(true);
    expect(seen).toEqual(["GET https://us.posthog.com/api/projects/1/persons/?distinct_id=acct_1", "DELETE https://us.posthog.com/api/projects/1/persons/p1/?delete_events=true"]);
  });
});
