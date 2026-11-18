/** Experiment assignment itself; see `experiment.ts`. */
import type { Assignment, AssignmentSource, Experiment } from "./experiment.js";

/**
 * The whole assignment, self-contained: `scripts/generate-experiment-source.ts` copies its source into
 * `experiment-source.ts` for `experimentScript`, so it must not refer to anything outside its own body.
 */
export function pick(experiment: Experiment, prefix: string, search: string): Assignment {
  const label = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
  const { key, variants } = experiment;
  const first = variants[0];
  const valid = label.test(key) && variants.length <= 16 && new Set(variants).size === variants.length && variants.every((name) => label.test(name));
  if (!valid || typeof window === "undefined") return { key, variant: first, source: "fallback" };
  const scope = globalThis as unknown as Record<string, unknown>;
  const found: unknown = scope.__hranessExperiments;
  const held = (typeof found === "object" && found !== null ? found : (scope.__hranessExperiments = {})) as { id?: unknown; seen?: unknown };
  if (typeof held.seen !== "object" || held.seen === null) held.seen = {};
  const seen = held.seen as Record<string, { variant?: unknown; source?: unknown } | undefined>;
  const before = seen[key];
  if (variants.some((name) => name === before?.variant) && ["id", "page", "override"].includes(String(before?.source))) {
    return { key, variant: before?.variant as string, source: before?.source as AssignmentSource };
  }
  const attempt = (read: () => string | null | undefined) => {
    try {
      return read() ?? undefined;
    } catch {
      return undefined;
    }
  };
  let assignment: Assignment;
  const forced = attempt(() => new URLSearchParams(search).get(`exp-${key}`));
  if (forced !== undefined && variants.some((name) => name === forced)) {
    assignment = { key, variant: forced, source: "override" };
  } else {
    const cookie = (name: string) => attempt(() => {
      const part = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
      return part === undefined ? undefined : decodeURIComponent(part.slice(name.length + 1));
    });
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
    // An analytics no in any store: the stored ID is not used, whatever else is left.
    const refused = [cookie(`${prefix}-choice`), attempt(() => localStorage.getItem(`${prefix}-choice`)), attempt(() => sessionStorage.getItem(`${prefix}-choice`))]
      .some((value) => /(?:^|&)a=no(?:&|$)/u.test(value ?? ""));
    const stored = refused ? undefined : [
      attempt(() => (JSON.parse(localStorage.getItem(`${prefix}-touch`) ?? "null") as { id?: string } | null)?.id),
      cookie(`${prefix}-id`),
    ].find((value) => typeof value === "string" && uuid.test(value));
    let id = stored?.toLowerCase();
    if (id === undefined) {
      if (typeof held.id !== "string" || !uuid.test(held.id)) {
        // Without `crypto.randomUUID` (an insecure page), a UUID-shaped random ID, so the client can still adopt it.
        held.id = attempt(() => crypto.randomUUID()) ?? "10000000-1000-4000-8000-100000000000".replace(/[018]/gu, (digit) => (Number(digit) ^ (Math.floor(Math.random() * 16) >> (Number(digit) / 4))).toString(16));
      }
      id = String(held.id);
    }
    // FNV-1a, then MurmurHash3's finalizer so nearby IDs spread over the whole range.
    let hash = 0x811c9dc5;
    for (const char of `${key}.${id}`) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193);
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    hash ^= hash >>> 16;
    const given = experiment.weights;
    const weights = given !== undefined && given.length === variants.length && given.every((weight) => Number.isFinite(weight) && weight >= 0) && given.some((weight) => weight > 0)
      ? given
      : variants.map(() => 1);
    let point = ((hash >>> 0) / 4294967296) * weights.reduce((sum, weight) => sum + weight, 0);
    let chosen = first;
    for (const [index, name] of variants.entries()) {
      const weight = weights[index] ?? 0;
      if (weight <= 0) continue;
      chosen = name;
      if (point < weight) break;
      point -= weight;
    }
    assignment = { key, variant: chosen, source: stored === undefined ? "page" : "id" };
  }
  seen[key] = { variant: assignment.variant, source: assignment.source };
  return assignment;
}
