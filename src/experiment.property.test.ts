import { afterEach, expect, test } from "bun:test";
import * as fc from "fast-check";

import { assign, EXPERIMENT_GLOBAL, type Experiment } from "./experiment.js";

afterEach(() => {
  for (const name of ["window", "location", "document", "localStorage", EXPERIMENT_GLOBAL]) Reflect.deleteProperty(globalThis, name);
});

function visit(id: string, search = "") {
  Reflect.deleteProperty(globalThis, EXPERIMENT_GLOBAL);
  Object.assign(globalThis, {
    window: {},
    location: { search },
    document: { cookie: `example-id=${id}` },
    localStorage: { getItem: () => null },
  });
}
const label = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,15}$/u);
const experiment = fc.uniqueArray(label, { minLength: 1, maxLength: 6 }).chain((variants) =>
  fc.record({
    key: label,
    variants: fc.constant(variants as unknown as readonly [string, ...string[]]),
    weights: fc.option(fc.array(fc.oneof(fc.double({ min: 0, max: 100, noNaN: true }), fc.constantFrom(Number.NaN, -1, Infinity)), { minLength: variants.length, maxLength: variants.length }), { nil: undefined }),
  }),
);

test("property: one stored ID gets one listed variant, the same on every page", () => {
  fc.assert(
    fc.property(experiment, fc.uuid({ version: 4 }), (exp, id) => {
      const shape: Experiment = exp;
      visit(id);
      const first = assign(shape, { siteId: "example" });
      expect(shape.variants).toContain(first.variant);
      expect(first.source).toBe("id");
      visit(id);
      expect(assign(shape, { siteId: "example" })).toEqual(first);
    }),
  );
});

test("property: a variant with weight 0 is never assigned while another has weight", () => {
  fc.assert(
    fc.property(experiment, fc.uuid({ version: 4 }), (exp, id) => {
      const weights = exp.variants.map((_, index) => (index === 0 ? 0 : 1));
      visit(id);
      const made = assign({ key: exp.key, variants: exp.variants, weights }, { siteId: "example" });
      if (exp.variants.length > 1) expect(made.variant).not.toBe(exp.variants[0]);
    }),
  );
});

test("property: the override never picks a variant outside the list", () => {
  fc.assert(
    fc.property(experiment, fc.string({ maxLength: 20 }), fc.uuid({ version: 4 }), (exp, forced, id) => {
      visit(id, `?${new URLSearchParams({ [`exp-${exp.key}`]: forced }).toString()}`);
      const made = assign({ key: exp.key, variants: exp.variants }, { siteId: "example" });
      expect(exp.variants).toContain(made.variant);
      expect(made.source).toBe(exp.variants.includes(forced) ? "override" : "id");
    }),
  );
});

test("property: equal weights split IDs evenly", () => {
  const header = { key: "header-cta", variants: ["control", "free"] } as const;
  fc.assert(
    fc.property(fc.uniqueArray(fc.uuid({ version: 4 }), { minLength: 4000, maxLength: 4000 }), (ids) => {
      let free = 0;
      for (const id of ids) {
        visit(id);
        if (assign(header, { siteId: "example" }).variant === "free") free += 1;
      }
      // 4000 fair coin flips land within 5 standard deviations (about 158) of 2000.
      expect(Math.abs(free - 2000)).toBeLessThan(160);
    }),
    { numRuns: 5 },
  );
});
