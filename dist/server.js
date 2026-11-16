// src/attribution.ts
var CAMPAIGNS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
var REFS = ["ref", "via"];
var CLICK_IDS = ["gclid", "fbclid", "msclkid"];
var TRACKING = [...REFS, ...CAMPAIGNS, ...CLICK_IDS];
function refLabel(value) {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9._-]{1,40}$/u.test(label) ? label : undefined;
}

// src/events.ts
var SCHEMA = 2;
var MARKETING_EVENTS = [
  "cta clicked",
  "outbound link opened",
  "demo played",
  "download started",
  "install command copied",
  "store link opened",
  "download link emailed",
  "download link failed",
  "analytics choice made"
];
var LIFECYCLE_EVENTS = [
  "app installed",
  "app opened",
  "cli command run",
  "mcp tool called",
  "account created",
  "signed in",
  "activated",
  "upgrade offered",
  "checkout started"
];
var SERVER_EVENTS = [
  "download served",
  "checkout completed",
  "subscription started",
  "subscription renewed",
  "subscription canceled",
  "payment failed",
  "refund issued",
  "checkout session created"
];
var SHARED_EVENTS = [...MARKETING_EVENTS, ...LIFECYCLE_EVENTS, ...SERVER_EVENTS];

// src/internal.ts
var bag = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
var count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
var encoder = new TextEncoder;
var hexOf = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
async function sha256Hex(value) {
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hexOf(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}
var NAMESPACE = Uint8Array.from([107, 167, 184, 17, 157, 173, 17, 209, 128, 180, 0, 192, 79, 212, 48, 200]);
async function uuidV5(name) {
  const text = encoder.encode(name);
  const input = new Uint8Array(NAMESPACE.length + text.length);
  input.set(NAMESPACE);
  input.set(text, NAMESPACE.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  bytes[6] = (bytes[6] ?? 0) & 15 | 80;
  bytes[8] = (bytes[8] ?? 0) & 63 | 128;
  const hex = hexOf(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
var ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf"]);
var THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
function decimalsOf(currency) {
  return ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2;
}
var UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
function later(waitUntil, timeoutMs, work) {
  const job = (async () => {
    const controller = new AbortController;
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      await work(controller.signal);
    } catch {} finally {
      clearTimeout(timer);
    }
  })();
  try {
    waitUntil?.(job);
  } catch {}
  return job;
}

// src/policy.ts
var REGION_TABLE = {
  eu: { analytics: "cookieless", autocapture: false, replay: false, ads: false, ask: "all" },
  uk_ch: { analytics: "persistent", autocapture: true, replay: false, ads: false, ask: "ads" },
  br: { analytics: "persistent", autocapture: true, replay: false, ads: false, ask: "ads" },
  us: { analytics: "persistent", autocapture: true, replay: true, ads: true, ask: "none" },
  row: { analytics: "persistent", autocapture: true, replay: true, ads: true, ask: "none" }
};
var EU_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  "IS",
  "LI",
  "NO",
  "AX",
  "GF",
  "GP",
  "MQ",
  "RE",
  "YT",
  "MF",
  "GG",
  "JE",
  "IM",
  "GI"
];
var UK_CH_COUNTRIES = ["GB", "CH"];
var BR_COUNTRIES = ["BR"];
var US_COUNTRIES = ["US", "PR", "GU", "VI", "AS", "MP", "UM"];
var PLACELESS_ZONE = /^(?:UTC|UCT|GMT|GMT0|GMT[+-]0|Greenwich|Universal|Zulu|Factory|Etc\/.*)$/u;
var UK_CH_ZONE = /^(?:Europe\/(?:London|Belfast|Zurich)|GB|GB-Eire)$/u;
var EU_ZONE = /^(?:Europe\/.*|Arctic\/.*|Atlantic\/(?:Reykjavik|Canary|Madeira|Azores|Faroe|Faeroe|Jan_Mayen)|Asia\/(?:Nicosia|Famagusta)|Africa\/Ceuta|Indian\/(?:Reunion|Mayotte)|America\/(?:Guadeloupe|Martinique|Cayenne|Marigot|St_Barthelemy)|Eire|Iceland|Portugal|Poland|CET|MET|EET|WET)$/u;
var BR_ZONE = /^(?:America\/(?:Sao_Paulo|Rio_Branco|Manaus|Cuiaba|Campo_Grande|Belem|Fortaleza|Recife|Araguaina|Maceio|Bahia|Santarem|Porto_Velho|Boa_Vista|Eirunepe|Noronha|Porto_Acre)|Brazil\/.*)$/u;
var US_ZONE = /^(?:America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak|Boise|Detroit|Menominee|Indiana\/.*|Kentucky\/.*|North_Dakota\/.*|Indianapolis|Louisville|Puerto_Rico|St_Thomas)|Pacific\/(?:Honolulu|Guam|Saipan|Pago_Pago|Midway|Wake)|US\/.*|EST|MST|HST|EST5EDT|CST6CDT|MST7MDT|PST8PDT|Navajo)$/u;
var EU_SET = new Set(EU_COUNTRIES);
var UK_CH_SET = new Set(UK_CH_COUNTRIES);
var BR_SET = new Set(BR_COUNTRIES);
var US_SET = new Set(US_COUNTRIES);
function countryCode(value) {
  if (typeof value !== "string")
    return;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(code) || code === "XX" || code === "ZZ")
    return;
  return code;
}
function groupOfCountry(code) {
  if (EU_SET.has(code))
    return "eu";
  if (UK_CH_SET.has(code))
    return "uk_ch";
  if (BR_SET.has(code))
    return "br";
  if (US_SET.has(code))
    return "us";
  return "row";
}
function groupOfZone(zone) {
  if (typeof zone !== "string")
    return "eu";
  const name = zone.trim();
  if (name === "" || PLACELESS_ZONE.test(name))
    return "eu";
  if (UK_CH_ZONE.test(name))
    return "uk_ch";
  if (EU_ZONE.test(name))
    return "eu";
  if (BR_ZONE.test(name))
    return "br";
  if (US_ZONE.test(name))
    return "us";
  return "row";
}
function regionGroup(input) {
  const code = countryCode(input.country);
  return code === undefined ? groupOfZone(input.zone) : groupOfCountry(code);
}
function regionPolicy(input) {
  const group = regionGroup(input);
  const rule = REGION_TABLE[group];
  const analyticsChoice = input.choices?.analytics;
  const adsChoice = input.choices?.ads;
  const gpc = input.gpc === true;
  let analytics = rule.analytics;
  let autocapture = rule.autocapture;
  let replay = rule.replay;
  let ads = rule.ads;
  let ask = rule.ask;
  if (group === "eu") {
    const yes = analyticsChoice === "yes" || analyticsChoice === undefined && adsChoice === "yes";
    if (yes) {
      analytics = "persistent";
      autocapture = true;
      replay = adsChoice !== "no";
      ads = adsChoice !== "no";
    }
    if (analyticsChoice !== undefined || adsChoice !== undefined)
      ask = "none";
  } else {
    if (adsChoice === "yes") {
      replay = true;
      ads = true;
    } else if (adsChoice === "no") {
      replay = false;
      ads = false;
    }
    if (adsChoice !== undefined || analyticsChoice !== undefined)
      ask = "none";
  }
  if (analyticsChoice === "no") {
    analytics = "cookieless";
    autocapture = false;
    replay = false;
    ads = false;
    ask = "none";
  }
  if (gpc) {
    replay = false;
    ads = false;
    if (ask === "ads")
      ask = "none";
  }
  return { region_group: group, analytics, autocapture, replay, ads, ask };
}
function regionResponse(input) {
  const country = countryCode(input.country) ?? null;
  const gpc = input.gpc === true;
  return { country, region_group: regionGroup(input), gpc, policy: regionPolicy({ country, zone: input.zone, gpc }) };
}

