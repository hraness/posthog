import { useEffect } from "react";

import {
  capturePostHogEvent,
  capturePostHogException,
  capturePostHogPageNotFound,
  observePostHogBrowser,
  initializePostHogBrowser,
  installDelegatedPostHogCapture,
  installPostHogExceptionCapture,
  type PostHogBrowserOptions,
} from "./client.js";
import type { PostHogSiteDefinition } from "./site.js";

export type PostHogAnalyticsProps = Readonly<{
  site: PostHogSiteDefinition;
  apiKey?: string | undefined;
  apiHost?: string | undefined;
}>;

export function PostHogAnalytics(props: PostHogAnalyticsProps) {
  const { apiHost, apiKey, site } = props;
  useEffect(() => {
    return observePostHogBrowser({ apiHost, apiKey, site }, () => {
      const removeExceptions = installPostHogExceptionCapture(site);
      const removeDelegated = installDelegatedPostHogCapture(site);
      return () => {
        removeDelegated();
        removeExceptions();
      };
    });
  }, [apiHost, apiKey, site]);
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
  }>,
) {
  const { apiHost, apiKey, eventName, properties, site } = props;
  useEffect(() => {
    let sent = false;
    return observePostHogBrowser({ apiHost, apiKey, site }, () => {
      if (!sent) { sent = true; capturePostHogEvent(site, eventName, properties); }
      return undefined;
    });
  }, [apiHost, apiKey, eventName, properties, site]);
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
