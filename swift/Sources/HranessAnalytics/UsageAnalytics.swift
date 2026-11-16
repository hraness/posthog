import Foundation
#if canImport(AppKit)
import AppKit
#endif

/// One count an app may send.
public struct EventSpec: Hashable, Sendable {
    /// The event name exactly as the product's server allowlist spells it, for example `"first project created"`.
    public let name: String
    /// Sent at most once per install. A once-only count is marked done even while sending is off.
    public let once: Bool

    public init(_ name: String, once: Bool = false) {
        self.name = name
        self.once = once
    }
}

/// Anonymous usage counts for a native app.
///
/// - What is sent: the count's name, a random install identifier made on the device (never derived from the
///   hardware, an account or an email), a random identifier for the count itself, when it happened, the app's
///   version and build, the system's major and minor version, the region group (`eu`, `uk_ch`, `br`, `us` or
///   `row`), whether the app runs on a Mac or a phone, and the few coarse properties the app names, such as a count
///   bucket. A download link's `ref` and visit ID are sent once, with "app installed", when they are valid.
/// - What is never sent: projects, files or file names, media, content, chat, email, the sign-in or account, the
///   device's exact region setting or time zone, or an exact count.
/// - Where: only to the product's own `/api/app/event` endpoint. The app never talks to an analytics provider
///   directly; the product's server checks every field against a closed list before forwarding anything.
/// - Choice: in the EU group (and where the region cannot be told) nothing is sent until the person says yes.
///   Everywhere else, the UK and Switzerland included, counts are on until the person turns them off. Turning them
///   off forgets the install identifier and anything unsent.
/// - Only a build configured with `isEnabled` (a signed release) sends or asks. Tests and development builds never do.
@MainActor
public final class UsageAnalytics {
    /// The text of the optional first-launch question.
    public struct Question: Sendable {
        public var title: String
        public var explanation: String
        public var allowButton: String
        public var denyButton: String

        public init(title: String = "Share anonymous usage data?",
                    explanation: String = "The app can send a few anonymous counts, such as that it was opened, so we can see what helps. It never sends your files, projects, content or email.",
                    allowButton: String = "Share",
                    denyButton: String = "Don’t Share") {
            self.title = title
            self.explanation = explanation
            self.allowButton = allowButton
            self.denyButton = denyButton
        }
    }

    public struct Configuration: Sendable {
        /// The product server's `/api/app/event` endpoint. Never an analytics provider directly.
        public var endpoint: URL
        /// Prefix for every `UserDefaults` key this class keeps.
        public var defaultsPrefix: String
        /// The counts this app may send, besides the built-in "app installed" and "app opened".
        public var events: [EventSpec]
        /// True only for a signed release. When false nothing is sent and nothing is asked.
        public var isEnabled: Bool
        /// The most counts kept while offline; older ones are dropped first.
        public var queueLimit: Int
        /// `"mac"` or `"ios"`, sent as `props.surface`.
        public var surface: String
        public var question: Question

        public init(endpoint: URL, defaultsPrefix: String, events: [EventSpec], isEnabled: Bool,
                    queueLimit: Int = 20, surface: String, question: Question = Question()) {
            self.endpoint = endpoint
            self.defaultsPrefix = defaultsPrefix
            self.events = events
            self.isEnabled = isEnabled
            self.queueLimit = queueLimit
            self.surface = surface
            self.question = question
        }
    }

    /// The person's answer.
    public enum Choice: String, Sendable { case yes, no }

    /// Sent once per install with the download link's `ref` and visit ID.
    public static let appInstalled = EventSpec("app installed", once: true)
    /// Sent at most once per UTC day.
    public static let appOpened = EventSpec("app opened")

    public let configuration: Configuration
    public let defaults: UserDefaults
    public let regionGroup: RegionGroup
    /// Posts one JSON body; true once the server has it or refused it for good, false to retry later.
    public var transport: (Data) async -> Bool

    private let info: [String: Any]
    private let osVersion: OperatingSystemVersion
    private let specs: [String: EventSpec]
    private var flushTask: Task<Void, Never>?

