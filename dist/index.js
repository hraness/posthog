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
function arrivalOf(path, search, referrer, contentParams = []) {
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
    path: path.split(/[?#]/u, 1)[0] || "/",
    search: kept.toString(),
    referrer: referrerSite(referrer),
    ...fbclid !== null && /^[\w-]{1,400}$/u.test(fbclid) ? { fbclid } : {},
    content
  };
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
function cleanValue(key, value, options, depth) {
  if (CLICK_FIELD.test(key))
    return;
  if (key === "first_source" || CAMPAIGN_FIELD.test(key))
    return campaignLabel(value);
  if (REF_FIELD.test(key))
    return refLabel(value);
  const routes = options.routes ?? [];
  if (typeof value === "string") {
    if (/referrer/iu.test(key))
      return value === "$direct" ? value : referrerSite(value);
    const text = LINKISH.test(key) && !/\s/u.test(value) ? key.toLowerCase().includes("pathname") ? routePattern(value, routes) : cleanText(cleanUrl(value, routes), routes) : cleanText(value, routes);
    return text.replace(EMAIL, "[email]");
  }
  if (depth > 8)
    return;
  if (Array.isArray(value))
    return value.map((item) => cleanValue(key, item, options, depth + 1));
  return plain(value) ? cleanBag(value, options, depth + 1, false) : value;
}
function cleanBag(props, options, depth, top) {
  const out = {};
  const allow = options.allowProps === undefined ? undefined : new Set(options.allowProps);
  for (const [key, value] of Object.entries(props)) {
    if (top && allow !== undefined && !key.startsWith("$") && !allow.has(key))
      continue;
    const cleaned = cleanValue(key, value, options, depth);
    if (cleaned !== undefined)
      out[key] = cleaned;
  }
  return out;
}
function cleanProps(props, options = {}) {
  return cleanBag(props, options, 0, true);
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
var MILESTONES = [1, 3, 10, 30, 100];
function daysBucket(days) {
  if (!Number.isFinite(days) || days < 1)
    return "0";
  if (days < 2)
    return "1";
  if (days < 7)
    return "2-6";
  if (days < 30)
    return "7-29";
  return "30+";
}
function durationBucket(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 1000)
    return "<1s";
  if (milliseconds < 5000)
    return "1-5s";
  if (milliseconds < 30000)
    return "5-30s";
  return "30s+";
}
function isEventName(value) {
  return typeof value === "string" && (/^[a-z][a-z0-9]*(?: [a-z0-9]+){0,5}$/u.test(value) || /^\$[a-z_]{2,40}$/u.test(value));
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
function parseRegionResponse(value) {
  if (typeof value !== "object" || value === null)
    return;
  const record = value;
  const country = record.country === null ? null : countryCode(record.country) ?? null;
  const group = record.region_group;
  if (typeof group !== "string" || !Object.hasOwn(REGION_TABLE, group))
    return;
  const gpc = record.gpc === true;
  const region = group;
  return { country, region_group: region, gpc, policy: policyForGroup(region, gpc, {}) };
}
var GROUP_COUNTRY = { eu: "DE", uk_ch: "GB", br: "BR", us: "US", row: "JP" };
function policyForGroup(group, gpc, choices) {
  return regionPolicy({ country: GROUP_COUNTRY[group], gpc, choices });
}
function telemetryDefault(group) {
  return group === "eu" ? "ask" : "on";
}
var consentMode = (policy) => policy.analytics;
export {
  withoutTracking,
  telemetryDefault,
  routePattern,
  remember,
  regionResponse,
  regionPolicy,
  regionGroup,
  referrerSite,
  referrerHost,
  refOf,
  refLabel,
  policyForGroup,
  parseRegionResponse,
  parseFirstTouch,
  mondayOf,
  matchRoute,
  isEventName,
  groupOfZone,
  firstTouchProps,
  durationBucket,
  daysBucket,
  countryCode,
  consentMode,
  clickKind,
  cleanUrl,
  cleanText,
  cleanProps,
  channelOf,
  carryRef,
  campaignLabel,
  arrivalProps,
  arrivalOf,
  afterFirstPageview,
  US_ZONE,
  US_COUNTRIES,
  UK_CH_ZONE,
  UK_CH_COUNTRIES,
  TRACKING,
  SHARED_EVENTS,
  SERVER_EVENTS,
  SCHEMA,
  REGION_TABLE,
  REF_CHANNELS,
  REFS,
  PLACELESS_ZONE,
  MILESTONES,
  MARKETING_EVENTS,
  LIFECYCLE_EVENTS,
  GROUP_COUNTRY,
  EU_ZONE,
  EU_COUNTRIES,
  CLICK_IDS,
  CAMPAIGNS,
  BR_ZONE,
  BR_COUNTRIES
};

//# debugId=F47028557CC63A0164756E2164756E21
