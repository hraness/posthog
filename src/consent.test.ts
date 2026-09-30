import { expect, test } from "bun:test";
import fc from "fast-check";
import { browserDoNotTrackEnabled, AnalyticsConsent, installConsentTransport, type ConsentEnvironment } from "./consent";

function fixture(body: unknown = { required: false }, ok = true) {
  let choice: string | null = null;
  let changed = () => {};
  let accepted = () => {};
  let requests = 0;
  let resolve!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
  const request = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(done => { resolve = done; });
  const environment: ConsentEnvironment = {
    readChoice: () => choice,
    requestRegion: () => { requests++; return request; },
    listen: (next, accept) => { changed = next; accepted = accept; return () => {}; },
  };
  const consent = new AnalyticsConsent(environment);
  return {
    consent, environment,
    requests: () => requests,
    choose: (next: string | null) => { choice = next; changed(); },
    accept: () => { accepted(); },
    settle: async () => { resolve({ ok, json: () => Promise.resolve(body) }); await request; await Promise.resolve(); await Promise.resolve(); },
  };
}

test("does not permit analytics until a successful region response explicitly clears consent", async () => {
  const f = fixture();
  const observed: boolean[] = [];
  const remove = f.consent.subscribe(() => { observed.push(f.consent.allowed()); });
  f.consent.start();
  expect(f.requests()).toBe(1);
  expect(f.consent.allowed()).toBe(false);
  await f.settle();
  expect(observed).toEqual([false, true]);
  remove();
  f.choose("declined");
  expect(f.consent.allowed()).toBe(false);
  expect(observed).toEqual([false, true]);
});

test("required, failed, or malformed regions wait for acceptance without persistent storage", async () => {
  for (const [body, ok] of [[{ required: true }, true], [{ required: false }, false], [{}, true]] as const) {
    const f = fixture(body, ok);
    f.consent.start();
    await f.settle();
    expect(f.consent.allowed()).toBe(false);
    f.accept();
    expect(f.consent.allowed()).toBe(true);
  }
  const environment: ConsentEnvironment = {
    readChoice: () => { throw new Error("Storage unavailable"); },
    requestRegion: () => Promise.reject(new Error("Offline")),
    listen: () => () => {},
  };
  const consent = new AnalyticsConsent(environment);
  consent.start();
  await Promise.resolve(); await Promise.resolve();
  expect(consent.allowed()).toBe(false);
});

test("persisted acceptance starts immediately; refusal and cross-tab changes win over region", async () => {
  for (const choice of ["accepted", "declined", "rejected", "denied"]) {
    const f = fixture();
    f.choose(choice);
    f.consent.start();
    expect(f.requests()).toBe(0);
    expect(f.consent.allowed()).toBe(choice === "accepted");
  }
  const f = fixture();
  f.consent.start();
  f.choose("declined");
  await f.settle();
  expect(f.consent.allowed()).toBe(false);
  f.choose("accepted");
  expect(f.consent.allowed()).toBe(true);
  f.choose("rejected");
  expect(f.consent.allowed()).toBe(false);
});

test("all arbitrary region payloads require literal false in a successful object response", async () => {
  await fc.assert(fc.asyncProperty(fc.jsonValue(), fc.boolean(), async (body, ok) => {
    const f = fixture(body, ok);
    f.consent.start();
    await f.settle();
    expect(f.consent.allowed()).toBe(ok && typeof body === "object" && body !== null
      && !Array.isArray(body) && Reflect.get(body, "required") === false);
  }));
});


test("withdrawal aborts pending requests and stale retries before notifying observers", async () => {
  const f = fixture();
  f.consent.start();
  expect(f.consent.requestSignal().aborted).toBe(true);
  await f.settle();
  const granted = f.consent.requestSignal();
  expect(granted.aborted).toBe(false);
  const remove = f.consent.subscribe(() => {
    if (!f.consent.allowed()) expect(granted.aborted).toBe(true);
  });
  f.choose("declined");
  expect(granted.aborted).toBe(true);
  f.accept();
  const accepted = f.consent.requestSignal();
  expect(accepted).not.toBe(granted);
  expect(accepted.aborted).toBe(false);
  expect(granted.aborted).toBe(true);
  f.choose("rejected");
  expect(accepted.aborted).toBe(true);
  remove();
});


