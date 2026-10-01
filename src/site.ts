import { redactSensitiveText } from "./redaction.js";

export const POSTHOG_SCHEMA_VERSION = 2 as const;

const MAX_PATH_LENGTH = 512;
const MAX_SLUG_LENGTH = 160;

export type AnalyticsRouteRule = Readonly<{
  match: "exact" | "prefix";
  path: string;
  pageKind: string;
  contentGroup?: string;
  captureSlug?: boolean;
}>;

export type AnalyticsPathRule = Readonly<{
  match: "exact" | "prefix";
  path: string;
}>;

export type PostHogSiteDefinition = Readonly<{
  id: string;
  canonicalDomain: string;
  allowedHosts: readonly string[];
  schemaVersion: number;
  routes: readonly AnalyticsRouteRule[];
  customEvents: readonly string[];
  delegatedEvents?: readonly string[];
  /** Remove all campaign attribution and keep every referrer at origin scope. */
  privacyMode?: "minimal" | "standard";
  /** If present, only these routes may send events. An empty list disables every route. */
  allowedPaths?: readonly AnalyticsPathRule[];
  /** Routes that never send events. Exclusion wins over allowedPaths. */
  excludedPaths?: readonly AnalyticsPathRule[];
  /**
   * Routes whose whole query, campaign attribution included, is removed before
   * delivery: sign-in, auth callbacks, account, billing and checkout returns,
   * invite links, and any user-owned or private route.
   */
  sensitivePaths?: readonly AnalyticsPathRule[];
  /** Referrer-only sites discard all campaign queries and properties, including traffic classification. */
  attributionMode?: "campaign" | "referrer_only";
  /**
   * @deprecated Since 0.3.0 the query is always reduced to the campaign
   * attribution keep-list (`utm_*` and ad click IDs), so this option has no
   * effect. Use `sensitivePaths` to drop attribution on private routes.
   */
  stripQueryAttribution?: boolean;
  unknownCanonicalPath?: string;
}>;

export type AnalyticsRouteContext = Readonly<{
  analytics_schema_version: number;
  site_id: string;
  canonical_domain: string;
  canonical_path: string;
  page_kind: string;
  content_group?: string;
  content_slug?: string;
}>;

export type AnalyticsLocation = Readonly<{
  hostname: string;
  pathname: string;
}>;

export function normalizeAnalyticsHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
}

export function normalizeAnalyticsPathname(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/u, 1)[0] ?? "/";
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/gu, "/");
  const withoutTrailingSlash = collapsed.length > 1 ? collapsed.replace(/\/$/u, "") : collapsed;
  return withoutTrailingSlash.slice(0, MAX_PATH_LENGTH) || "/";
}

export function isAllowedAnalyticsHost(
  site: PostHogSiteDefinition,
  hostname: string,
): boolean {
  const normalized = normalizeAnalyticsHostname(hostname);
  return site.allowedHosts.some((candidate) => normalizeAnalyticsHostname(candidate) === normalized);
}

export function parseAnalyticsLocation(
  site: PostHogSiteDefinition,
  value: string | URL | AnalyticsLocation,
): AnalyticsLocation | null {
  if (typeof value === "object" && !(value instanceof URL)) {
    if (!isAllowedAnalyticsHost(site, value.hostname)) {
      return null;
    }
    return {
      hostname: normalizeAnalyticsHostname(value.hostname),
      pathname: normalizeAnalyticsPathname(value.pathname),
    };
  }

  try {
    const parsed = value instanceof URL
      ? value
      : new URL(value, `https://${site.canonicalDomain}`);
    if (!isAllowedAnalyticsHost(site, parsed.hostname)) {
      return null;
    }
    return {
      hostname: normalizeAnalyticsHostname(parsed.hostname),
      pathname: normalizeAnalyticsPathname(parsed.pathname),
    };
  } catch {
    return null;
  }
}

