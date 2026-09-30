/** Shared Accounts policy; the browser never guesses a visitor's jurisdiction. */
export const CONSENT_REGION_URL = "https://account.hraness.com/api/consent/region";
export const CONSENT_STORAGE_KEY = "hraness-consent-cookies-v1";
export const CONSENT_ACCEPTED_EVENT = "hraness-consent-accepted";

export type ConsentEnvironment = Readonly<{
  readChoice: () => string | null;
  requestRegion: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  listen: (changed: () => void, accepted: () => void) => () => void;
}>;

/** A single page shares one region lookup, including simultaneous SDK callers. */
export class AnalyticsConsent {
  private regionAllows = false;
  private accepted = false;
  private denied = false;
  private started = false;
  private readonly listeners = new Set<() => void>();

  private readonly environment: ConsentEnvironment;

  constructor(environment: ConsentEnvironment) {
    this.environment = environment;
  }

  allowed(): boolean {
    return !this.denied && (this.accepted || this.regionAllows);
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  private readChoice(): void {
    let choice: string | null = null;
    try { choice = this.environment.readChoice(); } catch { /* No persistent storage. */ }
    this.accepted = choice === "accepted";
    // Preserve explicit refusal, including a newer choice this version does not understand.
    this.denied = choice !== null && choice !== "accepted";
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.readChoice();
    this.environment.listen(() => {
      this.readChoice();
      this.publish();
    }, () => {
      // The footer emits only after the user accepts, even if storage is blocked.
      this.accepted = true;
      this.denied = false;
      this.publish();
    });
    if (this.accepted || this.denied) return;
    void this.environment.requestRegion().then(async (response) => {
      const body = await response.json();
      this.regionAllows = response.ok && typeof body === "object" && body !== null
        && !Array.isArray(body) && Reflect.get(body, "required") === false;
      this.publish();
    }).catch(() => {
      this.regionAllows = false;
      this.publish();
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.start();
    listener();
    return () => { this.listeners.delete(listener); };
  }
}

let browserConsent: AnalyticsConsent | undefined;
export function getBrowserConsent(): AnalyticsConsent | undefined {
  if (typeof window === "undefined") return undefined;
  browserConsent ??= new AnalyticsConsent({
    readChoice: () => window.localStorage.getItem(CONSENT_STORAGE_KEY),
    requestRegion: () => fetch(CONSENT_REGION_URL, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    }),
    listen: (changed, accepted) => {
      const storageChanged = (event: StorageEvent) => {
        if (event.key === CONSENT_STORAGE_KEY || event.key === null) changed();
      };
      window.addEventListener("storage", storageChanged);
      window.addEventListener(CONSENT_ACCEPTED_EVENT, accepted);
      return () => {
        window.removeEventListener("storage", storageChanged);
        window.removeEventListener(CONSENT_ACCEPTED_EVENT, accepted);
      };
    },
  });
  return browserConsent;
}
