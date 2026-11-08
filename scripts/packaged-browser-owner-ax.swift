import AppKit
import ApplicationServices
import Foundation

// Owned-runner diagnostics only. These APIs never request a TCC permission or
// read page contents, window titles, credentials, or another app's AX tree.
guard CommandLine.arguments.count == 3,
      let processId = Int32(CommandLine.arguments[1]), processId > 1 else {
    exit(2)
}
let expectedBundle = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL.path
let application = NSRunningApplication(processIdentifier: processId)
let matchingApplications = NSWorkspace.shared.runningApplications.filter {
    $0.bundleURL?.standardizedFileURL.path == expectedBundle
}
let matchingIds = Set(matchingApplications.map { $0.processIdentifier })
let element = AXUIElementCreateApplication(processId)
var attributes: CFArray?
let attributeResult = AXUIElementCopyAttributeNames(element, &attributes)
var role: CFTypeRef?
let roleResult = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
var attributeSets: [[String: Any]] = []
for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
    let result = AXUIElementSetAttributeValue(element, name as CFString, kCFBooleanTrue)
    var value: CFTypeRef?
    let read = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    var observed: Any = NSNull()
    if let boolean = value as? NSNumber { observed = boolean.boolValue }
    attributeSets.append([
        "attribute": name, "setError": result.rawValue, "readError": read.rawValue,
        "booleanValue": observed,
    ])
}
var windows: CFTypeRef?
let windowResult = AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &windows)
let nativeWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
let candidateWindows = (nativeWindows ?? []).compactMap { row -> [String: Any]? in
    guard let owner = row[kCGWindowOwnerPID as String] as? NSNumber else { return nil }
    let name = row[kCGWindowOwnerName as String] as? String ?? ""
    guard owner.int32Value == processId || matchingIds.contains(owner.int32Value) || name == "Octant" else { return nil }
    return ["ownerPid": owner.int32Value, "ownerName": name,
            "windowId": row[kCGWindowNumber as String] ?? NSNull(),
            "layer": row[kCGWindowLayer as String] ?? NSNull(),
            "matchesStagedBundle": matchingIds.contains(owner.int32Value)]
}
let evidence: [String: Any] = [
    "capturedPid": processId,
    "diagnosticPid": ProcessInfo.processInfo.processIdentifier,
    "capturedExecutable": application?.executableURL?.path ?? "unavailable",
    "capturedBundle": application?.bundleURL?.standardizedFileURL.path ?? "unavailable",
    "stagedBundleMatches": matchingApplications.map { ["pid": $0.processIdentifier, "executable": $0.executableURL?.path ?? "unavailable"] },
    "nativeAxTrusted": AXIsProcessTrusted(),
    "attributeNamesError": attributeResult.rawValue,
    "attributeNames": attributes as? [String] ?? [],
    "roleError": roleResult.rawValue, "role": role as? String ?? "unavailable",
    "attributeSets": attributeSets,
    "windowsError": windowResult.rawValue, "axWindowCount": (windows as? NSArray)?.count ?? -1,
    "cgMetadataAvailable": nativeWindows != nil, "candidateWindowOwners": candidateWindows,
]
// Optional booleans are represented explicitly, not by reading arbitrary AX values.
let encoded = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])
FileHandle.standardOutput.write(encoded)
