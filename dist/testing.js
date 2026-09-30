// src/testing.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// src/client.ts
import { posthog } from "posthog-js";
import"posthog-js/dist/web-vitals.js";

// src/site.ts
var MAX_PATH_LENGTH = 512;
var MAX_SLUG_LENGTH = 160;
function normalizeAnalyticsHostname(hostname) {
  return hostname.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
}
function normalizeAnalyticsPathname(pathname) {
  const withoutQuery = pathname.split(/[?#]/u, 1)[0] ?? "/";
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/gu, "/");
  const withoutTrailingSlash = collapsed.length > 1 ? collapsed.replace(/\/$/u, "") : collapsed;
  return withoutTrailingSlash.slice(0, MAX_PATH_LENGTH) || "/";
}
function isAllowedAnalyticsHost(site, hostname) {
  const normalized = normalizeAnalyticsHostname(hostname);
  return site.allowedHosts.some((candidate) => normalizeAnalyticsHostname(candidate) === normalized);
}
function parseAnalyticsLocation(site, value) {
  if (typeof value === "object" && !(value instanceof URL)) {
    if (!isAllowedAnalyticsHost(site, value.hostname)) {
      return null;
    }
    return {
      hostname: normalizeAnalyticsHostname(value.hostname),
      pathname: normalizeAnalyticsPathname(value.pathname)
    };
  }
  try {
    const parsed = value instanceof URL ? value : new URL(value, `https://${site.canonicalDomain}`);
    if (!isAllowedAnalyticsHost(site, parsed.hostname)) {
      return null;
    }
    return {
      hostname: normalizeAnalyticsHostname(parsed.hostname),
      pathname: normalizeAnalyticsPathname(parsed.pathname)
    };
  } catch {
    return null;
  }
}
function ruleMatches(rule, pathname) {
  const rulePath = normalizeAnalyticsPathname(rule.path);
  if (rule.match === "exact") {
    return pathname === rulePath;
  }
  return rulePath === "/" || pathname === rulePath || pathname.startsWith(`${rulePath}/`);
}
function policyPathname(pathname) {
  try {
    return normalizeAnalyticsPathname(decodeURIComponent(normalizeAnalyticsPathname(pathname)));
  } catch {
    return null;
  }
}
function isAllowedAnalyticsPath(site, pathname) {
  const normalized = policyPathname(pathname);
  if (normalized === null)
    return false;
  return !site.excludedPaths?.some((rule) => ruleMatches(rule, normalized)) && (site.allowedPaths === undefined || site.allowedPaths.some((rule) => ruleMatches(rule, normalized)));
}
function slugForRule(rule, pathname) {
  if (!rule.captureSlug) {
    return;
  }
  const rulePath = normalizeAnalyticsPathname(rule.path);
  const relative = pathname.slice(rulePath.length).replace(/^\/+|\/+$/gu, "");
  return relative ? relative.slice(0, MAX_SLUG_LENGTH) : undefined;
}
function classifyAnalyticsRoute(site, location) {
  const parsed = parseAnalyticsLocation(site, location);
  if (!parsed || !isAllowedAnalyticsPath(site, parsed.pathname)) {
    return null;
  }
  const rule = site.routes.find((candidate) => ruleMatches(candidate, parsed.pathname));
  const contentSlug = rule ? slugForRule(rule, parsed.pathname) : undefined;
  return {
    analytics_schema_version: site.schemaVersion,
    site_id: site.id,
    canonical_domain: normalizeAnalyticsHostname(site.canonicalDomain),
    canonical_path: rule === undefined && site.unknownCanonicalPath !== undefined ? normalizeAnalyticsPathname(site.unknownCanonicalPath) : parsed.pathname,
    page_kind: rule?.pageKind ?? "other",
    ...rule?.contentGroup ? { content_group: rule.contentGroup } : {},
    ...contentSlug ? { content_slug: contentSlug } : {}
  };
}
function canonicalAnalyticsUrl(site, pathname) {
  return `https://${normalizeAnalyticsHostname(site.canonicalDomain)}${normalizeAnalyticsPathname(pathname)}`;
}
function isAllowedCustomEvent(site, eventName) {
  return site.customEvents.includes(eventName);
}
function isSensitiveAnalyticsPath(site, pathname) {
  const normalized = policyPathname(pathname);
  if (normalized === null)
    return true;
  return site.sensitivePaths?.some((rule) => ruleMatches(rule, normalized)) ?? false;
}

// src/event.ts
var MAX_PROPERTY_STRING_LENGTH = 256;
var MAX_PROVIDER_PROPERTY_STRING_LENGTH = 2048;
var CURRENT_URL_KEYS = new Set([
  "$current_url",
  "$initial_current_url",
  "$session_entry_url",
  "current_url",
  "url",
  "href",
  "url.full"
]);
var ANALYTICS_ATTRIBUTION_PARAMETERS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gbraid",
  "wbraid",
  "gad_source",
  "fbclid",
  "msclkid",
  "ttclid",
  "twclid",
  "li_fat_id",
  "igshid",
  "dclid",
  "epik",
  "rdt_cid",
  "sccid",
  "irclid",
  "mc_cid"
];
var ATTRIBUTION_PARAMETER_NAMES = new Set(ANALYTICS_ATTRIBUTION_PARAMETERS);
var DROPPED_CAMPAIGN_PROPERTY_NAMES = new Set([
  "_kx",
  "campaign_params",
  "gclsrc",
  "qclid",
  "ref"
]);
var PERSONAL_DATA_PROPERTY_NAMES = new Set([
  "code",
  "email",
  "key",
  "password",
  "secret",
  "token",
  "state",
  "access_token",
  "refresh_token",
  "id_token",
  "session_token",
  "api_key",
  "authorization"
]);
var PASSTHROUGH_PROPERTY_NAMES = new Set([
  "$cookieless_mode",
  "$device_id",
  "$insert_id",
  "$lib",
  "$lib_version",
  "$pageview_id",
  "$prev_pageview_id",
  "$raw_user_agent",
  "$session_id",
  "$window_id",
  "distinct_id"
]);
var REFERRER_URL_KEYS = new Set([
  "$referrer",
  "$initial_referrer",
  "$session_entry_referrer",
  "referrer"
]);
var DIRECT_REFERRER = "$direct";
function normalizedProviderPropertyName(key) {
  return key.toLowerCase().replace(/^\$/u, "").replace(/^(?:initial|session_entry)_/u, "");
}
function isProviderPathnameKey(key) {
  return /^(?:\$)?(?:(?:initial|session_entry|prev_pageview)_)?pathname$/u.test(key.toLowerCase());
}
function isAnalyticsAttributionProperty(key) {
  return ATTRIBUTION_PARAMETER_NAMES.has(normalizedProviderPropertyName(key));
}
function isDroppedCampaignProperty(key) {
  return DROPPED_CAMPAIGN_PROPERTY_NAMES.has(normalizedProviderPropertyName(key));
}
function isPersonalDataProperty(key) {
  return PERSONAL_DATA_PROPERTY_NAMES.has(normalizedProviderPropertyName(key).replace(/-/gu, "_"));
}
function cleanPropertyString(value) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("").replace(/\s{2,}/gu, " ").trim().slice(0, MAX_PROPERTY_STRING_LENGTH);
}
function sanitizeThirdPartyUrl(value, originOnly) {
  try {
    const parsed = new URL(value);
    return originOnly ? parsed.origin : `${parsed.origin}${normalizeAnalyticsPathname(parsed.pathname)}`;
  } catch {
    return "";
  }
}
function attributionValue(value) {
  return cleanPropertyString(redactSensitiveText(value));
}
function analyticsAttributionQuery(site, url) {
  if (site.attributionMode === "referrer_only" || isSensitiveAnalyticsPath(site, url.pathname)) {
    return "";
  }
  const kept = new URLSearchParams;
  for (const name of ANALYTICS_ATTRIBUTION_PARAMETERS) {
    const value = url.searchParams.get(name);
    if (value) {
      const safe = attributionValue(value);
      if (safe)
        kept.set(name, safe);
    }
  }
  const query = kept.toString();
  return query ? `?${query}` : "";
}
function ownedCanonicalUrl(site, parsed) {
  const route = classifyAnalyticsRoute(site, parsed);
  return redactSensitiveText(canonicalAnalyticsUrl(site, route?.canonical_path ?? "/"));
}
function sanitizeUrlValue(site, key, value, stripAttribution) {
  if (REFERRER_URL_KEYS.has(key)) {
    if (value === DIRECT_REFERRER) {
      return { handled: true, value };
    }
    try {
      const parsed = new URL(value);
      if (isAllowedAnalyticsHost(site, parsed.hostname)) {
        return { handled: true, value: ownedCanonicalUrl(site, parsed) };
      }
      return { handled: true, value: redactSensitiveText(sanitizeThirdPartyUrl(parsed.href, true)) };
    } catch {
      return { handled: true, value: "" };
    }
  }
  if (isProviderPathnameKey(key)) {
    try {
      const parsed = new URL(value, `https://${site.canonicalDomain}`);
      if (!isAllowedAnalyticsHost(site, parsed.hostname))
        return { handled: true, value: "" };
      return {
        handled: true,
        value: redactSensitiveText(classifyAnalyticsRoute(site, parsed)?.canonical_path ?? "/")
      };
    } catch {
      return { handled: true, value: "" };
    }
  }
  if (!CURRENT_URL_KEYS.has(key)) {
    return { handled: false };
  }
  try {
    const parsed = new URL(value, `https://${site.canonicalDomain}`);
    if (!isAllowedAnalyticsHost(site, parsed.hostname)) {
      return { handled: true, value: redactSensitiveText(sanitizeThirdPartyUrl(parsed.href, true)) };
    }
    return {
      handled: true,
      value: `${ownedCanonicalUrl(site, parsed)}${stripAttribution ? "" : analyticsAttributionQuery(site, parsed)}`
    };
  } catch {
    return { handled: true, value: "" };
  }
}
function sanitizeProviderValue(context, key, value, depth) {
  const { site } = context;
  if (isDroppedCampaignProperty(key)) {
    return;
  }
  if (isAnalyticsAttributionProperty(key)) {
    if (context.sensitive || typeof value !== "string") {
      return;
    }
    const safe = attributionValue(value);
    return safe || undefined;
  }
  if (PASSTHROUGH_PROPERTY_NAMES.has(key)) {
    if (typeof value === "string") {
      return value.slice(0, MAX_PROVIDER_PROPERTY_STRING_LENGTH);
    }
    return typeof value === "boolean" || typeof value === "number" ? value : undefined;
  }
  if (isPersonalDataProperty(key) && value !== null && value !== undefined) {
    return typeof value === "boolean" ? value : "[redacted]";
  }
  if (typeof value === "string") {
    const url = sanitizeUrlValue(site, key, value, context.sensitive);
    return (url.handled ? url.value : redactSensitiveText(value)).slice(0, MAX_PROVIDER_PROPERTY_STRING_LENGTH);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (depth >= 5 || !value || typeof value !== "object") {
    return;
  }
  if (context.seen.has(value)) {
    return;
  }
  context.seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderValue(context, key, item, depth + 1));
  }
  const result = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    const safeValue = sanitizeProviderValue(context, nestedKey, nestedValue, depth + 1);
    if (safeValue !== undefined) {
      result[nestedKey] = safeValue;
    }
  }
  return result;
}
function isSensitiveProviderLocation(site, currentUrl) {
  if (typeof currentUrl !== "string") {
    return false;
  }
  try {
    return isSensitiveAnalyticsPath(site, new URL(currentUrl, `https://${site.canonicalDomain}`).pathname);
  } catch {
    return false;
  }
}
function sanitizeProviderProperties(site, properties, currentUrl = properties["$current_url"], stripAttribution = false) {
  const context = {
    site,
    sensitive: site.attributionMode === "referrer_only" || stripAttribution || isSensitiveProviderLocation(site, currentUrl),
    seen: new WeakSet
  };
  const sanitized = {};
  for (const [key, value] of Object.entries(properties)) {
    const safeValue = sanitizeProviderValue(context, key, value, 0);
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }
  return sanitized;
}
function redactSensitiveText(value) {
  return value.replace(/\b(?:phc|phx|phs|pha|phr)_[A-Za-z0-9_-]+\b/gu, "[credential]").replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu, "Bearer [credential]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[credential]").replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s?#]+)@/giu, "$1[credential]@").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]").replace(/(https?:\/\/[^\s?#)]+)(?:\?[^\s#)]*)?(?:#[^\s)]*)?/giu, "$1").replace(/([/][^\s?#)]+)\?[^\s#)]*/gu, "$1").replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth(?:orization)?|secret|password|code|state)=([^\s&]+)/giu, "$1=[redacted]");
}
class ExceptionBudget {
  #totalLimit;
  #perFingerprintLimit;
  #windowMs;
  #all = [];
  #byFingerprint = new Map;
  constructor(options) {
    this.#totalLimit = options.totalLimit;
    this.#perFingerprintLimit = options.perFingerprintLimit;
    this.#windowMs = options.windowMs;
  }
  get activeFingerprintCount() {
    return this.#byFingerprint.size;
  }
  allow(fingerprint, now = Date.now()) {
    const threshold = now - this.#windowMs;
    this.#all = this.#all.filter((timestamp) => timestamp > threshold);
    for (const [candidate, timestamps] of this.#byFingerprint) {
      const active = timestamps.filter((timestamp) => timestamp > threshold);
      if (active.length === 0) {
        this.#byFingerprint.delete(candidate);
      } else if (active.length !== timestamps.length) {
        this.#byFingerprint.set(candidate, active);
      }
    }
    const matching = this.#byFingerprint.get(fingerprint) ?? [];
    if (this.#all.length >= this.#totalLimit || matching.length >= this.#perFingerprintLimit) {
      return false;
    }
    this.#all.push(now);
    matching.push(now);
    this.#byFingerprint.set(fingerprint, matching);
    return true;
  }
}
var STANDARD_ANALYTICS_EVENTS = {
  pageNotFound: "page not found",
  ctaClicked: "cta clicked",
  outboundLinkOpened: "outbound link opened",
  installCommandCopied: "install command copied",
  downloadStarted: "download started",
  emailSignupViewed: "email signup viewed",
  emailSignupSubmitted: "email signup submitted",
  emailSignupRequestAccepted: "email signup request accepted",
  checkoutStarted: "checkout started",
  purchaseCompleted: "purchase completed"
};
var EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?: [a-z0-9]+)*$/u;
var MAX_EVENT_NAME_LENGTH = 64;
function isStandardAnalyticsEventName(eventName) {
  return eventName.length <= MAX_EVENT_NAME_LENGTH && EVENT_NAME_PATTERN.test(eventName);
}

