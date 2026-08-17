"use client";

// src/client.ts
import posthog from "posthog-js";

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
  const withoutTrailingSlash = collapsed.length > 1 ? collapsed.replace(/\/+$/u, "") : collapsed;
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
  return pathname === rulePath || pathname.startsWith(`${rulePath}/`);
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
  if (!parsed) {
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
function isAllowedDelegatedEvent(site, eventName) {
  return site.delegatedEvents?.includes(eventName) ?? false;
}

// src/event.ts
var MAX_PROPERTY_COUNT = 32;
var MAX_PROPERTY_KEY_LENGTH = 64;
var MAX_PROPERTY_STRING_LENGTH = 256;
var MAX_PROPERTY_ARRAY_LENGTH = 20;
var MAX_ERROR_MESSAGE_LENGTH = 512;
var MAX_ERROR_STACK_LENGTH = 6000;
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
var QUERY_ATTRIBUTION_PROPERTY_NAMES = new Set([
  "_kx",
  "campaign_params",
  "dclid",
  "epik",
  "fbclid",
  "gad_source",
  "gbraid",
  "gclid",
  "gclsrc",
  "igshid",
  "irclid",
  "li_fat_id",
  "mc_cid",
  "msclkid",
  "qclid",
  "rdt_cid",
  "sccid",
  "ttclid",
  "twclid",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
  "wbraid"
]);
var REFERRER_URL_KEYS = new Set([
  "$referrer",
  "$initial_referrer",
  "referrer"
]);
function normalizedProviderPropertyName(key) {
  return key.toLowerCase().replace(/^\$/u, "").replace(/^(?:initial|session_entry)_/u, "");
}
function isProviderPathnameKey(key) {
  return /^(?:\$)?(?:(?:initial|session_entry|prev_pageview)_)?pathname$/u.test(key.toLowerCase());
}
function isQueryAttributionKey(key) {
  return QUERY_ATTRIBUTION_PROPERTY_NAMES.has(normalizedProviderPropertyName(key));
}
function cleanPropertyString(value) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("").replace(/\s{2,}/gu, " ").trim().slice(0, MAX_PROPERTY_STRING_LENGTH);
}
function normalizePrimitive(value) {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return cleanPropertyString(value);
  }
  return;
}
function normalizePropertyValue(value) {
  const primitive = normalizePrimitive(value);
  if (primitive !== undefined) {
    return primitive;
  }
  if (!Array.isArray(value)) {
    return;
  }
  const normalized = value.slice(0, MAX_PROPERTY_ARRAY_LENGTH).map(normalizePrimitive).filter((item) => item !== undefined);
  return normalized;
}
function normalizeAnalyticsProperties(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const normalized = {};
  for (const [key, propertyValue] of Object.entries(value).slice(0, MAX_PROPERTY_COUNT)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || key.length > MAX_PROPERTY_KEY_LENGTH) {
      continue;
    }
    const safeValue = normalizePropertyValue(propertyValue);
    if (safeValue !== undefined) {
      normalized[key] = safeValue;
    }
  }
  return normalized;
}
function sanitizeThirdPartyUrl(value, originOnly) {
  try {
    const parsed = new URL(value);
    return originOnly ? parsed.origin : `${parsed.origin}${normalizeAnalyticsPathname(parsed.pathname)}`;
  } catch {
    return "";
  }
}
function sanitizeUrlValue(site, key, value) {
  if (REFERRER_URL_KEYS.has(key)) {
    return sanitizeThirdPartyUrl(value, true);
  }
  if (isProviderPathnameKey(key)) {
    try {
      const parsed = new URL(value, `https://${site.canonicalDomain}`);
      if (!isAllowedAnalyticsHost(site, parsed.hostname))
        return "";
      return classifyAnalyticsRoute(site, parsed)?.canonical_path ?? "/";
    } catch {
      return "";
    }
  }
  if (!CURRENT_URL_KEYS.has(key)) {
    return value;
  }
  try {
    const parsed = new URL(value, `https://${site.canonicalDomain}`);
    if (!isAllowedAnalyticsHost(site, parsed.hostname)) {
      return sanitizeThirdPartyUrl(parsed.href, true);
    }
    const route = classifyAnalyticsRoute(site, parsed);
    return canonicalAnalyticsUrl(site, route?.canonical_path ?? "/");
  } catch {
    return "";
  }
}
function sanitizeProviderValue(site, key, value, depth, seen) {
  if (site.stripQueryAttribution === true && isQueryAttributionKey(key)) {
    return;
  }
  if (typeof value === "string") {
    return redactSensitiveText(sanitizeUrlValue(site, key, value)).slice(0, MAX_PROVIDER_PROPERTY_STRING_LENGTH);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (depth >= 5 || !value || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderValue(site, key, item, depth + 1, seen));
  }
  const result = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    const safeValue = sanitizeProviderValue(site, nestedKey, nestedValue, depth + 1, seen);
    if (safeValue !== undefined) {
      result[nestedKey] = safeValue;
    }
  }
  return result;
}
function sanitizeProviderProperties(site, properties) {
  const seen = new WeakSet;
  const sanitized = {};
  for (const [key, value] of Object.entries(properties)) {
    const safeValue = sanitizeProviderValue(site, key, value, 0, seen);
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }
  return sanitized;
}
function redactSensitiveText(value) {
  return value.replace(/\b(?:phc|phx|phs|pha|phr)_[A-Za-z0-9_-]+\b/gu, "[credential]").replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu, "Bearer [credential]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[credential]").replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]").replace(/(https?:\/\/[^\s?#)]+)(?:\?[^\s#)]*)?(?:#[^\s)]*)?/giu, "$1").replace(/([/][^\s?#)]+)\?[^\s#)]*/gu, "$1").replace(/\b(api[_-]?key|access[_-]?token|auth(?:orization)?|secret|password)=([^\s&]+)/giu, "$1=[redacted]");
}
function sanitizeAnalyticsError(value) {
  try {
    if (!(value instanceof Error)) {
      return new Error("Non-Error rejection");
    }
    const name = redactSensitiveText(value.name || "Error").slice(0, 80) || "Error";
    const message = redactSensitiveText(value.message || "Unknown error").slice(0, MAX_ERROR_MESSAGE_LENGTH);
    const sanitized = new Error(message);
    sanitized.name = name;
    if (value.stack) {
      sanitized.stack = redactSensitiveText(value.stack).slice(0, MAX_ERROR_STACK_LENGTH);
    }
    return sanitized;
  } catch {
    return new Error("Uninspectable rejection");
  }
}
function analyticsErrorFingerprint(error) {
  const stackFrame = error.stack?.split(`
`).slice(1, 3).join(`
`) ?? "";
  const input = `${error.name}
${error.message}
${stackFrame}`;
  let hash = 2166136261;
  for (let index = 0;index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `e_${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
  allow(fingerprint, now = Date.now()) {
    const threshold = now - this.#windowMs;
    this.#all = this.#all.filter((timestamp) => timestamp > threshold);
    const matching = (this.#byFingerprint.get(fingerprint) ?? []).filter((timestamp) => timestamp > threshold);
    if (this.#all.length >= this.#totalLimit || matching.length >= this.#perFingerprintLimit) {
      this.#byFingerprint.set(fingerprint, matching);
      return false;
    }
    this.#all.push(now);
    matching.push(now);
    this.#byFingerprint.set(fingerprint, matching);
    return true;
  }
}
function readDelegatedAnalyticsEvent(site, target) {
  if (!(target instanceof Element)) {
    return null;
  }
  const element = target.closest("[data-analytics-event]");
  const eventName = element?.dataset.analyticsEvent?.trim();
  if (!element || !eventName || !isAllowedDelegatedEvent(site, eventName)) {
    return null;
  }
  const properties = {};
  if (element.dataset.analyticsKind) {
    properties.target_kind = cleanPropertyString(element.dataset.analyticsKind);
  }
  if (element.dataset.analyticsId) {
    properties.target_id = cleanPropertyString(element.dataset.analyticsId);
  }
  if (element instanceof HTMLAnchorElement) {
    try {
      const targetUrl = new URL(element.href, window.location.href);
      properties.target_host = targetUrl.hostname.toLowerCase();
      properties.target_path = normalizeAnalyticsPathname(targetUrl.pathname);
    } catch {}
  }
  return { eventName, properties };
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
  if (!currentUrl) {
    return null;
  }
  try {
    return new URL(currentUrl, `https://${site.canonicalDomain}`).searchParams.get("utm_source");
  } catch {
    return null;
  }
}
function parseReferrerHostname(referrer) {
  if (!referrer || referrer === "$direct") {
    return null;
  }
  try {
    return normalizeAnalyticsHostname(new URL(referrer).hostname).replace(/^www\./u, "");
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
  const aiSource = sourceForHostname(hostname, AI_SOURCES);
  if (aiSource) {
    return {
      traffic_channel: "ai_referral",
      traffic_source: aiSource,
      referrer_host: hostname
    };
  }
  const searchSource = sourceForHostname(hostname, SEARCH_SOURCES);
  if (searchSource) {
    return {
      traffic_channel: "organic_search",
      traffic_source: searchSource,
      referrer_host: hostname
    };
  }
  const socialSource = sourceForHostname(hostname, SOCIAL_SOURCES);
  if (socialSource) {
    return {
      traffic_channel: "social",
      traffic_source: socialSource,
      referrer_host: hostname
    };
  }
  return {
    traffic_channel: "referral",
    traffic_source: hostname,
    referrer_host: hostname
  };
}

// src/client.ts
"use client";
var BUILT_IN_EVENTS = new Set(["$pageview", "$pageleave", "$web_vitals", "$exception"]);
var DEFAULT_API_HOST = "https://us.i.posthog.com";
var clientExceptionBudget = new ExceptionBudget({
  totalLimit: 20,
  perFingerprintLimit: 2,
  windowMs: 60000
});
var seenErrors = new WeakSet;
var activeSiteId = null;
function currentBrowserEvidence() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  return {
    hostname: window.location.hostname,
    href: window.location.href,
    referrer: document.referrer,
    production: false
  };
}
function isPostHogBrowserEligible(options) {
  const evidence = options.evidence ?? currentBrowserEvidence();
  return Boolean(evidence?.production && options.apiKey?.startsWith("phc_") && isAllowedAnalyticsHost(options.site, evidence.hostname));
}
function allowedEvent(site, eventName) {
  return BUILT_IN_EVENTS.has(eventName) || isAllowedCustomEvent(site, eventName);
}
function createPostHogBeforeSend(site, resolveEvidence) {
  return (capture) => {
    if (!capture || !allowedEvent(site, capture.event)) {
      return null;
    }
    const projectToken = typeof capture.properties.token === "string" && capture.properties.token.startsWith("phc_") ? capture.properties.token : null;
    if (!projectToken) {
      return null;
    }
    const evidence = resolveEvidence();
    const rawCurrentUrl = typeof capture.properties.$current_url === "string" ? capture.properties.$current_url : evidence.href;
    const route = classifyAnalyticsRoute(site, rawCurrentUrl);
    if (!route) {
      return null;
    }
    const rawReferrer = typeof capture.properties.$referrer === "string" ? capture.properties.$referrer : evidence.referrer;
    const traffic = classifyAnalyticsTraffic(site, rawReferrer, rawCurrentUrl);
    const properties = sanitizeProviderProperties(site, capture.properties);
    properties.token = projectToken;
    properties.$current_url = canonicalAnalyticsUrl(site, route.canonical_path);
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
function createPostHogBrowserConfig(site, evidence, apiHost = DEFAULT_API_HOST) {
  return {
    api_host: apiHost,
    ui_host: apiHost.includes("eu.i.posthog.com") ? "https://eu.posthog.com" : "https://us.posthog.com",
    defaults: "2026-05-30",
    autocapture: false,
    rageclick: false,
    capture_pageview: "history_change",
    capture_pageleave: true,
    capture_performance: {
      network_timing: false,
      web_vitals: true,
      web_vitals_allowed_metrics: ["LCP", "CLS", "FCP", "INP"],
      web_vitals_attribution: false
    },
    capture_exceptions: false,
    enable_recording_console_log: false,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_product_tours: true,
    disable_conversations: true,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    person_profiles: "never",
    persistence: "memory",
    cookieless_mode: "always",
    respect_dnt: true,
    cross_subdomain_cookie: false,
    disableDeviceModel: true,
    disable_capture_url_hashes: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: true,
    custom_personal_data_properties: ["email", "token", "code", "key", "secret"],
    properties_string_max_length: 2048,
    internal_or_test_user_hostname: null,
    rate_limiting: {
      events_per_second: 2,
      events_burst_limit: 12
    },
    before_send: createPostHogBeforeSend(site, () => evidence)
  };
}
function initializePostHogBrowser(options) {
  if (!isPostHogBrowserEligible(options)) {
    return false;
  }
  if (activeSiteId === options.site.id) {
    return true;
  }
  const evidence = options.evidence ?? currentBrowserEvidence();
  if (!evidence || !options.apiKey) {
    return false;
  }
  posthog.init(options.apiKey, createPostHogBrowserConfig(options.site, evidence, options.apiHost));
  activeSiteId = options.site.id;
  return true;
}
function capturePostHogEvent(site, eventName, properties = {}) {
  if (activeSiteId !== site.id || !isAllowedCustomEvent(site, eventName)) {
    return false;
  }
  posthog.capture(eventName, normalizeAnalyticsProperties(properties));
  return true;
}
function capturePostHogException(site, value, properties = {}) {
  if (activeSiteId !== site.id) {
    return false;
  }
  if (value && typeof value === "object") {
    if (seenErrors.has(value)) {
      return false;
    }
    seenErrors.add(value);
  }
  const error = sanitizeAnalyticsError(value);
  const fingerprint = analyticsErrorFingerprint(error);
  if (!clientExceptionBudget.allow(fingerprint)) {
    return false;
  }
  posthog.captureException(error, {
    ...normalizeAnalyticsProperties(properties),
    error_fingerprint: fingerprint,
    error_surface: "browser"
  });
  return true;
}
function installPostHogExceptionCapture(site) {
  const onError = (event) => {
    if (event.error instanceof Error) {
      capturePostHogException(site, event.error, { error_origin: "window_error" });
    }
  };
  const onUnhandledRejection = (event) => {
    capturePostHogException(site, event.reason, { error_origin: "unhandled_rejection" });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
function installDelegatedPostHogCapture(site) {
  const onClick = (event) => {
    if (event.button !== 0) {
      return;
    }
    const delegated = readDelegatedAnalyticsEvent(site, event.target);
    if (delegated) {
      capturePostHogEvent(site, delegated.eventName, delegated.properties);
    }
  };
  document.addEventListener("click", onClick);
  return () => {
    document.removeEventListener("click", onClick);
  };
}
export {
  isPostHogBrowserEligible,
  installPostHogExceptionCapture,
  installDelegatedPostHogCapture,
  initializePostHogBrowser,
  createPostHogBrowserConfig,
  createPostHogBeforeSend,
  capturePostHogException,
  capturePostHogEvent
};

//# debugId=4850788D72BA568164756E2164756E21
