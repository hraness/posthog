// src/experiment.ts
var EXPERIMENT_GLOBAL = "__hranessExperiments";
var prefixOf = (site) => site.storagePrefix ?? site.siteId;
function pick(experiment, prefix, search) {
  const label = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
  const { key, variants } = experiment;
  const first = variants[0];
  const valid = label.test(key) && variants.length <= 16 && new Set(variants).size === variants.length && variants.every((name) => label.test(name));
  if (!valid || typeof window === "undefined")
    return { key, variant: first, source: "fallback" };
  const scope = globalThis;
  const found = scope.__hranessExperiments;
  const held = typeof found === "object" && found !== null ? found : scope.__hranessExperiments = {};
  if (typeof held.seen !== "object" || held.seen === null)
    held.seen = {};
  const seen = held.seen;
  const before = seen[key];
  if (variants.some((name) => name === before?.variant) && ["id", "page", "override"].includes(String(before?.source))) {
    return { key, variant: before?.variant, source: before?.source };
  }
  const attempt = (read) => {
    try {
      return read() ?? undefined;
    } catch {
      return;
    }
  };
  let assignment;
  const forced = attempt(() => new URLSearchParams(search).get(`exp-${key}`));
  if (forced !== undefined && variants.some((name) => name === forced)) {
    assignment = { key, variant: forced, source: "override" };
  } else {
    const cookie = (name) => attempt(() => {
      const part = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
      return part === undefined ? undefined : decodeURIComponent(part.slice(name.length + 1));
    });
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
    const refused = [cookie(`${prefix}-choice`), attempt(() => localStorage.getItem(`${prefix}-choice`))].some((value) => /(?:^|&)a=no(?:&|$)/u.test(value ?? ""));
    const stored = refused ? undefined : [
      attempt(() => JSON.parse(localStorage.getItem(`${prefix}-touch`) ?? "null")?.id),
      cookie(`${prefix}-id`)
    ].find((value) => typeof value === "string" && uuid.test(value));
    let id = stored?.toLowerCase();
    if (id === undefined) {
      if (typeof held.id !== "string" || !uuid.test(held.id))
        held.id = attempt(() => crypto.randomUUID()) ?? String(Math.random());
      id = String(held.id);
    }
    let hash = 2166136261;
    for (const char of `${key}.${id}`)
      hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
    hash = Math.imul(hash ^ hash >>> 16, 2246822507);
    hash = Math.imul(hash ^ hash >>> 13, 3266489909);
    hash ^= hash >>> 16;
    const given = experiment.weights;
    const weights = given !== undefined && given.length === variants.length && given.every((weight) => Number.isFinite(weight) && weight >= 0) && given.some((weight) => weight > 0) ? given : variants.map(() => 1);
    let point = (hash >>> 0) / 4294967296 * weights.reduce((sum, weight) => sum + weight, 0);
    let chosen = first;
    for (const [index, name] of variants.entries()) {
      const weight = weights[index] ?? 0;
      if (weight <= 0)
        continue;
      chosen = name;
      if (point < weight)
        break;
      point -= weight;
    }
    assignment = { key, variant: chosen, source: stored === undefined ? "page" : "id" };
  }
  seen[key] = { variant: assignment.variant, source: assignment.source };
  return assignment;
}
function assign(experiment, site) {
  let search = "";
  try {
    search = typeof location === "undefined" ? "" : location.search;
  } catch {}
  return pick(experiment, prefixOf(site), search);
}
function experimentScript(experiments, site) {
  const data = JSON.stringify(experiments.map(({ key, variants, weights }) => ({ key, variants, ...weights === undefined ? {} : { weights } })));
  const prefix = JSON.stringify(prefixOf(site));
  const safe = (text) => text.replace(/</gu, "\\u003c");
  return `(()=>{const pick=${pick.toString()};for(const e of ${safe(data)}){try{const a=pick(e,${safe(prefix)},location.search);document.documentElement.setAttribute("data-exp-"+a.key,a.variant)}catch{}}})();`;
}
function parseAssignment(value) {
  if (typeof value !== "object" || value === null)
    return;
  const { key, variant, source } = value;
  const label = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
  if (typeof key !== "string" || !label.test(key) || typeof variant !== "string" || !label.test(variant))
    return;
  if (source !== "id" && source !== "page" && source !== "override" && source !== "fallback")
    return;
  return { key, variant, source };
}
function heldExperiments() {
  const held = globalThis[EXPERIMENT_GLOBAL];
  if (typeof held !== "object" || held === null)
    return { id: undefined, assignments: [] };
  const { id, seen } = held;
  const assignments = typeof seen === "object" && seen !== null ? Object.entries(seen).flatMap(([key, entry]) => {
    const parsed = parseAssignment({ ...typeof entry === "object" ? entry : {}, key });
    return parsed === undefined ? [] : [parsed];
  }) : [];
  return { id: typeof id === "string" ? id : undefined, assignments };
}
export {
  parseAssignment,
  heldExperiments,
  experimentScript,
  assign,
  EXPERIMENT_GLOBAL
};

//# debugId=38701828ABE373A964756E2164756E21
