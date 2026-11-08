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
guard ["diagnostic", "read", "press", "click"].contains(mode),
      (mode == "press" || mode == "click") == !requestedTitle.isEmpty,
      requestedTitle.count <= 256 else { exit(2) }
let preferenceTitle = "Keep Browser available without windows"
// Leave time for the matching mouse-up before the owned six-second command bound.
let dispatchDeadline = Date().addingTimeInterval(4)
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
func binary(_ value: CFTypeRef?) -> Bool? {
    guard let number = value as? NSNumber, number.doubleValue == 0 || number.doubleValue == 1 else { return nil }
    return number.intValue == 1
}
func bounds(_ node: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?, sizeValue: CFTypeRef?
    let positionRead = AXUIElementCopyAttributeValue(node, kAXPositionAttribute as CFString, &positionValue)
    let sizeRead = AXUIElementCopyAttributeValue(node, kAXSizeAttribute as CFString, &sizeValue)
    for result in [positionRead, sizeRead] where result != .success {
        readErrors += 1
        nativeReadErrors.insert(result.rawValue)
    }
    guard positionRead == .success, sizeRead == .success,
          let positionValue, let sizeValue,
          CFGetTypeID(positionValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    // The Core Foundation type identity is verified before converting its API type.
    let position = unsafeBitCast(positionValue, to: AXValue.self)
    let size = unsafeBitCast(sizeValue, to: AXValue.self)
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions),
          [point.x, point.y, dimensions.width, dimensions.height].allSatisfy({ $0.isFinite }),
          dimensions.width > 0, dimensions.height > 0 else { return nil }
    return CGRect(origin: point, size: dimensions)
}
func rectangle(_ value: CGRect) -> [String: Double] {
    return ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height]
}
func cgBounds(_ row: [String: Any]) -> CGRect? {
    guard let value = row[kCGWindowBounds as String] as? [String: Any],
          let x = value["X"] as? NSNumber, let y = value["Y"] as? NSNumber,
          let width = value["Width"] as? NSNumber, let height = value["Height"] as? NSNumber else { return nil }
    let values = [x.doubleValue, y.doubleValue, width.doubleValue, height.doubleValue]
    guard values.allSatisfy({ $0.isFinite }), values[2] > 0, values[3] > 0 else { return nil }
    return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
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
        if (mode == "press" || mode == "click") && (title == requestedTitle || description == requestedTitle) { pressTargets.append(node) }
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
if mode == "press" || mode == "click" {
    action = ["status": "refused", "method": mode == "click" ? "native-click" : "AXPress", "matches": pressTargets.count, "requestedTitle": requestedTitle]
    let live = NSRunningApplication(processIdentifier: processId)
    if treeIdentityMatched, !truncated, readErrors == 0, pressTargets.count == 1,
       live?.isTerminated == false,
       live?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle,
       let target = pressTargets.first {
        var targetPid: pid_t = 0
        let targetIdentityRead = AXUIElementGetPid(target, &targetPid)
        var enabledValue: CFTypeRef?, focusedValue: CFTypeRef?, actionNames: CFArray?
        let enabledRead = AXUIElementCopyAttributeValue(target, kAXEnabledAttribute as CFString, &enabledValue)
        let focusedRead = AXUIElementCopyAttributeValue(target, kAXFocusedAttribute as CFString, &focusedValue)
        let namesRead = AXUIElementCopyActionNames(target, &actionNames)
        let availableActions = actionNames as? [String] ?? []
        let actionNamesTruncated = availableActions.count > 32 || availableActions.contains { $0.count > 256 }
        action["targetPid"] = targetPid
        action["ownerAppActive"] = live?.isActive ?? false
        action["frontmostPid"] = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        action["enabledReadError"] = enabledRead.rawValue
        action["enabled"] = binary(enabledValue).map { $0 as Any } ?? NSNull()
        action["focusedReadError"] = focusedRead.rawValue
        action["focused"] = binary(focusedValue).map { $0 as Any } ?? NSNull()
        action["actionsReadError"] = namesRead.rawValue
        action["availableActions"] = availableActions.prefix(32).map { String($0.prefix(256)) }
        action["actionNamesTruncated"] = actionNamesTruncated
        if targetIdentityRead == .success, targetPid == processId {
            if mode == "press" && enabledRead == .success && binary(enabledValue) == true {
                let result = AXUIElementPerformAction(target, kAXPressAction as CFString)
                action["status"] = result == .success ? "pressed" : "uncertain"
                action["nativeError"] = result.rawValue
            }
            if mode == "click", enabledRead == .success, binary(enabledValue) == true,
               namesRead == .success, !actionNamesTruncated, live?.isActive == true,
               NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
               !["AXTextField", "AXTextArea"].contains(label(target, kAXRoleAttribute as CFString)),
               let targetBounds = bounds(target) {
                action["controlBounds"] = rectangle(targetBounds)
                var windowValue: CFTypeRef?
                let windowRead = AXUIElementCopyAttributeValue(target, kAXWindowAttribute as CFString, &windowValue)
                action["windowReadError"] = windowRead.rawValue
                if windowRead == .success,
                   let windowValue, CFGetTypeID(windowValue) == AXUIElementGetTypeID() {
                    let window = unsafeBitCast(windowValue, to: AXUIElement.self)
                    let belongs = (windows as? [AXUIElement] ?? []).contains { CFEqual($0, window) }
                    var windowPid: pid_t = 0
                    let windowIdentityRead = AXUIElementGetPid(window, &windowPid)
                    action["windowIdentityMatched"] = belongs
                    action["windowPid"] = windowPid
                    action["windowIdentityReadError"] = windowIdentityRead.rawValue
                    if belongs, windowIdentityRead == .success, windowPid == processId,
                       let windowBounds = bounds(window) {
                        action["windowBounds"] = rectangle(windowBounds)
                        let center = CGPoint(x: targetBounds.midX, y: targetBounds.midY)
                        let onScreen = CGDisplayBounds(CGMainDisplayID()).contains(center)
                        action["controlInsideWindow"] = windowBounds.contains(targetBounds)
                        action["centerOnScreen"] = onScreen
                        let top = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).first {
                            ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 &&
                            (($0[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0 &&
                            cgBounds($0)?.contains(center) == true
                        }
                        let topPid = (top?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
                        action["pointWindowOwnerPid"] = topPid
                        action["postEventAccess"] = CGPreflightPostEventAccess()
                        if let top, let frame = cgBounds(top) { action["pointWindowBounds"] = rectangle(frame) }
                        if windowBounds.contains(targetBounds), onScreen, topPid == processId, let top, let frame = cgBounds(top),
                           abs(frame.minX - windowBounds.minX) <= 2, abs(frame.minY - windowBounds.minY) <= 2,
                           abs(frame.width - windowBounds.width) <= 2, abs(frame.height - windowBounds.height) <= 2,
                           CGPreflightPostEventAccess(),
                           NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
                           Date() < dispatchDeadline,
                           let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: center, mouseButton: .left),
                           let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: center, mouseButton: .left) {
                            down.setIntegerValueField(.mouseEventClickState, value: 1)
                            up.setIntegerValueField(.mouseEventClickState, value: 1)
                            down.post(tap: .cghidEventTap)
                            usleep(50_000)
                            up.post(tap: .cghidEventTap)
                            action["status"] = "dispatched"
                            action["center"] = ["x": center.x, "y": center.y]
                        }
                    }
                }
            }
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
    "ownerAppActive": application?.isActive ?? false,
    "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
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