function ruleMatches(rule: AnalyticsPathRule, pathname: string): boolean {
  const rulePath = normalizeAnalyticsPathname(rule.path);
  if (rule.match === "exact") {
    return pathname === rulePath;
  }
  return rulePath === "/" || pathname === rulePath || pathname.startsWith(`${rulePath}/`);
}

function policyPathname(pathname: string): string | null {
  try {
    return normalizeAnalyticsPathname(decodeURIComponent(normalizeAnalyticsPathname(pathname)));
  } catch {
    return null;
  }
}

/** Segment-aware route permission, checked independently from route classification. */
export function isAllowedAnalyticsPath(site: PostHogSiteDefinition, pathname: string): boolean {
  const normalized = policyPathname(pathname);
  if (normalized === null) return false;
  return !site.excludedPaths?.some(rule => ruleMatches(rule, normalized))
    && (site.allowedPaths === undefined || site.allowedPaths.some(rule => ruleMatches(rule, normalized)));
}

function slugForRule(rule: AnalyticsRouteRule, pathname: string): string | undefined {
  if (!rule.captureSlug) {
    return undefined;
  }
  const rulePath = normalizeAnalyticsPathname(rule.path);
  const relative = pathname.slice(rulePath.length).replace(/^\/+|\/+$/gu, "");
  return relative ? relative.slice(0, MAX_SLUG_LENGTH) : undefined;
}

export function classifyAnalyticsRoute(
  site: PostHogSiteDefinition,
  location: string | URL | AnalyticsLocation,
): AnalyticsRouteContext | null {
  const parsed = parseAnalyticsLocation(site, location);
  if (!parsed || !isAllowedAnalyticsPath(site, parsed.pathname)) {
    return null;
  }

  const rule = site.routes.find((candidate) => ruleMatches(candidate, parsed.pathname));
  // Eligibility and rule selection use the original location; emitted paths
  // redact before length caps so a clipped identifier cannot evade matching.
  const rawPathname = typeof location === "object" && !(location instanceof URL)
    ? location.pathname
    : (location instanceof URL ? location : new URL(location, `https://${site.canonicalDomain}`)).pathname;
  const emittedPath = normalizeAnalyticsPathname(redactSensitiveText(rawPathname));
  const contentSlug = rule ? slugForRule(rule, emittedPath) : undefined;
  return {
    analytics_schema_version: site.schemaVersion,
    site_id: site.id,
    canonical_domain: normalizeAnalyticsHostname(site.canonicalDomain),
    canonical_path: redactSensitiveText(rule === undefined && site.unknownCanonicalPath !== undefined
      ? normalizeAnalyticsPathname(redactSensitiveText(site.unknownCanonicalPath))
      : emittedPath),
    page_kind: rule?.pageKind ?? "other",
    ...(rule?.contentGroup ? { content_group: rule.contentGroup } : {}),
    ...(contentSlug ? { content_slug: redactSensitiveText(contentSlug) } : {}),
  };
}

export function canonicalAnalyticsUrl(
  site: PostHogSiteDefinition,
  pathname: string,
): string {
  return `https://${normalizeAnalyticsHostname(site.canonicalDomain)}${normalizeAnalyticsPathname(redactSensitiveText(pathname))}`;
}

export function isAllowedCustomEvent(
  site: PostHogSiteDefinition,
  eventName: string,
): boolean {
  return site.customEvents.includes(eventName);
}

export function isAllowedDelegatedEvent(
  site: PostHogSiteDefinition,
  eventName: string,
): boolean {
  return site.delegatedEvents?.includes(eventName) ?? false;
}

export function isSensitiveAnalyticsPath(
  site: PostHogSiteDefinition,
  pathname: string,
): boolean {
  const normalized = policyPathname(pathname);
  if (normalized === null) return true;
  return site.sensitivePaths?.some((rule) => ruleMatches(rule, normalized)) ?? false;
}
