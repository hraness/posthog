import { expect, test } from "bun:test";

import { daysBucket, durationBucket, isEventName, MILESTONES, SHARED_EVENTS, type PropsOf } from "./events.ts";

test("every shared event follows the naming rule and appears once", () => {
  for (const name of SHARED_EVENTS) expect(isEventName(name)).toBe(true);
  expect(new Set(SHARED_EVENTS).size).toBe(SHARED_EVENTS.length);
  for (const bad of ["CTA Clicked", "cta_clicked", "", "a  b", 5]) expect(isEventName(bad)).toBe(false);
  expect(isEventName("$pageview")).toBe(true);
});

test("buckets", () => {
  expect([0, 1, 3, 10, 45].map(daysBucket)).toEqual(["0", "1", "2-6", "7-29", "30+"]);
  expect([10, 1000, 6000, 60_000, Number.NaN].map(durationBucket)).toEqual(["<1s", "1-5s", "5-30s", "30s+", "<1s"]);
  expect(MILESTONES).toEqual([1, 3, 10, 30, 100]);
});

test("shared events have typed properties", () => {
  const cta: PropsOf<"cta clicked"> = { cta: "download", placement: "hero" };
  // @ts-expect-error a shared event needs its properties
  const missing: PropsOf<"cta clicked"> = { cta: "download" };
  expect([cta, missing]).toHaveLength(2);
});
