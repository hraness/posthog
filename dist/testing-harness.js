import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/testing-harness.ts
var chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
}
var input = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
var listeners = { addEventListener() {}, removeEventListener() {} };
var firstScenario = input.scenarios[0];
if (!firstScenario) {
  throw new Error("harness needs at least one scenario");
}
var pageLocation = new URL(firstScenario.href);
var pageDocument = {
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
  visibilityState: "visible"
};
var sent = [];
var browserGlobals = {
  document: pageDocument,
  location: pageLocation,
  navigator: {
    doNotTrack: null,
    language: "en-US",
    languages: ["en-US"],
    onLine: true,
    userAgent: input.userAgent,
    webdriver: false
  },
  screen: { height: 900, width: 1440 },
  window: globalThis,
  innerHeight: 900,
  innerWidth: 1440,
  ...listeners,
  fetch: async (_url, init = {}) => {
    const body = init.body;
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body instanceof ArrayBuffer ? new Uint8Array(body) : body instanceof Uint8Array ? body : new Uint8Array;
    sent.push(Buffer.from(bytes).toString("base64"));
    return new Response('{"status":1}', { status: 200 });
  }
};
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}
var { posthog } = await import("posthog-js");
var { createPostHogBrowserConfig } = await import("./client.js");
var received = [];
var returned = [];
var evidence = { href: firstScenario.href, referrer: firstScenario.referrer ?? "" };
var config = createPostHogBrowserConfig(input.site, evidence, input.apiHost);
var productionBeforeSend = config.before_send;
if (typeof productionBeforeSend !== "function") {
  throw new Error("production config has no before_send function");
}
posthog.init(input.apiKey, {
  ...config,
  capture_pageview: false,
  capture_pageleave: false,
  capture_performance: false,
  disable_external_dependency_loading: true,
  request_batching: false,
  before_send: (event) => {
    received.push(structuredClone(event));
    const result = productionBeforeSend(event);
    returned.push(structuredClone(result));
    return result;
  }
});
async function drain(expected) {
  for (const deadline = Date.now() + 5000;sent.length < expected && Date.now() < deadline; ) {
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
      if (capture.error.stack)
        error.stack = capture.error.stack;
      posthog.captureException(error, capture.properties ?? {});
    } else {
      posthog.capture(capture.event, capture.properties ?? {}, {
        send_instantly: true,
        transport: "fetch"
      });
    }
    const accepted = returned.slice(before).filter((value) => value !== null).length;
    await drain(sent.length + accepted);
  }
}
process.stdout.write(JSON.stringify({ sent, received, returned }));
process.exit(0);

//# debugId=5B8F504B363A7CB764756E2164756E21
