import {
  canonicalAnalyticsUrl,
  classifyAnalyticsRoute,
  isAllowedAnalyticsHost,
  isAllowedDelegatedEvent,
  normalizeAnalyticsPathname,
  type PostHogSiteDefinition,
} from "./site";

const MAX_PROPERTY_COUNT = 32;
const MAX_PROPERTY_KEY_LENGTH = 64;
const MAX_PROPERTY_STRING_LENGTH = 256;
const MAX_PROPERTY_ARRAY_LENGTH = 20;
const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_ERROR_STACK_LENGTH = 6_000;
const MAX_PROVIDER_PROPERTY_STRING_LENGTH = 2_048;

export type AnalyticsPrimitive = string | number | boolean | null;
export type AnalyticsPropertyValue = AnalyticsPrimitive | readonly AnalyticsPrimitive[];
export type AnalyticsProperties = Readonly<Record<string, AnalyticsPropertyValue>>;

const CURRENT_URL_KEYS = new Set([
  "$current_url",
  "$initial_current_url",
  "$session_entry_url",
  "current_url",
  "url",
  "href",
  "url.full",
]);

const QUERY_ATTRIBUTION_PROPERTY_NAMES = new Set([
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
  "wbraid",
]);

const REFERRER_URL_KEYS = new Set([
  "$referrer",
  "$initial_referrer",
  "referrer",
]);

function normalizedProviderPropertyName(key: string): string {
  return key.toLowerCase()
    .replace(/^\$/u, "")
    .replace(/^(?:initial|session_entry)_/u, "");
}

function isProviderPathnameKey(key: string): boolean {
  return /^(?:\$)?(?:(?:initial|session_entry|prev_pageview)_)?pathname$/u.test(
    key.toLowerCase(),
  );
}

function isQueryAttributionKey(key: string): boolean {
  return QUERY_ATTRIBUTION_PROPERTY_NAMES.has(
    normalizedProviderPropertyName(key),
  );
}

function cleanPropertyString(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, MAX_PROPERTY_STRING_LENGTH);
}

function normalizePrimitive(value: unknown): AnalyticsPrimitive | undefined {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return cleanPropertyString(value);
  }
  return undefined;
}

function normalizePropertyValue(value: unknown): AnalyticsPropertyValue | undefined {
  const primitive = normalizePrimitive(value);
  if (primitive !== undefined) {
    return primitive;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .slice(0, MAX_PROPERTY_ARRAY_LENGTH)
    .map(normalizePrimitive)
    .filter((item): item is AnalyticsPrimitive => item !== undefined);
  return normalized;
}

export function normalizeAnalyticsProperties(value: unknown): AnalyticsProperties {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, AnalyticsPropertyValue> = {};
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

function sanitizeThirdPartyUrl(value: string, originOnly: boolean): string {
  try {
    const parsed = new URL(value);
    return originOnly ? parsed.origin : `${parsed.origin}${normalizeAnalyticsPathname(parsed.pathname)}`;
  } catch {
    return "";
  }
}

function sanitizeUrlValue(
  site: PostHogSiteDefinition,
  key: string,
  value: string,
): string {
  if (REFERRER_URL_KEYS.has(key)) {
    return sanitizeThirdPartyUrl(value, true);
  }
  if (isProviderPathnameKey(key)) {
    try {
      const parsed = new URL(value, `https://${site.canonicalDomain}`);
      if (!isAllowedAnalyticsHost(site, parsed.hostname)) return "";
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

function sanitizeProviderValue(
  site: PostHogSiteDefinition,
  key: string,
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (site.stripQueryAttribution === true && isQueryAttributionKey(key)) {
    return undefined;
  }
  if (typeof value === "string") {
    return redactSensitiveText(sanitizeUrlValue(site, key, value))
      .slice(0, MAX_PROVIDER_PROPERTY_STRING_LENGTH);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (depth >= 5 || !value || typeof value !== "object") {
    return undefined;
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderValue(site, key, item, depth + 1, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    const safeValue = sanitizeProviderValue(site, nestedKey, nestedValue, depth + 1, seen);
    if (safeValue !== undefined) {
      result[nestedKey] = safeValue;
    }
  }
  return result;
}

export function sanitizeProviderProperties(
  site: PostHogSiteDefinition,
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const safeValue = sanitizeProviderValue(site, key, value, 0, seen);
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }
  return sanitized;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:phc|phx|phs|pha|phr)_[A-Za-z0-9_-]+\b/gu, "[credential]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu, "Bearer [credential]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[credential]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
    .replace(/(https?:\/\/[^\s?#)]+)(?:\?[^\s#)]*)?(?:#[^\s)]*)?/giu, "$1")
    .replace(/([/][^\s?#)]+)\?[^\s#)]*/gu, "$1")
    .replace(/\b(api[_-]?key|access[_-]?token|auth(?:orization)?|secret|password)=([^\s&]+)/giu, "$1=[redacted]");
}

export function sanitizeAnalyticsError(value: unknown): Error {
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

export function analyticsErrorFingerprint(error: Error): string {
  const stackFrame = error.stack?.split("\n").slice(1, 3).join("\n") ?? "";
  const input = `${error.name}\n${error.message}\n${stackFrame}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `e_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export class ExceptionBudget {
  readonly #totalLimit: number;
  readonly #perFingerprintLimit: number;
  readonly #windowMs: number;
  #all: number[] = [];
  #byFingerprint = new Map<string, number[]>();

  constructor(options: Readonly<{
    totalLimit: number;
    perFingerprintLimit: number;
    windowMs: number;
  }>) {
    this.#totalLimit = options.totalLimit;
    this.#perFingerprintLimit = options.perFingerprintLimit;
    this.#windowMs = options.windowMs;
  }

  allow(fingerprint: string, now = Date.now()): boolean {
    const threshold = now - this.#windowMs;
    this.#all = this.#all.filter((timestamp) => timestamp > threshold);
    const matching = (this.#byFingerprint.get(fingerprint) ?? [])
      .filter((timestamp) => timestamp > threshold);
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

export type DelegatedAnalyticsEvent = Readonly<{
  eventName: string;
  properties: AnalyticsProperties;
}>;

export function readDelegatedAnalyticsEvent(
  site: PostHogSiteDefinition,
  target: EventTarget | null,
): DelegatedAnalyticsEvent | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const element = target.closest<HTMLElement>("[data-analytics-event]");
  const eventName = element?.dataset.analyticsEvent?.trim();
  if (!element || !eventName || !isAllowedDelegatedEvent(site, eventName)) {
    return null;
  }

  const properties: Record<string, AnalyticsPropertyValue> = {};
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
    } catch {
      // A malformed or non-HTTP href simply contributes no target properties.
    }
  }
  return { eventName, properties };
}