// src/traffic.ts
var AI_SOURCES = [
  ["chatgpt", ["chatgpt.com", "chat.openai.com"]],
  ["perplexity", ["perplexity.ai"]],
  ["claude", ["claude.ai"]],
  ["gemini", ["gemini.google.com"]],
  ["copilot", ["copilot.microsoft.com"]],
  ["poe", ["poe.com"]],
  ["you.com", ["you.com"]],
  ["meta_ai", ["meta.ai"]]
];
var SEARCH_SOURCES = [
  ["google", ["google.com", "google.co.uk", "google.ca", "google.com.au"]],
  ["bing", ["bing.com"]],
  ["duckduckgo", ["duckduckgo.com"]],
  ["yahoo", ["search.yahoo.com", "yahoo.com"]],
  ["brave", ["search.brave.com"]],
  ["ecosia", ["ecosia.org"]],
  ["baidu", ["baidu.com"]],
  ["yandex", ["yandex.com", "yandex.ru"]]
];
var SOCIAL_SOURCES = [
  ["reddit", ["reddit.com"]],
  ["x", ["x.com", "twitter.com", "t.co"]],
  ["linkedin", ["linkedin.com"]],
  ["facebook", ["facebook.com", "fb.com"]],
  ["instagram", ["instagram.com"]],
  ["youtube", ["youtube.com", "youtu.be"]],
  ["mastodon", ["mastodon.social"]],
  ["threads", ["threads.net"]]
];
function hostnameMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
function sourceForHostname(hostname, sources) {
  for (const [source, domains] of sources) {
    if (domains.some((domain) => hostnameMatches(hostname, domain))) {
      return source;
    }
  }
  return null;
}
function sourceForAttribution(value, sources) {
  const normalized = value.trim().toLowerCase().replace(/^www\./u, "");
  if (!normalized) {
    return null;
  }
  for (const [source, domains] of sources) {
    if (normalized === source || domains.some((domain) => hostnameMatches(normalized, domain))) {
      return source;
    }
  }
  return null;
}
function parseAttributionSource(site, currentUrl) {
  if (!currentUrl || site.attributionMode === "referrer_only") {
    return null;
  }
  try {
    const url = new URL(currentUrl, `https://${site.canonicalDomain}`);
    if (isSensitiveAnalyticsPath(site, url.pathname) || !isAllowedAnalyticsPath(site, url.pathname))
      return null;
    return url.searchParams.get("utm_source");
  } catch {
    return null;
  }
}
function parseReferrerHostname(referrer) {
  if (!referrer || referrer === "$direct") {
    return null;
  }
  try {
    return normalizeAnalyticsHostname(new URL(referrer).hostname);
  } catch {
    return "";
  }
}
function classifyAnalyticsTraffic(site, referrer, currentUrl) {
  const attributionSource = parseAttributionSource(site, currentUrl);
  if (attributionSource) {
    const attributedAiSource = sourceForAttribution(attributionSource, AI_SOURCES);
    if (attributedAiSource) {
      return {
        traffic_channel: "ai_referral",
        traffic_source: attributedAiSource
      };
    }
    const attributedSearchSource = sourceForAttribution(attributionSource, SEARCH_SOURCES);
    if (attributedSearchSource) {
      return {
        traffic_channel: "organic_search",
        traffic_source: attributedSearchSource
      };
    }
    const attributedSocialSource = sourceForAttribution(attributionSource, SOCIAL_SOURCES);
    if (attributedSocialSource) {
      return {
        traffic_channel: "social",
        traffic_source: attributedSocialSource
      };
    }
  }
  const hostname = parseReferrerHostname(referrer);
  if (hostname === null) {
    return { traffic_channel: "direct", traffic_source: "direct" };
  }
  if (!hostname) {
    return { traffic_channel: "referral", traffic_source: "unknown" };
  }
  if (isAllowedAnalyticsHost(site, hostname)) {
    return {
      traffic_channel: "internal",
      traffic_source: "internal",
      referrer_host: hostname
    };
  }
  const publicHostname = hostname.replace(/^www\./u, "");
  const aiSource = sourceForHostname(publicHostname, AI_SOURCES);
  if (aiSource) {
    return {
      traffic_channel: "ai_referral",
      traffic_source: aiSource,
      referrer_host: publicHostname
    };
  }
  const searchSource = sourceForHostname(publicHostname, SEARCH_SOURCES);
  if (searchSource) {
    return {
      traffic_channel: "organic_search",
      traffic_source: searchSource,
      referrer_host: publicHostname
    };
  }
  const socialSource = sourceForHostname(publicHostname, SOCIAL_SOURCES);
  if (socialSource) {
    return {
      traffic_channel: "social",
      traffic_source: socialSource,
      referrer_host: publicHostname
    };
  }
  return {
    traffic_channel: "referral",
    traffic_source: publicHostname,
    referrer_host: publicHostname
  };
}

