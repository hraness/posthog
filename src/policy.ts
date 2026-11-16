/**
 * The region policy: what a visitor's region allows before and after they answer the consent question.
 *
 * Pure data and functions with no browser, provider or Node import, so the browser, the edge, the server, the CLI
 * and (through the generated Swift table) the Mac app read one table.
 *
 * Region comes from the edge's country header. The clock's time zone is used only when the country is unknown,
 * and a visitor whose region cannot be told is treated like the European Union: nothing is kept until they say yes.
 */

/** Where the visitor is, as the policy groups places. */
export type RegionGroup = "eu" | "uk_ch" | "br" | "us" | "row";
/** How first-party analytics identifies a visitor. `persistent` keeps a first-party ID; `cookieless` keeps nothing. */
export type AnalyticsMode = "persistent" | "cookieless";
/** What the consent banner asks about: nothing, ads and recordings only, or everything. */
export type AskScope = "none" | "ads" | "all";
/** A visitor's answer. `undefined` means they have not answered. */
export type Choice = "yes" | "no";

/**
 * A visitor's stored answers. `analytics` is the answer about first-party analytics (the European question, or the
 * privacy page's opt-out link). `ads` is the answer about ads and session recordings (the UK, Swiss and Brazilian
 * banner, the European banner, or the "Your Privacy Choices" link).
 */
export type Choices = Readonly<{ analytics?: Choice | undefined; ads?: Choice | undefined }>;

export type PolicyInput = Readonly<{
  /** ISO 3166-1 alpha-2 country from the edge (`cf-ipcountry`, `x-vercel-ip-country`), any case. */
  country?: string | null | undefined;
  /** IANA time zone, used only when the country is missing or unknown. */
  zone?: string | null | undefined;
  /** Global Privacy Control (`navigator.globalPrivacyControl`, `Sec-GPC: 1`) or a stored account opt-out. */
  gpc?: boolean | undefined;
  choices?: Choices | undefined;
}>;

export type RegionPolicy = Readonly<{
  region_group: RegionGroup;
  /** First-party analytics identity. */
  analytics: AnalyticsMode;
  /** Autocapture, heatmaps, rage clicks, dead clicks and Web Vitals attribution (subject to the surface preset). */
  autocapture: boolean;
  /** Session replay (subject to the surface preset: never on private surfaces). */
  replay: boolean;
  /** Meta Pixel, Conversions API and storing ad click IDs. */
  ads: boolean;
  /** What the banner should ask now. `none` once answered or where nothing needs asking. */
  ask: AskScope;
}>;

/** One row of the region table: the defaults before any answer. */
export type RegionRule = Readonly<{
  analytics: AnalyticsMode;
  autocapture: boolean;
  replay: boolean;
  ads: boolean;
  /** What the banner asks before an answer. */
  ask: AskScope;
}>;

/**
 * The region table (owner decision, 2026-11-16).
 *
 * - EU/EEA and unknown: cookieless until yes; one question covers analytics, recordings and ads.
 * - UK, Switzerland, Brazil: analytics on by default; the banner asks only about ads and recordings.
 * - US and the rest of the world: everything on, with a "Your Privacy Choices" link instead of a banner.
 *
 * GPC turns off ads and replay in every region and nothing else. Do Not Track is ignored.
 */
export const REGION_TABLE: Readonly<Record<RegionGroup, RegionRule>> = {
  eu: { analytics: "cookieless", autocapture: false, replay: false, ads: false, ask: "all" },
  uk_ch: { analytics: "persistent", autocapture: true, replay: false, ads: false, ask: "ads" },
  br: { analytics: "persistent", autocapture: true, replay: false, ads: false, ask: "ads" },
  us: { analytics: "persistent", autocapture: true, replay: true, ads: true, ask: "none" },
  row: { analytics: "persistent", autocapture: true, replay: true, ads: true, ask: "none" },
};

