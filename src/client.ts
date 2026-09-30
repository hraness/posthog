import { posthog } from "posthog-js";
import type { CaptureResult, PostHogConfig } from "posthog-js";
// Register the same non-attribution callbacks before initialization so the SDK
// uses the application bundle instead of injecting a remote script under CSP.
import "posthog-js/dist/web-vitals.js";

import {
  analyticsErrorFingerprint,
  ctaClickedProperties,
  ExceptionBudget,
  installCommandCopiedProperties,
  normalizeAnalyticsProperties,
  outboundLinkOpenedProperties,
  pageNotFoundProperties,
  sanitizeAnalyticsError,
  sanitizeProviderProperties,
  STANDARD_ANALYTICS_EVENTS,
  type AnalyticsInstallMethod,
  type AnalyticsLinkKind,
  type AnalyticsPlacement,
  type AnalyticsProperties,
} from "./event.js";
import {
  canonicalAnalyticsUrl,
  classifyAnalyticsRoute,
  isAllowedAnalyticsHost,
  isAllowedAnalyticsPath,
  isAllowedCustomEvent,
  isSensitiveAnalyticsPath,
  isAllowedDelegatedEvent,
  normalizeAnalyticsHostname,
  parseAnalyticsLocation,
  type PostHogSiteDefinition,
} from "./site.js";
import { getBrowserConsent } from "./consent.js";
import { classifyAnalyticsTraffic } from "./traffic.js";

const BUILT_IN_EVENTS = new Set([
  "$pageview",
  "$pageleave",
  "$web_vitals",
  "$exception",
  STANDARD_ANALYTICS_EVENTS.pageNotFound,
]);
const DEFAULT_API_HOST = "https://us.i.posthog.com";
const clientExceptionBudget = new ExceptionBudget({
  totalLimit: 20,
  perFingerprintLimit: 2,
  windowMs: 60_000,
});
const seenErrors = new WeakSet<object>();

let activeSiteId: string | null = null;

export type BrowserAnalyticsEvidence = Readonly<{
  hostname: string;
  href: string;
  referrer: string;
  production: boolean;
}>;

export type PostHogBrowserOptions = Readonly<{
  site: PostHogSiteDefinition;
  apiKey?: string | undefined;
  apiHost?: string | undefined;
  evidence?: BrowserAnalyticsEvidence;
}>;

export type DelegatedAnalyticsEvent = Readonly<{
  eventName: string;
  properties: AnalyticsProperties;
}>;

export function readDelegatedAnalyticsEvent(
  site: PostHogSiteDefinition,
  target: EventTarget | null,
): DelegatedAnalyticsEvent | null {
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
  const rawProperties: Record<string, unknown> = {
    ...(dataset.analyticsKind ? { target_kind: dataset.analyticsKind } : {}),
    ...(dataset.analyticsId ? { target_id: dataset.analyticsId } : {}),
    ...(dataset.analyticsCta ? { cta: dataset.analyticsCta } : {}),
    ...(dataset.analyticsPlacement ? { placement: dataset.analyticsPlacement } : {}),
    ...(dataset.analyticsLinkKind ? { link_kind: dataset.analyticsLinkKind } : {}),
    ...(dataset.analyticsInstallMethod
      ? { install_method: dataset.analyticsInstallMethod }
      : {}),
  };
  if (typeof HTMLAnchorElement !== "undefined" && element instanceof HTMLAnchorElement) {
    try {
      const base = typeof window === "undefined"
        ? `https://${site.canonicalDomain}`
        : window.location.href;
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
    } catch {
      // A malformed href simply contributes no target properties.
    }
  }
  return {
    eventName,
    properties: normalizeAnalyticsProperties(rawProperties),
  };
}

function currentBrowserEvidence(): BrowserAnalyticsEvidence | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  return {
    hostname: window.location.hostname,
    href: window.location.href,
    referrer: document.referrer,
    production: typeof process !== "undefined"
      && process.env["NODE_ENV"] === "production",
  };
}

function liveRouteAllowed(site: PostHogSiteDefinition): boolean {
  const href = typeof window === "undefined" || typeof window.location === "undefined"
    ? undefined : window.location.href;
  return href === undefined || classifyAnalyticsRoute(site, href) !== null;
}

export function isPostHogBrowserEligible(options: PostHogBrowserOptions): boolean {
  const evidence = options.evidence ?? currentBrowserEvidence();
  return Boolean(
    evidence?.production
    && options.apiKey?.startsWith("phc_")
    && isAllowedAnalyticsHost(options.site, evidence.hostname)
    && classifyAnalyticsRoute(options.site, evidence.href) !== null
    && liveRouteAllowed(options.site),
  );
}

function allowedEvent(site: PostHogSiteDefinition, eventName: string): boolean {
  return BUILT_IN_EVENTS.has(eventName) || isAllowedCustomEvent(site, eventName);
}

