import { redactSensitiveText } from "./redaction.js";
export { redactSensitiveText } from "./redaction.js";

import {
  canonicalAnalyticsUrl,
  classifyAnalyticsRoute,
  isAllowedAnalyticsHost,
  isSensitiveAnalyticsPath,
  normalizeAnalyticsPathname,
  type PostHogSiteDefinition,
} from "./site.js";

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

/**
 * Campaign parameters kept as event properties and as the only query
 * parameters of an owned `$current_url` (portfolio observability standard,
 * version 2). Everything else in a query is removed.
 */
export const ANALYTICS_ATTRIBUTION_PARAMETERS = [
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
  "mc_cid",
] as const;

const ATTRIBUTION_PARAMETER_NAMES: ReadonlySet<string> = new Set(ANALYTICS_ATTRIBUTION_PARAMETERS);

// Provider attribution outside the keep-list. Klaviyo `_kx` can identify a
// person; `ph_keyword` copies private search text out of a referrer's query.
// URL redaction alone does not remove these separately derived properties.
const DROPPED_CAMPAIGN_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  "_kx",
  "campaign_params",
  "gclsrc",
  "ph_keyword",
  "qclid",
  "ref",
]);

// posthog-js masks these names when `mask_personal_data_properties` is on.
// That flag also masks ad click IDs, so the package turns it off and redacts
// the same names here instead.
const PERSONAL_DATA_PROPERTY_NAMES: ReadonlySet<string> = new Set([
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
  "authorization",
]);

// Provider identity and transport values the cookieless hash, sessions, and
// device breakdowns depend on. They pass through without text redaction.
const PASSTHROUGH_PROPERTY_NAMES: ReadonlySet<string> = new Set([
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
  "distinct_id",
]);

const REFERRER_URL_KEYS = new Set([
  "$referrer",
  "$initial_referrer",
  "$session_entry_referrer",
  "referrer",
]);

const DIRECT_REFERRER = "$direct";

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

export function isAnalyticsAttributionProperty(key: string): boolean {
  return ATTRIBUTION_PARAMETER_NAMES.has(normalizedProviderPropertyName(key));
}

function isDroppedCampaignProperty(key: string): boolean {
  return DROPPED_CAMPAIGN_PROPERTY_NAMES.has(normalizedProviderPropertyName(key));
}

function isPersonalDataProperty(key: string): boolean {
  return PERSONAL_DATA_PROPERTY_NAMES.has(normalizedProviderPropertyName(key).replace(/-/gu, "_"));
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
    return cleanPropertyString(redactSensitiveText(value));
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

function attributionValue(value: string): string {
  return cleanPropertyString(redactSensitiveText(value));
}

/**
 * Returns `?name=value` for the keep-listed campaign parameters of `url`, in
 * keep-list order, or an empty string. Sensitive paths never keep a query.
 */
export function analyticsAttributionQuery(
  site: PostHogSiteDefinition,
  url: URL,
): string {
  if (site.privacyMode === "minimal" || site.attributionMode === "referrer_only" || isSensitiveAnalyticsPath(site, url.pathname)) {
    return "";
  }
  const kept = new URLSearchParams();
  for (const name of ANALYTICS_ATTRIBUTION_PARAMETERS) {
    const value = url.searchParams.get(name);
    if (value) {
      const safe = attributionValue(value);
      if (safe) kept.set(name, safe);
    }
  }
  const query = kept.toString();
  return query ? `?${query}` : "";
}

function ownedCanonicalUrl(site: PostHogSiteDefinition, parsed: URL): string {
  const route = classifyAnalyticsRoute(site, parsed);
  return redactSensitiveText(canonicalAnalyticsUrl(site, route?.canonical_path ?? "/"));
}

type ProviderUrlResult = Readonly<{ handled: false }> | Readonly<{ handled: true; value: string }>;

function sanitizeUrlValue(
  site: PostHogSiteDefinition,
  key: string,
  value: string,
  stripAttribution: boolean,
): ProviderUrlResult {
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
      if (!isAllowedAnalyticsHost(site, parsed.hostname)) return { handled: true, value: "" };
      return {
        handled: true,
        value: redactSensitiveText(classifyAnalyticsRoute(site, parsed)?.canonical_path ?? "/"),
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
      value: `${ownedCanonicalUrl(site, parsed)}${stripAttribution ? "" : analyticsAttributionQuery(site, parsed)}`,
    };
  } catch {
    return { handled: true, value: "" };
  }
}