/**
 * EU member states, the other EEA states, and EU territories with their own ISO code. Crown dependencies and
 * Gibraltar are listed too: their own GDPR-style laws make asking first the safe reading.
 */
export const EU_COUNTRIES: readonly string[] = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV",
  "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
  "IS", "LI", "NO",
  "AX", "GF", "GP", "MQ", "RE", "YT", "MF",
  "GG", "JE", "IM", "GI",
];
export const UK_CH_COUNTRIES: readonly string[] = ["GB", "CH"];
export const BR_COUNTRIES: readonly string[] = ["BR"];
/** The United States and its territories. */
export const US_COUNTRIES: readonly string[] = ["US", "PR", "GU", "VI", "AS", "MP", "UM"];

/** Zones that name no place: the region is unknown. */
export const PLACELESS_ZONE = /^(?:UTC|UCT|GMT|GMT0|GMT[+-]0|Greenwich|Universal|Zulu|Factory|Etc\/.*)$/u;
export const UK_CH_ZONE = /^(?:Europe\/(?:London|Belfast|Zurich)|GB|GB-Eire)$/u;
export const EU_ZONE =
  /^(?:Europe\/.*|Arctic\/.*|Atlantic\/(?:Reykjavik|Canary|Madeira|Azores|Faroe|Faeroe|Jan_Mayen)|Asia\/(?:Nicosia|Famagusta)|Africa\/Ceuta|Indian\/(?:Reunion|Mayotte)|America\/(?:Guadeloupe|Martinique|Cayenne|Marigot|St_Barthelemy)|Eire|Iceland|Portugal|Poland|CET|MET|EET|WET)$/u;
export const BR_ZONE =
  /^(?:America\/(?:Sao_Paulo|Rio_Branco|Manaus|Cuiaba|Campo_Grande|Belem|Fortaleza|Recife|Araguaina|Maceio|Bahia|Santarem|Porto_Velho|Boa_Vista|Eirunepe|Noronha|Porto_Acre)|Brazil\/.*)$/u;
export const US_ZONE =
  /^(?:America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak|Boise|Detroit|Menominee|Indiana\/.*|Kentucky\/.*|North_Dakota\/.*|Indianapolis|Louisville|Puerto_Rico|St_Thomas)|Pacific\/(?:Honolulu|Guam|Saipan|Pago_Pago|Midway|Wake)|US\/.*|EST|MST|HST|EST5EDT|CST6CDT|MST7MDT|PST8PDT|Navajo)$/u;

const EU_SET = new Set(EU_COUNTRIES);
const UK_CH_SET = new Set(UK_CH_COUNTRIES);
const BR_SET = new Set(BR_COUNTRIES);
const US_SET = new Set(US_COUNTRIES);

/** An ISO alpha-2 code, upper case, or undefined for anything else (`XX`, `T1` for Tor, empty, a sentence). */
export function countryCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(code) || code === "XX" || code === "ZZ") return undefined;
  return code;
}

function groupOfCountry(code: string): RegionGroup {
  if (EU_SET.has(code)) return "eu";
  if (UK_CH_SET.has(code)) return "uk_ch";
  if (BR_SET.has(code)) return "br";
  if (US_SET.has(code)) return "us";
  return "row";
}

/** The region group a time zone suggests. An empty or placeless zone is unknown, which is treated as `eu`. */
export function groupOfZone(zone: unknown): RegionGroup {
  if (typeof zone !== "string") return "eu";
  const name = zone.trim();
  if (name === "" || PLACELESS_ZONE.test(name)) return "eu";
  if (UK_CH_ZONE.test(name)) return "uk_ch";
  if (EU_ZONE.test(name)) return "eu";
  if (BR_ZONE.test(name)) return "br";
  if (US_ZONE.test(name)) return "us";
  return "row";
}

/** The region group: the edge country first, then the time zone. */
export function regionGroup(input: Pick<PolicyInput, "country" | "zone">): RegionGroup {
  const code = countryCode(input.country);
  return code === undefined ? groupOfZone(input.zone) : groupOfCountry(code);
}