// src/server.ts
var COUNTRY_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country", "x-country-code"];
var headersOf = (source) => ("headers" in source) ? source.headers : source;
function regionOf(source, zone) {
  const headers = headersOf(source);
  const country = COUNTRY_HEADERS.map((name) => headers.get(name)).find((value) => typeof value === "string" && value !== "") ?? null;
  return regionResponse({ country, zone, gpc: headers.get("sec-gpc") === "1" });
}
function regionHandler(request) {
  let zone;
  try {
    const tz = new URL(request.url).searchParams.get("tz");
    zone = tz !== null && /^[A-Za-z0-9_+/-]{1,64}$/u.test(tz) ? tz : undefined;
  } catch {
    zone = undefined;
  }
  return new Response(JSON.stringify(regionOf(request, zone)), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", vary: "*" }
  });
}
function regionScript(region) {
  return `window.__hranessRegion=${JSON.stringify(region).replace(/</gu, "\\u003c")};`;
}
var CAPTURE_PATH = "/i/v0/e/";
async function captureBody(config, input) {
  const namespace = config.namespace ?? config.siteId;
  const key = input.key ?? crypto.randomUUID();
  const uuid = await uuidV5(`${namespace}\x00${key}`);
  const person = input.person === true;
  return {
    api_key: config.token,
    uuid,
    event: input.event,
    distinct_id: input.distinctId,
    timestamp: new Date((input.at ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    properties: {
      ...input.props,
      site_id: config.siteId,
      surface: input.surface ?? "server",
      schema: SCHEMA,
      $process_person_profile: person,
      $geoip_disable: true,
      $ip: null,
      $insert_id: uuid,
      ...person && input.setOnce !== undefined ? { $set_once: input.setOnce } : {},
      ...person && input.set !== undefined ? { $set: input.set } : {}
    }
  };
}
function capture(config, input, waitUntil) {
  if (config.token === undefined || config.token === "")
    return Promise.resolve();
  const send = config.fetch ?? fetch;
  return later(waitUntil, config.timeoutMs ?? 3000, async (signal) => {
    const event = await input;
    if (event === undefined)
      return;
    await send(`${(config.host ?? "https://us.i.posthog.com").replace(/\/$/u, "")}${CAPTURE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(await captureBody(config, event)),
      signal
    });
  });
}
async function accountDistinctId(secret, account) {
  if (secret.length < 16)
    throw new Error("accountDistinctId needs a secret of at least 16 characters");
  return `acct_${(await hmacHex(secret, `account\x00${account}`)).slice(0, 40)}`;
}
function money(amount, currency) {
  if (typeof currency !== "string" || !/^[a-z]{3}$/iu.test(currency))
    return {};
  const code = currency.toLowerCase();
  const minor = count(amount);
  return { currency: code, ...minor === undefined ? {} : { amount: minor / 10 ** decimalsOf(code) } };
}
var id = (value) => typeof value === "string" && value.length > 0 && value.length <= 255 ? value : id(bag(value)?.id);
var interval = (value) => value === "day" || value === "week" || value === "month" || value === "year" ? value : undefined;
function recurring(object) {
  const items = bag(object.items)?.data;
  const first = Array.isArray(items) ? bag(items[0]) : undefined;
  const price = bag(first?.price) ?? bag(object.plan);
  return interval(bag(price?.recurring)?.interval ?? price?.interval);
}
var invoiceSubscription = (invoice) => id(invoice.subscription) ?? id(bag(bag(invoice.parent)?.subscription_details)?.subscription);
var invoiceMetadata = (invoice) => bag(bag(bag(invoice.parent)?.subscription_details)?.metadata) ?? bag(bag(invoice.subscription_details)?.metadata);
var metadataProps = (metadata) => {
  const ref = refLabel(metadata?.first_ref);
  const source = typeof metadata?.first_source === "string" && /^[a-z0-9._-]{1,60}$/u.test(metadata.first_source) ? metadata.first_source : undefined;
  const plan = typeof metadata?.plan === "string" && /^[a-z0-9._-]{1,40}$/u.test(metadata.plan) ? metadata.plan : undefined;
  const platform = typeof metadata?.platform === "string" && /^(mac|windows|linux|ios|web)$/u.test(metadata.platform) ? metadata.platform : undefined;
  return { first_ref: ref, first_source: source, plan, platform };
};
async function billingEvent(stripe, options) {
  const input = bag(stripe);
  const object = bag(bag(input?.data)?.object);
  const eventId = id(input?.id);
  const at = count(input?.created);
  if (input === undefined || object === undefined || eventId === undefined || at === undefined || typeof input.livemode !== "boolean")
    return;
  const type = input.type;
  const previous = bag(bag(input.data)?.previous_attributes);
  const base = { store: "stripe", livemode: input.livemode };
  let metadata = bag(object.metadata);
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    if (object.payment_status !== "paid" && object.payment_status !== "no_payment_required")
      return;
    if (options.accept && !options.accept(object))
      return;
    const subscription = object.mode === "subscription";
    const external = subscription ? id(object.subscription) : id(object.payment_intent) ?? id(object.id);
    if (external === undefined)
      return;
    const account = await options.resolve({ kind: subscription ? "subscription" : "payment", id: external });
    if (account === undefined)
      return;
    const event = subscription ? "subscription started" : "checkout completed";
    return {
      event,
      key: `${event}:${external}`,
      at,
      account,
      props: { ...base, ...metadataProps(metadata), ...money(object.amount_total, object.currency), ...subscription ? { interval: interval(metadata?.interval) ?? "month" } : {} }
    };
  }
  if (type === "invoice.paid" || type === "invoice.payment_failed") {
    const subscription = invoiceSubscription(object);
    if (subscription === undefined)
      return;
    const account = await options.resolve({ kind: "subscription", id: subscription });
    if (account === undefined)
      return;
    metadata = invoiceMetadata(object) ?? metadata;
    const lines = bag(object.lines)?.data;
    const every = Array.isArray(lines) ? interval(bag(bag(bag(lines[0])?.price)?.recurring)?.interval ?? bag(bag(bag(lines[0])?.pricing)?.price_details)?.interval) : undefined;
    if (type === "invoice.paid") {
      const invoice = id(object.id);
      if (object.billing_reason !== "subscription_cycle" || invoice === undefined)
        return;
      return {
        event: "subscription renewed",
        key: `subscription renewed:${invoice}`,
        at: count(bag(object.status_transitions)?.paid_at) ?? at,
        account,
        props: { ...base, ...metadataProps(metadata), interval: every, ...money(object.amount_paid, object.currency) }
      };
    }
    return { event: "payment failed", key: eventId, at, account, props: { ...base, ...metadataProps(metadata), interval: every, ...money(object.amount_due, object.currency) } };
  }
  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const cancelAt = count(object.cancel_at);
    const scheduled = object.cancel_at_period_end === true || cancelAt !== undefined && cancelAt > at;
    const changed = previous !== undefined && (object.cancel_at_period_end === true && previous.cancel_at_period_end === false || cancelAt !== undefined && Object.hasOwn(previous, "cancel_at") && previous.cancel_at !== cancelAt);
    if (type !== "customer.subscription.deleted" && !(scheduled && changed))
      return;
    const subscription = id(object.id);
    if (subscription === undefined)
      return;
    const account = await options.resolve({ kind: "subscription", id: subscription });
    if (account === undefined)
      return;
    const items = bag(object.items)?.data;
    const ends = [object.current_period_end, ...Array.isArray(items) ? items.map((item) => bag(item)?.current_period_end) : []].map(count);
    const atPeriodEnd = object.cancel_at_period_end === true || cancelAt !== undefined && ends.includes(cancelAt);
    const time = count(object.canceled_at) ?? at;
    return {
      event: "subscription canceled",
      key: `subscription canceled:${subscription}:${String(time)}`,
      at: time,
      account,
      props: { ...base, ...metadataProps(metadata), interval: recurring(object), at_period_end: atPeriodEnd }
    };
  }
  if (type === "charge.refunded") {
    let account;
    const payment = id(object.payment_intent);
    if (payment !== undefined)
      account = await options.resolve({ kind: "payment", id: payment });
    if (account === undefined) {
      const invoice = bag(object.invoice) ?? await options.invoiceOf?.(object);
      const subscription = invoice === undefined ? undefined : invoiceSubscription(invoice);
      if (subscription !== undefined)
        account = await options.resolve({ kind: "subscription", id: subscription });
      if (invoice !== undefined)
        metadata = invoiceMetadata(invoice) ?? metadata;
    }
    if (account === undefined)
      return;
    const total = count(object.amount_refunded);
    const before = count(previous?.amount_refunded);
    const refunds = bag(object.refunds)?.data;
    const amount = total !== undefined && before !== undefined && total >= before ? total - before : Array.isArray(refunds) && refunds.length === 1 ? count(bag(refunds[0])?.amount) : total;
    return { event: "refund issued", key: eventId, at, account, props: { ...base, ...metadataProps(metadata), ...money(amount, object.currency), full: object.refunded === true } };
  }
  return;
}
function captureBilling(config, stripe, options, waitUntil) {
  return capture(config, (async () => {
    const mapped = await billingEvent(stripe, options);
    if (mapped === undefined)
      return;
    return { event: mapped.event, key: mapped.key, at: mapped.at, distinctId: await accountDistinctId(config.secret, mapped.account), props: mapped.props, person: true };
  })(), waitUntil);
}
function checkoutMetadata(input) {
  const out = {};
  const ref = refLabel(input.firstRef);
  if (ref !== undefined)
    out["metadata[first_ref]"] = ref;
  if (typeof input.firstSource === "string" && /^[a-z0-9._-]{1,60}$/u.test(input.firstSource))
    out["metadata[first_source]"] = input.firstSource;
  if (input.plan !== undefined && /^[a-z0-9._-]{1,40}$/u.test(input.plan))
    out["metadata[plan]"] = input.plan;
  if (input.platform !== undefined && /^(mac|windows|linux|ios|web)$/u.test(input.platform))
    out["metadata[platform]"] = input.platform;
  if (interval(input.interval) !== undefined)
    out["metadata[interval]"] = input.interval ?? "";
  return out;
}
var WIRE_FIELDS = new Set(["v", "event", "install", "id", "at", "app", "build", "os", "region", "props"]);
var label = (value) => /^[a-z0-9._-]{1,40}$/u.test(value);
var PLATFORMS = ["mac", "windows", "linux", "ios", "web"];
var COMMON_PROPS = {
  region_group: Object.keys(REGION_TABLE),
  surface: ["mac", "ios", "cli", "mcp", "extension", "web_app"],
  platform: PLATFORMS,
  ci: ["true", "false"]
};
var LIFECYCLE_WIRE = {
  "app installed": { channel: ["direct", "app_store", "npm", "brew"], ref: (value) => refLabel(value) === value, visit: (value) => UUID.test(value) },
  "app opened": { days_since_install_bucket: ["0", "1", "2-6", "7-29", "30+"] },
  "cli command run": { command: label, ok: ["true", "false"], duration_bucket: ["<1s", "1-5s", "5-30s", "30s+"] },
  "mcp tool called": { tool: label, client: ["claude", "cursor", "codex", "other"], ok: ["true", "false"] }
};
var allows = (rule, value) => rule === undefined ? false : typeof rule === "function" ? rule(value) : rule.includes(value);
function parseWireEvent(value, events = {}, now = Math.floor(Date.now() / 1000)) {
  const input = bag(value);
  if (input === undefined || input.v !== 1 || Object.keys(input).some((key) => !WIRE_FIELDS.has(key)))
    return;
  const name = input.event;
  if (typeof name !== "string")
    return;
  const allowed = Object.hasOwn(events, name) ? events[name] : Object.hasOwn(LIFECYCLE_WIRE, name) ? LIFECYCLE_WIRE[name] : undefined;
  if (allowed === undefined)
    return;
  if (typeof input.install !== "string" || !UUID.test(input.install) || typeof input.id !== "string" || !UUID.test(input.id))
    return;
  if (typeof input.app !== "string" || !/^\d{1,4}(\.\d{1,4}){0,3}$/u.test(input.app))
    return;
  if (typeof input.build !== "number" || !Number.isSafeInteger(input.build) || input.build < 0 || input.build > 1e7)
    return;
  if (typeof input.os !== "string" || !/^\d{1,3}\.\d{1,3}$/u.test(input.os))
    return;
  if (input.region !== "ask" && input.region !== "default")
    return;
  const raw = input.props ?? {};
  const bagged = bag(raw);
  if (bagged === undefined)
    return;
  const props = {};
  for (const [key, item] of Object.entries(bagged)) {
    if (typeof item !== "string")
      return;
    const rule = Object.hasOwn(allowed, key) ? allowed[key] : COMMON_PROPS[key];
    if (!allows(rule, item))
      return;
    props[key] = item;
  }
  const at = typeof input.at === "number" && Number.isSafeInteger(input.at) && input.at > now - 30 * 86400 && input.at < now + 600 ? input.at : now;
  return { event: name, install: input.install.toLowerCase(), id: input.id.toLowerCase(), at, app: input.app, build: input.build, os: input.os, region: input.region, props };
}
async function installDistinctId(config, install) {
  return `${config.siteId}:install:${(await sha256Hex(`${config.namespace ?? config.siteId}\x00install\x00${install}`)).slice(0, 40)}`;
}
async function wireCapture(config, event, once = new Set(["app installed"])) {
  const { surface, ...props } = event.props;
  return {
    event: event.event,
    distinctId: await installDistinctId(config, event.install),
    key: once.has(event.event) ? `app\x00${event.event}\x00${event.install}` : `app\x00${event.event}\x00${event.install}\x00${event.id}`,
    at: event.at,
    surface: surface ?? "mac",
    props: {
      ...Object.fromEntries(Object.entries(props).map(([key, value]) => [key, value === "true" ? true : value === "false" ? false : value])),
      identity_scope: "install",
      app_version: event.app,
      app_build: event.build,
      os_version: event.os,
      consent_region: event.region
    }
  };
}
async function wireHandler(config, request, events = {}, waitUntil) {
  const empty = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 16384)
    return new Response(null, { status: 413 });
  let body;
  try {
    const text = await request.text();
    if (text.length > 16384)
      return new Response(null, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const list = Array.isArray(body) ? body.slice(0, 20) : [body];
  const parsed = list.map((item) => parseWireEvent(item, events));
  if (parsed.some((item) => item === undefined))
    return new Response(null, { status: 400 });
  for (const event of parsed)
    if (event !== undefined)
      capture(config, wireCapture(config, event), waitUntil);
  return empty();
}
function downloadServed(config, input, waitUntil) {
  const ref = refLabel(input.ref);
  const visit = typeof input.visit === "string" && UUID.test(input.visit) ? input.visit.toLowerCase() : undefined;
  const version = input.version !== undefined && /^[0-9A-Za-z.+-]{1,40}$/u.test(input.version) ? input.version : undefined;
  return capture(config, {
    event: "download served",
    distinctId: visit ?? `download:${crypto.randomUUID()}`,
    props: { platform: input.platform, artifact: input.artifact, version, ref }
  }, waitUntil);
}
async function deletePerson(config, distinctId) {
  const send = config.fetch ?? fetch;
  const host = (config.host ?? "https://us.posthog.com").replace(/\/$/u, "");
  const headers = { authorization: `Bearer ${config.personalApiKey}` };
  const base = `${host}/api/projects/${encodeURIComponent(String(config.projectId))}/persons`;
  const found = await send(`${base}/?distinct_id=${encodeURIComponent(distinctId)}`, { headers });
  if (!found.ok)
    return false;
  const results = bag(await found.json())?.results;
  const people = Array.isArray(results) ? results.map((item) => id(bag(item)?.uuid)).filter((item) => item !== undefined) : [];
  for (const person of people) {
    const removed = await send(`${base}/${encodeURIComponent(person)}/?delete_events=true`, { method: "DELETE", headers });
    if (!removed.ok && removed.status !== 404)
      return false;
  }
  return true;
}
export {
  wireHandler,
  wireCapture,
  regionScript,
  regionOf,
  regionHandler,
  parseWireEvent,
  money,
  installDistinctId,
  downloadServed,
  deletePerson,
  checkoutMetadata,
  captureBody,
  captureBilling,
  capture,
  billingEvent,
  accountDistinctId,
  WIRE_FIELDS,
  SERVER_EVENTS,
  LIFECYCLE_WIRE,
  COUNTRY_HEADERS,
  COMMON_PROPS,
  CAPTURE_PATH
};

//# debugId=AF0A7454A5B6C4B464756E2164756E21
