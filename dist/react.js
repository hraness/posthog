"use client";

// src/react.tsx
import { useEffect } from "react";
import {
  capturePostHogEvent,
  capturePostHogException,
  capturePostHogPageNotFound,
  observePostHogBrowser,
  initializePostHogBrowser,
  installDelegatedPostHogCapture,
  installPostHogExceptionCapture
} from "./client.js";
function PostHogAnalytics(props) {
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
function PostHogExceptionReporter(props) {
  const { apiHost, apiKey, error, origin, site } = props;
  useEffect(() => {
    if (!initializePostHogBrowser({ apiHost, apiKey, site }))
      return;
    capturePostHogException(site, error, {
      error_origin: origin ?? "react_error_boundary"
    });
  }, [apiHost, apiKey, error, origin, site]);
  return null;
}
function PostHogEventReporter(props) {
  const { apiHost, apiKey, eventName, properties, site } = props;
  useEffect(() => {
    let sent = false;
    return observePostHogBrowser({ apiHost, apiKey, site }, () => {
      if (!sent) {
        sent = true;
        capturePostHogEvent(site, eventName, properties);
      }
      return;
    });
  }, [apiHost, apiKey, eventName, properties, site]);
  return null;
}
function PostHogPageNotFound(props) {
  const { apiHost, apiKey, site } = props;
  useEffect(() => {
    let sent = false;
    return observePostHogBrowser({ apiHost, apiKey, site }, () => {
      if (!sent) {
        sent = true;
        capturePostHogPageNotFound(site);
      }
      return;
    });
  }, [apiHost, apiKey, site]);
  return null;
}
export {
  PostHogPageNotFound,
  PostHogExceptionReporter,
  PostHogEventReporter,
  PostHogAnalytics
};

//# debugId=E0E7410D3DBC689B64756E2164756E21
