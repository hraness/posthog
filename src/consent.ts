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
  private transportController: AbortController | undefined;
  private readonly listeners = new Set<() => void>();

  private readonly environment: ConsentEnvironment;

  constructor(environment: ConsentEnvironment) {
    this.environment = environment;
  }

  allowed(): boolean {
    return !this.denied && (this.accepted || this.regionAllows);
  }

  /** A revoked generation stays aborted even when a later choice grants consent. */
  requestSignal(): AbortSignal {
    if (!this.transportController || (this.allowed() && this.transportController.signal.aborted)) {
      this.transportController = new AbortController();
    }
    if (!this.allowed()) this.transportController.abort();
    return this.transportController.signal;
  }

  private publish(): void {
    this.requestSignal();
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

type RequestRecord = Record<string, unknown>;
const guardedProviders = new WeakMap<object, AnalyticsConsent>();

/**
 * Guard PostHog's final transport seam, including retries and page-leave requests.
 * Its public opt-out is a no-op in cookieless:always and shutdown flushes queues.
 * Pinned provider regressions cover this seam; an unknown request shape is dropped.
 */
export function installConsentTransport(provider: object, consent: AnalyticsConsent | undefined = getBrowserConsent()): boolean {
  if (!consent || typeof fetch !== "function" || typeof AbortSignal === "undefined"
    || typeof AbortSignal.any !== "function" || typeof AbortSignal.timeout !== "function") return false;
  // Later providers changed retry dispatch to bypass this seam. Qualify each
  // exact provider before allowing it to initialize through this contract.
  const version = Reflect.get(provider, "version") as unknown;
  if (version !== "1.412.1" && version !== "1.422.5") return false;
  const existing = guardedProviders.get(provider);
  if (existing) return existing === consent;
  const send = Reflect.get(provider, "_send_request") as unknown;
  if (typeof send !== "function") return false;
  const generations = new WeakMap<object, AbortSignal>();
  const guarded = (raw: unknown): unknown => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const options = raw as RequestRecord;
    const data = options.data;
    const config = Reflect.get(provider, "config") as unknown;
    const drop = (): void => {
      if (typeof options.callback === "function") Reflect.apply(options.callback, undefined, [{ statusCode: 400 }]);
    };
    if (typeof config !== "object" || config === null || Reflect.get(config, "request_batching") !== false
      || typeof data !== "object" || data === null || typeof fetch !== "function") { drop(); return; }
    let signal = generations.get(data);
    if (!signal) { signal = consent.requestSignal(); generations.set(data, signal); }
    if (signal.aborted || !consent.allowed()) { drop(); return; }
    const configuredOptions = Reflect.get(config, "fetch_options") as unknown;
    const fetchOptions = {
      ...(typeof configuredOptions === "object" && configuredOptions !== null ? configuredOptions : {}),
      ...(typeof options.fetchOptions === "object" && options.fetchOptions !== null ? options.fetchOptions : {}),
    } as Record<string, unknown>;
    const callerSignals = fetchOptions.signal instanceof AbortSignal ? [fetchOptions.signal] : [];
    return Reflect.apply(send, provider, [{
      ...options,
      transport: "fetch",
      disableTransport: ["XHR", "sendBeacon"],
      // fetchOptions overrides the provider's native timeout signal; retain its
      // sixty-second default (or an explicit bounded timeout) alongside consent.
      fetchOptions: { ...fetchOptions, signal: AbortSignal.any([signal, ...callerSignals, AbortSignal.timeout(
        typeof options.timeout === "number" && Number.isSafeInteger(options.timeout) && options.timeout > 0
          ? Math.min(options.timeout, 60_000) : 60_000,
      )]) },
    }]);
  };
  if (!Reflect.set(provider, "_send_request", guarded)) return false;
  guardedProviders.set(provider, consent);
  return true;
}
