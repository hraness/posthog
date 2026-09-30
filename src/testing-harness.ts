// Child-process harness for `@hraness/posthog/testing`. It loads the pinned
// posthog-js under a minimal browser shape, initializes it with the package's
// production browser config (including its real before_send), captures the
// requested events, and prints what before_send received and returned plus the
// request bodies posthog-js handed to fetch. It runs in its own process so the
// browser globals never leak into the caller's test runner.
import type { CaptureResult } from "posthog-js";

import type { PostHogSiteDefinition } from "./site.js";

type HarnessCapture = Readonly<{
  event: string;
  properties?: Record<string, unknown>;
  error?: Readonly<{ name?: string; message: string; stack?: string }>;
}>;

type HarnessScenario = Readonly<{
  href: string;
  referrer?: string;
  title?: string;
  captures: readonly HarnessCapture[];
}>;

type HarnessInput = Readonly<{
  site: PostHogSiteDefinition;
  apiKey: string;
  apiHost?: string;
  userAgent: string;
  scenarios: readonly HarnessScenario[];
}>;

const chunks: Uint8Array[] = [];
for await (const chunk of process.stdin) {
  chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk as Uint8Array);
}
const input = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as HarnessInput;

const listeners = { addEventListener() {}, removeEventListener() {} };
const firstScenario = input.scenarios[0];
if (!firstScenario) {
  throw new Error("harness needs at least one scenario");
}
const pageLocation = new URL(firstScenario.href);
const pageDocument = {
  ...listeners,
  body: null,
  cookie: "",
  createElement: () => ({ ...listeners, setAttribute() {}, style: {} }),
  documentElement: {},
  getElementsByTagName: () => [],
  location: pageLocation,
  URL: pageLocation.href,
  querySelector: () => null,
  querySelectorAll: () => [],
  readyState: "complete",
  referrer: firstScenario.referrer ?? "",
  title: firstScenario.title ?? "",
  visibilityState: "visible",
};
const sent: string[] = [];
const browserGlobals: Record<string, unknown> = {
  localStorage: { getItem: () => "accepted" },
  document: pageDocument,
  location: pageLocation,
  navigator: {
    doNotTrack: null,
    language: "en-US",
    languages: ["en-US"],
    onLine: true,
    userAgent: input.userAgent,
    webdriver: false,
  },
  screen: { height: 900, width: 1440 },
  window: globalThis,
  innerHeight: 900,
  innerWidth: 1440,
  ...listeners,
  fetch: async (_url: string, init: { body?: unknown } = {}) => {
    const body = init.body;
    const bytes = typeof body === "string"
      ? new TextEncoder().encode(body)
      : body instanceof Blob
        ? new Uint8Array(await body.arrayBuffer())
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : body instanceof Uint8Array
            ? body
            : new Uint8Array();
    sent.push(Buffer.from(bytes).toString("base64"));
    return new Response('{"status":1}', { status: 200 });
  },
};
// Node 21+ defines `navigator` as a getter-only global, so each browser global
// is redefined instead of assigned.
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

// posthog-js reads browser globals when it loads, so it loads only after the
// page shape above exists.
const { posthog } = await import("posthog-js");
const { createPostHogBrowserConfig, initializePostHogBrowser } = await import("./client.js");

const received: unknown[] = [];
const returned: unknown[] = [];
const evidence = { href: firstScenario.href, referrer: firstScenario.referrer ?? "" };
const config = createPostHogBrowserConfig(input.site, evidence, input.apiHost);
const productionBeforeSend = config.before_send;
if (typeof productionBeforeSend !== "function") {
  throw new Error("production config has no before_send function");
}
// Initialize through the real consent path with an explicit accepted choice.
// Suppress the initial automatic view, then install the explicit capture setup.
const originalInit = posthog.init.bind(posthog);
posthog.init = (token, options, name) => originalInit(token, {
  ...options, capture_pageview: false, capture_pageleave: false,
  capture_performance: false, disable_external_dependency_loading: true,
}, name);
initializePostHogBrowser({
  site: input.site, apiKey: input.apiKey,
  ...(input.apiHost ? { apiHost: input.apiHost } : {}),
  evidence: { ...evidence, hostname: pageLocation.hostname, production: true },
});
posthog.init = originalInit;
posthog.set_config({
  ...config,
  // Explicit captures only; everything else is the production config.
  capture_pageview: false,
  capture_pageleave: false,
  capture_performance: false,
  disable_external_dependency_loading: true,
  request_batching: false,
  before_send: (event: CaptureResult | null) => {
    received.push(structuredClone(event));
    const result = productionBeforeSend(event);
    returned.push(structuredClone(result));
    return result;
  },
});

async function drain(expected: number): Promise<void> {
  for (const deadline = Date.now() + 5_000; sent.length < expected && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

for (const scenario of input.scenarios) {
  const next = new URL(scenario.href);
  pageLocation.href = next.href;
  pageDocument.URL = next.href;
  pageDocument.referrer = scenario.referrer ?? "";
  pageDocument.title = scenario.title ?? "";
  evidence.href = scenario.href;
  evidence.referrer = scenario.referrer ?? "";
  for (const capture of scenario.captures) {
    const before = returned.length;
    if (capture.error) {
      const error = new Error(capture.error.message);
      error.name = capture.error.name ?? "Error";
      if (capture.error.stack) error.stack = capture.error.stack;
      posthog.captureException(error, capture.properties ?? {});
    } else {
      posthog.capture(capture.event, capture.properties ?? {}, {
        send_instantly: true,
        transport: "fetch",
      });
    }
    const accepted = returned.slice(before).filter((value) => value !== null).length;
    await drain(sent.length + accepted);
  }
}

process.stdout.write(JSON.stringify({ sent, received, returned }));
process.exit(0);
