import { useEffect } from "react";

import {
  capturePostHogEvent,
  capturePostHogException,
  capturePostHogPageNotFound,
  observePostHogBrowser,
  initializePostHogBrowser,
  installDelegatedPostHogCapture,
  installPostHogOutboundCapture,
  installPostHogExceptionCapture,
  type PostHogBrowserOptions,
} from "./client.js";
import type { PostHogSiteDefinition } from "./site.js";

export type PostHogAnalyticsProps = Readonly<{
  site: PostHogSiteDefinition;
  apiKey?: string | undefined;
  apiHost?: string | undefined;
}>;

export function PostHogAnalytics(props: PostHogAnalyticsProps & Readonly<{ captureOutboundLinks?: boolean }>) {
  const { apiHost, apiKey, site, captureOutboundLinks = false } = props;
  useEffect(() => {
    return observePostHogBrowser({ apiHost, apiKey, site }, () => {
      const removeExceptions = installPostHogExceptionCapture(site);
      const removeDelegated = installDelegatedPostHogCapture(site);
      const removeOutbound = captureOutboundLinks ? installPostHogOutboundCapture(site) : () => {};
      return () => {
        removeOutbound();
        removeDelegated();
        removeExceptions();
      };
    });
  }, [apiHost, apiKey, site, captureOutboundLinks]);
  return null;
}

export function PostHogExceptionReporter(
  props: PostHogAnalyticsProps & Readonly<{ error: unknown; origin?: string }>,
) {
  const { apiHost, apiKey, error, origin, site } = props;
  useEffect(() => {
    if (!initializePostHogBrowser({ apiHost, apiKey, site })) return;
    capturePostHogException(site, error, {
      error_origin: origin ?? "react_error_boundary",
    });
  }, [apiHost, apiKey, error, origin, site]);
  return null;
}

export function PostHogEventReporter(
  props: PostHogAnalyticsProps & Readonly<{
    eventName: string;
    properties?: unknown;
    /** Stable event UUID for provider-side eventual deduplication. */
    uuid?: string;
  }>,
) {
  const { apiHost, apiKey, eventName, properties, site, uuid } = props;
  useEffect(() => {
    let sent = false;
    return observePostHogBrowser({ apiHost, apiKey, site }, () => {
      if (!sent) { sent = true; capturePostHogEvent(site, eventName, properties, uuid ? { uuid } : {}); }
      return undefined;
    });
  }, [apiHost, apiKey, eventName, properties, site, uuid]);
  return null;
}

/**
 * Mount in `not-found.tsx` to send one `page not found` per 404 render with the
 * normalized requested path and the referrer host.
 */
export function PostHogPageNotFound(props: PostHogAnalyticsProps) {
  const { apiHost, apiKey, site } = props;
  useEffect(() => {
    let sent = false;
    return observePostHogBrowser({ apiHost, apiKey, site }, () => {
      if (!sent) { sent = true; capturePostHogPageNotFound(site); }
      return undefined;
    });
  }, [apiHost, apiKey, site]);
  return null;
}

export type { PostHogBrowserOptions };
