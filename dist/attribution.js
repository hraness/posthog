// src/attribution.ts
var CAMPAIGNS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
var REFS = ["ref", "via"];
var CLICK_IDS = ["gclid", "fbclid", "msclkid"];
var TRACKING = [...REFS, ...CAMPAIGNS, ...CLICK_IDS];
var LABEL = /^[a-z0-9._-]+$/u;
function campaignLabel(value) {
  if (typeof value !== "string")
    return;
  const label = value.trim().toLowerCase();
  return label.length > 0 && LABEL.test(label) ? label.slice(0, 60) : undefined;
}
function refLabel(value) {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9._-]{1,40}$/u.test(label) ? label : undefined;
}
function refOf(search) {
  const params = new URLSearchParams(search);
  return refLabel(params.get("ref")) ?? refLabel(params.get("via"));
}
function referrerSite(value) {
  if (typeof value !== "string" || value === "")
    return "";
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:")
      return `${url.origin}/`;
  } catch {}
  return "";
}
function referrerHost(value) {
  const site = referrerSite(value);
  return site === "" ? "" : new URL(site).hostname.replace(/^www\./u, "");
}
var AI = /(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|anthropic\.com|gemini\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com|poe\.com|meta\.ai|grok\.com|deepseek\.com|chat\.deepseek\.com|mistral\.ai|chat\.mistral\.ai|kagi\.com)$/u;
var SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.[a-z.]+|baidu\.com|yandex\.[a-z.]+|ecosia\.org|search\.brave\.com|startpage\.com|naver\.com|qwant\.com)$/u;
var SOCIAL = /(^|\.)(x\.com|t\.co|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|linkedin\.com|lnkd\.in|threads\.(net|com)|pinterest\.[a-z.]+|discord\.com|bsky\.app|mastodon\.social)$/u;
var COMMUNITY = /(^|\.)(news\.ycombinator\.com|reddit\.com|producthunt\.com|forums\.macrumors\.com|lobste\.rs|indiehackers\.com)$/u;
var AI_NAMES = /^(chatgpt|openai|perplexity|claude|anthropic|gemini|copilot|grok|deepseek|mistral|meta\.?ai|you\.com|phind|poe)(\.|$)/u;
var SOCIAL_NAMES = /^(x|twitter|facebook|instagram|tiktok|youtube|linkedin|threads|pinterest|discord|bluesky|mastodon)(\.|$)/u;
var COMMUNITY_NAMES = /^(reddit|hackernews|hn|producthunt|macrumors|lobsters|indiehackers)(\.|$)/u;
var PAID_MEDIUM = /^(cpc|ppc|paid|paidsocial|paid_social|display|ads?)$/u;
var REF_CHANNELS = {
  hn: "community",
  producthunt: "community",
  macrumors: "community",
  obsidian: "community",
  cursor: "community",
  ih: "community",
  kvr: "community",
  gearspace: "community",
  lines: "community",
  lobsters: "community",
  console: "email",
  newsletter: "email",
  dir: "referral"
};
function refChannel(ref, extra) {
  if (/^r-./u.test(ref))
    return "community";
  const venues = { ...REF_CHANNELS, ...extra };
  for (const [venue, channel] of Object.entries(venues))
    if (ref === venue || ref.startsWith(`${venue}-`))
      return channel;
  return;
}
function channelOf(referrer, search, options = {}) {
  const params = new URLSearchParams(search);
  const label = campaignLabel(params.get("utm_source")) ?? "";
  const ref = refOf(search) ?? "";
  const medium = (params.get("utm_medium") ?? "").toLowerCase();
  let host = referrerHost(referrer);
  const own = options.ownHosts ?? [];
  if (own.some((name) => host === name || host.endsWith(`.${name}`)))
    host = "";
  const source = label || ref || host;
  if (PAID_MEDIUM.test(medium) || params.has("gclid") || params.has("msclkid"))
    return { channel: "paid", source };
  const tagged = ref ? refChannel(ref, options.refChannels) : undefined;
  if (tagged)
    return { channel: tagged, source };
  if (AI.test(host) || AI_NAMES.test(label))
    return { channel: "ai", source };
  if (SEARCH.test(host))
    return { channel: "search", source };
  if (COMMUNITY.test(host) || COMMUNITY_NAMES.test(label))
    return { channel: "community", source };
  if (SOCIAL.test(host) || SOCIAL_NAMES.test(label))
    return { channel: "social", source };
  if (ref || label)
    return { channel: "campaign", source };
  if (host)
    return { channel: "referral", source };
  return { channel: "direct", source: "" };
}
function withoutTracking(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  let changed = false;
  for (const name of TRACKING) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  return changed ? url.pathname.replace(/^\/{2,}/u, "/") + url.search + url.hash : null;
}
function carryRef(href, ref, here, skipPrefixes = ["/downloads/"]) {
  if (ref === undefined || refLabel(ref) !== ref)
    return null;
  let url;
  let from;
  try {
    url = new URL(href, here);
    from = new URL(here);
  } catch {
    return null;
  }
  if (url.origin !== from.origin)
    return null;
  if (skipPrefixes.some((prefix) => url.pathname.startsWith(prefix)))
    return null;
  if (url.searchParams.has("ref") || url.searchParams.has("via"))
    return null;
  if (url.pathname === from.pathname && url.search === from.search && url.hash)
    return null;
  url.searchParams.set("ref", ref);
  return url.href;
}
function afterFirstPageview(then) {
  let done = false;
  return (event) => {
    if (done || event !== "$pageview")
      return;
    done = true;
    then();
  };
}
function arrivalOf(path, search, referrer, contentParams = [], routes = []) {
  const input = new URLSearchParams(search);
  const kept = new URLSearchParams;
  for (const name of CAMPAIGNS) {
    const value = campaignLabel(input.get(name));
    if (value !== undefined)
      kept.set(name, value);
  }
  for (const name of REFS) {
    const value = refLabel(input.get(name));
    if (value !== undefined)
      kept.set(name, value);
  }
  for (const name of ["gclid", "msclkid"])
    if (input.has(name))
      kept.set(name, "");
  const fbclid = input.get("fbclid");
  const content = {};
  for (const name of contentParams) {
    const value = campaignLabel(input.get(name));
    if (value !== undefined)
      content[name] = value;
  }
  return {
    path: routePattern(path.split(/[?#]/u, 1)[0] || "/", routes),
    search: kept.toString(),
    referrer: referrerSite(referrer),
    ...fbclid !== null && /^[\w-]{1,400}$/u.test(fbclid) ? { fbclid } : {},
    content
  };
}
var ARRIVAL_GLOBAL = "__hranessArrival";
var ARRIVAL_SCRIPT = `window.${ARRIVAL_GLOBAL}=window.${ARRIVAL_GLOBAL}||{path:location.pathname,search:location.search,referrer:document.referrer};`;
function parseArrivalSnapshot(value) {
  if (typeof value !== "object" || value === null)
    return;
  const { path, search, referrer } = value;
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 2048)
    return;
  if (typeof search !== "string" || search !== "" && !search.startsWith("?") || search.length > 4096)
    return;
  if (typeof referrer !== "string" || referrer.length > 4096)
    return;
  return { path, search, referrer };
}
function snapshotArrival() {
  const scope = globalThis;
  const held = parseArrivalSnapshot(scope[ARRIVAL_GLOBAL]);
  if (held !== undefined)
    return held;
  if (typeof location === "undefined" || typeof document === "undefined")
    return;
  let made;
  try {
    made = { path: location.pathname, search: location.search, referrer: document.referrer };
  } catch {
    return;
  }
  const parsed = parseArrivalSnapshot(made);
  if (parsed === undefined)
    return;
  try {
    scope[ARRIVAL_GLOBAL] = parsed;
  } catch {}
  return parsed;
}
function clickKind(search, fbclid) {
  const params = new URLSearchParams(search);
  if (params.has("gclid"))
    return "gclid";
  if (fbclid !== undefined || params.has("fbclid"))
    return "fbclid";
  if (params.has("msclkid"))
    return "msclkid";
  return "none";
}
var day = (now) => now.toISOString().slice(0, 10);
function mondayOf(now) {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  at.setUTCDate(at.getUTCDate() - (at.getUTCDay() + 6) % 7);
  return day(at);
}
function remember(before, now, arrival, context = {}) {
  const ref = refOf(arrival.search);
  if (before === undefined) {
    const params = new URLSearchParams(arrival.search);
    const { channel, source } = channelOf(arrival.referrer, arrival.search, context.channel);
    const host = referrerHost(arrival.referrer);
    return {
      channel,
      source,
      medium: campaignLabel(params.get("utm_medium")),
      campaign: campaignLabel(params.get("utm_campaign")),
      content: campaignLabel(params.get("utm_content")),
      landing: arrival.path,
      landingKind: context.landingKind,
      referrerHost: host === "" ? undefined : host,
      clickKind: clickKind(arrival.search, arrival.fbclid),
      week: mondayOf(now),
      surface: context.surface,
      ref,
      lastRef: ref,
      labels: { ...arrival.content },
      days: 1,
      last: day(now)
    };
  }
  const refs = ref === undefined ? {} : { ref: refLabel(before.ref) ?? ref, lastRef: ref };
  if (before.last === day(now))
    return { ...before, ...refs };
  return { ...before, ...refs, days: before.days + 1, last: day(now) };
}
function parseFirstTouch(value) {
  if (typeof value !== "object" || value === null)
    return;
  const record = value;
  const channels = ["ai", "community", "search", "social", "paid", "email", "referral", "direct", "campaign"];
  const channel = channels.find((name) => name === record.channel);
  const days = record.days;
  if (channel === undefined || typeof record.landing !== "string" || typeof record.week !== "string" || typeof record.last !== "string" || typeof days !== "number" || !Number.isSafeInteger(days) || days < 1)
    return;
  const kinds = ["gclid", "fbclid", "msclkid", "none"];
  const labels = {};
  if (typeof record.labels === "object" && record.labels !== null) {
    for (const [key, label] of Object.entries(record.labels)) {
      const safe = campaignLabel(label);
      if (/^[a-z][a-z0-9_]{0,30}$/u.test(key) && safe !== undefined)
        labels[key] = safe;
    }
  }
  const host = typeof record.referrerHost === "string" && /^[a-z0-9.-]{1,253}$/u.test(record.referrerHost) ? record.referrerHost : undefined;
  return {
    channel,
    source: campaignLabel(record.source) ?? referrerHostLabel(record.source),
    medium: campaignLabel(record.medium),
    campaign: campaignLabel(record.campaign),
    content: campaignLabel(record.content),
    landing: record.landing.slice(0, 200),
    landingKind: campaignLabel(record.landingKind),
    referrerHost: host,
    clickKind: kinds.find((kind) => kind === record.clickKind) ?? "none",
    week: /^\d{4}-\d{2}-\d{2}$/u.test(record.week) ? record.week : "",
    surface: campaignLabel(record.surface),
    ref: refLabel(record.ref),
    lastRef: refLabel(record.lastRef),
    labels,
    days,
    last: record.last.slice(0, 10)
  };
}
var referrerHostLabel = (value) => typeof value === "string" && /^[a-z0-9.-]{1,253}$/u.test(value) ? value : "";
function firstTouchProps(touch) {
  const props = {
    first_channel: touch.channel,
    first_source: touch.source === "" ? undefined : touch.source.slice(0, 60),
    first_medium: touch.medium,
    first_campaign: touch.campaign,
    first_content: touch.content,
    first_ref: refLabel(touch.ref),
    last_ref: refLabel(touch.lastRef),
    first_landing: touch.landing,
    first_landing_kind: touch.landingKind,
    first_referrer_host: touch.referrerHost,
    first_click_kind: touch.clickKind,
    first_week: touch.week,
    first_surface: touch.surface,
    active_days: touch.days,
    returning: touch.days > 1
  };
  for (const [name, value] of Object.entries(touch.labels ?? {}))
    props[`first_${name}`] = value;
  return props;
}
function arrivalProps(arrival, options = {}) {
  const params = new URLSearchParams(arrival.search);
  const props = { channel: channelOf(arrival.referrer, arrival.search, options).channel, ref: refOf(arrival.search) };
  for (const name of CAMPAIGNS)
    props[name] = params.get(name) ?? undefined;
  for (const [name, value] of Object.entries(arrival.content))
    props[name] = value;
  return props;
}
function matchRoute(path, patterns) {
  const segments = path.split("/").filter(Boolean);
  for (const pattern of patterns) {
    const parts = pattern.split("/").filter(Boolean);
    let matched = true;
    for (let index = 0;index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      if (part === "*")
        return pattern;
      const segment = segments[index];
      if (segment === undefined) {
        matched = false;
        break;
      }
      if (part.includes(":")) {
        const [prefix = ""] = part.split(":", 1);
        if (!segment.startsWith(prefix)) {
          matched = false;
          break;
        }
        continue;
      }
      if (part !== segment) {
        matched = false;
        break;
      }
    }
    if (matched && parts.length === segments.length)
      return pattern;
  }
  return;
}
function routePattern(path, patterns) {
  return matchRoute(path, patterns) ?? path;
}
function cleanUrl(value, routes = []) {
  const cut = value.indexOf("#");
  const whole = cut < 0 ? value : value.slice(0, cut);
  const at = whole.indexOf("?");
  let base = at < 0 ? whole : whole.slice(0, at);
  if (routes.length > 0) {
    const match = /^(https?:\/\/[^/]+)?(\/[^?]*)?$/u.exec(base);
    if (match)
      base = (match[1] ?? "") + routePattern(match[2] ?? "/", routes);
  }
  if (at < 0)
    return base;
  const input = new URLSearchParams(whole.slice(at + 1));
  const kept = new URLSearchParams;
  for (const name of CAMPAIGNS) {
    const label = campaignLabel(input.get(name));
    if (label !== undefined)
      kept.set(name, label);
  }
  for (const name of REFS) {
    const label = refLabel(input.get(name));
    if (label !== undefined)
      kept.set(name, label);
  }
  const search = kept.toString();
  return base + (search ? `?${search}` : "");
}
function cleanText(value, routes = []) {
  return value.replace(/\b(data|blob):[^\s"')]+/giu, "$1:").replace(/https?:\/\/[^\s"')]+/giu, (url) => cleanUrl(url, routes));
}
var LINKISH = /url|referrer|href|pathname/iu;
var CAMPAIGN_FIELD = /^(?:\$(?:initial_|session_entry_)?)?utm_(source|medium|campaign|term|content)$/iu;
var REF_FIELD = /^(?:(?:\$(?:initial_|session_entry_)?)?(?:ref|via)|(?:first|last)_ref)$/iu;
var CLICK_FIELD = /^(?:\$(?:initial_|session_entry_)?)?(gclid|gclsrc|dclid|fbclid|msclkid|twclid|ttclid|li_fat_id|igshid|wbraid|gbraid|gad_source|mc_cid|mc_eid)$/iu;
var EMAIL = /[^\s@<>()"',;:]{1,64}@[^\s@<>()"',;:]{1,255}\.[a-z]{2,}/giu;
var plain = (value) => typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function cleanChain(chain, routes) {
  return cleanText(chain.replace(/((?:attr__)?href=")([^"]*)"/gu, (_whole, name, href) => `${name}${cleanUrl(href, routes)}"`), routes).replace(EMAIL, "[email]");
}
function cleanValue(key, value, options, depth) {
  if (CLICK_FIELD.test(key))
    return;
  if (key === "first_source" || CAMPAIGN_FIELD.test(key))
    return campaignLabel(value);
  if (REF_FIELD.test(key))
    return refLabel(value);
  const routes = options.routes ?? [];
  if (typeof value === "string") {
    if (/referrer_host$/iu.test(key))
      return /^[a-z0-9.-]{1,253}$/u.test(value) ? value : referrerHost(value) || undefined;
    if (/referrer/iu.test(key))
      return value === "$direct" ? value : referrerSite(value);
    if (key === "$elements_chain")
      return cleanChain(value, routes);
    const text = LINKISH.test(key) && !/\s/u.test(value) ? key.toLowerCase().includes("pathname") ? routePattern(value, routes) : cleanText(cleanUrl(value, routes), routes) : cleanText(value, routes);
    return text.replace(EMAIL, "[email]");
  }
  if (depth > 8)
    return;
  if (Array.isArray(value))
    return value.map((item) => cleanValue(key, item, options, depth + 1));
  return plain(value) ? cleanBag(value, options, depth + 1, false) : value;
}
function cleanKey(key, routes) {
  if (/^[\w$.:-]*$/u.test(key))
    return key;
  const text = /^(?:https?:\/\/|\/)\S*$/iu.test(key) ? cleanUrl(key, routes) : cleanText(key, routes);
  return text.replace(EMAIL, "[email]");
}
function mergeValues(first, second) {
  if (Array.isArray(first) && Array.isArray(second))
    return [...first, ...second];
  if (plain(first) && plain(second)) {
    const out = { ...first };
    for (const [key, value] of Object.entries(second))
      out[key] = Object.hasOwn(out, key) ? mergeValues(out[key], value) : value;
    return out;
  }
  return first;
}
function cleanBag(props, options, depth, top) {
  const out = {};
  const allow = options.allowProps === undefined ? undefined : new Set(options.allowProps);
  for (const [raw, value] of Object.entries(props)) {
    if (top && allow !== undefined && !raw.startsWith("$") && !allow.has(raw))
      continue;
    const key = cleanKey(raw, options.routes ?? []);
    const cleaned = cleanValue(key, value, options, depth);
    if (cleaned === undefined)
      continue;
    out[key] = Object.hasOwn(out, key) ? mergeValues(out[key], cleaned) : cleaned;
  }
  return out;
}
function cleanEvent(event, options = {}) {
  const { properties, ...rest } = event;
  const fields = cleanBag(rest, options.routes === undefined ? {} : { routes: options.routes }, 0, false);
  return { ...fields, properties: cleanBag(properties ?? {}, options, 0, true) };
}
function cleanProps(props, options = {}) {
  return cleanBag(props, options, 0, true);
}
export {
  withoutTracking,
  snapshotArrival,
  routePattern,
  remember,
  referrerSite,
  referrerHost,
  refOf,
  refLabel,
  parseFirstTouch,
  parseArrivalSnapshot,
  mondayOf,
  matchRoute,
  firstTouchProps,
  clickKind,
  cleanUrl,
  cleanText,
  cleanProps,
  cleanEvent,
  channelOf,
  carryRef,
  campaignLabel,
  arrivalProps,
  arrivalOf,
  afterFirstPageview,
  TRACKING,
  REF_CHANNELS,
  REFS,
  CLICK_IDS,
  CAMPAIGNS,
  ARRIVAL_SCRIPT,
  ARRIVAL_GLOBAL
};

//# debugId=641C345720EBD54C64756E2164756E21
