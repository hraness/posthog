import { describe, expect, test } from "bun:test";

import {
  countryCode,
  EU_COUNTRIES,
  GROUP_COUNTRY,
  groupOfZone,
  parseRegionResponse,
  policyForGroup,
  REGION_TABLE,
  regionGroup,
  regionPolicy,
  regionResponse,
  telemetryDefault,
  type Choices,
  type RegionGroup,
} from "./policy.ts";

const GROUPS: readonly RegionGroup[] = ["eu", "uk_ch", "br", "us", "row"];

describe("the region table the owner approved", () => {
  test("each group's defaults", () => {
    expect(REGION_TABLE).toEqual({
      eu: { analytics: "cookieless", autocapture: false, replay: false, ads: false, ask: "all" },
      uk_ch: { analytics: "persistent", autocapture: true, replay: false, ads: false, ask: "ads" },
      br: { analytics: "persistent", autocapture: true, replay: false, ads: false, ask: "ads" },
      us: { analytics: "persistent", autocapture: true, replay: true, ads: true, ask: "none" },
      row: { analytics: "persistent", autocapture: true, replay: true, ads: true, ask: "none" },
    });
  });

  const choiceSets: readonly Choices[] = [{}, { analytics: "yes" }, { analytics: "no" }, { ads: "yes" }, { ads: "no" }, { analytics: "yes", ads: "no" }, { analytics: "no", ads: "yes" }];
  test("every group, answer and GPC combination", () => {
    for (const group of GROUPS) {
      for (const gpc of [false, true]) {
        for (const choices of choiceSets) {
          const policy = policyForGroup(group, gpc, choices);
          expect(policy.region_group).toBe(group);
          // GPC turns off Meta and replay only; DNT is never an input.
          if (gpc) {
            expect(policy.ads).toBe(false);
            expect(policy.replay).toBe(false);
          }
          // An analytics no anywhere is cookieless with nothing extra.
          if (choices.analytics === "no") {
            expect(policy).toMatchObject({ analytics: "cookieless", autocapture: false, replay: false, ads: false });
          }
          // An ads no never leaves ads or replay on.
          if (choices.ads === "no") {
            expect(policy.ads).toBe(false);
            expect(policy.replay).toBe(false);
          }
          const euYes = choices.analytics === "yes" || (choices.analytics === undefined && choices.ads === "yes");
          if (group === "eu" && !euYes) {
            expect(policy.analytics).toBe("cookieless");
            expect(policy.autocapture).toBe(false);
          }
          if (group === "eu" && euYes) {
            expect(policy.analytics).toBe("persistent");
            expect(policy.autocapture).toBe(true);
            expect(policy.ads).toBe(!gpc && choices.ads !== "no");
          }
          if ((group === "uk_ch" || group === "br") && choices.analytics !== "no") {
            expect(policy.analytics).toBe("persistent");
            expect(policy.autocapture).toBe(true);
            expect(policy.ads).toBe(!gpc && choices.ads === "yes");
            expect(policy.replay).toBe(!gpc && choices.ads === "yes");
          }
          if ((group === "us" || group === "row") && choices.analytics !== "no") {
            expect(policy.analytics).toBe("persistent");
            expect(policy.ads).toBe(!gpc && choices.ads !== "no");
            expect(policy.ask).toBe("none");
          }
        }
      }
    }
  });

  test("who is asked what", () => {
    expect(policyForGroup("eu", false, {}).ask).toBe("all");
    expect(policyForGroup("eu", true, {}).ask).toBe("all");
    expect(policyForGroup("eu", false, { analytics: "yes" }).ask).toBe("none");
    expect(policyForGroup("eu", false, { analytics: "no" }).ask).toBe("none");
    expect(policyForGroup("uk_ch", false, {}).ask).toBe("ads");
    expect(policyForGroup("br", false, {}).ask).toBe("ads");
    // With GPC there is nothing left to ask outside Europe.
    expect(policyForGroup("uk_ch", true, {}).ask).toBe("none");
    expect(policyForGroup("uk_ch", false, { ads: "no" }).ask).toBe("none");
    expect(policyForGroup("us", false, {}).ask).toBe("none");
  });
});

