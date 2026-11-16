// src/internal.ts
var bag = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
var count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
var encoder = new TextEncoder;
var hexOf = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
async function sha256Hex(value) {
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
var NAMESPACE = Uint8Array.from([107, 167, 184, 17, 157, 173, 17, 209, 128, 180, 0, 192, 79, 212, 48, 200]);
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

// src/meta.ts
var SCRIPT = "https://connect.facebook.net/en_US/fbevents.js";
var GRAPH = "https://graph.facebook.com/v26.0";
var COOKIE_DAYS = 90;
var FBC = /^fb\.\d\.\d{10,16}\.[\w.-]{1,450}$/u;
var FBP = /^fb\.\d\.\d{10,16}\.[\w.-]{1,64}$/u;
var clickId = (value) => typeof value === "string" && /^[\w-]{1,400}$/u.test(value) ? value : undefined;
var fbcFor = (fbclid, at) => `fb.1.${String(at)}.${fbclid}`;
var fbpFor = (at, random) => `fb.1.${String(at)}.${String(Math.floor(random * 2 ** 31))}`;
var clickOf = (fbc) => fbc?.split(".").slice(3).join(".");
function adsAllowed(input) {
  return input.policy?.ads === true && input.gpc !== true && input.optedOut !== true;
}
var DEFAULT_KEPT = ["fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
function safeAddress(href, kept = DEFAULT_KEPT, check) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (href.includes("#"))
    return false;
  for (const [key, value] of url.searchParams) {
    if (!kept.includes(key))
      return false;
    if (check && !check(key, value))
      return false;
  }
  return true;
}
var readCookie = (page, name) => {
  try {
    const part = page.document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
    return part === undefined ? undefined : decodeURIComponent(part.slice(name.length + 1));
  } catch {
    return;
  }
};
var writeCookie = (page, name, value) => {
  try {
    page.document.cookie = `${name}=${value}; max-age=${String(COOKIE_DAYS * 86400)}; path=/; domain=${page.location.hostname}; secure; samesite=lax`;
  } catch {}
};
function stub(page) {
  const existing = page.window.fbq;
  if (existing)
    return existing;
  const fbq = (...args) => {
    if (fbq.callMethod)
      fbq.callMethod(...args);
    else
      fbq.queue.push(args);
  };
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.queue = [];
  fbq.disablePushState = true;
  fbq.disableConfigLoading = true;
  page.window.fbq = page.window._fbq = fbq;
  const script = page.document.createElement("script");
  script.async = true;
  script.fetchPriority = "low";
  script.src = SCRIPT;
  page.document.head.append(script);
  return fbq;
}
var eventIdFor = (page) => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${String(page.now())}-${String(Math.floor(page.random() * 2 ** 31))}`;
  }
};
function startPixel(config, page, fbclid, allowed) {
  const at = page.now();
  if (!FBP.test(readCookie(page, "_fbp") ?? ""))
    writeCookie(page, "_fbp", fbpFor(at, page.random()));
  const click = clickId(fbclid);
  if (click !== undefined && clickOf(readCookie(page, "_fbc")) !== click)
    writeCookie(page, "_fbc", fbcFor(click, at));
  const fbq = stub(page);
  fbq("set", "autoConfig", false, config.pixelId);
  fbq("init", config.pixelId);
  const custom = new Set(config.customEvents ?? []);
  const kept = [...DEFAULT_KEPT, ...config.keptParams ?? []];
  const dayKey = config.dayKey ?? "hra-meta-days";
  const sentHere = {};
  const readDays = () => {
    try {
      const days = JSON.parse(page.storage?.()?.getItem(dayKey) ?? "{}");
      return bag(days) ?? {};
    } catch {
      return {};
    }
  };
  const pixel = {
    allowed,
    track(name, params = {}, eventId) {
      if (!allowed() || !safeAddress(page.location.href, kept, config.keptCheck))
        return;
      if (!custom.has(name)) {
        fbq("track", name, params, ...eventId === undefined ? [] : [{ eventID: eventId }]);
        return;
      }
      const day = new Date(page.now()).toISOString().slice(0, 10);
      const days = readDays();
      if (days[name] === day || sentHere[name] === day)
        return;
      sentHere[name] = days[name] = day;
      try {
        page.storage?.()?.setItem(dayKey, JSON.stringify(days));
      } catch {}
      fbq("trackCustom", name, params, { eventID: eventId ?? eventIdFor(page) });
    },
    identity() {
      const fbp = readCookie(page, "_fbp");
      const fbc = readCookie(page, "_fbc");
      return { ...fbp !== undefined && FBP.test(fbp) ? { fbp } : {}, ...fbc !== undefined && FBC.test(fbc) ? { fbc } : {} };
    }
  };
  if (config.pageView !== false)
    pixel.track("PageView");
  return pixel;
}
var browserPage = () => ({
  document,
  window,
  location,
  now: () => Date.now(),
  random: Math.random,
  storage: () => localStorage
});
function trackForServer(pixel, name, params = {}) {
  if (pixel === undefined || !pixel.allowed())
    return;
  const eventId = crypto.randomUUID();
  pixel.track(name, params, eventId);
  return { event_id: eventId, ...pixel.identity() };
}
function readAds(value) {
  const input = bag(value);
  if (input === undefined || typeof input.event_id !== "string" || !UUID.test(input.event_id))
    return;
  const fbp = typeof input.fbp === "string" && FBP.test(input.fbp) ? input.fbp : undefined;
  const fbc = typeof input.fbc === "string" && FBC.test(input.fbc) ? input.fbc : undefined;
  return { event_id: input.event_id.toLowerCase(), ...fbp === undefined ? {} : { fbp }, ...fbc === undefined ? {} : { fbc } };
}
function adsMetadata(ads) {
  return { "metadata[meta]": "1", ...ads.fbp === undefined ? {} : { "metadata[meta_fbp]": ads.fbp }, ...ads.fbc === undefined ? {} : { "metadata[meta_fbc]": ads.fbc } };
}
function adsFromMetadata(metadata) {
  const input = bag(metadata);
  if (input?.meta !== "1")
    return;
  const fbp = typeof input.meta_fbp === "string" && FBP.test(input.meta_fbp) ? input.meta_fbp : undefined;
  const fbc = typeof input.meta_fbc === "string" && FBC.test(input.meta_fbc) ? input.meta_fbc : undefined;
  return { ...fbp === undefined ? {} : { fbp }, ...fbc === undefined ? {} : { fbc } };
}
async function hashEmail(value) {
  if (typeof value !== "string")
    return;
  const email = value.normalize("NFC").trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/u.test(email) && email.length <= 254 ? sha256Hex(email) : undefined;
}
async function stableEventId(namespace, ...parts) {
  return (await sha256Hex([namespace, ...parts].join("\x00"))).slice(0, 32);
}
function metaValue(amount, currency) {
  const minor = count(amount);
  if (typeof currency !== "string" || !/^[a-z]{3}$/iu.test(currency) || minor === undefined)
    return {};
  const code = currency.toLowerCase();
  return { value: minor / 10 ** decimalsOf(code), currency: code.toUpperCase() };
}
var ipAddress = (value) => typeof value === "string" && /^[0-9a-f:.]{3,45}$/iu.test(value) && /[.:]/u.test(value) ? value : undefined;
function sourceUrl(origin, path) {
  try {
    const url = new URL(typeof path === "string" ? path : "/", origin);
    if (url.origin === new URL(origin).origin)
      return url.origin + url.pathname;
  } catch {}
  return `${origin.replace(/\/$/u, "")}/`;
}
async function capiEvent(input) {
  const em = await hashEmail(input.email);
  const agent = input.userAgent?.slice(0, 512);
  const address = ipAddress(input.ip);
  return {
    event_name: input.name,
    event_time: input.at ?? Math.floor(Date.now() / 1000),
    event_id: input.eventId,
    action_source: input.source ?? "website",
    ...input.url === undefined ? {} : { event_source_url: input.url },
    user_data: {
      ...em === undefined ? {} : { em: [em] },
      ...input.externalId === undefined ? {} : { external_id: [input.externalId] },
      ...input.ads?.fbp === undefined ? {} : { fbp: input.ads.fbp },
      ...input.ads?.fbc === undefined ? {} : { fbc: input.ads.fbc },
      ...address === undefined ? {} : { client_ip_address: address },
      ...agent === undefined || agent === "" ? {} : { client_user_agent: agent }
    },
    ...input.custom === undefined ? {} : { custom_data: input.custom }
  };
}
var capiBody = (config, events) => JSON.stringify({ data: events, access_token: config.token, ...config.testEventCode === undefined || config.testEventCode === "" ? {} : { test_event_code: config.testEventCode } });
function sendCapi(config, make, options = {}) {
  if (config.token === undefined || config.token === "")
    return Promise.resolve();
  const send = options.fetch ?? fetch;
  return later(options.waitUntil, config.timeoutMs ?? 3000, async (signal) => {
    const event = await make();
    if (event === undefined)
      return;
    await send(`${config.graph ?? GRAPH}/${config.pixelId}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: capiBody(config, [event]), signal });
  });
}
export {
  trackForServer,
  startPixel,
  stableEventId,
  sourceUrl,
  sendCapi,
  safeAddress,
  readAds,
  metaValue,
  hashEmail,
  fbpFor,
  fbcFor,
  clickId,
  capiEvent,
  capiBody,
  browserPage,
  adsMetadata,
  adsFromMetadata,
  adsAllowed,
  SCRIPT,
  GRAPH,
  FBP,
  FBC,
  DEFAULT_KEPT,
  COOKIE_DAYS
};

//# debugId=B81E7B73C766D70D64756E2164756E21
