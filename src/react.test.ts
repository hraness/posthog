import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

test("mounted event and 404 reporters wait for permission and send once", () => {
  const result = execFileSync(process.execPath, ["--eval", `
    import { mock } from "bun:test";
    import { posthog } from "posthog-js";
    const effects = [];
    mock.module("react", () => ({ useEffect: (effect) => effects.push(effect) }));
    const events = new EventTarget();
    let choice = null;
    let resolveRegion;
    globalThis.window = {
      location: { hostname: "example.com", href: "https://example.com/", pathname: "/" },
      localStorage: { getItem: () => choice },
      addEventListener: (...args) => events.addEventListener(...args),
      removeEventListener: (...args) => events.removeEventListener(...args),
    };
    globalThis.document = { referrer: "" };
    globalThis.fetch = () => new Promise(resolve => { resolveRegion = resolve; });
    process.env.NODE_ENV = "production";
    const captured = [];
    posthog.init = () => {};
    posthog.capture = (name) => captured.push(name);
    posthog.captureException = () => captured.push("exception");
    const react = await import(${JSON.stringify(import.meta.dir + "/react.tsx")});
    const props = { site: {
      id: "react-example", canonicalDomain: "example.com", allowedHosts: ["example.com"],
      schemaVersion: 2, routes: [], customEvents: ["cta clicked"],
    }, apiKey: "phc_public" };
    react.PostHogEventReporter({ ...props, eventName: "cta clicked" });
    react.PostHogPageNotFound(props);
    react.PostHogExceptionReporter({ ...props, error: new Error("early") });
    const cleanups = effects.map(effect => effect());
    const before = [...captured];
    resolveRegion(new Response(JSON.stringify({ required: true })));
    await new Promise(resolve => setTimeout(resolve, 0));
    const denied = [...captured];
    choice = "accepted";
    events.dispatchEvent(new Event("hraness-consent-accepted"));
    events.dispatchEvent(new Event("hraness-consent-accepted"));
    for (const cleanup of cleanups) cleanup?.();
    console.log(JSON.stringify({ before, denied, captured }));
  `], { encoding: "utf8", timeout: 10_000 });
  expect(JSON.parse(result)).toEqual({
    before: [], denied: [], captured: ["cta clicked", "page not found"],
  });
});
