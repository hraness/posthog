// src/consent.ts
var CONSENT_REGION_URL = "https://account.hraness.com/api/consent/region";
var CONSENT_STORAGE_KEY = "hraness-consent-cookies-v1";
var CONSENT_ACCEPTED_EVENT = "hraness-consent-accepted";

class AnalyticsConsent {
  environment;
  regionAllows = false;
  accepted = false;
  denied = false;
  started = false;
  listeners = new Set;
  constructor(environment) {
    this.environment = environment;
  }
  allowed() {
    return !this.denied && (this.accepted || this.regionAllows);
  }
  publish() {
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
    listen: (changed, accepted) => {
      const storageChanged = (event) => {
        if (event.key === CONSENT_STORAGE_KEY || event.key === null)
          changed();
      };
      window.addEventListener("storage", storageChanged);
      window.addEventListener(CONSENT_ACCEPTED_EVENT, accepted);
      return () => {
        window.removeEventListener("storage", storageChanged);
        window.removeEventListener(CONSENT_ACCEPTED_EVENT, accepted);
      };
    }
  });
  return browserConsent;
}
export {
  getBrowserConsent,
  CONSENT_STORAGE_KEY,
  CONSENT_REGION_URL,
  CONSENT_ACCEPTED_EVENT,
  AnalyticsConsent
};

//# debugId=AF1464B1DAF2DFA064756E2164756E21