    /// - Parameters:
    ///   - regionGroup: defaults to this device's group, read locally from its region setting and time zone.
    ///   - info: the bundle's Info.plist, for the version and build.
    ///   - transport: defaults to a cookieless, cacheless POST to `configuration.endpoint`.
    public init(configuration: Configuration,
                defaults: UserDefaults = .standard,
                regionGroup: RegionGroup = Region.current(),
                info: [String: Any] = Bundle.main.infoDictionary ?? [:],
                osVersion: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion,
                transport: ((Data) async -> Bool)? = nil) {
        self.configuration = configuration
        self.defaults = defaults
        self.regionGroup = regionGroup
        self.info = info
        self.osVersion = osVersion
        var specs: [String: EventSpec] = [:]
        for spec in [Self.appInstalled, Self.appOpened] + configuration.events { specs[spec.name] = spec }
        self.specs = specs
        let endpoint = configuration.endpoint
        self.transport = transport ?? { body in await UsageAnalytics.post(body, to: endpoint) }
    }

    // MARK: Keys

    private func key(_ name: String) -> String { configuration.defaultsPrefix + name }
    var choiceKey: String { key("Choice") }
    var installKey: String { key("Install") }
    var milestonesKey: String { key("Milestones") }
    var queueKey: String { key("Queue") }
    var installDateKey: String { key("InstallDate") }
    var lastOpenedDayKey: String { key("LastOpenedDay") }

    // MARK: Choice

    public var isEnabled: Bool { configuration.isEnabled }
    /// Whether this device is in a place that asks before sending.
    public var asksFirst: Bool { Region.telemetryDefault(regionGroup) == .ask }
    public var choice: Choice? { defaults.string(forKey: choiceKey).flatMap(Choice.init(rawValue:)) }

    /// Whether counts are sent now.
    public var isOn: Bool {
        guard isEnabled else { return false }
        switch choice {
        case .yes: return true
        case .no: return false
        case nil: return !asksFirst
        }
    }

    /// Whether to ask: a release, in a place that asks first, before any answer.
    public var shouldAsk: Bool { isEnabled && choice == nil && asksFirst }

    /// Stores the answer. Off forgets the install identifier and anything unsent.
    public func setChoice(_ on: Bool) {
        defaults.set((on ? Choice.yes : .no).rawValue, forKey: choiceKey)
        if !on {
            defaults.removeObject(forKey: installKey)
            defaults.removeObject(forKey: queueKey)
        }
    }

    // MARK: Milestones

    private var milestones: Set<String> { Set(defaults.stringArray(forKey: milestonesKey) ?? []) }

    /// Whether a once-only count has already happened on this install.
    public func hasHappened(_ name: String) -> Bool { milestones.contains(name) }

    /// For an install from before analytics: marks these once-only counts as done so an update never reports an
    /// old user's "first" anything. Does nothing once any milestone record exists.
    public func markDone(_ names: [String]) {
        guard defaults.object(forKey: milestonesKey) == nil else { return }
        defaults.set(Array(Set(names)).sorted(), forKey: milestonesKey)
    }

    /// Notes a count. A once-only count is marked done whether or not it was sent, so turning sending on later never
    /// reports an old first. A name that is neither configured nor built in is ignored.
    public func record(_ name: String, properties: [String: String] = [:], at now: Date = Date()) {
        guard let spec = specs[name] else { return }
        if spec.once {
            guard !hasHappened(name) else { return }
            defaults.set(Array(milestones.union([name])).sorted(), forKey: milestonesKey)
        }
        guard isOn, let data = try? JSONSerialization.data(withJSONObject: payload(name, properties: properties, at: now),
                                                            options: [.sortedKeys]) else { return }
        var queue = defaults.array(forKey: queueKey) as? [Data] ?? []
        queue.append(data)
        defaults.set(Array(queue.suffix(max(1, configuration.queueLimit))), forKey: queueKey)
        flush()
    }

    // MARK: Lifecycle

    /// "app installed", once per install. `ref` is the download link's campaign tag and `visit` its `ph` visit ID;
    /// each is sent only when valid (see `DownloadOrigin`). Also notes the install date for "app opened".
    public func appInstalled(ref: String? = nil, visit: String? = nil, at now: Date = Date()) {
        noteInstallDate(now)
        var props: [String: String] = [:]
        if let ref = DownloadOrigin.validRef(ref) { props["ref"] = ref }
        if let visit = DownloadOrigin.validVisit(visit) { props["visit"] = visit }
        record(Self.appInstalled.name, properties: props, at: now)
    }

