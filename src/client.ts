import { posthog } from "posthog-js";
import type { CaptureResult, PostHogConfig } from "posthog-js";

import {
  analyticsErrorFingerprint,
  ExceptionBudget,
  normalizeAnalyticsProperties,
  sanitizeAnalyticsError,
  sanitizeProviderProperties,
  type AnalyticsProperties,
} from "./event.js";
import {
  canonicalAnalyticsUrl,
  classifyAnalyticsRoute,
  isAllowedAnalyticsHost,
  isAllowedCustomEvent,
  isAllowedDelegatedEvent,
  normalizeAnalyticsHostname,
  type PostHogSiteDefinition,
} from "./site.js";
import { classifyAnalyticsTraffic } from "./traffic.js";

const BUILT_IN_EVENTS = new Set(["$pageview", "$pageleave", "$web_vitals", "$exception"]);
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

  const rawProperties: Record<string, unknown> = {
    ...(element.dataset.analyticsKind
      ? { target_kind: element.dataset.analyticsKind }
      : {}),
    ...(element.dataset.analyticsId
      ? { target_id: element.dataset.analyticsId }
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
        rawProperties.target_host = targetHost;
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

export function isPostHogBrowserEligible(options: PostHogBrowserOptions): boolean {
  const evidence = options.evidence ?? currentBrowserEvidence();
  return Boolean(
    evidence?.production
    && options.apiKey?.startsWith("phc_")
    && isAllowedAnalyticsHost(options.site, evidence.hostname),
  );
}

function allowedEvent(site: PostHogSiteDefinition, eventName: string): boolean {
  return BUILT_IN_EVENTS.has(eventName) || isAllowedCustomEvent(site, eventName);
}

export function createPostHogBeforeSend(
  site: PostHogSiteDefinition,
  resolveEvidence: () => Pick<BrowserAnalyticsEvidence, "href" | "referrer">,
): (capture: CaptureResult | null) => CaptureResult | null {
  return (capture) => {
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
    const rawCurrentUrl = typeof capture.properties.$current_url === "string"
      ? capture.properties.$current_url
      : evidence.href;
    const route = classifyAnalyticsRoute(site, rawCurrentUrl);
    if (!route) {
      return null;
    }
    const rawReferrer = typeof capture.properties.$referrer === "string"
      ? capture.properties.$referrer
      : evidence.referrer;
    const traffic = classifyAnalyticsTraffic(site, rawReferrer, rawCurrentUrl);
    const properties = sanitizeProviderProperties(site, capture.properties);
    // PostHog derives the batch api_key from this required transport property.
    // Preserve the already-validated public project token after generic strings
    // are redacted so ingestion can still attribute the event to its project.
    properties.token = projectToken;
    properties.$current_url = canonicalAnalyticsUrl(site, route.canonical_path);
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
    mask_personal_data_properties: true,
    custom_personal_data_properties: ["email", "token", "code", "key", "secret"],
    properties_string_max_length: 2_048,
    internal_or_test_user_hostname: null,
    rate_limiting: {
      events_per_second: 2,
      events_burst_limit: 12,
    },
    before_send: createPostHogBeforeSend(site, () => evidence),
  };
}

export function initializePostHogBrowser(options: PostHogBrowserOptions): boolean {
  if (!isPostHogBrowserEligible(options)) {
    return false;
  }
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

export function capturePostHogEvent(
  site: PostHogSiteDefinition,
  eventName: string,
  properties: unknown = {},
): boolean {
  if (activeSiteId !== site.id || !isAllowedCustomEvent(site, eventName)) {
    return false;
  }
  posthog.capture(eventName, normalizeAnalyticsProperties(properties));
  return true;
}

export function capturePostHogException(
  site: PostHogSiteDefinition,
  value: unknown,
  properties: unknown = {},
): boolean {
  if (activeSiteId !== site.id) {
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
    error_surface: "browser",
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
