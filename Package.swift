// swift-tools-version: 5.9
// The native client of the shared analytics policy. Foundation only; no dependencies.
import PackageDescription

let package = Package(
    name: "HranessAnalytics",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "HranessAnalytics", targets: ["HranessAnalytics"]),
    ],
    targets: [
        .target(name: "HranessAnalytics", path: "swift/Sources/HranessAnalytics"),
        .testTarget(name: "HranessAnalyticsTests", dependencies: ["HranessAnalytics"], path: "swift/Tests/HranessAnalyticsTests"),
    ]
)