    /// "app opened", at most once per UTC day, with a coarse bucket of days since install.
    public func appOpened(now: Date = Date()) {
        let installed = noteInstallDate(now)
        let today = Self.utcDay(now)
        guard defaults.string(forKey: lastOpenedDayKey) != today else { return }
        defaults.set(today, forKey: lastOpenedDayKey)
        let days = Int(max(0, now.timeIntervalSince(installed)) / 86_400)
        record(Self.appOpened.name, properties: ["days_since_install_bucket": Self.daysBucket(days)], at: now)
    }

    @discardableResult
    private func noteInstallDate(_ now: Date) -> Date {
        if let date = defaults.object(forKey: installDateKey) as? Date { return date }
        defaults.set(now, forKey: installDateKey)
        return now
    }

    static func utcDay(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// Days since install as a coarse bucket: 0, 1, 2-6, 7-29, 30+.
    public nonisolated static func daysBucket(_ days: Int) -> String {
        switch days {
        case ...0: return "0"
        case 1: return "1"
        case 2...6: return "2-6"
        case 7...29: return "7-29"
        default: return "30+"
        }
    }

    /// A coarse count, never the exact number: 1, 2, 3, 4-9, 10-24, 25+.
    public nonisolated static func bucket(_ count: Int) -> String {
        switch count {
        case ...1: return "1"
        case 2: return "2"
        case 3: return "3"
        case 4...9: return "4-9"
        case 10...24: return "10-24"
        default: return "25+"
        }
    }

    // MARK: Payload

    /// The random install identifier, made on first use. Never derived from the hardware or an account.
    public var installID: String {
        if let id = defaults.string(forKey: installKey), UUID(uuidString: id) != nil { return id }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: installKey)
        return id
    }

    /// The whole request body. Nothing here comes from a project, a file or the account.
    public func payload(_ name: String, properties: [String: String], at now: Date) -> [String: Any] {
        var props = properties
        props["region_group"] = regionGroup.rawValue
        props["surface"] = configuration.surface
        var body: [String: Any] = [
            "v": 1,
            "event": name,
            "install": installID,
            "id": UUID().uuidString.lowercased(),
            "at": Int(now.timeIntervalSince1970),
            "app": info["CFBundleShortVersionString"] as? String ?? "0",
            "build": Int(info["CFBundleVersion"] as? String ?? "") ?? 0,
            "os": "\(osVersion.majorVersion).\(osVersion.minorVersion)",
            "region": asksFirst ? "ask" : "default",
        ]
        if !props.isEmpty { body["props"] = props }
        return body
    }

    /// The counts waiting to be sent, oldest first.
    public var queued: [Data] { defaults.array(forKey: queueKey) as? [Data] ?? [] }

    // MARK: Sending

    /// Sends what is queued, oldest first, in the background. A failure keeps the rest for the next count or launch.
    /// Returns the running send, which callers may await.
    @discardableResult
    public func flush() -> Task<Void, Never>? {
        if let flushTask { return flushTask }
        guard isOn else { return nil }
        let task = Task { [weak self] in
            while let self, self.isOn, let next = self.queued.first {
                guard await self.transport(next) else { break }
                var queue = self.queued
                if queue.first == next { queue.removeFirst() }
                self.defaults.set(queue, forKey: self.queueKey)
            }
            self?.flushTask = nil
        }
        flushTask = task
        return task
    }

    /// POSTs one body with an ephemeral session: no cookies, no cache. True unless the server is busy (5xx, 429) or
    /// unreachable, so a refusal is dropped and only a retryable failure is kept.
    public nonisolated static func post(_ body: Data, to endpoint: URL) async -> Bool {
        var request = URLRequest(url: endpoint, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        guard let (_, response) = try? await session.data(for: request),
              let status = (response as? HTTPURLResponse)?.statusCode else { return false }
        return status < 500 && status != 429
    }

    // MARK: The question

    #if canImport(AppKit)
    /// Asks once, as a sheet on `window`, where the region asks first. Calls `done` either way.
    public func askIfNeeded(on window: NSWindow?, then done: @escaping @MainActor () -> Void) {
        guard shouldAsk, let window, window.attachedSheet == nil else { done(); return }
        let alert = NSAlert()
        alert.messageText = configuration.question.title
        alert.informativeText = configuration.question.explanation
        alert.addButton(withTitle: configuration.question.allowButton)
        alert.addButton(withTitle: configuration.question.denyButton)
        alert.beginSheetModal(for: window) { [weak self] response in
            MainActor.assumeIsolated {
                self?.setChoice(response == .alertFirstButtonReturn)
                done()
            }
        }
    }
    #endif
}
