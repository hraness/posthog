import {
  isAllowedAnalyticsHost,
  normalizeAnalyticsHostname,
  type PostHogSiteDefinition,
} from "./site";

export type AnalyticsTrafficChannel =
  | "direct"
  | "internal"
  | "organic_search"
  | "ai_referral"
  | "social"
  | "referral";

export type AnalyticsTrafficContext = Readonly<{
  traffic_channel: AnalyticsTrafficChannel;
  traffic_source: string;
  referrer_host?: string;
}>;

const AI_SOURCES = [
  ["chatgpt", ["chatgpt.com", "chat.openai.com"]],
  ["perplexity", ["perplexity.ai"]],
  ["claude", ["claude.ai"]],
  ["gemini", ["gemini.google.com"]],
  ["copilot", ["copilot.microsoft.com"]],
  ["poe", ["poe.com"]],
  ["you.com", ["you.com"]],
  ["meta_ai", ["meta.ai"]],
] as const;

const SEARCH_SOURCES = [
  ["google", ["google.com", "google.co.uk", "google.ca", "google.com.au"]],
  ["bing", ["bing.com"]],
  ["duckduckgo", ["duckduckgo.com"]],
  ["yahoo", ["search.yahoo.com", "yahoo.com"]],
  ["brave", ["search.brave.com"]],
  ["ecosia", ["ecosia.org"]],
  ["baidu", ["baidu.com"]],
  ["yandex", ["yandex.com", "yandex.ru"]],
] as const;

const SOCIAL_SOURCES = [
  ["reddit", ["reddit.com"]],
  ["x", ["x.com", "twitter.com", "t.co"]],
  ["linkedin", ["linkedin.com"]],
  ["facebook", ["facebook.com", "fb.com"]],
  ["instagram", ["instagram.com"]],
  ["youtube", ["youtube.com", "youtu.be"]],
  ["mastodon", ["mastodon.social"]],
  ["threads", ["threads.net"]],
] as const;

function hostnameMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function sourceForHostname(
  hostname: string,
  sources: readonly (readonly [string, readonly string[]])[],
): string | null {
  for (const [source, domains] of sources) {
    if (domains.some((domain) => hostnameMatches(hostname, domain))) {
      return source;
    }
  }
  return null;
}

function sourceForAttribution(
  value: string,
  sources: readonly (readonly [string, readonly string[]])[],
): string | null {
  const normalized = value.trim().toLowerCase().replace(/^www\./u, "");
  if (!normalized) {
    return null;
  }
  for (const [source, domains] of sources) {
    if (
      normalized === source
      || domains.some((domain) => hostnameMatches(normalized, domain))
    ) {
      return source;
    }
  }
  return null;
}

function parseAttributionSource(
  site: PostHogSiteDefinition,
  currentUrl: string | null | undefined,
): string | null {
  if (!currentUrl) {
    return null;
  }
  try {
    return new URL(currentUrl, `https://${site.canonicalDomain}`)
      .searchParams.get("utm_source");
  } catch {
    return null;
  }
}

function parseReferrerHostname(referrer: string | null | undefined): string | null {
  if (!referrer || referrer === "$direct") {
    return null;
  }
  try {
    return normalizeAnalyticsHostname(new URL(referrer).hostname).replace(/^www\./u, "");
  } catch {
    return "";
  }
}

export function classifyAnalyticsTraffic(
  site: PostHogSiteDefinition,
  referrer: string | null | undefined,
  currentUrl?: string | null,
): AnalyticsTrafficContext {
  const attributionSource = parseAttributionSource(site, currentUrl);
  if (attributionSource) {
    const attributedAiSource = sourceForAttribution(attributionSource, AI_SOURCES);
    if (attributedAiSource) {
      return {
        traffic_channel: "ai_referral",
        traffic_source: attributedAiSource,
      };
    }

    const attributedSearchSource = sourceForAttribution(
      attributionSource,
      SEARCH_SOURCES,
    );
    if (attributedSearchSource) {
      return {
        traffic_channel: "organic_search",
        traffic_source: attributedSearchSource,
      };
    }

    const attributedSocialSource = sourceForAttribution(
      attributionSource,
      SOCIAL_SOURCES,
    );
    if (attributedSocialSource) {
      return {
        traffic_channel: "social",
        traffic_source: attributedSocialSource,
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
      referrer_host: hostname,
    };
  }

  const aiSource = sourceForHostname(hostname, AI_SOURCES);
  if (aiSource) {
    return {
      traffic_channel: "ai_referral",
      traffic_source: aiSource,
      referrer_host: hostname,
    };
  }

  const searchSource = sourceForHostname(hostname, SEARCH_SOURCES);
  if (searchSource) {
    return {
      traffic_channel: "organic_search",
      traffic_source: searchSource,
      referrer_host: hostname,
    };
  }

  const socialSource = sourceForHostname(hostname, SOCIAL_SOURCES);
  if (socialSource) {
    return {
      traffic_channel: "social",
      traffic_source: socialSource,
      referrer_host: hostname,
    };
  }

  return {
    traffic_channel: "referral",
    traffic_source: hostname,
    referrer_host: hostname,
  };
}
