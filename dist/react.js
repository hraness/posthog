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
  installPostHogOutboundCapture,
  installPostHogExceptionCapture
} from "./client.js";
function PostHogAnalytics(props) {
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
  const { apiHost, apiKey, eventName, properties, site, uuid } = props;
  useEffect(() => {
    let sent = false;
    return observePostHogBrowser({ apiHost, apiKey, site }, () => {
      if (!sent) {
        sent = true;
        capturePostHogEvent(site, eventName, properties, uuid ? { uuid } : {});
      }
      return;
    });
  }, [apiHost, apiKey, eventName, properties, site, uuid]);
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

//# debugId=7E0B3FAB3774D48B64756E2164756E21
