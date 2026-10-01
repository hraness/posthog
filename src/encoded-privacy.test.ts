import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fc from "fast-check";
import { normalizeAnalyticsProperties, pageNotFoundProperties, redactSensitiveText, sanitizeAnalyticsError, sanitizeProviderProperties } from "./event";
import { runPostHogHarness } from "./testing";
import { canonicalAnalyticsUrl, classifyAnalyticsRoute, isAllowedAnalyticsPath, type PostHogSiteDefinition } from "./site";

const site: PostHogSiteDefinition = {
  id: "example", canonicalDomain: "example.com", allowedHosts: ["example.com"], schemaVersion: 2,
  routes: [{ match: "prefix", path: "/article", pageKind: "article", captureSlug: true }],
  customEvents: [], excludedPaths: [{ match: "prefix", path: "/private" }],
};

test("encoded email paths are redacted at every emitted public boundary", () => {
  const path = "/article/person.contract%40example.com";
  const url = `https://example.com${path}?private=1#secret`;
  expect(classifyAnalyticsRoute(site, url)).toMatchObject({ canonical_path: "/article/[email]", content_slug: "[email]" });
  expect(canonicalAnalyticsUrl(site, path)).toBe("https://example.com/article/[email]");
  expect(pageNotFoundProperties({ requestedPath: url })).toEqual({ requested_path: "/article/[email]" });
  const result = sanitizeProviderProperties(site, {
    $current_url: url, $pathname: path, requested_path: path, canonical_path: path,
    nested: { message: path }, $initial_current_url: url, $referrer: url,
  });
  expect(result).toMatchObject({ $current_url: "https://example.com/article/[email]", $pathname: "/article/[email]", nested: { message: "/article/[email]" } });
  expect(JSON.stringify(result)).not.toContain("person.contract");
});

test("inspection preserves reserved bytes, Unicode, and malformed escapes outside redacted spans", () => {
  const prefix = "/café/%E2%98%83/%2F/%3f/%23/%zz/";
  expect(redactSensitiveText(prefix + "person%2540example.com/%E0%A4%A/end")).toBe(prefix + "[email]/%E0%A4%A/end");
  expect(redactSensitiveText(prefix + "plain%20text")).toBe(prefix + "plain%20text");
  expect(redactSensitiveText("/bad%/person%40example.com")).toBe("/bad%/[email]");
  expect(redactSensitiveText("/safe/%70hc_private/%65yJabc.def.ghi")).toBe("/safe/[credential]/[credential]");
});

test("over-cap nested encodings fail closed without changing literal path separators", () => {
  const encoded = "person%" + "25".repeat(12) + "40example.com";
  expect(redactSensitiveText(`/safe/${encoded}/end`)).toBe("/safe/[redacted]/end");
  expect(redactSensitiveText("x".repeat(32_768) + "%40")).toBe("[redacted]");
});

test("stricter attribution and encoded private-route eligibility stay in effect", () => {
  expect(isAllowedAnalyticsPath(site, "/%70rivate/value")).toBe(false);
  expect(isAllowedAnalyticsPath(site, "/private%2fvalue")).toBe(false);
  expect(isAllowedAnalyticsPath(site, "/private/%zz")).toBe(false);
  const properties = sanitizeProviderProperties({ ...site, attributionMode: "referrer_only", privacyMode: "minimal" }, {
    $current_url: "https://example.com/article/person%40example.com?utm_source=private",
    $referrer: "https://outside.com/path/person%40example.com?q=private",
    utm_source: "private", ph_keyword: "private",
  });
  expect(properties).toEqual({ $current_url: "https://example.com/article/[email]", $referrer: "https://outside.com" });
});

