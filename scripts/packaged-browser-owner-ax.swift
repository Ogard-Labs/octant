import AppKit
import ApplicationServices
import Foundation

// Owned-runner native UI QA. Never requests a TCC permission or reads text-field
// values, credentials, or another app's tree. Only one named switch has a value.
guard (3...5).contains(CommandLine.arguments.count),
      let processId = Int32(CommandLine.arguments[1]), processId > 1 else {
    exit(2)
}
let mode = CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : "diagnostic"
let requestedTitle = CommandLine.arguments.count == 5 ? CommandLine.arguments[4] : ""
guard ["diagnostic", "read", "press"].contains(mode),
      (mode == "press") == !requestedTitle.isEmpty,
      requestedTitle.count <= 256 else { exit(2) }
let preferenceTitle = "Keep Browser available without windows"
let expectedBundle = URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath().standardizedFileURL.path
let application = NSRunningApplication(processIdentifier: processId)
let capturedBundle = application?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path
let treeIdentityMatched = capturedBundle == expectedBundle && application?.isTerminated == false
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
for name in mode == "diagnostic" ? ["AXManualAccessibility", "AXEnhancedUserInterface"] : [] {
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
// Read named controls, never text-field values or static page text. The owned
// process has already been identified above; this is not a system-wide tree.
let controlRoles = Set(["AXButton", "AXCheckBox", "AXSwitch", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTextField", "AXTextArea"])
var pending = (treeIdentityMatched ? (windows as? [AXUIElement] ?? []) : []).map { ($0, 0) }
var visited = Set<CFHashCode>()
var controls: [[String: Any]] = []
var pressTargets: [AXUIElement] = []
var readErrors = 0
var nativeReadErrors = Set<Int32>()
var next = 0
var depthLimited = false
var labelsLimited = false
let treeDeadline = Date().addingTimeInterval(3)
func label(_ node: AXUIElement, _ attribute: CFString) -> String {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(node, attribute, &value)
    if result != .success && result != .attributeUnsupported && result != .noValue {
        readErrors += 1
        nativeReadErrors.insert(result.rawValue)
    }
    guard result == .success, let text = value as? String else { return "" }
    if text.count > 256 { labelsLimited = true; return "" }
    return text
}
while next < pending.count, next < 512, Date() < treeDeadline {
    let (node, depth) = pending[next]
    next += 1
    guard visited.insert(CFHash(node)).inserted else { continue }
    var roleValue: CFTypeRef?
    let roleRead = AXUIElementCopyAttributeValue(node, kAXRoleAttribute as CFString, &roleValue)
    guard roleRead == .success,
          let nodeRole = roleValue as? String else {
        readErrors += 1
        if roleRead != .success { nativeReadErrors.insert(roleRead.rawValue) }
        continue
    }
    if nodeRole == "AXSecureTextField" || label(node, kAXSubroleAttribute as CFString) == "AXSecureTextField" { continue }
    if controlRoles.contains(nodeRole) {
        let title = label(node, kAXTitleAttribute as CFString)
        let description = label(node, kAXDescriptionAttribute as CFString)
        var control: [String: Any] = ["role": nodeRole, "title": title, "description": description, "depth": depth]
        if (nodeRole == "AXCheckBox" || nodeRole == "AXSwitch") && (title == preferenceTitle || description == preferenceTitle) {
            var state: CFTypeRef?
            let stateRead = AXUIElementCopyAttributeValue(node, kAXValueAttribute as CFString, &state)
            if stateRead == .success,
               let number = state as? NSNumber, number.doubleValue == 0 || number.doubleValue == 1 {
                control["value"] = number.intValue
            } else {
                readErrors += 1
                if stateRead != .success { nativeReadErrors.insert(stateRead.rawValue) }
            }
        }
        controls.append(control)
        if mode == "press" && (title == requestedTitle || description == requestedTitle) { pressTargets.append(node) }
    }
    if depth >= 20 { depthLimited = true; continue }
    var childrenValue: CFTypeRef?
    let childrenRead = AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &childrenValue)
    if childrenRead == .success {
        if let children = childrenValue as? [AXUIElement] {
            pending.append(contentsOf: children.prefix(max(0, 512 - pending.count)).map { ($0, depth + 1) })
        } else { readErrors += 1 }
    } else if childrenRead != .attributeUnsupported && childrenRead != .noValue {
        readErrors += 1
        nativeReadErrors.insert(childrenRead.rawValue)
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
let truncated = depthLimited || labelsLimited || next < pending.count || pending.count >= 512
var action: [String: Any] = ["status": "not-requested"]
if mode == "press" {
    action = ["status": "refused", "matches": pressTargets.count, "requestedTitle": requestedTitle]
    let live = NSRunningApplication(processIdentifier: processId)
    if treeIdentityMatched, !truncated, readErrors == 0, pressTargets.count == 1,
       live?.isTerminated == false,
       live?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle,
       let target = pressTargets.first {
        var targetPid: pid_t = 0
        let targetIdentityRead = AXUIElementGetPid(target, &targetPid)
        if targetIdentityRead == .success, targetPid == processId {
            let result = AXUIElementPerformAction(target, kAXPressAction as CFString)
            action["status"] = result == .success ? "pressed" : "uncertain"
            action["nativeError"] = result.rawValue
        } else { action["identityReadError"] = targetIdentityRead.rawValue }
    }
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
    "treeVisited": next, "treeReadErrors": readErrors, "treeNativeErrors": nativeReadErrors.sorted(),
    "treeTruncated": truncated, "action": action,
    "cgMetadataAvailable": nativeWindows != nil, "candidateWindowOwners": candidateWindows,
]
// Optional booleans are represented explicitly, not by reading arbitrary AX values.
let encoded = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])
FileHandle.standardOutput.write(encoded)
