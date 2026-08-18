"use client";

// src/react.tsx
import { useEffect } from "react";
import {
  capturePostHogEvent,
  capturePostHogException,
  initializePostHogBrowser,
  installDelegatedPostHogCapture,
  installPostHogExceptionCapture
} from "./client.js";
function initialize(props) {
  return initializePostHogBrowser({
    site: props.site,
    apiKey: props.apiKey,
    apiHost: props.apiHost
  });
}
function PostHogAnalytics(props) {
  const { apiHost, apiKey, site } = props;
  useEffect(() => {
    if (!initialize({ apiHost, apiKey, site })) {
      return;
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
function PostHogExceptionReporter(props) {
  const { apiHost, apiKey, error, origin, site } = props;
  useEffect(() => {
    if (initialize({ apiHost, apiKey, site })) {
      capturePostHogException(site, error, {
        error_origin: origin ?? "react_error_boundary"
      });
    }
  }, [apiHost, apiKey, error, origin, site]);
  return null;
}
function PostHogEventReporter(props) {
  const { apiHost, apiKey, eventName, properties, site } = props;
  useEffect(() => {
    if (initialize({ apiHost, apiKey, site })) {
      capturePostHogEvent(site, eventName, properties);
    }
  }, [apiHost, apiKey, eventName, properties, site]);
  return null;
}
export {
  PostHogExceptionReporter,
  PostHogEventReporter,
  PostHogAnalytics
};

//# debugId=CD53137435EEFC5D64756E2164756E21
