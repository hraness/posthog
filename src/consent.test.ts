import { expect, test } from "bun:test";
import fc from "fast-check";
import { AnalyticsConsent, type ConsentEnvironment } from "./consent";

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
