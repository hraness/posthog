/**
 * A/B assignment that runs before the analytics client: synchronous, dependency-free and local. No PostHog flag is
 * evaluated and nothing is stored. A visitor with the package's first-party ID keeps one variant across pages; one
 * without gets a variant for this page, from a random ID the client adopts if it later starts persistent analytics.
 * `createAnalytics` reports each assignment PostHog Experiments can read: `$feature/<key>` on every later event and
 * one `$feature_flag_called` per page.
 */

import { pick } from "./experiment-pick.js";
import { PICK_SOURCE } from "./experiment-source.js";

/** An experiment: a key matching the PostHog experiment's feature flag key, its variants and optional weights. */
export type Experiment<V extends string = string> = Readonly<{
  /** Lower-case letters, digits, `-` and `_`, up to 64 characters. The same key as the PostHog experiment. */
  key: string;
  /** Up to 16 distinct labels in the same alphabet. The first is the control. */
  variants: readonly [V, ...V[]];
  /** One non-negative weight per variant. Missing or invalid: equal weights. */
  weights?: readonly number[] | undefined;
}>;

/**
 * Where a variant came from: `id` the stored first-party ID (stable across pages), `page` this page alone, `override`
 * the `?exp-<key>=<variant>` query (never reported), `fallback` an invalid experiment or no browser (the first
 * variant, never reported).
 */
export type AssignmentSource = "id" | "page" | "override" | "fallback";

export type Assignment<V extends string = string> = Readonly<{ key: string; variant: V; source: AssignmentSource }>;

/** The same `siteId` and `storagePrefix` the page passes to `createAnalytics`, so both read one first-party ID. */
export type ExperimentSite = Readonly<{ siteId: string; storagePrefix?: string | undefined }>;

/** Where this page's assignments are held, so a later `createAnalytics` can report them. */
export const EXPERIMENT_GLOBAL = "__hranessExperiments";

const prefixOf = (site: ExperimentSite) => site.storagePrefix ?? site.siteId;

/**
 * This page's variant of an experiment, decided at once with no network request. Call it while the page draws; the
 * same experiment on the same page always gets the same answer. Outside a browser it returns the first variant with
 * source `fallback`.
 */
export function assign<const V extends string>(experiment: Experiment<V>, site: ExperimentSite): Assignment<V> {
  let search = "";
  try {
    search = typeof location === "undefined" ? "" : location.search;
  } catch {
    // Blocked: no override.
  }
  return pick(experiment, prefixOf(site), search) as Assignment<V>;
}

/**
 * An inline `<head>` script that assigns each experiment before the page paints and sets `data-exp-<key>="<variant>"`
 * on `<html>`, so CSS can show the variant with no flicker. Server-rendered pages can render every variant and let
 * the attribute choose. The script has no imports.
 */
export function experimentScript(experiments: readonly Experiment[], site: ExperimentSite): string {
  const data = JSON.stringify(experiments.map(({ key, variants, weights }) => ({ key, variants, ...(weights === undefined ? {} : { weights }) })));
  const prefix = JSON.stringify(prefixOf(site));
  // Since ES2019 a string literal may hold U+2028 and U+2029; only `</script>` could end the script early.
  const safe = (text: string) => text.replace(/</gu, "\\u003c");
  return `(()=>{const pick=${PICK_SOURCE};for(const e of ${safe(data)}){try{const a=pick(e,${safe(prefix)},location.search);document.documentElement.setAttribute("data-exp-"+a.key,a.variant)}catch{}}})();`;
}

/** An assignment parsed from `unknown`, or undefined. */
export function parseAssignment(value: unknown): Assignment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { key, variant, source } = value as Record<string, unknown>;
  const label = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
  if (typeof key !== "string" || !label.test(key) || typeof variant !== "string" || !label.test(variant)) return undefined;
  if (source !== "id" && source !== "page" && source !== "override" && source !== "fallback") return undefined;
  return { key, variant, source };
}

/** What this page has assigned so far, and the page ID the client may adopt. */
export function heldExperiments(): Readonly<{ id: string | undefined; assignments: readonly Assignment[] }> {
  const held = (globalThis as unknown as Record<string, unknown>)[EXPERIMENT_GLOBAL];
  if (typeof held !== "object" || held === null) return { id: undefined, assignments: [] };
  const { id, seen } = held as Record<string, unknown>;
  const assignments = typeof seen === "object" && seen !== null
    ? Object.entries(seen).flatMap(([key, entry]) => {
      const parsed = parseAssignment({ ...(typeof entry === "object" ? entry : {}), key });
      return parsed === undefined ? [] : [parsed];
    })
    : [];
  return { id: typeof id === "string" ? id : undefined, assignments };
}
