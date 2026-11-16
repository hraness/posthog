import Foundation
import Testing
@testable import HranessAnalytics

// MARK: Region

@Test func countriesGroup() {
    #expect(Region.group(country: "de", zone: "America/New_York") == .eu)
    #expect(Region.group(country: "NO", zone: nil) == .eu)
    #expect(Region.group(country: "GB", zone: nil) == .ukCh)
    #expect(Region.group(country: "ch", zone: nil) == .ukCh)
    #expect(Region.group(country: "BR", zone: nil) == .br)
    #expect(Region.group(country: "US", zone: "Europe/Paris") == .us)
    #expect(Region.group(country: "PR", zone: nil) == .us)
    #expect(Region.group(country: "JP", zone: nil) == .row)
}

@Test func unknownCountryFallsBackToZone() {
    for country in [nil, "", "XX", "ZZ", "T1", "001", "USA", "a sentence"] as [String?] {
        #expect(Region.group(country: country, zone: "America/Chicago") == .us)
    }
    #expect(Region.countryCode(" gb ") == "GB")
}

@Test func zonesGroup() {
    #expect(Region.group(country: nil, zone: nil) == .eu)
    #expect(Region.group(country: nil, zone: "") == .eu)
    #expect(Region.group(country: nil, zone: "UTC") == .eu)
    #expect(Region.group(country: nil, zone: "Etc/GMT+5") == .eu)
    #expect(Region.group(country: nil, zone: "Europe/London") == .ukCh)
    #expect(Region.group(country: nil, zone: "Europe/Zurich") == .ukCh)
    #expect(Region.group(country: nil, zone: "Europe/Berlin") == .eu)
    #expect(Region.group(country: nil, zone: "Atlantic/Canary") == .eu)
    #expect(Region.group(country: nil, zone: "America/Sao_Paulo") == .br)
    #expect(Region.group(country: nil, zone: "America/Los_Angeles") == .us)
    #expect(Region.group(country: nil, zone: "Pacific/Honolulu") == .us)
    #expect(Region.group(country: nil, zone: "Asia/Tokyo") == .row)
    #expect(Region.group(country: nil, zone: "America/Toronto") == .row)
}

@Test func telemetryDefaults() {
    #expect(Region.telemetryDefault(.eu) == .ask)
    for group in [RegionGroup.ukCh, .br, .us, .row] { #expect(Region.telemetryDefault(group) == .on) }
    #expect(RegionGroup.ukCh.rawValue == "uk_ch")
    #expect(Region.rule(for: .eu).ask == .all)
    #expect(Region.rule(for: .us).ask == .nothing)
    #expect(Region.rule(for: .ukCh).analytics == .persistent)
}

// MARK: Helpers

@MainActor
final class Sent {
    var bodies: [Data] = []
    var results: [Bool] = []
    func send(_ body: Data) -> Bool {
        bodies.append(body)
        return results.isEmpty ? true : results.removeFirst()
    }
}

@MainActor
func make(_ group: RegionGroup, enabled: Bool = true, sent: Sent? = nil, queueLimit: Int = 20) -> UsageAnalytics {
    let sent = sent ?? Sent()
    let suite = "hraness-analytics-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let configuration = UsageAnalytics.Configuration(
        endpoint: URL(string: "https://example.com/api/app/event")!,
        defaultsPrefix: "Test",
        events: [EventSpec("first launch", once: true), EventSpec("thing done")],
        isEnabled: enabled,
        queueLimit: queueLimit,
        surface: "mac")
    return UsageAnalytics(configuration: configuration, defaults: defaults, regionGroup: group,
                          info: ["CFBundleShortVersionString": "1.2.3", "CFBundleVersion": "45"],
                          osVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 1, patchVersion: 2),
                          transport: { body in sent.send(body) })
}

func json(_ data: Data) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

// MARK: Choice

@MainActor @Test func isOnAndShouldAskByRegion() {
    let eu = make(.eu)
    #expect(!eu.isOn)
    #expect(eu.shouldAsk)
    eu.setChoice(true)
    #expect(eu.isOn)
    #expect(!eu.shouldAsk)

    for group in [RegionGroup.ukCh, .br, .us, .row] {
        let analytics = make(group)
        #expect(analytics.isOn)
        #expect(!analytics.shouldAsk)
        analytics.setChoice(false)
        #expect(!analytics.isOn)
    }

    let dev = make(.us, enabled: false)
    #expect(!dev.isOn)
    #expect(!make(.eu, enabled: false).shouldAsk)
}

