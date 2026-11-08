import AppKit
import ApplicationServices
import Foundation

// Owned-runner diagnostics only. These APIs never request a TCC permission or
// read page contents, window titles, credentials, or another app's AX tree.
guard CommandLine.arguments.count == 3,
      let processId = Int32(CommandLine.arguments[1]), processId > 1 else {
    exit(2)
}
let expectedBundle = URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath().standardizedFileURL.path
let application = NSRunningApplication(processIdentifier: processId)
let capturedBundle = application?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path
let treeIdentityMatched = capturedBundle == expectedBundle
let matchingApplications = NSWorkspace.shared.runningApplications.filter {
    $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle
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
// Read only named controls, never field values or static page text. The owned
// process has already been identified above; this is not a system-wide tree.
let controlRoles = Set(["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTextField", "AXTextArea"])
var pending = (treeIdentityMatched ? (windows as? [AXUIElement] ?? []) : []).map { ($0, 0) }
var visited = Set<CFHashCode>()
var controls: [[String: Any]] = []
var readErrors = 0
var next = 0
var depthLimited = false
let treeDeadline = Date().addingTimeInterval(3)
func label(_ node: AXUIElement, _ attribute: CFString) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(node, attribute, &value) == .success,
          let text = value as? String else { return "" }
    return text.count <= 256 ? text : "[label exceeds diagnostic bound]"
}
while next < pending.count, next < 512, Date() < treeDeadline {
    let (node, depth) = pending[next]
    next += 1
    guard visited.insert(CFHash(node)).inserted else { continue }
    var roleValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(node, kAXRoleAttribute as CFString, &roleValue) == .success,
          let nodeRole = roleValue as? String else { readErrors += 1; continue }
    if nodeRole == "AXSecureTextField" || label(node, kAXSubroleAttribute as CFString) == "AXSecureTextField" { continue }
    if controlRoles.contains(nodeRole) {
        controls.append(["role": nodeRole,
                         "title": label(node, kAXTitleAttribute as CFString),
                         "description": label(node, kAXDescriptionAttribute as CFString),
                         "depth": depth])
    }
    if depth >= 20 { depthLimited = true; continue }
    var childrenValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &childrenValue) == .success,
       let children = childrenValue as? [AXUIElement] {
        pending.append(contentsOf: children.prefix(max(0, 512 - pending.count)).map { ($0, depth + 1) })
    }
}
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
    "expectedStagedBundle": expectedBundle,
    "capturedExecutable": application?.executableURL?.path ?? "unavailable",
    "capturedBundle": capturedBundle ?? "unavailable",
    "stagedBundleMatches": matchingApplications.map { ["pid": $0.processIdentifier, "executable": $0.executableURL?.path ?? "unavailable"] },
    "nativeAxTrusted": AXIsProcessTrusted(),
    "attributeNamesError": attributeResult.rawValue,
    "attributeNames": attributes as? [String] ?? [],
    "roleError": roleResult.rawValue, "role": role as? String ?? "unavailable",
    "attributeSets": attributeSets,
    "windowsError": windowResult.rawValue, "axWindowCount": (windows as? NSArray)?.count ?? -1,
    "interactiveControls": controls, "treeIdentityMatched": treeIdentityMatched,
    "treeVisited": next, "treeReadErrors": readErrors,
    "treeTruncated": depthLimited || next < pending.count || pending.count >= 512,
    "cgMetadataAvailable": nativeWindows != nil, "candidateWindowOwners": candidateWindows,
]
// Optional booleans are represented explicitly, not by reading arbitrary AX values.
let encoded = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])
FileHandle.standardOutput.write(encoded)
