import Foundation

/// Where a person is, as the region policy groups places. Mirrors `RegionGroup` in `src/policy.ts`.
public enum RegionGroup: String, CaseIterable, Hashable, Sendable {
    /// The EU, the EEA, EU territories, the Crown dependencies, Gibraltar, and anywhere that cannot be told.
    case eu
    /// The United Kingdom and Switzerland.
    case ukCh = "uk_ch"
    /// Brazil.
    case br
    /// The United States and its territories.
    case us
    /// The rest of the world.
    case row
}

/// How first-party analytics identifies a person. `persistent` keeps a first-party ID; `cookieless` keeps nothing.
public enum AnalyticsMode: String, Hashable, Sendable {
    case persistent
    case cookieless
}

/// What a consent question asks about: nothing, ads and recordings only, or everything.
public enum AskScope: String, Hashable, Sendable {
    case nothing = "none"
    case ads
    case all
}

/// One row of the region table: what a region allows before any answer.
public struct Rule: Hashable, Sendable {
    public let analytics: AnalyticsMode
    /// Autocapture, heatmaps and similar automatic page signals (web only).
    public let autocapture: Bool
    /// Session recordings (web only, never on private surfaces).
    public let replay: Bool
    /// Ad pixels and conversion events.
    public let ads: Bool
    /// What the question asks before an answer.
    public let ask: AskScope

    public init(analytics: AnalyticsMode, autocapture: Bool, replay: Bool, ads: Bool, ask: AskScope) {
        self.analytics = analytics
        self.autocapture = autocapture
        self.replay = replay
        self.ads = ads
        self.ask = ask
    }
}

/// Whether a native app or CLI sends usage counts before the person answers.
public enum TelemetryDefault: String, Hashable, Sendable {
    /// Nothing is sent until the person says yes.
    case ask
    /// Counts are sent until the person turns them off.
    case on
}

/// The region policy for native clients. The table itself is generated from `src/policy.ts` into `PolicyTable`.
///
/// A native app tells its region from the device's region setting first and its time zone second. Neither leaves
/// the device: only the resulting group (for example `"eu"`) is sent with a count.
public enum Region {
    /// An ISO 3166-1 alpha-2 code in upper case, or nil for anything else (`XX`, `ZZ`, empty, numeric, a sentence).
    public static func countryCode(_ value: String?) -> String? {
        guard let value else { return nil }
        let code = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard code.count == 2, code.unicodeScalars.allSatisfy({ ("A"..."Z").contains($0) }),
              code != "XX", code != "ZZ" else { return nil }
        return code
    }

    /// The group a country code belongs to. The code must already be valid (see `countryCode(_:)`).
    static func group(ofCountry code: String) -> RegionGroup {
        if PolicyTable.euCountries.contains(code) { return .eu }
        if PolicyTable.ukChCountries.contains(code) { return .ukCh }
        if PolicyTable.brCountries.contains(code) { return .br }
        if PolicyTable.usCountries.contains(code) { return .us }
        return .row
    }

    /// The group a time zone suggests. An empty zone, or one that names no place (UTC, `Etc/…`), is unknown and
    /// treated as `eu`. Checked in the same order as `groupOfZone` in `src/policy.ts`.
    public static func group(zone: String?) -> RegionGroup {
        let name = (zone ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || matches(name, PolicyTable.placelessZone) { return .eu }
        if matches(name, PolicyTable.ukChZone) { return .ukCh }
        if matches(name, PolicyTable.euZone) { return .eu }
        if matches(name, PolicyTable.brZone) { return .br }
        if matches(name, PolicyTable.usZone) { return .us }
        return .row
    }

    /// The region group: the country first, then the time zone.
    public static func group(country: String?, zone: String?) -> RegionGroup {
        if let code = countryCode(country) { return group(ofCountry: code) }
        return group(zone: zone)
    }

    /// This device's group, from its region setting and then its time zone. Both are read locally.
    public static func current() -> RegionGroup {
        group(country: Locale.current.region?.identifier, zone: TimeZone.current.identifier)
    }

    /// The table row for a group.
    public static func rule(for group: RegionGroup) -> Rule {
        // The generated table has every group; the fallback is the strictest row.
        PolicyTable.rules[group] ?? Rule(analytics: .cookieless, autocapture: false, replay: false, ads: false, ask: .all)
    }

    /// Opt-in in the EU group (and wherever the region cannot be told), opt-out everywhere else, the UK and
    /// Switzerland included.
    public static func telemetryDefault(_ group: RegionGroup) -> TelemetryDefault {
        group == .eu ? .ask : .on
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}