describe("where a visitor is", () => {
  test("the edge's country wins over the time zone", () => {
    expect(regionGroup({ country: "FR", zone: "America/New_York" })).toBe("eu");
    expect(regionGroup({ country: "US", zone: "Europe/Paris" })).toBe("us");
    expect(regionGroup({ country: "gb", zone: undefined })).toBe("uk_ch");
    expect(regionGroup({ country: "CH", zone: undefined })).toBe("uk_ch");
    expect(regionGroup({ country: "BR", zone: undefined })).toBe("br");
    expect(regionGroup({ country: "JP", zone: undefined })).toBe("row");
    expect(regionGroup({ country: "PR", zone: undefined })).toBe("us");
    for (const code of ["NO", "IS", "LI", "RE", "GF", "AX"]) expect(regionGroup({ country: code, zone: undefined })).toBe("eu");
    expect(EU_COUNTRIES).toHaveLength(new Set(EU_COUNTRIES).size);
  });

  test("an unknown or placeless country falls back to the time zone, and an unknown zone is Europe", () => {
    for (const country of [null, undefined, "", "XX", "ZZ", "T1", "A1", "usa", 5]) expect(countryCode(country)).toBeUndefined();
    expect(regionGroup({ country: "XX", zone: "America/Chicago" })).toBe("us");
    expect(regionGroup({ country: null, zone: "Europe/Berlin" })).toBe("eu");
    expect(regionGroup({ country: null, zone: "Europe/London" })).toBe("uk_ch");
    expect(regionGroup({ country: null, zone: "Europe/Zurich" })).toBe("uk_ch");
    expect(regionGroup({ country: null, zone: "America/Sao_Paulo" })).toBe("br");
    expect(regionGroup({ country: null, zone: "Asia/Tokyo" })).toBe("row");
    expect(regionGroup({ country: null, zone: "Australia/Sydney" })).toBe("row");
    for (const zone of [undefined, "", "UTC", "Etc/GMT+3", "GMT", "Factory"]) expect(groupOfZone(zone)).toBe("eu");
    for (const zone of ["Atlantic/Reykjavik", "Atlantic/Canary", "Asia/Nicosia", "Indian/Reunion", "America/Martinique", "Europe/Oslo"]) {
      expect(groupOfZone(zone)).toBe("eu");
    }
    for (const zone of ["America/New_York", "America/Los_Angeles", "Pacific/Honolulu", "America/Puerto_Rico"]) expect(groupOfZone(zone)).toBe("us");
  });

  test("the representative country of each group maps back to the group", () => {
    for (const group of GROUPS) expect(regionGroup({ country: GROUP_COUNTRY[group], zone: undefined })).toBe(group);
  });
});

describe("the region response", () => {
  test("round-trips, and a tampered policy is recomputed from the group", () => {
    const response = regionResponse({ country: "us", zone: undefined, gpc: true });
    expect(response).toEqual({ country: "US", region_group: "us", gpc: true, policy: regionPolicy({ country: "US", zone: undefined, gpc: true }) });
    expect(parseRegionResponse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    const tampered = { ...response, region_group: "eu", policy: { ...response.policy, ads: true, analytics: "persistent" } };
    expect(parseRegionResponse(tampered)?.policy).toEqual(policyForGroup("eu", true, {}));
    for (const bad of [null, 1, "eu", {}, { region_group: "mars" }]) expect(parseRegionResponse(bad)).toBeUndefined();
  });

  test("apps and the CLI ask first only in Europe", () => {
    expect(GROUPS.map(telemetryDefault)).toEqual(["ask", "on", "on", "on", "on"]);
  });
});