export function createPostHogBeforeSend(
  site: PostHogSiteDefinition,
  resolveEvidence: () => Pick<BrowserAnalyticsEvidence, "href" | "referrer">,
): (capture: CaptureResult | null) => CaptureResult | null {
  let sensitiveAttributionSeen = false;
  return (capture) => {
    if (!liveRouteAllowed(site)) { sensitiveAttributionSeen = true; return null; }
    if (!capture || !allowedEvent(site, capture.event)) {
      return null;
    }
    const projectToken = typeof capture.properties.token === "string"
      && capture.properties.token.startsWith("phc_")
      ? capture.properties.token
      : null;
    if (!projectToken) {
      return null;
    }
    const evidence = resolveEvidence();
    if (!classifyAnalyticsRoute(site, evidence.href)) { sensitiveAttributionSeen = true; return null; }
    const rawCurrentUrl = typeof capture.properties.$current_url === "string"
      ? capture.properties.$current_url
      : evidence.href;
    const route = classifyAnalyticsRoute(site, rawCurrentUrl);
    if (!route) {
      sensitiveAttributionSeen = true;
      return null;
    }
    const rawReferrer = typeof capture.properties.$referrer === "string"
      ? capture.properties.$referrer
      : evidence.referrer;
    const traffic = classifyAnalyticsTraffic(site, rawReferrer, rawCurrentUrl);
    const location = parseAnalyticsLocation(site, rawCurrentUrl);
    // Scrub values in place. Rebuilding from a short allowlist loses $host,
    // $raw_user_agent, $cookieless_mode, and session properties, and PostHog
    // then drops or merges the event.
    for (const url of [rawCurrentUrl, capture.properties.$initial_current_url, capture.properties.$session_entry_url]) {
      if (typeof url !== "string") continue;
      try {
        const pathname = new URL(url, `https://${site.canonicalDomain}`).pathname;
        if (isSensitiveAnalyticsPath(site, pathname) || !isAllowedAnalyticsPath(site, pathname)) {
          sensitiveAttributionSeen = true;
        }
      } catch {
        // Malformed provider URLs are removed by the sanitizer.
      }
    }
    // Memory persistence can carry a private landing page's campaign into a
    // later public navigation. Once observed, discard attribution for this
    // browser instance, including initial and session-entry URL queries.
    const properties = sanitizeProviderProperties(site, capture.properties, rawCurrentUrl, sensitiveAttributionSeen);
    // PostHog derives the batch api_key from this required transport property.
    // Preserve the already-validated public project token after generic strings
    // are redacted so ingestion can still attribute the event to its project.
    properties.token = projectToken;
    const $host = location?.hostname;
    if ($host) {
      properties.$host = normalizeAnalyticsHostname($host).replace(/^www\./u, "");
    }
    properties.$current_url = sanitizeProviderProperties(
      site,
      { $current_url: rawCurrentUrl },
      rawCurrentUrl,
      sensitiveAttributionSeen,
    ).$current_url ?? canonicalAnalyticsUrl(site, route.canonical_path);
    properties.$pathname = route.canonical_path;
    properties.$process_person_profile = false;

    return {
      uuid: capture.uuid,
      event: capture.event,
      properties: {
        ...properties,
        ...route,
        ...traffic,
      },
      ...(capture.timestamp ? { timestamp: capture.timestamp } : {}),
    };
  };
}

export function createPostHogBrowserConfig(
  site: PostHogSiteDefinition,
  evidence: Pick<BrowserAnalyticsEvidence, "href" | "referrer">,
  apiHost = DEFAULT_API_HOST,
): Partial<PostHogConfig> {
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
      web_vitals_attribution: false,
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
    cross_subdomain_cookie: false,
    disableDeviceModel: true,
    disable_capture_url_hashes: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    // posthog-js masks ad click IDs under this flag. before_send removes every
    // non-attribution query parameter and redacts email, token, code, key, and
    // secret values instead.
    mask_personal_data_properties: false,
    properties_string_max_length: 2_048,
    internal_or_test_user_hostname: null,
    rate_limiting: {
      events_per_second: 2,
      events_burst_limit: 12,
    },
    before_send: (capture) => getBrowserConsent()?.allowed() === true
      ? beforeSend(capture)
      : null,
  };
}

export function initializePostHogBrowser(options: PostHogBrowserOptions): boolean {
  if (!isPostHogBrowserEligible(options)) {
    return false;
  }
  const consent = getBrowserConsent();
  consent?.start();
  if (!consent?.allowed()) return false;
  if (activeSiteId === options.site.id) {
    return true;
  }
  const evidence = options.evidence ?? currentBrowserEvidence();
  if (!evidence || !options.apiKey) {
    return false;
  }
  posthog.init(
    options.apiKey,
    createPostHogBrowserConfig(options.site, evidence, options.apiHost),
  );
  activeSiteId = options.site.id;
  return true;
}