type SanitizeContext = Readonly<{
  site: PostHogSiteDefinition;
  sensitive: boolean;
  seen: WeakSet<object>;
}>;

function sanitizeProviderValue(
  context: SanitizeContext,
  key: string,
  value: unknown,
  depth: number,
): unknown {
  const { site } = context;
  if (isDroppedCampaignProperty(key)) {
    return undefined;
  }
  if (isAnalyticsAttributionProperty(key)) {
    if (context.sensitive || typeof value !== "string") {
      return undefined;
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
    return (url.handled ? url.value : redactSensitiveText(value))
      .slice(0, MAX_PROVIDER_PROPERTY_STRING_LENGTH);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (depth >= 5 || !value || typeof value !== "object") {
    return undefined;
  }
  if (context.seen.has(value)) {
    return undefined;
  }
  context.seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderValue(context, key, item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    const safeValue = sanitizeProviderValue(context, nestedKey, nestedValue, depth + 1);
    if (safeValue !== undefined) {
      result[nestedKey] = safeValue;
    }
  }
  return result;
}

function isSensitiveProviderLocation(
  site: PostHogSiteDefinition,
  currentUrl: unknown,
): boolean {
  if (typeof currentUrl !== "string") {
    return false;
  }
  try {
    return isSensitiveAnalyticsPath(
      site,
      new URL(currentUrl, `https://${site.canonicalDomain}`).pathname,
    );
  } catch {
    return false;
  }
}

/**
 * Scrubs a provider-shaped property object without rebuilding it from a short
 * allowlist: identity, session, device, and campaign properties survive, while
 * queries, fragments, emails, credentials, and personal-data names do not.
 * `currentUrl` decides whether campaign properties belong to a sensitive path;
 * it defaults to the object's own `$current_url`.
 */
export function sanitizeProviderProperties(
  site: PostHogSiteDefinition,
  properties: Readonly<Record<string, unknown>>,
  currentUrl: unknown = properties["$current_url"],
  stripAttribution = false,
): Record<string, unknown> {
  const context: SanitizeContext = {
    site,
    sensitive: site.privacyMode === "minimal" || site.attributionMode === "referrer_only" || stripAttribution || isSensitiveProviderLocation(site, currentUrl),
    seen: new WeakSet<object>(),
  };
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const safeValue = sanitizeProviderValue(context, key, value, 0);
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }
  return sanitized;
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

  get activeFingerprintCount(): number {
    return this.#byFingerprint.size;
  }

  allow(fingerprint: string, now = Date.now()): boolean {
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

/** Standard placements for `cta clicked`, `outbound link opened`, and friends. */
export const ANALYTICS_PLACEMENTS = [
  "hero",
  "nav",
  "footer",
  "inline",
  "pricing",
  "docs",
  "modal",
  "sticky",
  "not_found",
] as const;
export type AnalyticsPlacement = (typeof ANALYTICS_PLACEMENTS)[number];

export const ANALYTICS_INSTALL_METHODS = [
  "brew",
  "curl",
  "npm",
  "bun",
  "pip",
  "go",
  "cargo",
  "other",
] as const;
export type AnalyticsInstallMethod = (typeof ANALYTICS_INSTALL_METHODS)[number];

export const ANALYTICS_LINK_KINDS = ["github", "docs", "social", "portfolio", "other"] as const;
export type AnalyticsLinkKind = (typeof ANALYTICS_LINK_KINDS)[number];

/** Event names defined by the portfolio observability standard, version 2. */
export const STANDARD_ANALYTICS_EVENTS = {
  pageNotFound: "page not found",
  ctaClicked: "cta clicked",
  outboundLinkOpened: "outbound link opened",
  installCommandCopied: "install command copied",
  downloadStarted: "download started",
  emailSignupViewed: "email signup viewed",
  emailSignupSubmitted: "email signup submitted",
  emailSignupRequestAccepted: "email signup request accepted",
  checkoutStarted: "checkout started",
  purchaseCompleted: "purchase completed",
} as const;

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?: [a-z0-9]+)*$/u;
const SNAKE_CASE_ID_PATTERN = /^[a-z][a-z0-9_]*$/u;
const MAX_EVENT_NAME_LENGTH = 64;

/** True when a custom event name follows the lowercase `object verb` naming rule. */
export function isStandardAnalyticsEventName(eventName: string): boolean {
  return eventName.length <= MAX_EVENT_NAME_LENGTH && EVENT_NAME_PATTERN.test(eventName);
}

function snakeCaseId(value: unknown): string | null {
  return typeof value === "string"
    && value.length <= MAX_PROPERTY_KEY_LENGTH
    && SNAKE_CASE_ID_PATTERN.test(value)
    ? value
    : null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? value as T
    : null;
}

function hostOf(value: unknown): string | null {
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

/**
 * Properties for `page not found`: the normalized requested path with no query
 * or fragment (256 characters max, emails and credentials redacted) and the
 * referrer host. Returns `null` for input that cannot form a path.
 */
export function pageNotFoundProperties(
  input: Readonly<{ requestedPath: unknown; referrer?: unknown }>,
): AnalyticsProperties | null {
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
  const requestedPath = cleanPropertyString(
    normalizeAnalyticsPathname(redactSensitiveText(pathname)),
  );
  const referrerHost = input.referrer === "$direct" ? null : hostOf(input.referrer);
  return {
    requested_path: requestedPath || "/",
    ...(referrerHost ? { referrer_host: referrerHost } : {}),
  };
}

/** Properties for `cta clicked`; `null` unless `cta` is a snake_case ID and `placement` is standard. */
export function ctaClickedProperties(
  input: Readonly<{ cta: unknown; placement: unknown; targetHost?: unknown }>,
): AnalyticsProperties | null {
  const cta = snakeCaseId(input.cta);
  const placement = oneOf(ANALYTICS_PLACEMENTS, input.placement);
  if (!cta || !placement) {
    return null;
  }
  const targetHost = hostOf(input.targetHost);
  return { cta, placement, ...(targetHost ? { target_host: targetHost } : {}) };
}

/** Properties for `outbound link opened`; `null` without a valid host and standard placement. */
export function outboundLinkOpenedProperties(
  input: Readonly<{ targetHost: unknown; placement: unknown; linkKind?: unknown }>,
): AnalyticsProperties | null {
  const targetHost = hostOf(input.targetHost);
  const placement = oneOf(ANALYTICS_PLACEMENTS, input.placement);
  if (!targetHost || !placement) {
    return null;
  }
  const linkKind = input.linkKind === undefined ? null : oneOf(ANALYTICS_LINK_KINDS, input.linkKind);
  if (input.linkKind !== undefined && !linkKind) {
    return null;
  }
  return { target_host: targetHost, placement, ...(linkKind ? { link_kind: linkKind } : {}) };
}

/** Properties for `install command copied`; never the raw command text. */
export function installCommandCopiedProperties(
  input: Readonly<{ installMethod: unknown; placement: unknown }>,
): AnalyticsProperties | null {
  const installMethod = oneOf(ANALYTICS_INSTALL_METHODS, input.installMethod);
  const placement = oneOf(ANALYTICS_PLACEMENTS, input.placement);
  return installMethod && placement ? { install_method: installMethod, placement } : null;
}
