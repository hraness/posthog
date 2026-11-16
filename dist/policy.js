// src/policy.ts
var REGION_TABLE = {
  eu: { analytics: "cookieless", autocapture: false, replay: false, ads: false, ask: "all" },
  uk_ch: { analytics: "persistent", autocapture: true, replay: false, ads: false, ask: "ads" },
  br: { analytics: "persistent", autocapture: true, replay: false, ads: false, ask: "ads" },
  us: { analytics: "persistent", autocapture: true, replay: true, ads: true, ask: "none" },
  row: { analytics: "persistent", autocapture: true, replay: true, ads: true, ask: "none" }
};
var EU_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  "IS",
  "LI",
  "NO",
  "AX",
  "GF",
  "GP",
  "MQ",
  "RE",
  "YT",
  "MF",
  "GG",
  "JE",
  "IM",
  "GI"
];
var UK_CH_COUNTRIES = ["GB", "CH"];
var BR_COUNTRIES = ["BR"];
var US_COUNTRIES = ["US", "PR", "GU", "VI", "AS", "MP", "UM"];
var PLACELESS_ZONE = /^(?:UTC|UCT|GMT|GMT0|GMT[+-]0|Greenwich|Universal|Zulu|Factory|Etc\/.*)$/u;
var UK_CH_ZONE = /^(?:Europe\/(?:London|Belfast|Zurich)|GB|GB-Eire)$/u;
var EU_ZONE = /^(?:Europe\/.*|Arctic\/.*|Atlantic\/(?:Reykjavik|Canary|Madeira|Azores|Faroe|Faeroe|Jan_Mayen)|Asia\/(?:Nicosia|Famagusta)|Africa\/Ceuta|Indian\/(?:Reunion|Mayotte)|America\/(?:Guadeloupe|Martinique|Cayenne|Marigot|St_Barthelemy)|Eire|Iceland|Portugal|Poland|CET|MET|EET|WET)$/u;
var BR_ZONE = /^(?:America\/(?:Sao_Paulo|Rio_Branco|Manaus|Cuiaba|Campo_Grande|Belem|Fortaleza|Recife|Araguaina|Maceio|Bahia|Santarem|Porto_Velho|Boa_Vista|Eirunepe|Noronha|Porto_Acre)|Brazil\/.*)$/u;
var US_ZONE = /^(?:America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak|Boise|Detroit|Menominee|Indiana\/.*|Kentucky\/.*|North_Dakota\/.*|Indianapolis|Louisville|Puerto_Rico|St_Thomas)|Pacific\/(?:Honolulu|Guam|Saipan|Pago_Pago|Midway|Wake)|US\/.*|EST|MST|HST|EST5EDT|CST6CDT|MST7MDT|PST8PDT|Navajo)$/u;
var EU_SET = new Set(EU_COUNTRIES);
var UK_CH_SET = new Set(UK_CH_COUNTRIES);
var BR_SET = new Set(BR_COUNTRIES);
var US_SET = new Set(US_COUNTRIES);
function countryCode(value) {
  if (typeof value !== "string")
    return;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(code) || code === "XX" || code === "ZZ")
    return;
  return code;
}
function groupOfCountry(code) {
  if (EU_SET.has(code))
    return "eu";
  if (UK_CH_SET.has(code))
    return "uk_ch";
  if (BR_SET.has(code))
    return "br";
  if (US_SET.has(code))
    return "us";
  return "row";
}
function groupOfZone(zone) {
  if (typeof zone !== "string")
    return "eu";
  const name = zone.trim();
  if (name === "" || PLACELESS_ZONE.test(name))
    return "eu";
  if (UK_CH_ZONE.test(name))
    return "uk_ch";
  if (EU_ZONE.test(name))
    return "eu";
  if (BR_ZONE.test(name))
    return "br";
  if (US_ZONE.test(name))
    return "us";
  return "row";
}
function regionGroup(input) {
  const code = countryCode(input.country);
  return code === undefined ? groupOfZone(input.zone) : groupOfCountry(code);
}
function regionPolicy(input) {
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
    const yes = analyticsChoice === "yes" || analyticsChoice === undefined && adsChoice === "yes";
    if (yes) {
      analytics = "persistent";
      autocapture = true;
      replay = adsChoice !== "no";
      ads = adsChoice !== "no";
    }
    if (analyticsChoice !== undefined || adsChoice !== undefined)
      ask = "none";
  } else {
    if (adsChoice === "yes") {
      replay = true;
      ads = true;
    } else if (adsChoice === "no") {
      replay = false;
      ads = false;
    }
    if (adsChoice !== undefined || analyticsChoice !== undefined)
      ask = "none";
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
    if (ask === "ads")
      ask = "none";
  }
  return { region_group: group, analytics, autocapture, replay, ads, ask };
}
function regionResponse(input) {
  const country = countryCode(input.country) ?? null;
  const gpc = input.gpc === true;
  return { country, region_group: regionGroup(input), gpc, policy: regionPolicy({ country, zone: input.zone, gpc }) };
}
function parseRegionResponse(value) {
  if (typeof value !== "object" || value === null)
    return;
  const record = value;
  const country = record.country === null ? null : countryCode(record.country) ?? null;
  const group = record.region_group;
  if (typeof group !== "string" || !Object.hasOwn(REGION_TABLE, group))
    return;
  const gpc = record.gpc === true;
  const region = group;
  return { country, region_group: region, gpc, policy: policyForGroup(region, gpc, {}) };
}
var GROUP_COUNTRY = { eu: "DE", uk_ch: "GB", br: "BR", us: "US", row: "JP" };
function policyForGroup(group, gpc, choices) {
  return regionPolicy({ country: GROUP_COUNTRY[group], gpc, choices });
}
function telemetryDefault(group) {
  return group === "eu" ? "ask" : "on";
}
var consentMode = (policy) => policy.analytics;
export {
  telemetryDefault,
  regionResponse,
  regionPolicy,
  regionGroup,
  policyForGroup,
  parseRegionResponse,
  groupOfZone,
  countryCode,
  consentMode,
  US_ZONE,
  US_COUNTRIES,
  UK_CH_ZONE,
  UK_CH_COUNTRIES,
  REGION_TABLE,
  PLACELESS_ZONE,
  GROUP_COUNTRY,
  EU_ZONE,
  EU_COUNTRIES,
  BR_ZONE,
  BR_COUNTRIES
};

//# debugId=BCA310E5344AEA1164756E2164756E21