/** Subscribe before initialization so both React and direct SDK callers obey the same policy. */
export function observePostHogBrowser(
  options: PostHogBrowserOptions,
  ready: () => (() => void) | undefined,
): () => void {
  if (!isPostHogBrowserEligible(options)) return () => {};
  let cleanup: (() => void) | undefined;
  let started = false;
  const removeConsent = getBrowserConsent()?.subscribe(() => {
    if (initializePostHogBrowser(options)) {
      if (!started) { started = true; cleanup = ready(); }
    } else {
      cleanup?.();
      cleanup = undefined;
      started = false;
    }
  });
  return () => { removeConsent?.(); cleanup?.(); };
}

export function capturePostHogEvent(
  site: PostHogSiteDefinition,
  eventName: string,
  properties: unknown = {},
  options: Readonly<{ transport?: "fetch" | "sendBeacon"; send_instantly?: boolean; href?: string }> = {},
): boolean {
  if (getBrowserConsent()?.allowed() !== true || !liveRouteAllowed(site) || activeSiteId !== site.id || !isAllowedCustomEvent(site, eventName)) {
    return false;
  }
  if (options.href !== undefined && !classifyAnalyticsRoute(site, options.href)) {
    return false;
  }
  posthog.capture(eventName, {
    ...normalizeAnalyticsProperties(properties),
    ...(options.href ? { $current_url: options.href } : {}),
  }, {
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.transport === "sendBeacon" ? { send_instantly: true }
      : options.send_instantly !== undefined ? { send_instantly: options.send_instantly } : {}),
  });
  return true;
}

export function capturePostHogException(
  site: PostHogSiteDefinition,
  value: unknown,
  properties: unknown = {},
): boolean {
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
    error_surface: "client",
  });
  return true;
}

export function installPostHogExceptionCapture(site: PostHogSiteDefinition): () => void {
  const onError = (event: ErrorEvent): void => {
    if (event.error instanceof Error) {
      capturePostHogException(site, event.error, { error_origin: "window_error" });
    }
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    capturePostHogException(site, event.reason, { error_origin: "unhandled_rejection" });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

export function installDelegatedPostHogCapture(site: PostHogSiteDefinition): () => void {
  const onClick = (event: MouseEvent): void => {
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

export type { AnalyticsProperties };

function currentPathname(): string | null {
  return typeof window === "undefined" ? null : window.location.pathname;
}

function currentReferrer(): string {
  return typeof document === "undefined" ? "" : document.referrer;
}

/**
 * Sends `page not found` once per call with the normalized requested path and
 * the referrer host. Call it once per 404 render.
 */
export function capturePostHogPageNotFound(
  site: PostHogSiteDefinition,
  input: Readonly<{ requestedPath?: string; referrer?: string }> = {},
): boolean {
  if (getBrowserConsent()?.allowed() !== true || !liveRouteAllowed(site) || activeSiteId !== site.id) {
    return false;
  }
  const properties = pageNotFoundProperties({
    requestedPath: input.requestedPath ?? currentPathname(),
    referrer: input.referrer ?? currentReferrer(),
  });
  if (!properties) {
    return false;
  }
  posthog.capture(STANDARD_ANALYTICS_EVENTS.pageNotFound, properties);
  return true;
}

function captureStandardEvent(
  site: PostHogSiteDefinition,
  eventName: string,
  properties: AnalyticsProperties | null,
): boolean {
  return properties !== null && capturePostHogEvent(site, eventName, properties);
}

/** Sends `cta clicked {cta, placement, target_host?}` when declared in `customEvents`. */
export function capturePostHogCtaClicked(
  site: PostHogSiteDefinition,
  input: Readonly<{ cta: string; placement: AnalyticsPlacement; targetHost?: string }>,
): boolean {
  return captureStandardEvent(site, STANDARD_ANALYTICS_EVENTS.ctaClicked, ctaClickedProperties(input));
}

/** Sends `outbound link opened {target_host, placement, link_kind?}` when declared. */
export function capturePostHogOutboundLinkOpened(
  site: PostHogSiteDefinition,
  input: Readonly<{ targetHost: string; placement: AnalyticsPlacement; linkKind?: AnalyticsLinkKind }>,
): boolean {
  return captureStandardEvent(
    site,
    STANDARD_ANALYTICS_EVENTS.outboundLinkOpened,
    outboundLinkOpenedProperties(input),
  );
}

/** Sends `install command copied {install_method, placement}` when declared. */
export function capturePostHogInstallCommandCopied(
  site: PostHogSiteDefinition,
  input: Readonly<{ installMethod: AnalyticsInstallMethod; placement: AnalyticsPlacement }>,
): boolean {
  return captureStandardEvent(
    site,
    STANDARD_ANALYTICS_EVENTS.installCommandCopied,
    installCommandCopiedProperties(input),
  );
}
