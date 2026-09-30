// src/site.ts
var POSTHOG_SCHEMA_VERSION = 2;
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
function isAllowedDelegatedEvent(site, eventName) {
  return site.delegatedEvents?.includes(eventName) ?? false;
}
function isSensitiveAnalyticsPath(site, pathname) {
  const normalized = policyPathname(pathname);
  if (normalized === null)
    return true;
  return site.sensitivePaths?.some((rule) => ruleMatches(rule, normalized)) ?? false;
}
export {
  parseAnalyticsLocation,
  normalizeAnalyticsPathname,
  normalizeAnalyticsHostname,
  isSensitiveAnalyticsPath,
  isAllowedDelegatedEvent,
  isAllowedCustomEvent,
  isAllowedAnalyticsPath,
  isAllowedAnalyticsHost,
  classifyAnalyticsRoute,
  canonicalAnalyticsUrl,
  POSTHOG_SCHEMA_VERSION
};

//# debugId=703C1EA99D3E20ED64756E2164756E21