@MainActor @Test func offForgetsIdentifierAndQueue() async {
    let sent = Sent()
    sent.results = [false]
    let analytics = make(.us, sent: sent)
    let id = analytics.installID
    analytics.record("thing done")
    await analytics.flush()?.value
    #expect(analytics.queued.count == 1)
    analytics.setChoice(false)
    #expect(analytics.queued.isEmpty)
    #expect(analytics.defaults.string(forKey: analytics.installKey) == nil)
    analytics.record("thing done")
    #expect(analytics.queued.isEmpty)
    analytics.setChoice(true)
    #expect(analytics.installID != id)
}

// MARK: Milestones

@MainActor @Test func onceOnlyCountsAsDoneWhileOff() async {
    let sent = Sent()
    let analytics = make(.eu, sent: sent)
    analytics.record("first launch")
    #expect(analytics.hasHappened("first launch"))
    analytics.setChoice(true)
    analytics.record("first launch")
    analytics.record("thing done")
    analytics.record("thing done")
    analytics.record("not configured")
    await analytics.flush()?.value
    #expect(sent.bodies.map { json($0)["event"] as? String } == ["thing done", "thing done"])
}

@MainActor @Test func markDoneOnlyWithoutRecord() {
    let analytics = make(.us)
    analytics.markDone(["first launch"])
    #expect(analytics.hasHappened("first launch"))
    let fresh = make(.us)
    fresh.record("app installed")
    fresh.markDone(["first launch"])
    #expect(!fresh.hasHappened("first launch"))
}

// MARK: Payload

@MainActor @Test func payloadWireKeys() throws {
    let at = Date(timeIntervalSince1970: 1_800_000_000)
    let analytics = make(.ukCh)
    let data = try JSONSerialization.data(withJSONObject: analytics.payload("thing done", properties: ["k": "x"], at: at), options: [.sortedKeys])
    let body = json(data)
    #expect(Set(body.keys) == ["v", "event", "install", "id", "at", "app", "build", "os", "region", "props"])
    #expect(body["v"] as? Int == 1)
    #expect(body["event"] as? String == "thing done")
    #expect(body["at"] as? Int == 1_800_000_000)
    #expect(body["app"] as? String == "1.2.3")
    #expect(body["build"] as? Int == 45)
    #expect(body["os"] as? String == "26.1")
    #expect(body["region"] as? String == "default")
    let install = try #require(body["install"] as? String)
    let id = try #require(body["id"] as? String)
    #expect(install == install.lowercased() && UUID(uuidString: install) != nil)
    #expect(id == id.lowercased() && UUID(uuidString: id) != nil && id != install)
    #expect(body["props"] as? [String: String] == ["k": "x", "region_group": "uk_ch", "surface": "mac"])
    let text = try #require(String(data: data, encoding: .utf8))
    #expect(text.hasPrefix(#"{"app":"#))

    let eu = make(.eu).payload("thing done", properties: [:], at: at)
    #expect(eu["region"] as? String == "ask")
    #expect(eu["props"] as? [String: String] == ["region_group": "eu", "surface": "mac"])

    let bare = UsageAnalytics(configuration: analytics.configuration, defaults: analytics.defaults, regionGroup: .row, info: [:])
        .payload("thing done", properties: [:], at: at)
    #expect(bare["app"] as? String == "0")
    #expect(bare["build"] as? Int == 0)
}

// MARK: Attribution

@Test func refAndVisitValidation() {
    #expect(DownloadOrigin.validRef("Launch_2026.x-1") == "launch_2026.x-1")
    #expect(DownloadOrigin.validRef("") == nil)
    #expect(DownloadOrigin.validRef("has space") == nil)
    #expect(DownloadOrigin.validRef(String(repeating: "a", count: 41)) == nil)
    #expect(DownloadOrigin.validRef(nil) == nil)
    #expect(DownloadOrigin.validVisit("0190A2B4-1111-7222-8333-444455556666") == "0190a2b4-1111-7222-8333-444455556666")
    #expect(DownloadOrigin.validVisit("not-a-uuid") == nil)
    #expect(DownloadOrigin.validVisit("0190a2b4111172228333444455556666") == nil)
}

