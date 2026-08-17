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
export {
  classifyAnalyticsTraffic
};

//# debugId=272D1DB3BED3A0F564756E2164756E21
