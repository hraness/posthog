// src/consent.ts
var CONSENT_REGION_URL = "https://account.hraness.com/api/consent/region";
var CONSENT_STORAGE_KEY = "hraness-consent-cookies-v1";
var CONSENT_ACCEPTED_EVENT = "hraness-consent-accepted";
var CONSENT_DECLINED_EVENT = "hraness-consent-declined";
function browserDoNotTrackEnabled() {
  const browserNavigator = typeof navigator === "undefined" ? undefined : navigator;
  const browserWindow = typeof window === "undefined" ? undefined : window;
  return [
    browserNavigator?.doNotTrack,
    browserNavigator && Reflect.get(browserNavigator, "msDoNotTrack"),
    browserWindow && Reflect.get(browserWindow, "doNotTrack")
  ].some((value) => value === "1" || value === 1 || value === "yes");
}

class AnalyticsConsent {
  regionAllows = false;
  accepted = false;
  denied = false;
  started = false;
  transportController;
  listeners = new Set;
  environment;
  constructor(environment) {
    this.environment = environment;
  }
  allowed() {
    return !browserDoNotTrackEnabled() && !this.denied && (this.accepted || this.regionAllows);
  }
  requestSignal() {
    if (!this.transportController || this.allowed() && this.transportController.signal.aborted) {
      this.transportController = new AbortController;
    }
    if (!this.allowed())
      this.transportController.abort();
    return this.transportController.signal;
  }
  publish() {
    this.requestSignal();
    for (const listener of this.listeners)
      listener();
  }
  readChoice() {
    let choice = null;
    try {
      choice = this.environment.readChoice();
    } catch {}
    this.accepted = choice === "accepted";
    this.denied = choice !== null && choice !== "accepted";
  }
  start() {
    if (this.started)
      return;
    this.started = true;
    this.readChoice();
    this.environment.listen(() => {
      this.readChoice();
      this.publish();
    }, () => {
      this.accepted = true;
      this.denied = false;
      this.publish();
    }, () => {
      this.accepted = false;
      this.denied = true;
      this.publish();
    });
    if (this.accepted || this.denied)
      return;
    this.environment.requestRegion().then(async (response) => {
      const body = await response.json();
      this.regionAllows = response.ok && typeof body === "object" && body !== null && !Array.isArray(body) && Reflect.get(body, "required") === false;
      this.publish();
    }).catch(() => {
      this.regionAllows = false;
      this.publish();
    });
  }
  subscribe(listener) {
    this.listeners.add(listener);
    this.start();
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
}
var browserConsent;
function getBrowserConsent() {
  if (typeof window === "undefined")
    return;
  browserConsent ??= new AnalyticsConsent({
    readChoice: () => window.localStorage.getItem(CONSENT_STORAGE_KEY),
    requestRegion: () => fetch(CONSENT_REGION_URL, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000)
    }),
    listen: (changed, accepted, declined) => {
      const storageChanged = (event) => {
        if (event.key === CONSENT_STORAGE_KEY || event.key === null)
          changed();
      };
      window.addEventListener("storage", storageChanged);
      window.addEventListener(CONSENT_ACCEPTED_EVENT, accepted);
      window.addEventListener(CONSENT_DECLINED_EVENT, declined);
      return () => {
        window.removeEventListener("storage", storageChanged);
        window.removeEventListener(CONSENT_ACCEPTED_EVENT, accepted);
        window.removeEventListener(CONSENT_DECLINED_EVENT, declined);
      };
    }
  });
  return browserConsent;
}
var guardedProviders = new WeakMap;
function installConsentTransport(provider, consent = getBrowserConsent()) {
  if (!consent || typeof fetch !== "function" || typeof AbortSignal === "undefined" || typeof AbortSignal.any !== "function" || typeof AbortSignal.timeout !== "function")
    return false;
  const version = Reflect.get(provider, "version");
  if (version !== "1.412.1" && version !== "1.422.5")
    return false;
  const existing = guardedProviders.get(provider);
  if (existing)
    return existing === consent;
  const send = Reflect.get(provider, "_send_request");
  if (typeof send !== "function")
    return false;
  const generations = new WeakMap;
  const guarded = (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return;
    const options = raw;
    const data = options.data;
    const config = Reflect.get(provider, "config");
    const drop = () => {
      if (typeof options.callback === "function")
        Reflect.apply(options.callback, undefined, [{ statusCode: 400 }]);
    };
    if (typeof config !== "object" || config === null || Reflect.get(config, "request_batching") !== false || typeof data !== "object" || data === null || typeof fetch !== "function") {
      drop();
      return;
    }
    let signal = generations.get(data);
    if (!signal) {
      signal = consent.requestSignal();
      generations.set(data, signal);
    }
    if (signal.aborted || !consent.allowed()) {
      drop();
      return;
    }
    const configuredOptions = Reflect.get(config, "fetch_options");
    const fetchOptions = {
      ...typeof configuredOptions === "object" && configuredOptions !== null ? configuredOptions : {},
      ...typeof options.fetchOptions === "object" && options.fetchOptions !== null ? options.fetchOptions : {}
    };
    const callerSignals = fetchOptions.signal instanceof AbortSignal ? [fetchOptions.signal] : [];
    return Reflect.apply(send, provider, [{
      ...options,
      transport: "fetch",
      disableTransport: ["XHR", "sendBeacon"],
      fetchOptions: { ...fetchOptions, signal: AbortSignal.any([signal, ...callerSignals, AbortSignal.timeout(typeof options.timeout === "number" && Number.isSafeInteger(options.timeout) && options.timeout > 0 ? Math.min(options.timeout, 60000) : 60000)]) }
    }]);
  };
  if (!Reflect.set(provider, "_send_request", guarded))
    return false;
  guardedProviders.set(provider, consent);
  return true;
}
export {
  installConsentTransport,
  getBrowserConsent,
  browserDoNotTrackEnabled,
  CONSENT_STORAGE_KEY,
  CONSENT_REGION_URL,
  CONSENT_DECLINED_EVENT,
  CONSENT_ACCEPTED_EVENT,
  AnalyticsConsent
};

//# debugId=D995A5F95A0CECFF64756E2164756E21