test("property: mixed and recursively percent-encoded emails do not escape", () => {
  const word = fc.stringMatching(/^[a-z]{1,16}$/u);
  fc.assert(fc.property(word, word, fc.integer({ min: 1, max: 6 }), (local, host, depth) => {
    let email = `${local}@${host}.com`;
    for (let pass = 0; pass < depth; pass += 1) email = encodeURIComponent(email);
    expect(redactSensitiveText(`/safe%2Fsegment/${email}/end%3F`)).toBe("/safe%2Fsegment/[email]/end%3F");
  }));
});


test("actual SDK wire requests redact encoded path identifiers without analytics delivery", () => {
  const result = runPostHogHarness({ site, scenarios: [{
    href: "https://example.com/article/person.contract%40example.com",
    captures: [{ event: "$pageview" }],
  }] });
  expect(JSON.stringify(result.received)).toContain("person.contract%40example.com");
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0]?.properties).toMatchObject({ canonical_path: "/article/[email]", content_slug: "[email]", $current_url: "https://example.com/article/[email]" });
  expect(JSON.stringify(result.sent)).not.toContain("person.contract");
}, 30_000);


test("redaction precedes path, slug, property, and exception length caps", () => {
  const address = "person.contract%40example.com";
  const path = "/article/" + "a".repeat(480) + "/" + address;
  expect(classifyAnalyticsRoute(site, path)?.canonical_path).not.toContain("person");
  expect(canonicalAnalyticsUrl(site, path)).not.toContain("person");
  expect(pageNotFoundProperties({ requestedPath: path })?.requested_path).not.toContain("person");
  const slug = "/article/" + "a".repeat(140) + "/" + address;
  expect(classifyAnalyticsRoute(site, slug)?.content_slug).not.toContain("person");
  expect(normalizeAnalyticsProperties({ text: "a".repeat(240) + "/" + address }).text).not.toContain("person");
  const error = new Error("a".repeat(495) + "/" + address);
  error.stack = "/article/" + address;
  const safeError = sanitizeAnalyticsError(error);
  expect(safeError.message).not.toContain("person");
  expect(safeError.stack).toBe("/article/[email]");
  expect(sanitizeProviderProperties(site, { text: "a".repeat(2030) + "/" + address }).text).not.toContain("person");
});


test("inspection redacts every credential class and mixed Unicode email local parts", () => {
  const cases = [
    ["Bearer%20canary_secret_123", "Bearer%20[credential]"],
    ["api_key%3Dcanary_secret_123", "api_key%3D[redacted]"],
    ["https%3A%2F%2Fcanary_user%3Acanary_password%40example.com/path", "https%3A%2F%2F[credential]%40example.com/path"],
    ["https%3a%2f%2fcanary_user%40example.com/path", "https%3a%2f%2f[credential]%40example.com/path"],
    ["/personé%40example.com", "/[email]"],
    ["/person%C3%A9%40example.com", "/[email]"],
    ["/personé@example.com", "/[email]"],
    ["/person@例子.中国", "/[email]"],
    ["/person%40%E4%BE%8B%E5%AD%90.%E4%B8%AD%E5%9B%BD", "/[email]"],
    ["/caf%C3%A9/%F0%9F%8C%BB/person%40example.com", "/caf%C3%A9/%F0%9F%8C%BB/[email]"],
  ] as const;
  for (const [input, output] of cases) {
    expect(redactSensitiveText(input)).toBe(output);
    expect(sanitizeAnalyticsError(new Error(input)).message).toBe(output);
    expect(sanitizeProviderProperties(site, { text: input }).text).toBe(output);
  }
});

test("property: encoded bearer and assignment secrets never reach generic properties", () => {
  fc.assert(fc.property(
    fc.stringMatching(/^[a-z]{8,24}$/u), fc.integer({ min: 1, max: 6 }),
    (secret, depth) => {
      for (const prefix of ["Bearer ", "api_key=", "password=", "authorization="]) {
        let input = prefix + secret;
        for (let pass = 0; pass < depth; pass += 1) input = encodeURIComponent(input);
        expect(JSON.stringify(sanitizeProviderProperties(site, { text: input }))).not.toContain(secret);
      }
    },
  ));
});