// src/client.ts
var BUILT_IN_EVENTS = new Set([
  "$pageview",
  "$pageleave",
  "$web_vitals",
  "$exception",
  STANDARD_ANALYTICS_EVENTS.pageNotFound
]);
var clientExceptionBudget = new ExceptionBudget({
  totalLimit: 20,
  perFingerprintLimit: 2,
  windowMs: 60000
});
var seenErrors = new WeakSet;
function liveRouteAllowed(site) {
  const href = typeof window === "undefined" || typeof window.location === "undefined" ? undefined : window.location.href;
  return href === undefined || classifyAnalyticsRoute(site, href) !== null;
}
function allowedEvent(site, eventName) {
  return BUILT_IN_EVENTS.has(eventName) || isAllowedCustomEvent(site, eventName);
}
function createPostHogBeforeSend(site, resolveEvidence) {
  let sensitiveAttributionSeen = false;
  return (capture) => {
    if (!liveRouteAllowed(site)) {
      sensitiveAttributionSeen = true;
      return null;
    }
    if (!capture || !allowedEvent(site, capture.event)) {
      return null;
    }
    const projectToken = typeof capture.properties.token === "string" && capture.properties.token.startsWith("phc_") ? capture.properties.token : null;
    if (!projectToken) {
      return null;
    }
    const evidence = resolveEvidence();
    if (!classifyAnalyticsRoute(site, evidence.href)) {
      sensitiveAttributionSeen = true;
      return null;
    }
    const rawCurrentUrl = typeof capture.properties.$current_url === "string" ? capture.properties.$current_url : evidence.href;
    const route = classifyAnalyticsRoute(site, rawCurrentUrl);
    if (!route) {
      sensitiveAttributionSeen = true;
      return null;
    }
    const rawReferrer = typeof capture.properties.$referrer === "string" ? capture.properties.$referrer : evidence.referrer;
    const location = parseAnalyticsLocation(site, rawCurrentUrl);
    for (const url of [evidence.href, rawCurrentUrl, capture.properties.$initial_current_url, capture.properties.$session_entry_url]) {
      if (typeof url !== "string")
        continue;
      try {
        const pathname = new URL(url, `https://${site.canonicalDomain}`).pathname;
        if (isSensitiveAnalyticsPath(site, pathname) || !isAllowedAnalyticsPath(site, pathname)) {
          sensitiveAttributionSeen = true;
        }
      } catch {}
    }
    const traffic = classifyAnalyticsTraffic(site, rawReferrer, sensitiveAttributionSeen ? null : rawCurrentUrl);
    const properties = sanitizeProviderProperties(site, capture.properties, rawCurrentUrl, sensitiveAttributionSeen);
    properties.token = projectToken;
    const $host = location?.hostname;
    if ($host) {
      properties.$host = normalizeAnalyticsHostname($host).replace(/^www\./u, "");
    }
    properties.$current_url = sanitizeProviderProperties(site, { $current_url: rawCurrentUrl }, rawCurrentUrl, sensitiveAttributionSeen).$current_url ?? canonicalAnalyticsUrl(site, route.canonical_path);
    properties.$pathname = route.canonical_path;
    properties.$process_person_profile = false;
    return {
      uuid: capture.uuid,
      event: capture.event,
      properties: {
        ...properties,
        ...route,
        ...traffic
      },
      ...capture.timestamp ? { timestamp: capture.timestamp } : {}
    };
  };
}