@Test func whereFromsParse() {
    let visit = "0190a2b4-1111-7222-8333-444455556666"
    let parsed = DownloadOrigin.parse(["http://insecure.example/?ref=no", "https://example.com/download?via=Ads&ph=\(visit)", "https://ref.example/"])
    #expect(parsed.ref == "ads")
    #expect(parsed.visit == visit)
    let bad = DownloadOrigin.parse(["https://example.com/?ref=bad%20tag&ph=nope"])
    #expect(bad.ref == nil && bad.visit == nil)
    #expect(DownloadOrigin.parse([]).ref == nil)
}

#if os(macOS)
@Test func whereFromsReadMissingAttribute() throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("where-froms-\(UUID().uuidString)")
    try Data().write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    let none = DownloadOrigin.read(from: file)
    #expect(none.ref == nil && none.visit == nil)

    let plist = try PropertyListSerialization.data(fromPropertyList: ["https://example.com/d?ref=news&ph=0190a2b4-1111-7222-8333-444455556666"],
                                                   format: .binary, options: 0)
    let status = plist.withUnsafeBytes { setxattr(file.path, DownloadOrigin.attribute, $0.baseAddress, plist.count, 0, 0) }
    try #require(status == 0)
    let read = DownloadOrigin.read(from: file)
    #expect(read.ref == "news")
    #expect(read.visit == "0190a2b4-1111-7222-8333-444455556666")
}
#endif

@MainActor @Test func appInstalledSendsOnceWithValidProps() async {
    let sent = Sent()
    let analytics = make(.row, sent: sent)
    analytics.appInstalled(ref: "News", visit: "nope")
    analytics.appInstalled(ref: "again", visit: nil)
    await analytics.flush()?.value
    #expect(sent.bodies.count == 1)
    let body = json(sent.bodies[0])
    #expect(body["event"] as? String == "app installed")
    #expect(body["props"] as? [String: String] == ["ref": "news", "region_group": "row", "surface": "mac"])
}

// MARK: Buckets and opens

@Test func buckets() {
    let expected = [0: "1", 1: "1", 2: "2", 3: "3", 4: "4-9", 9: "4-9", 10: "10-24", 24: "10-24", 25: "25+", 1000: "25+"]
    for (count, bucket) in expected { #expect(UsageAnalytics.bucket(count) == bucket) }
    let days = [0: "0", 1: "1", 2: "2-6", 6: "2-6", 7: "7-29", 29: "7-29", 30: "30+"]
    for (count, bucket) in days { #expect(UsageAnalytics.daysBucket(count) == bucket) }
}

@MainActor @Test func appOpenedOncePerUTCDay() async {
    let sent = Sent()
    let analytics = make(.us, sent: sent)
    let install = Date(timeIntervalSince1970: 1_800_000_000) // 2027-01-15 08:00 UTC
    analytics.appInstalled(at: install)
    analytics.appOpened(now: install)
    analytics.appOpened(now: install.addingTimeInterval(3_600))
    analytics.appOpened(now: install.addingTimeInterval(86_400 * 3))
    analytics.appOpened(now: install.addingTimeInterval(86_400 * 3 + 60))
    analytics.appOpened(now: install.addingTimeInterval(86_400 * 40))
    await analytics.flush()?.value
    let opens = sent.bodies.map(json).filter { $0["event"] as? String == "app opened" }
    #expect(opens.compactMap { ($0["props"] as? [String: String])?["days_since_install_bucket"] } == ["0", "2-6", "30+"])
}

// MARK: Queue

@MainActor @Test func flushStopsOnFailureAndKeepsRest() async {
    let sent = Sent()
    sent.results = [true, false]
    let analytics = make(.us, sent: sent)
    analytics.record("thing done", properties: ["n": "1"])
    analytics.record("thing done", properties: ["n": "2"])
    analytics.record("thing done", properties: ["n": "3"])
    await analytics.flush()?.value
    #expect(sent.bodies.count == 2)
    #expect(analytics.queued.map { (json($0)["props"] as? [String: String])?["n"] } == ["2", "3"])
    await analytics.flush()?.value
    #expect(analytics.queued.isEmpty)
    #expect(sent.bodies.compactMap { (json($0)["props"] as? [String: String])?["n"] } == ["1", "2", "2", "3"])
}

@MainActor @Test func queueKeepsNewest() async {
    let sent = Sent()
    sent.results = Array(repeating: false, count: 10)
    let analytics = make(.us, sent: sent, queueLimit: 2)
    for n in 1...4 { analytics.record("thing done", properties: ["n": "\(n)"]) }
    #expect(analytics.queued.map { (json($0)["props"] as? [String: String])?["n"] } == ["3", "4"])
    await analytics.flush()?.value
}
