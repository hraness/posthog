import type { Instrumentation } from "next";
import { PostHog } from "posthog-node";

import {
  analyticsErrorFingerprint,
  ExceptionBudget,
  normalizeAnalyticsProperties,
  sanitizeAnalyticsError,
  sanitizeProviderProperties,
} from "./event.js";
import {
  classifyAnalyticsRoute,
  isAllowedAnalyticsHost,
  isAllowedCustomEvent,
  normalizeAnalyticsHostname,
  type PostHogSiteDefinition,
} from "./site.js";
import { classifyAnalyticsTraffic } from "./traffic.js";

const DEFAULT_API_HOST = "https://us.i.posthog.com";
const serverExceptionBudget = new ExceptionBudget({
  totalLimit: 30,
  perFingerprintLimit: 3,
  windowMs: 60_000,
});
const clients = new Map<string, PostHog>();

export type PostHogServerOptions = Readonly<{
  site: PostHogSiteDefinition;
  apiKey?: string | undefined;
  apiHost?: string | undefined;
  production?: boolean;
}>;

function firstHeader(
  headers: NodeJS.Dict<string | string[]>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestHostname(headers: NodeJS.Dict<string | string[]>): string {
  return normalizeAnalyticsHostname(
    firstHeader(headers, "x-forwarded-host")
      ?? firstHeader(headers, "host")
      ?? "",
  );
}

function serverClient(options: PostHogServerOptions): PostHog | null {
  if (!options.apiKey?.startsWith("phc_")) {
    return null;
  }
  const key = `${options.site.id}:${options.apiKey}:${options.apiHost ?? DEFAULT_API_HOST}`;
  const existing = clients.get(key);
  if (existing) {
    return existing;
  }
  const client = new PostHog(options.apiKey, {
    host: options.apiHost ?? DEFAULT_API_HOST,
    flushAt: 1,
    flushInterval: 0,
    maxQueueSize: 100,
    disableGeoip: true,
    privacyMode: true,
    enableExceptionAutocapture: false,
  });
  clients.set(key, client);
  return client;
}

export function createPostHogRequestErrorReporter(
  options: PostHogServerOptions,
): Instrumentation.onRequestError {
  return async (value, request, context) => {
    const production = options.production ?? process.env.VERCEL_ENV === "production";
    const hostname = requestHostname(request.headers);
    if (!production || !isAllowedAnalyticsHost(options.site, hostname)) {
      return;
    }
    const client = serverClient(options);
    if (!client) {
      return;
    }
    const error = sanitizeAnalyticsError(value);
    const fingerprint = analyticsErrorFingerprint(error);
    if (!serverExceptionBudget.allow(fingerprint)) {
      return;
    }
    const route = classifyAnalyticsRoute(options.site, {
      hostname,
      pathname: request.path,
    });
    if (!route) {
      return;
    }
    const traffic = classifyAnalyticsTraffic(
      options.site,
      firstHeader(request.headers, "referer"),
    );
    const properties = sanitizeProviderProperties(options.site, {
      ...route,
      ...traffic,
      error_fingerprint: fingerprint,
      error_surface: "server",
      error_origin: "next_request_error",
      request_method: request.method.slice(0, 12).toUpperCase(),
      route_type: context.routeType,
      router_kind: context.routerKind,
      framework_route: context.routePath,
      $process_person_profile: false,
    });
    try {
      await client.captureExceptionImmediate(error, `server:${options.site.id}`, properties);
    } catch {
      // Observability must never break a request or error boundary.
    }
  };
}

/** Sends an anonymous, allowlisted server event and waits for delivery. */
export async function capturePostHogEvent(
  options: PostHogServerOptions,
  input: Readonly<{ event: string; hostname: string; pathname?: string; properties?: unknown }>,
): Promise<boolean> {
  const production = options.production ?? process.env.VERCEL_ENV === "production";
  if (!production || !isAllowedAnalyticsHost(options.site, input.hostname)
    || !isAllowedCustomEvent(options.site, input.event)) {
    return false;
  }
  const route = classifyAnalyticsRoute(options.site, {
    hostname: input.hostname,
    pathname: input.pathname ?? "/",
  });
  if (!route) return false;
  try {
    const client = serverClient(options);
    if (!client) return false;
    await client.captureImmediate({
      distinctId: `server:${options.site.id}`,
      event: input.event,
      properties: {
        ...sanitizeProviderProperties(options.site, normalizeAnalyticsProperties(input.properties),
          `https://${normalizeAnalyticsHostname(input.hostname)}${input.pathname ?? "/"}`),
        ...route,
        $process_person_profile: false,
      },
      disableGeoip: true,
    });
    return true;
  } catch {
    // Analytics failures must never break a payment webhook or request.
    return false;
  }
}
