"use client";

import { useEffect } from "react";

import {
  capturePostHogEvent,
  capturePostHogException,
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

function initialize(props: PostHogAnalyticsProps): boolean {
  return initializePostHogBrowser({
    site: props.site,
    apiKey: props.apiKey,
    apiHost: props.apiHost,
  });
}

export function PostHogAnalytics(props: PostHogAnalyticsProps) {
  const { apiHost, apiKey, site } = props;
  useEffect(() => {
    if (!initialize({ apiHost, apiKey, site })) {
      return undefined;
    }
    const removeExceptions = installPostHogExceptionCapture(site);
    const removeDelegated = installDelegatedPostHogCapture(site);
    return () => {
      removeDelegated();
      removeExceptions();
    };
  }, [apiHost, apiKey, site]);
  return null;
}

export function PostHogExceptionReporter(
  props: PostHogAnalyticsProps & Readonly<{ error: unknown; origin?: string }>,
) {
  const { apiHost, apiKey, error, origin, site } = props;
  useEffect(() => {
    if (initialize({ apiHost, apiKey, site })) {
      capturePostHogException(site, error, {
        error_origin: origin ?? "react_error_boundary",
      });
    }
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
    if (initialize({ apiHost, apiKey, site })) {
      capturePostHogEvent(site, eventName, properties);
    }
  }, [apiHost, apiKey, eventName, properties, site]);
  return null;
}

export type { PostHogBrowserOptions };
