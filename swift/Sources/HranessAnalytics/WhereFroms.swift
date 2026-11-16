import Foundation
#if os(macOS)
import Darwin
#endif

/// Where a downloaded app came from: the `ref` campaign tag and `ph` visit ID of its download link.
///
/// macOS records a download's source URLs in the file's `com.apple.metadata:kMDItemWhereFroms` attribute. Reading it
/// is local; nothing is fetched. Only a tag matching `^[a-z0-9._-]{1,40}$` and a visit ID that is a UUID are kept,
/// so no other part of the URL, the referring page or anything personal is ever passed on.
public enum DownloadOrigin {
    /// A lowercased campaign tag, or nil unless it matches `^[a-z0-9._-]{1,40}$`.
    public static func validRef(_ value: String?) -> String? {
        guard let value else { return nil }
        let ref = value.lowercased()
        guard ref.range(of: #"^[a-z0-9._-]{1,40}$"#, options: .regularExpression) != nil else { return nil }
        return ref
    }

    /// A lowercased visit ID, or nil unless it is a UUID.
    public static func validVisit(_ value: String?) -> String? {
        guard let value,
              value.range(of: #"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$"#, options: .regularExpression) != nil
        else { return nil }
        return value.lowercased()
    }

    /// The `ref` (or `via`) and `ph` query values of the first https URL in a list of source URLs.
    public static func parse(_ urls: [String]) -> (ref: String?, visit: String?) {
        guard let first = urls.lazy.compactMap({ URLComponents(string: $0) }).first(where: { $0.scheme?.lowercased() == "https" })
        else { return (nil, nil) }
        let items = first.queryItems ?? []
        func value(_ name: String) -> String? { items.first(where: { $0.name == name })?.value }
        return (validRef(value("ref") ?? value("via")), validVisit(value("ph")))
    }

    #if os(macOS)
    static let attribute = "com.apple.metadata:kMDItemWhereFroms"

    /// Reads the download source of a file or app bundle. Returns nils when the attribute is missing or unreadable.
    public static func read(from url: URL) -> (ref: String?, visit: String?) {
        let size = getxattr(url.path, attribute, nil, 0, 0, 0)
        guard size > 0, size < 1 << 20 else { return (nil, nil) }
        var data = Data(count: size)
        let read = data.withUnsafeMutableBytes { getxattr(url.path, attribute, $0.baseAddress, size, 0, 0) }
        guard read == size,
              let list = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [Any]
        else { return (nil, nil) }
        return parse(list.compactMap { $0 as? String })
    }
    #endif
}
