// src/site.ts
var POSTHOG_SCHEMA_VERSION = 1;
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
export {
  sanitizeProviderProperties,
  sanitizeAnalyticsError,
  readDelegatedAnalyticsEvent,
  normalizeAnalyticsProperties,
  analyticsErrorFingerprint,
  ExceptionBudget
};

//# debugId=F2C6B16F336DF2C264756E2164756E21
