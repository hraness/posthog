"use client";

// src/client.ts
import { posthog } from "posthog-js";
import"posthog-js/dist/web-vitals.js";

// src/redaction.ts
var MAX_INSPECTION_LENGTH = 32768;
var MAX_DECODE_PASSES = 8;
function percentCharacter(value, index) {
  const first = value.slice(index, index + 3);
  if (!/^%[0-9a-f]{2}$/iu.test(first))
    return null;
  const byte = Number.parseInt(first.slice(1), 16);
  const count = byte < 128 ? 1 : byte >= 194 && byte <= 223 ? 2 : byte >= 224 && byte <= 239 ? 3 : byte >= 240 && byte <= 244 ? 4 : 0;
  if (!count)
    return null;
  const encoded = value.slice(index, index + count * 3);
  if (!/^(?:%[0-9a-f]{2})+$/iu.test(encoded) || encoded.length !== count * 3)
    return null;
  try {
    return { text: decodeURIComponent(encoded), length: encoded.length };
  } catch {
    return null;
  }
}
function emailSpans(value) {
  const result = [];
  const domain = new RegExp(String.raw`@[\p{L}\p{N}\p{M}.-]+\.[\p{L}\p{M}]{2,}`, "uy");
  const localCharacter = new RegExp(String.raw`^[\p{L}\p{N}\p{M}._%+-]+$`, "u");
  let previousAt = -1;
  let previousEnd = 0;
  for (let at = value.indexOf("@");at >= 0; at = value.indexOf("@", at + 1)) {
    let start = at;
    const floor = Math.max(previousAt + 1, previousEnd);
    while (start > floor) {
      const unit = value.charCodeAt(start - 1);
      const width = unit >= 56320 && unit <= 57343 && start - 2 >= floor ? 2 : 1;
      if (!localCharacter.test(value.slice(start - width, start)))
        break;
      start -= width;
    }
    const candidateStart = start;
    while (start < at && /^[._%+-]$/u.test(value.charAt(start)))
      start += 1;
    if (start === at)
      start = candidateStart;
    previousAt = at;
    if (start === at)
      continue;
    domain.lastIndex = at;
    const match = domain.exec(value);
    if (!match)
      continue;
    const end = at + match[0].length;
    result.push({ start, end });
    previousEnd = end;
  }
  return result;
}
function userinfoSpans(value) {
  const result = [];
  for (let colon = value.indexOf("://");colon >= 0; colon = value.indexOf("://", colon + 3)) {
    let scheme = colon;
    while (scheme > 0 && /^[a-z0-9+.-]$/iu.test(value.charAt(scheme - 1)))
      scheme -= 1;
    while (scheme < colon && !/^[a-z]$/iu.test(value.charAt(scheme)))
      scheme += 1;
    if (scheme === colon)
      continue;
    const start = colon + 3;
    let end = start;
    let at = -1;
    while (end < value.length && !/[/\s?#]/u.test(value.charAt(end))) {
      if (value.charAt(end) === "@")
        at = end;
      end += 1;
    }
    if (at > start)
      result.push({ start, end: at });
  }
  return result;
}
function redactEncodedIdentifiers(value) {
  let shadow = value;
  let spans = Array.from({ length: value.length }, (_, index) => ({ start: index, end: index + 1 }));
  const spanAt = (index) => spans[index] ?? { start: 0, end: value.length };
  for (let pass = 0;pass < MAX_DECODE_PASSES && shadow.includes("%"); pass += 1) {
    let decoded = "";
    const decodedSpans = [];
    let changed = false;
    for (let index = 0;index < shadow.length; index += 1) {
      const escape = percentCharacter(shadow, index);
      if (escape) {
        decoded += escape.text;
        const span = { start: spanAt(index).start, end: spanAt(index + escape.length - 1).end };
        for (let unit = 0;unit < escape.text.length; unit += 1)
          decodedSpans.push(span);
        index += escape.length - 1;
        changed = true;
      } else {
        decoded += shadow.charAt(index);
        decodedSpans.push(spanAt(index));
      }
    }
    shadow = decoded;
    spans = decodedSpans;
    if (!changed)
      break;
  }
  const replacements = [];
  const unresolvedSpans = Array.from(shadow.matchAll(/%[0-9a-f]{2}/giu)).filter((match) => percentCharacter(shadow, match.index) !== null).map((match) => spanAt(match.index));
  let unresolvedIndex = 0;
  for (const segment of value.matchAll(/[^\s/?#]+/gu)) {
    const end = segment.index + segment[0].length;
    while (unresolvedSpans[unresolvedIndex] && (unresolvedSpans[unresolvedIndex]?.start ?? Infinity) < segment.index)
      unresolvedIndex += 1;
    if (unresolvedSpans[unresolvedIndex] && (unresolvedSpans[unresolvedIndex]?.start ?? Infinity) < end) {
      replacements.push({ start: segment.index, end, replacement: "[redacted]", priority: 0 });
    }
  }
  const patterns = [
    [/(\bBearer\s+)([A-Za-z0-9._~+/=-]+)\b/giu, "[credential]"],
    [/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth(?:orization)?|secret|password|code|state)=)([^\s&]+)/giu, "[redacted]"],
    [/\b(?:phc|phx|phs|pha|phr)_[A-Za-z0-9_-]+\b/gu, "[credential]"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[credential]"]
  ];
  for (const [priority, [pattern, replacement]] of patterns.entries()) {
    for (const match of shadow.matchAll(pattern)) {
      const offset = match.index + (match[1]?.length ?? 0);
      const length = (match[2] ?? match[0]).length;
      const start = spanAt(offset).start;
      const end = spanAt(offset + length - 1).end;
      replacements.push({ start, end, replacement, priority: priority + 2 });
    }
  }
  for (const { start, end } of userinfoSpans(shadow)) {
    replacements.push({ start: spanAt(start).start, end: spanAt(end - 1).end, replacement: "[credential]", priority: 1 });
  }
  for (const { start, end } of emailSpans(shadow)) {
    replacements.push({ start: spanAt(start).start, end: spanAt(end - 1).end, replacement: "[email]", priority: 6 });
  }
  replacements.sort((left, right) => left.start - right.start || left.priority - right.priority || right.end - left.end);
  let result = "";
  let cursor = 0;
  for (const { start, end, replacement } of replacements) {
    if (start < cursor)
      continue;
    result += value.slice(cursor, start) + replacement;
    cursor = end;
  }
  return result + value.slice(cursor);
}
function removeRelativePathQueries(value) {
  return value.replace(/[^\s)]+/gu, (token) => token.split("#").map((part) => {
    const slash = part.indexOf("/");
    if (slash < 0)
      return part;
    const query = part.indexOf("?", slash + 1);
    return query > slash + 1 ? part.slice(0, query) : part;
  }).join("#"));
}
function redactSensitiveText(value) {
  if (value.length > MAX_INSPECTION_LENGTH)
    return "[redacted]";
  return removeRelativePathQueries(redactEncodedIdentifiers(value).replace(/\b(?:phc|phx|phs|pha|phr)_[A-Za-z0-9_-]+\b/gu, "[credential]").replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu, "Bearer [credential]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[credential]").replace(/(https?:\/\/[^\s?#)]+)(?:\?[^\s#)]*)?(?:#[^\s)]*)?/giu, "$1").replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth(?:orization)?|secret|password|code|state)=([^\s&]+)/giu, "$1=[redacted]"));
}

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
  const rawPathname = typeof location === "object" && !(location instanceof URL) ? location.pathname : (location instanceof URL ? location : new URL(location, `https://${site.canonicalDomain}`)).pathname;
  const emittedPath = normalizeAnalyticsPathname(redactSensitiveText(rawPathname));
  const contentSlug = rule ? slugForRule(rule, emittedPath) : undefined;
  return {
    analytics_schema_version: site.schemaVersion,
    site_id: site.id,
    canonical_domain: normalizeAnalyticsHostname(site.canonicalDomain),
    canonical_path: redactSensitiveText(rule === undefined && site.unknownCanonicalPath !== undefined ? normalizeAnalyticsPathname(redactSensitiveText(site.unknownCanonicalPath)) : emittedPath),
    page_kind: rule?.pageKind ?? "other",
    ...rule?.contentGroup ? { content_group: rule.contentGroup } : {},
    ...contentSlug ? { content_slug: redactSensitiveText(contentSlug) } : {}
  };
}
function canonicalAnalyticsUrl(site, pathname) {
  return `https://${normalizeAnalyticsHostname(site.canonicalDomain)}${normalizeAnalyticsPathname(redactSensitiveText(pathname))}`;
}
function isAllowedCustomEvent(site, eventName) {
  return site.customEvents.includes(eventName);
}
function isAllowedDelegatedEvent(site, eventName) {
  return site.delegatedEvents?.includes(eventName) ?? false;
}
function isSensitiveAnalyticsPath(site, pathname) {
  const normalized = policyPathname(pathname);
  if (normalized === null)
    return true;
  return site.sensitivePaths?.some((rule) => ruleMatches(rule, normalized)) ?? false;
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
  "ph_keyword",
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
function normalizePrimitive(value) {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return cleanPropertyString(redactSensitiveText(value));
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
function attributionValue(value) {
  return cleanPropertyString(redactSensitiveText(value));
}
function analyticsAttributionQuery(site, url) {
  if (site.privacyMode === "minimal" || site.attributionMode === "referrer_only" || isSensitiveAnalyticsPath(site, url.pathname)) {
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
    if (site.privacyMode === "minimal") {
      return { handled: true, value: redactSensitiveText(sanitizeThirdPartyUrl(value, true)) };
    }
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
  if (site.privacyMode !== "minimal" && PASSTHROUGH_PROPERTY_NAMES.has(key)) {
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
    sensitive: site.privacyMode === "minimal" || site.attributionMode === "referrer_only" || stripAttribution || isSensitiveProviderLocation(site, currentUrl),
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
var ANALYTICS_PLACEMENTS = [
  "hero",
  "nav",
  "footer",
  "inline",
  "pricing",
  "docs",
  "modal",
  "sticky",
  "not_found"
];
var ANALYTICS_INSTALL_METHODS = [
  "brew",
  "curl",
  "npm",
  "bun",
  "pip",
  "go",
  "cargo",
  "other"
];
var ANALYTICS_LINK_KINDS = ["github", "docs", "social", "portfolio", "other"];
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
var SNAKE_CASE_ID_PATTERN = /^[a-z][a-z0-9_]*$/u;
function snakeCaseId(value) {
  return typeof value === "string" && value.length <= MAX_PROPERTY_KEY_LENGTH && SNAKE_CASE_ID_PATTERN.test(value) ? value : null;
}
function oneOf(values, value) {
  return typeof value === "string" && values.includes(value) ? value : null;
}
function hostOf(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const parsed = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    const host = parsed.hostname.toLowerCase().replace(/\.$/u, "").replace(/^www\./u, "");
    return host && host.length <= MAX_PROPERTY_STRING_LENGTH ? host : null;
  } catch {
    return null;
  }
}
function pageNotFoundProperties(input) {
  if (typeof input.requestedPath !== "string") {
    return null;
  }
  let pathname = input.requestedPath;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(pathname)) {
      pathname = new URL(pathname).pathname;
    }
  } catch {
    return null;
  }
  const requestedPath = cleanPropertyString(normalizeAnalyticsPathname(redactSensitiveText(pathname)));
  const referrerHost = input.referrer === "$direct" ? null : hostOf(input.referrer);
  return {
    requested_path: requestedPath || "/",
    ...referrerHost ? { referrer_host: referrerHost } : {}
  };
}
function ctaClickedProperties(input) {
  const cta = snakeCaseId(input.cta);
  const placement = oneOf(ANALYTICS_PLACEMENTS, input.placement);
  if (!cta || !placement) {
    return null;
  }
  const targetHost = hostOf(input.targetHost);
  return { cta, placement, ...targetHost ? { target_host: targetHost } : {} };
}
function outboundLinkOpenedProperties(input) {
  const targetHost = hostOf(input.targetHost);
  const placement = oneOf(ANALYTICS_PLACEMENTS, input.placement);
  if (!targetHost || !placement) {
    return null;
  }
  const linkKind = input.linkKind === undefined ? null : oneOf(ANALYTICS_LINK_KINDS, input.linkKind);
  if (input.linkKind !== undefined && !linkKind) {
    return null;
  }
  return { target_host: targetHost, placement, ...linkKind ? { link_kind: linkKind } : {} };
}
function installCommandCopiedProperties(input) {
  const installMethod = oneOf(ANALYTICS_INSTALL_METHODS, input.installMethod);
  const placement = oneOf(ANALYTICS_PLACEMENTS, input.placement);
  return installMethod && placement ? { install_method: installMethod, placement } : null;
}

// src/client.ts
import { browserDoNotTrackEnabled, getBrowserConsent, installConsentTransport } from "./consent.js";

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
var DEFAULT_API_HOST = "https://us.i.posthog.com";
var clientExceptionBudget = new ExceptionBudget({
  totalLimit: 20,
  perFingerprintLimit: 2,
  windowMs: 60000
});
var seenErrors = new WeakSet;
var activeSiteId = null;
function readDelegatedAnalyticsEvent(site, target) {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return null;
  }
  const element = target.closest("[data-analytics-event]");
  if (typeof HTMLElement === "undefined" || !(element instanceof HTMLElement)) {
    return null;
  }
  const eventName = element.dataset.analyticsEvent?.trim();
  if (!eventName || !isAllowedDelegatedEvent(site, eventName)) {
    return null;
  }
  const { dataset } = element;
  const rawProperties = {
    ...dataset.analyticsKind ? { target_kind: dataset.analyticsKind } : {},
    ...dataset.analyticsId ? { target_id: dataset.analyticsId } : {},
    ...dataset.analyticsCta ? { cta: dataset.analyticsCta } : {},
    ...dataset.analyticsPlacement ? { placement: dataset.analyticsPlacement } : {},
    ...dataset.analyticsLinkKind ? { link_kind: dataset.analyticsLinkKind } : {},
    ...dataset.analyticsInstallMethod ? { install_method: dataset.analyticsInstallMethod } : {}
  };
  if (typeof HTMLAnchorElement !== "undefined" && element instanceof HTMLAnchorElement) {
    try {
      const base = typeof window === "undefined" ? `https://${site.canonicalDomain}` : window.location.href;
      const targetUrl = new URL(element.href, base);
      if (targetUrl.protocol === "http:" || targetUrl.protocol === "https:") {
        const targetHost = normalizeAnalyticsHostname(targetUrl.hostname);
        rawProperties.target_host = targetHost.replace(/^www\./u, "");
        if (isAllowedAnalyticsHost(site, targetHost)) {
          const route = classifyAnalyticsRoute(site, targetUrl);
          if (route) {
            rawProperties.target_path = route.canonical_path;
          }
        }
      }
    } catch {}
  }
  return {
    eventName,
    properties: normalizeAnalyticsProperties(rawProperties)
  };
}
function currentBrowserEvidence() {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  return {
    hostname: window.location.hostname,
    href: window.location.href,
    referrer: document.referrer,
    production: typeof process !== "undefined" && process.env["NODE_ENV"] === "production"
  };
}
function liveRouteAllowed(site) {
  const href = typeof window === "undefined" || typeof window.location === "undefined" ? undefined : window.location.href;
  return href === undefined || classifyAnalyticsRoute(site, href) !== null;
}
function isPostHogBrowserEligible(options) {
  const evidence = options.evidence ?? currentBrowserEvidence();
  return Boolean(!browserDoNotTrackEnabled() && evidence?.production && options.apiKey?.startsWith("phc_") && isAllowedAnalyticsHost(options.site, evidence.hostname) && classifyAnalyticsRoute(options.site, evidence.href) !== null && liveRouteAllowed(options.site));
}
function allowedEvent(site, eventName) {
  return BUILT_IN_EVENTS.has(eventName) || isAllowedCustomEvent(site, eventName);
}
function createPostHogBeforeSend(site, resolveEvidence) {
  let sensitiveAttributionSeen = false;
  return (capture) => {
    if (browserDoNotTrackEnabled())
      return null;
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
function createPostHogBrowserConfig(site, evidence, apiHost = DEFAULT_API_HOST) {
  const beforeSend = createPostHogBeforeSend(site, () => evidence);
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
    request_batching: false,
    cross_subdomain_cookie: false,
    disableDeviceModel: true,
    disable_capture_url_hashes: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: site.privacyMode === "minimal",
    ...site.privacyMode === "minimal" ? {
      custom_personal_data_properties: ["email", "token", "code", "key", "secret"]
    } : {},
    properties_string_max_length: 2048,
    internal_or_test_user_hostname: null,
    rate_limiting: {
      events_per_second: 2,
      events_burst_limit: 12
    },
    before_send: (capture) => getBrowserConsent()?.allowed() === true ? beforeSend(capture) : null
  };
}
function initializePostHogBrowser(options) {
  if (!isPostHogBrowserEligible(options)) {
    return false;
  }
  const consent = getBrowserConsent();
  consent?.start();
  if (!consent?.allowed() || !installConsentTransport(posthog, consent))
    return false;
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
function observePostHogBrowser(options, ready) {
  if (!isPostHogBrowserEligible(options))
    return () => {};
  let cleanup;
  let started = false;
  const removeConsent = getBrowserConsent()?.subscribe(() => {
    if (initializePostHogBrowser(options)) {
      if (!started) {
        started = true;
        cleanup = ready();
      }
    } else {
      cleanup?.();
      cleanup = undefined;
      started = false;
    }
  });
  return () => {
    removeConsent?.();
    cleanup?.();
  };
}
function capturePostHogEvent(site, eventName, properties = {}, options = {}) {
  if (getBrowserConsent()?.allowed() !== true || !liveRouteAllowed(site) || activeSiteId !== site.id || !isAllowedCustomEvent(site, eventName)) {
    return false;
  }
  if (options.href !== undefined && !classifyAnalyticsRoute(site, options.href)) {
    return false;
  }
  if (options.uuid !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(options.uuid))
    return false;
  posthog.capture(eventName, {
    ...normalizeAnalyticsProperties(properties),
    ...options.href ? { $current_url: options.href } : {}
  }, {
    ...options.uuid ? { uuid: options.uuid } : {},
    ...options.transport ? { transport: options.transport } : {},
    ...options.transport === "sendBeacon" ? { send_instantly: true } : options.send_instantly !== undefined ? { send_instantly: options.send_instantly } : {}
  });
  return true;
}
function capturePostHogException(site, value, properties = {}) {
  if (getBrowserConsent()?.allowed() !== true || !liveRouteAllowed(site) || activeSiteId !== site.id) {
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
    error_surface: "client"
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
function installPostHogOutboundCapture(site) {
  if (!isAllowedCustomEvent(site, STANDARD_ANALYTICS_EVENTS.outboundLinkOpened))
    return () => {};
  const onClick = (event) => {
    if (event.button !== 0 || event.defaultPrevented || !(event.target instanceof Element))
      return;
    const anchor = event.target.closest("a[href]");
    if (!anchor || anchor.getAttribute("data-analytics-event") === STANDARD_ANALYTICS_EVENTS.outboundLinkOpened)
      return;
    try {
      const url = new URL(anchor.getAttribute("href") ?? "", window.location.href);
      if (!/^https?:$/u.test(url.protocol) || isAllowedAnalyticsHost(site, url.hostname))
        return;
      const region = anchor.closest("header, footer, [data-hraness-marketing]");
      const name = region?.getAttribute("data-hraness-marketing") ?? region?.tagName.toLowerCase();
      const placement = name === "hero" ? "hero" : name === "header" ? "nav" : name === "footer" ? "footer" : "inline";
      capturePostHogOutboundLinkOpened(site, { targetHost: url.hostname, placement });
    } catch {}
  };
  document.addEventListener("click", onClick);
  return () => {
    document.removeEventListener("click", onClick);
  };
}
function currentPathname() {
  return typeof window === "undefined" ? null : window.location.pathname;
}
function currentReferrer() {
  return typeof document === "undefined" ? "" : document.referrer;
}
function capturePostHogPageNotFound(site, input = {}) {
  if (getBrowserConsent()?.allowed() !== true || !liveRouteAllowed(site) || activeSiteId !== site.id) {
    return false;
  }
  const requestedPath = input.requestedPath ?? currentPathname();
  if (requestedPath === null)
    return false;
  let requestedRoute;
  try {
    requestedRoute = classifyAnalyticsRoute(site, new URL(requestedPath, `https://${site.canonicalDomain}`).href);
  } catch {
    return false;
  }
  if (!requestedRoute)
    return false;
  const properties = pageNotFoundProperties({
    requestedPath: requestedRoute.canonical_path,
    referrer: input.referrer ?? currentReferrer()
  });
  if (!properties) {
    return false;
  }
  posthog.capture(STANDARD_ANALYTICS_EVENTS.pageNotFound, properties);
  return true;
}
function captureStandardEvent(site, eventName, properties) {
  return properties !== null && capturePostHogEvent(site, eventName, properties);
}
function capturePostHogCtaClicked(site, input) {
  return captureStandardEvent(site, STANDARD_ANALYTICS_EVENTS.ctaClicked, ctaClickedProperties(input));
}
function capturePostHogOutboundLinkOpened(site, input) {
  return captureStandardEvent(site, STANDARD_ANALYTICS_EVENTS.outboundLinkOpened, outboundLinkOpenedProperties(input));
}
function capturePostHogInstallCommandCopied(site, input) {
  return captureStandardEvent(site, STANDARD_ANALYTICS_EVENTS.installCommandCopied, installCommandCopiedProperties(input));
}
export {
  readDelegatedAnalyticsEvent,
  observePostHogBrowser,
  isPostHogBrowserEligible,
  installPostHogOutboundCapture,
  installPostHogExceptionCapture,
  installDelegatedPostHogCapture,
  initializePostHogBrowser,
  createPostHogBrowserConfig,
  createPostHogBeforeSend,
  capturePostHogPageNotFound,
  capturePostHogOutboundLinkOpened,
  capturePostHogInstallCommandCopied,
  capturePostHogException,
  capturePostHogEvent,
  capturePostHogCtaClicked
};

//# debugId=34628DED295DA66164756E2164756E21