/**
 * What this visitor's region and answers allow.
 *
 * - An analytics "no" makes the visit cookieless with nothing extra, anywhere.
 * - In the EU an analytics "yes" (the one European question) turns everything on, as does an ads "yes".
 * - Elsewhere an ads "yes" turns on ads and replay; an ads "no" turns them off.
 * - GPC turns off ads and replay, whatever was answered, and never changes first-party analytics.
 */
export function regionPolicy(input: PolicyInput): RegionPolicy {
  const group = regionGroup(input);
  const rule = REGION_TABLE[group];
  const analyticsChoice = input.choices?.analytics;
  const adsChoice = input.choices?.ads;
  const gpc = input.gpc === true;

  let analytics = rule.analytics;
  let autocapture = rule.autocapture;
  let replay = rule.replay;
  let ads = rule.ads;
  let ask = rule.ask;

  if (group === "eu") {
    const yes = analyticsChoice === "yes" || (analyticsChoice === undefined && adsChoice === "yes");
    if (yes) {
      analytics = "persistent";
      autocapture = true;
      replay = adsChoice !== "no";
      ads = adsChoice !== "no";
    }
    if (analyticsChoice !== undefined || adsChoice !== undefined) ask = "none";
  } else {
    if (adsChoice === "yes") {
      replay = true;
      ads = true;
    } else if (adsChoice === "no") {
      replay = false;
      ads = false;
    }
    if (adsChoice !== undefined || analyticsChoice !== undefined) ask = "none";
  }

  if (analyticsChoice === "no") {
    analytics = "cookieless";
    autocapture = false;
    replay = false;
    ads = false;
    ask = "none";
  }
  if (gpc) {
    replay = false;
    ads = false;
    // Nothing left to ask outside the EU: the banner there is only about ads and recordings.
    if (ask === "ads") ask = "none";
  }
  return { region_group: group, analytics, autocapture, replay, ads, ask };
}

/** The JSON the edge serves at `/api/region` (and injects into pages): the policy without the visitor's answers. */
export type RegionResponse = Readonly<{ country: string | null; region_group: RegionGroup; gpc: boolean; policy: RegionPolicy }>;

export function regionResponse(input: Pick<PolicyInput, "country" | "zone" | "gpc">): RegionResponse {
  const country = countryCode(input.country) ?? null;
  const gpc = input.gpc === true;
  return { country, region_group: regionGroup(input), gpc, policy: regionPolicy({ country, zone: input.zone, gpc }) };
}

/** Parses a region response from `unknown` (a fetch result, an injected global). */
export function parseRegionResponse(value: unknown): RegionResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const country = record.country === null ? null : countryCode(record.country) ?? null;
  const group = record.region_group;
  if (typeof group !== "string" || !Object.hasOwn(REGION_TABLE, group)) return undefined;
  const gpc = record.gpc === true;
  const region = group as RegionGroup;
  // The policy is recomputed from the group: a stale or tampered policy object is never trusted.
  return { country, region_group: region, gpc, policy: policyForGroup(region, gpc, {}) };
}

/** The policy for a known group (used when only the group crosses a boundary, as in native apps and the CLI). */
export function policyForGroup(group: RegionGroup, gpc: boolean, choices: Choices): RegionPolicy {
  const country = { eu: "DE", uk_ch: "GB", br: "BR", us: "US", row: "JP" }[group];
  return regionPolicy({ country, gpc, choices });
}

/** Whether a non-browser client (app, CLI) sends usage counts: opt-in in the EU, opt-out elsewhere. */
export function telemetryDefault(group: RegionGroup): "ask" | "on" {
  return group === "eu" ? "ask" : "on";
}

/** The super property `consent_mode`. */
export const consentMode = (policy: RegionPolicy): AnalyticsMode => policy.analytics;
