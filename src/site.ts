export const POSTHOG_SCHEMA_VERSION = 1 as const;

const MAX_PATH_LENGTH = 512;
const MAX_SLUG_LENGTH = 160;

export type AnalyticsRouteRule = Readonly<{
  match: "exact" | "prefix";
  path: string;
  pageKind: string;
  contentGroup?: string;
  captureSlug?: boolean;
}>;

export type PostHogSiteDefinition = Readonly<{
  id: string;
  canonicalDomain: string;
  allowedHosts: readonly string[];
  schemaVersion: number;
  routes: readonly AnalyticsRouteRule[];
  customEvents: readonly string[];
  delegatedEvents?: readonly string[];
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
  const withoutTrailingSlash = collapsed.length > 1 ? collapsed.replace(/\/+$/u, "") : collapsed;
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

function ruleMatches(rule: AnalyticsRouteRule, pathname: string): boolean {
  const rulePath = normalizeAnalyticsPathname(rule.path);
  if (rule.match === "exact") {
    return pathname === rulePath;
  }
  return pathname === rulePath || pathname.startsWith(`${rulePath}/`);
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
  if (!parsed) {
    return null;
  }

  const rule = site.routes.find((candidate) => ruleMatches(candidate, parsed.pathname));
  const contentSlug = rule ? slugForRule(rule, parsed.pathname) : undefined;
  return {
    analytics_schema_version: site.schemaVersion,
    site_id: site.id,
    canonical_domain: normalizeAnalyticsHostname(site.canonicalDomain),
    canonical_path: rule === undefined && site.unknownCanonicalPath !== undefined
      ? normalizeAnalyticsPathname(site.unknownCanonicalPath)
      : parsed.pathname,
    page_kind: rule?.pageKind ?? "other",
    ...(rule?.contentGroup ? { content_group: rule.contentGroup } : {}),
    ...(contentSlug ? { content_slug: contentSlug } : {}),
  };
}

export function canonicalAnalyticsUrl(
  site: PostHogSiteDefinition,
  pathname: string,
): string {
  return `https://${normalizeAnalyticsHostname(site.canonicalDomain)}${normalizeAnalyticsPathname(pathname)}`;
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