// src/testing.ts
var HARNESS_API_KEY = "phc_harness";
var HARNESS_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
function harnessPath() {
  for (const candidate of ["./testing-harness.js", "./testing-harness.ts"]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) {
      return path;
    }
  }
  throw new Error("@hraness/posthog/testing: harness entry is missing from the package");
}
function decodeBody(base64) {
  let bytes = Buffer.from(base64, "base64");
  if (bytes[0] === 31 && bytes[1] === 139) {
    bytes = gunzipSync(bytes);
  }
  let text = new TextDecoder().decode(bytes);
  if (text.startsWith("data=")) {
    text = Buffer.from(decodeURIComponent(text.slice(5)), "base64").toString("utf8");
  }
  const parsed = JSON.parse(text);
  const batch = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.batch) ? parsed.batch : [parsed];
  return batch;
}
function runPostHogHarness(options) {
  const input = JSON.stringify({
    site: options.site,
    apiKey: options.apiKey ?? HARNESS_API_KEY,
    apiHost: options.apiHost,
    userAgent: options.userAgent ?? HARNESS_USER_AGENT,
    scenarios: options.scenarios
  });
  const child = spawnSync(options.runtime ?? process.execPath, [harnessPath()], {
    input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30000,
    maxBuffer: 64 * 1024 * 1024
  });
  if (child.status !== 0) {
    throw new Error(`@hraness/posthog/testing: harness exited ${String(child.status ?? child.signal)}
${child.stderr}`);
  }
  const output = JSON.parse(child.stdout);
  return {
    sent: output.sent.flatMap(decodeBody),
    received: output.received,
    returned: output.returned
  };
}
var REQUIRED_CONTRACT_PROPERTIES = [
  "$host",
  "$raw_user_agent",
  "$current_url",
  "$pathname",
  "$referrer",
  "$referring_domain",
  "token",
  "site_id",
  "analytics_schema_version",
  "canonical_path",
  "page_kind",
  "$cookieless_mode",
  "distinct_id"
];
var PRESERVED_CONTRACT_PROPERTIES = [
  "$session_id",
  "$window_id",
  "$pageview_id",
  "$prev_pageview_id",
  "$lib",
  "$lib_version",
  "$browser",
  "$os",
  "$device_type",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width"
];
var LEAK_EMAIL = "person.contract@example.com";
var LEAK_CODE = "oauthcontractcode123";
var LEAK_PARAM = "private_contract_param";
function propertyOf(event, key) {
  return event.properties[key] ?? (key === "distinct_id" ? event["distinct_id"] : undefined);
}
function checkPostHogContract(options) {
  const { site } = options;
  const origin = `https://${site.canonicalDomain}`;
  const publicPath = options.publicPath ?? "/";
  const publicHref = `${origin}${publicPath}?utm_source=contract&gclid=contractclick&email=${encodeURIComponent(LEAK_EMAIL)}&code=${LEAK_CODE}&${LEAK_PARAM}=1#fragment`;
  const sensitiveHref = `${origin}${options.sensitivePath}?utm_source=contract&gclid=contractclick&code=${LEAK_CODE}`;
  const referrer = "https://news.example.org/some/article/path?ref=contract";
  const standard = [
    { event: "$pageview" },
    { event: "$pageleave" },
    {
      event: "$web_vitals",
      properties: { $web_vitals_LCP_value: 1200, $web_vitals_LCP_event: { name: "LCP", value: 1200 } }
    },
    { event: "$exception", error: { name: "TypeError", message: `failed for ${LEAK_EMAIL}` } }
  ];
  const customEvents = options.customEvents ?? [];
  const result = runPostHogHarness({
    site,
    ...options.runtime ? { runtime: options.runtime } : {},
    scenarios: [
      { href: publicHref, referrer, captures: [...standard, ...customEvents] },
      { href: sensitiveHref, referrer, captures: [{ event: "$pageview" }] }
    ]
  });
  const violations = [];
  const receivedByUuid = new Map;
  for (const value of result.received) {
    if (value && typeof value === "object") {
      const received = value;
      receivedByUuid.set(received.uuid, received.properties ?? {});
    }
  }
  const publicEvents = result.sent.filter((event) => {
    const url = receivedByUuid.get(event["uuid"])?.["$current_url"] ?? propertyOf(event, "$current_url");
    return typeof url === "string" && !url.includes(options.sensitivePath);
  });
  const sensitiveEvents = result.sent.filter((event) => !publicEvents.includes(event));
  for (const expected of [...standard, ...customEvents]) {
    if (!publicEvents.some((event) => event.event === expected.event)) {
      violations.push(`${expected.event}: no request was sent`);
    }
  }
  if (isAllowedAnalyticsPath(site, options.sensitivePath)) {
    if (sensitiveEvents.length === 0)
      violations.push(`${options.sensitivePath}: no sensitive-path $pageview was sent`);
  } else if (sensitiveEvents.length > 0) {
    violations.push(`${options.sensitivePath}: excluded route sent events`);
  }
  for (const event of result.sent) {
    const label = event.event;
    const received = receivedByUuid.get(event["uuid"]) ?? {};
    for (const key of PRESERVED_CONTRACT_PROPERTIES) {
      if (received[key] !== undefined && received[key] !== null && propertyOf(event, key) !== received[key]) {
        violations.push(`${label}: changed or dropped ${key}`);
      }
    }
    for (const key of REQUIRED_CONTRACT_PROPERTIES) {
      const value = propertyOf(event, key);
      if (value === undefined || value === null || value === "") {
        violations.push(`${label}: missing ${key}`);
      }
    }
    if (propertyOf(event, "$cookieless_mode") !== true) {
      violations.push(`${label}: $cookieless_mode is not true`);
    }
    if (propertyOf(event, "site_id") !== site.id) {
      violations.push(`${label}: site_id is not ${site.id}`);
    }
    if (propertyOf(event, "analytics_schema_version") !== site.schemaVersion) {
      violations.push(`${label}: analytics_schema_version is not ${String(site.schemaVersion)}`);
    }
    const serialized = JSON.stringify(event);
    for (const [leak, name] of [
      [LEAK_EMAIL, "email"],
      [LEAK_CODE, "OAuth code"],
      [LEAK_PARAM, "non-attribution query parameter"],
      ["#fragment", "fragment"],
      ["/some/article/path", "third-party referrer path"]
    ]) {
      if (serialized.includes(leak)) {
        violations.push(`${label}: leaked the ${name}`);
      }
    }
  }
  for (const event of publicEvents) {
    const label = event.event;
    const currentUrl = String(propertyOf(event, "$current_url"));
    let params = [];
    try {
      params = [...new URL(currentUrl).searchParams.keys()].sort();
    } catch {
      violations.push(`${label}: $current_url is not a URL`);
    }
    const expectedParams = site.attributionMode === "referrer_only" ? "" : "gclid,utm_source";
    if (params.join(",") !== expectedParams) {
      violations.push(`${label}: $current_url query is [${params.join(",")}], want [${expectedParams}]`);
    }
    if (site.attributionMode === "referrer_only") {
      const serialized = JSON.stringify(event.properties);
      if (serialized.includes("contractclick") || serialized.includes('"utm_source"')) {
        violations.push(`${label}: referrer-only site kept attribution`);
      }
      continue;
    }
    if (propertyOf(event, "utm_source") !== "contract") {
      violations.push(`${label}: utm_source was not kept`);
    }
    if (propertyOf(event, "gclid") !== "contractclick") {
      violations.push(`${label}: gclid was not kept`);
    }
  }
  for (const event of sensitiveEvents) {
    const serialized = JSON.stringify(event.properties);
    if (String(propertyOf(event, "$current_url")).includes("?")) {
      violations.push(`${event.event} on ${options.sensitivePath}: kept a query`);
    }
    if (serialized.includes("contractclick") || serialized.includes('"utm_source"')) {
      violations.push(`${event.event} on ${options.sensitivePath}: kept attribution`);
    }
  }
  for (const eventName of [...site.customEvents, ...site.delegatedEvents ?? []]) {
    if (!isStandardAnalyticsEventName(eventName)) {
      violations.push(`${eventName}: custom event name breaks the lowercase object-verb rule`);
    }
  }
  for (const capture of customEvents) {
    if (!site.customEvents.includes(capture.event) && !site.delegatedEvents?.includes(capture.event)) {
      violations.push(`${capture.event}: not in the site's customEvents allowlist`);
    }
  }
  const rejectedHosts = options.rejectedHosts ?? [
    `preview.${site.canonicalDomain}`,
    `${site.id.replace(/[^a-z0-9-]/gu, "-")}-git-branch.vercel.app`,
    "localhost"
  ];
  for (const host of rejectedHosts) {
    const href = `https://${host}${publicPath}`;
    const beforeSend = createPostHogBeforeSend(site, () => ({ href, referrer: "" }));
    const sample = beforeSend({
      uuid: "00000000-0000-4000-8000-000000000000",
      event: "$pageview",
      properties: { token: HARNESS_API_KEY, $current_url: href, $host: host }
    });
    if (sample !== null) {
      violations.push(`${host}: before_send did not return null`);
    }
  }
  return { violations, result };
}
export {
  runPostHogHarness,
  checkPostHogContract,
  REQUIRED_CONTRACT_PROPERTIES,
  PRESERVED_CONTRACT_PROPERTIES,
  HARNESS_USER_AGENT,
  HARNESS_API_KEY
};

//# debugId=A5E9AB02F91A354B64756E2164756E21