test("the final transport drops stale retries after reacceptance and forces abortable page leaves", async () => {
  const f = fixture(); f.consent.start(); await f.settle();
  const requests: Record<string, unknown>[] = [];
  const provider = { version: "1.422.5", config: { request_batching: false }, _send_request: (options: Record<string, unknown>) => { requests.push(options); } };
  expect(installConsentTransport(provider, f.consent)).toBe(true);
  expect(installConsentTransport(provider, f.consent)).toBe(true);
  const data = { event: "$pageview" };
  provider._send_request({ data, transport: "sendBeacon" });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.transport).toBe("fetch");
  expect(requests[0]?.disableTransport).toEqual(["XHR", "sendBeacon"]);
  const signal = (requests[0]?.fetchOptions as { signal: AbortSignal }).signal;
  f.choose("declined"); expect(signal.aborted).toBe(true);
  let dropped = 0;
  const retry = { data, callback: (response: { statusCode: number }) => { expect(response.statusCode).toBe(400); dropped++; } };
  provider._send_request(retry);
  f.accept(); provider._send_request(retry);
  expect(requests).toHaveLength(1); expect(dropped).toBe(2);
  provider._send_request({ data: { event: "$pageleave" }, transport: "sendBeacon" });
  expect(requests).toHaveLength(2);
  expect((requests[1]?.fetchOptions as { signal: AbortSignal }).signal.aborted).toBe(false);
  provider._send_request({ data: "unknown payload", callback: retry.callback });
  expect(requests).toHaveLength(2); expect(dropped).toBe(3);
  provider.config.request_batching = true;
  provider._send_request({ data: { event: "$pageview" }, callback: retry.callback });
  expect(requests).toHaveLength(2); expect(dropped).toBe(4);
  expect(installConsentTransport({}, f.consent)).toBe(false);
});


test("consent signals retain the provider's request timeout", async () => {
  const f = fixture(); f.consent.start(); await f.settle();
  let signal: AbortSignal | undefined;
  const provider = { version: "1.422.5", config: { request_batching: false }, _send_request: (options: Record<string, unknown>) => {
    signal = (options.fetchOptions as { signal: AbortSignal }).signal;
  } };
  installConsentTransport(provider, f.consent);
  provider._send_request({ data: { event: "$pageview" }, timeout: 5 });
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(signal?.aborted).toBe(true);
  expect(f.consent.allowed()).toBe(true);
  expect(f.consent.requestSignal().aborted).toBe(false);
});


test("transport preserves the caller's cancellation signal", async () => {
  const f = fixture(); f.consent.start(); await f.settle();
  const caller = new AbortController(); let signal: AbortSignal | undefined;
  const provider = { version: "1.422.5", config: { request_batching: false, fetch_options: { signal: caller.signal } }, _send_request: (options: Record<string, unknown>) => {
    signal = (options.fetchOptions as { signal: AbortSignal }).signal;
  } };
  installConsentTransport(provider, f.consent);
  provider._send_request({ data: { event: "$pageview" } });
  caller.abort();
  expect(signal?.aborted).toBe(true);
  expect(f.consent.requestSignal().aborted).toBe(false);
});


test("unqualified providers fail closed before initialization", async () => {
  const f = fixture(); f.consent.start(); await f.settle();
  for (const version of [undefined, "1.434.5", "2.0.0"]) {
    const provider = { version, _send_request: () => {} };
    expect(installConsentTransport(provider, f.consent)).toBe(false);
  }
});

test("current and legacy Do Not Track signals override accepted consent and transport", () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    for (const field of ["doNotTrack", "msDoNotTrack", "window"]) {
      for (const enabled of ["1", "yes", 1]) {
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: field === "window" ? {} : { [field]: enabled } });
        Object.defineProperty(globalThis, "window", { configurable: true, value: field === "window" ? { doNotTrack: enabled } : {} });
        expect(browserDoNotTrackEnabled()).toBe(true);
        const f = fixture(); f.consent.start(); f.accept();
        expect(f.consent.allowed()).toBe(false);
        expect(f.consent.requestSignal().aborted).toBe(true);
      }
    }
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
