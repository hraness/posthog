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
  const domain = /@[\p{L}\p{N}\p{M}.-]+\.[\p{L}\p{M}]{2,}/uy;
  let previousAt = -1;
  let previousEnd = 0;
  for (let at = value.indexOf("@");at >= 0; at = value.indexOf("@", at + 1)) {
    let start = at;
    const floor = Math.max(previousAt + 1, previousEnd);
    while (start > floor) {
      const unit = value.charCodeAt(start - 1);
      const width = unit >= 56320 && unit <= 57343 && start - 2 >= floor ? 2 : 1;
      if (!/^[\p{L}\p{N}\p{M}._%+-]+$/u.test(value.slice(start - width, start)))
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

//# debugId=8CF3195DAB22124664756E2164756E21