test("actual SDK exception payloads redact encoded credential classes", () => {
  const canaries = ["person%40%E4%BE%8B%E5%AD%90.%E4%B8%AD%E5%9B%BD", "Bearer%20canary_bearer_secret", "api_key%3Dcanary_key_secret", "https%3A%2F%2Fcanary_user%3Acanary_password%40example.com/path", "personé%40example.com"];
  const result = runPostHogHarness({ site, scenarios: [{ href: "https://example.com/article/public", captures: canaries.map(message => ({ event: "$exception", error: { message, stack: message } })) }] });
  expect(result.sent.length).toBeGreaterThan(0);
  expect(JSON.stringify(result.received)).toContain("canary");
  expect(JSON.stringify(result.sent)).not.toContain("canary");
  expect(JSON.stringify(result.sent)).not.toContain("personé");
}, 30_000);

test("property: mixed raw and encoded Unicode email parts are redacted", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom("a", "é", "中", "ि"), { minLength: 1, maxLength: 16 }),
    fc.boolean(), fc.boolean(),
    (letters, encodeLocal, encodeDomain) => {
      const local = letters.join("");
      const domain = "例子.中国";
      const email = `${encodeLocal ? encodeURIComponent(local) : local}%40${encodeDomain ? encodeURIComponent(domain) : domain}`;
      expect(redactSensitiveText(`/caf%C3%A9/${email}/end%2F`)).toBe("/caf%C3%A9/[email]/end%2F");
    },
  ));
});


test("identifier inspection has bounded near-miss and many-match runtime", () => {
  const source = new URL("./event.ts", import.meta.url).href;
  const script = `import { redactSensitiveText } from ${JSON.stringify(source)};
    const overflow = "a".repeat(64000);
    if (redactSensitiveText(overflow) !== "[redacted]") throw new Error("overflow not closed");
    const samples = ["a".repeat(32000), "a".repeat(16000) + "@" + "b".repeat(16000), "x@" + "b.".repeat(15000) + "1", "a/".repeat(16000), "a%40b.co/".repeat(3000), "Bearer%20canary ".repeat(1500)];
    for (let pass = 0; pass < 16; pass += 1) for (const input of samples) {
      const output = redactSensitiveText(input);
      if (output.includes("%40") || output.includes("canary")) throw new Error("leaked match");
    }
    console.log("bounded inspection passed");`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("bounded inspection passed");
}, 10_000);


test("punctuated URL credentials and adjacent raw or encoded emails redact independently", () => {
  const cases = [
    ["...https://canary_user:canary_password@example.com/path", "...https://[credential]@example.com/path"],
    ["...https%3A%2F%2Fcanary_user%3Acanary_password%40example.com/path", "...https%3A%2F%2F[credential]%40example.com/path"],
    ["a@b.com+c@d.com", "[email]+[email]"],
    ["a%40b.com%2Bc%40d.com", "[email]%2B[email]"],
  ] as const;
  for (const [input, output] of cases) {
    expect(redactSensitiveText(input)).toBe(output);
    expect(sanitizeProviderProperties(site, { text: input }).text).toBe(output);
  }
});

test("punctuation-only email local parts remain redacted without consuming adjacent separators", () => {
  for (const local of ["+", "_", "%", "-", ".", ".%+-_"]) {
    const email = `${local}@a.aa`;
    for (const input of [email, encodeURIComponent(email), encodeURIComponent(encodeURIComponent(email))]) {
      expect(redactSensitiveText(`/notes/${input}/end%2F`)).toBe("/notes/[email]/end%2F");
      expect(sanitizeProviderProperties(site, { text: input }).text).toBe("[email]");
    }
  }
  expect(redactSensitiveText("a@b.com+c@d.com")).toBe("[email]+[email]");
  expect(redactSensitiveText("a%40b.com%2Bc%40d.com")).toBe("[email]%2B[email]");
});
