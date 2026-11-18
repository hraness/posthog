/**
 * Experiment assignment against a small fake page: the stored first-party ID, the per-page fallback, an analytics no,
 * the query override, weights, and the inline script.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { assign, EXPERIMENT_GLOBAL, experimentScript, heldExperiments, parseAssignment, type Experiment } from "./experiment.js";

const HEADER = { key: "header-cta", variants: ["control", "free"] } as const satisfies Experiment;
const SITE = { siteId: "example" } as const;
const ID = "0b9f3c1e-6a3d-4c55-9a2f-7d1e2b3c4d5e";

const saved = new Map<string, PropertyDescriptor | undefined>();
function setGlobal(name: string, value: unknown) {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  saved.clear();
  Reflect.deleteProperty(globalThis, EXPERIMENT_GLOBAL);
});

function page(options: { search?: string; cookies?: Record<string, string>; local?: Record<string, string>; blocked?: boolean } = {}) {
  const attributes = new Map<string, string>();
  const cookies = Object.entries(options.cookies ?? {}).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
  const local = new Map(Object.entries(options.local ?? {}));
  setGlobal("window", {});
  setGlobal("location", { search: options.search ?? "" });
  setGlobal("document", {
    get cookie(): string {
      if (options.blocked === true) throw new Error("blocked");
      return cookies;
    },
    documentElement: { setAttribute: (name: string, value: string) => { attributes.set(name, value); } },
  });
  setGlobal("localStorage", {
    getItem(key: string) {
      if (options.blocked === true) throw new Error("blocked");
      return local.get(key) ?? null;
    },
  });
  return { attributes, local };
}
const newPage = () => { Reflect.deleteProperty(globalThis, EXPERIMENT_GLOBAL); };

describe("experiment assignment", () => {
  test("the stored first-party ID gives one variant on every page", () => {
    page({ cookies: { "example-id": ID } });
    const first = assign(HEADER, SITE);
    expect(first.source).toBe("id");
    for (let index = 0; index < 5; index += 1) {
      newPage();
      expect(assign(HEADER, SITE)).toEqual(first);
    }
    // The first-touch record's ID wins over the cookie, as in the client.
    newPage();
    page({ cookies: { "example-id": "11111111-1111-4111-8111-111111111111" }, local: { "example-touch": JSON.stringify({ id: ID }) } });
    expect(assign(HEADER, SITE)).toEqual(first);
  });

  test("a custom storage prefix reads its own ID", () => {
    page({ cookies: { "site-id": ID } });
    expect(assign(HEADER, { siteId: "example", storagePrefix: "site" }).source).toBe("id");
    newPage();
    expect(assign(HEADER, SITE).source).toBe("page");
  });

  test("without a stored ID: a page assignment from a held random ID, stable within the page, nothing stored", () => {
    const tab = page();
    const first = assign(HEADER, SITE);
    expect(first.source).toBe("page");
    const held = heldExperiments();
    expect(held.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(held.assignments).toEqual([first]);
    for (let index = 0; index < 5; index += 1) expect(assign(HEADER, SITE)).toEqual(first);
    expect(tab.local.size).toBe(0);
    // Once the client stores that ID, the next page gets the same variant from it.
    newPage();
    page({ cookies: { "example-id": held.id ?? "" } });
    expect(assign(HEADER, SITE)).toEqual({ ...first, source: "id" });
  });

  test("an analytics no in either store leaves the stored ID unused", () => {
    page({ cookies: { "example-id": ID, "example-choice": "a=no&d=no&t=1" } });
    expect(assign(HEADER, SITE).source).toBe("page");
    newPage();
    page({ cookies: { "example-id": ID }, local: { "example-choice": "a=no" } });
    expect(assign(HEADER, SITE).source).toBe("page");
    newPage();
    page({ cookies: { "example-id": ID, "example-choice": "a=yes&d=no" } });
    expect(assign(HEADER, SITE).source).toBe("id");
  });

  test("an analytics no kept only for the session also leaves the stored ID unused", () => {
    page({ cookies: { "example-id": ID } });
    setGlobal("sessionStorage", { getItem: (key: string) => (key === "example-choice" ? "a=no" : null) });
    expect(assign(HEADER, SITE).source).toBe("page");
  });

  test("without crypto.randomUUID the page ID is still a UUID the client can adopt", () => {
    page();
    setGlobal("crypto", {});
    assign(HEADER, SITE);
    expect(heldExperiments().id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  test("blocked storage still assigns", () => {
    page({ blocked: true });
    expect(assign(HEADER, SITE).source).toBe("page");
  });

  test("the query override picks a listed variant and is marked, an unlisted one is ignored", () => {
    page({ search: "?exp-header-cta=free&utm_source=x", cookies: { "example-id": ID } });
    expect(assign(HEADER, SITE)).toEqual({ key: "header-cta", variant: "free", source: "override" });
    newPage();
    page({ search: "?exp-header-cta=nope", cookies: { "example-id": ID } });
    expect(assign(HEADER, SITE).source).toBe("id");
  });

  test("a zero weight is never chosen; invalid weights mean equal ones", () => {
    page();
    for (let index = 0; index < 200; index += 1) {
      newPage();
      expect(assign({ ...HEADER, weights: [0, 1] }, SITE).variant).toBe("free");
    }
    const counts = { control: 0, free: 0 };
    for (let index = 0; index < 2000; index += 1) {
      newPage();
      counts[assign({ ...HEADER, weights: [1, Number.NaN] }, SITE).variant] += 1;
    }
    expect(counts.control).toBeGreaterThan(850);
    expect(counts.free).toBeGreaterThan(850);
  });

  test("an invalid experiment or no browser gets the first variant as a fallback", () => {
    expect(assign(HEADER, SITE)).toEqual({ key: "header-cta", variant: "control", source: "fallback" });
    expect(heldExperiments()).toEqual({ id: undefined, assignments: [] });
    page();
    for (const bad of [
      { key: "Header CTA", variants: ["control", "free"] },
      { key: "header-cta", variants: ["control", "control"] },
      { key: "header-cta", variants: ["control", "Free"] },
    ] as const) {
      expect(assign(bad as Experiment, SITE).source).toBe("fallback");
    }
    expect(heldExperiments().assignments).toEqual([]);
  });

  test("a junk global is replaced, and junk entries are not reported", () => {
    page();
    Object.assign(globalThis, { [EXPERIMENT_GLOBAL]: { id: 5, seen: { "header-cta": { variant: "other", source: "id" }, "x y": { variant: "a", source: "id" } } } });
    const made = assign(HEADER, SITE);
    expect(made.source).toBe("page");
    expect(heldExperiments().assignments).toEqual([made]);
    Object.assign(globalThis, { [EXPERIMENT_GLOBAL]: "nope" });
    expect(assign(HEADER, SITE).source).toBe("page");
  });

  test("parseAssignment keeps only well-formed assignments", () => {
    expect(parseAssignment({ key: "header-cta", variant: "free", source: "page" })).toEqual({ key: "header-cta", variant: "free", source: "page" });
    for (const bad of [null, "x", { key: "header-cta", variant: "free", source: "maybe" }, { key: "Header", variant: "free", source: "id" }, { key: "a", variant: "<b>", source: "id" }]) {
      expect(parseAssignment(bad)).toBeUndefined();
    }
  });

  test("the inline script sets data-exp-<key> before paint and agrees with assign", () => {
    const tab = page({ cookies: { "example-id": ID } });
    const script = experimentScript([HEADER, { key: "pricing", variants: ["control", "annual"], weights: [1, 3] }], SITE);
    expect(script).not.toContain("</script");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the published inline script exactly as a page would.
    (new Function(script) as () => void)();
    const expected = assign(HEADER, SITE);
    expect(tab.attributes.get("data-exp-header-cta")).toBe(expected.variant);
    newPage();
    expect(assign(HEADER, SITE)).toEqual(expected);
    expect(tab.attributes.has("data-exp-pricing")).toBe(true);
    // A hostile key cannot close the script tag.
    expect(experimentScript([{ key: "</script><script>alert(1)", variants: ["control"] }], SITE)).not.toContain("</script");
  });
});
