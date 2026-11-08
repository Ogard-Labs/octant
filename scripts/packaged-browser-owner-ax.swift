import AppKit
import ApplicationServices
import Foundation
import Darwin

// Owned-runner native UI QA. Never requests a TCC permission or reads text-field
// values or credentials. Dock reads retain only the exact staged bundle icon.
guard (3...6).contains(CommandLine.arguments.count),
      let processId = Int32(CommandLine.arguments[1]), processId > 1 else { exit(2) }
let mode = CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : "diagnostic"
let fillsFixtureField = mode == "fill-name" || mode == "fill-address"
let requestedTitle = mode == "fill-name" ? "Name" : mode == "fill-address" ? "Address" :
    (CommandLine.arguments.count == 5 ? CommandLine.arguments[4] : "")
let fixtureText = fillsFixtureField && CommandLine.arguments.count == 6 ? CommandLine.arguments[4] : ""
let fixtureBirthParts = fillsFixtureField && CommandLine.arguments.count == 6 ? CommandLine.arguments[5].split(separator: ":", omittingEmptySubsequences: false) : []
let fixtureBirth = fixtureBirthParts.compactMap { UInt64($0) }
let fixtureAddress = URLComponents(string: fixtureText)
let allowedFixtureText = mode == "fill-name" ? fixtureText == "Owned native Browser fixture" :
    mode == "fill-address" && fixtureAddress?.scheme == "http" && fixtureAddress?.host == "127.0.0.1" &&
    fixtureAddress?.path == "/v1" && fixtureAddress?.port.map { (1...65535).contains($0) } == true && fixtureAddress?.user == nil &&
    fixtureAddress?.password == nil && fixtureAddress?.query == nil && fixtureAddress?.fragment == nil
if fillsFixtureField {
    guard CommandLine.arguments.count == 6, fixtureBirthParts.count == 2, fixtureBirth.count == 2,
          !fixtureText.isEmpty, fixtureText.utf16.count <= 64, allowedFixtureText else { exit(2) }
} else { guard CommandLine.arguments.count <= 5 else { exit(2) } }
guard ["diagnostic", "read", "click", "reveal", "dock-read", "quit-hint", "dock-click", "bundle-census", "bundle-cleanup", "fill-name", "fill-address"].contains(mode),
      (mode == "click" || mode == "reveal" || mode == "dock-click" || fillsFixtureField) == !requestedTitle.isEmpty,
      requestedTitle.count <= 256 else { exit(2) }
let preferenceTitle = "Keep Browser available without windows"
// Leave time for the matching mouse-up before the owned six-second command bound.
let dispatchDeadline = Date().addingTimeInterval(4)
let expectedBundle = URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath().standardizedFileURL.path
let bundleURL = URL(fileURLWithPath: expectedBundle)
let staging = bundleURL.deletingLastPathComponent()
let temporary = URL(fileURLWithPath: NSTemporaryDirectory()).resolvingSymlinksInPath().standardizedFileURL.path
let isTaskStagedBundle = bundleURL.lastPathComponent == "Octant.app" &&
    staging.lastPathComponent.hasPrefix("octant-packaged-app.") && staging.deletingLastPathComponent().path == temporary
struct KernelIdentity: Equatable {
    let pid: pid_t
    let parentPid: UInt32
    let groupPid: UInt32
    let birthSeconds: UInt64
    let birthMicroseconds: UInt64
    let executable: String
    var evidence: [String: Any] { ["pid": pid, "parentPid": parentPid, "groupPid": groupPid,
        "birthSeconds": birthSeconds, "birthMicroseconds": birthMicroseconds,
        "kernelCanonicalExecutable": executable,
        "underExactStagedBundle": executable.hasPrefix(expectedBundle + "/")] }
}
func kernelIdentity(_ pid: pid_t) -> KernelIdentity? {
    guard pid > 1 else { return nil }
    var before = proc_bsdinfo(), after = proc_bsdinfo()
    var path = [CChar](repeating: 0, count: 4 * Int(PATH_MAX))
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    let first = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, size)
    let pathRead = proc_pidpath(pid, &path, UInt32(path.count))
    let second = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, size)
    guard first == size, second == size, pathRead > 0,
          before.pbi_pid == UInt32(pid), after.pbi_pid == UInt32(pid),
          before.pbi_uid == geteuid(), after.pbi_uid == geteuid(),
          before.pbi_pgid == after.pbi_pgid,
          before.pbi_start_tvsec == after.pbi_start_tvsec,
          before.pbi_start_tvusec == after.pbi_start_tvusec else { return nil }
    return KernelIdentity(pid: pid, parentPid: before.pbi_ppid, groupPid: before.pbi_pgid,
        birthSeconds: before.pbi_start_tvsec, birthMicroseconds: before.pbi_start_tvusec,
        executable: URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().standardizedFileURL.path)
}
func bundleCensus(_ deadline: Date) -> (complete: Bool, owned: [KernelIdentity]) {
    var pids = [pid_t](repeating: 0, count: 4096)
    // proc_listpids returns bytes, unlike proc_listpgrppids' PID count.
    let bytes = proc_listpids(UInt32(PROC_UID_ONLY), geteuid(), &pids, Int32(pids.count * MemoryLayout<pid_t>.stride))
    let count = max(0, Int(bytes) / MemoryLayout<pid_t>.stride)
    var complete = bytes > 0 && count < pids.count
    var owned: [KernelIdentity] = []
    for pid in pids.prefix(min(count, pids.count)) where pid > 1 {
        if Date() >= deadline { complete = false; break }
        if let identity = kernelIdentity(pid) {
            if identity.executable.hasPrefix(expectedBundle + "/") { owned.append(identity) }
        } else if kill(pid, 0) == 0 || errno != ESRCH { complete = false }
    }
    return (complete, owned)
}
let initialKernelIdentity = kernelIdentity(processId)
let kernelOnly = mode == "bundle-census" || mode == "bundle-cleanup"
let application = kernelOnly ? nil : NSRunningApplication(processIdentifier: processId)
let capturedBundle = application?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path
let treeIdentityMatched = capturedBundle == expectedBundle && application?.isTerminated == false
let matchingApplications = (kernelOnly ? [] : NSWorkspace.shared.runningApplications).filter {
    $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle
}
let matchingIds = Set(matchingApplications.map { $0.processIdentifier })
let element = kernelOnly ? nil : AXUIElementCreateApplication(processId)
var attributes: CFArray?
let attributeResult = element.map { AXUIElementCopyAttributeNames($0, &attributes) } ?? AXError.attributeUnsupported
var role: CFTypeRef?
let roleResult = element.map { AXUIElementCopyAttributeValue($0, kAXRoleAttribute as CFString, &role) } ?? AXError.attributeUnsupported
var attributeSets: [[String: Any]] = []
for name in mode == "diagnostic" ? ["AXManualAccessibility", "AXEnhancedUserInterface"] : [] {
    guard let element else { continue }
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
let windowResult = element.map { AXUIElementCopyAttributeValue($0, kAXWindowsAttribute as CFString, &windows) } ?? AXError.attributeUnsupported
// Read named controls, never text-field values or static page text. The owned
// process has already been identified above; this is not a system-wide tree.
let controlRoles = Set(["AXButton", "AXCheckBox", "AXSwitch", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTextField", "AXTextArea", "AXDisclosureTriangle", "AXComboBox", "AXMenuItem"])
var pending = (treeIdentityMatched ? (windows as? [AXUIElement] ?? []) : []).map { ($0, 0, false, false) }
var visited = Set<CFHashCode>()
var controls: [[String: Any]] = []
var pressTargets: [AXUIElement] = []
var quitHintTitleSeen = false, quitHintDetailSeen = false
var quitToastBranches = 0
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
    let (node, depth, parentIsToast, parentIsEndpointDialog) = pending[next]
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
    let nodeSubrole = label(node, kAXSubroleAttribute as CFString)
    if nodeRole == "AXSecureTextField" || nodeSubrole == "AXSecureTextField" { continue }
    let isEndpointDialog = parentIsEndpointDialog ||
        (nodeSubrole == "AXApplicationDialog" &&
         (label(node, kAXTitleAttribute as CFString) == "Add a model endpoint" || label(node, kAXDescriptionAttribute as CFString) == "Add a model endpoint"))
    var isToast = parentIsToast
    if mode == "quit-hint", !isToast, nodeRole == "AXGroup" {
        var classes: CFTypeRef?
        let classRead = AXUIElementCopyAttributeValue(node, "AXDOMClassList" as CFString, &classes)
        if classRead == .success {
            isToast = (classes as? [String])?.contains("toast") == true
            if isToast { quitToastBranches += 1 }
        }
        else if classRead != .attributeUnsupported && classRead != .noValue {
            readErrors += 1
            nativeReadErrors.insert(classRead.rawValue)
        }
    }
    if mode == "quit-hint", isToast, nodeRole == "AXStaticText" {
        // Only recognize the two fixed normal confirmation strings inside a
        // native toast. No other text or any text-field value is retained.
        let text = label(node, kAXValueAttribute as CFString)
        if text == "Quit Octant?" { quitHintTitleSeen = true }
        if text == "Press ⌘Q again to quit Octant" { quitHintDetailSeen = true }
    }
    if controlRoles.contains(nodeRole) {
        let title = label(node, kAXTitleAttribute as CFString)
        let description = label(node, kAXDescriptionAttribute as CFString)
        var fieldLabel = ""
        if isEndpointDialog, nodeRole == "AXTextField" {
            var associated: CFTypeRef?
            if AXUIElementCopyAttributeValue(node, kAXTitleUIElementAttribute as CFString, &associated) == .success,
               let associated, CFGetTypeID(associated) == AXUIElementGetTypeID() {
                let labelNode = unsafeBitCast(associated, to: AXUIElement.self)
                var labelPid: pid_t = 0
                if AXUIElementGetPid(labelNode, &labelPid) == .success, labelPid == processId,
                   label(labelNode, kAXRoleAttribute as CFString) == "AXStaticText" {
                    // Associated visible label text is not the field's value.
                    let text = label(labelNode, kAXValueAttribute as CFString)
                    if ["Name", "Address"].contains(text) { fieldLabel = text }
                }
            }
        }
        var control: [String: Any] = ["role": nodeRole, "title": title, "description": description, "depth": depth]
        if !fieldLabel.isEmpty { control["fieldLabel"] = fieldLabel }
        if isEndpointDialog { control["ownedEndpointDialog"] = true }
        if (nodeRole == "AXCheckBox" || nodeRole == "AXSwitch") && (title == preferenceTitle || description == preferenceTitle) {
            var state: CFTypeRef?
            let stateRead = AXUIElementCopyAttributeValue(node, kAXValueAttribute as CFString, &state)
            control["stateReadError"] = stateRead.rawValue
            control["stateType"] = state.map { CFCopyTypeIDDescription(CFGetTypeID($0)) as String } ?? "nil"
            control["subrole"] = label(node, kAXSubroleAttribute as CFString)
            var stateAttributes: CFArray?
            let attributesRead = AXUIElementCopyAttributeNames(node, &stateAttributes)
            let stateAttributeNames = stateAttributes as? [String] ?? []
            control["stateAttributesReadError"] = attributesRead.rawValue
            control["stateAttributeNames"] = stateAttributeNames.prefix(64).map { String($0.prefix(256)) }
            control["stateAttributeNamesTruncated"] = stateAttributeNames.count > 64 || stateAttributeNames.contains { $0.count > 256 }
            // Only safe known switch representations are exposed. These labels
            // never become a checked bit; unsupported state cannot authorize a toggle.
            if let text = state as? String {
                control["stateBinaryString"] = text.isEmpty ? "empty" : (["0", "1", "false", "true", "on", "off", "mixed"].contains(text) ? text : "unsupported")
            }
            if stateRead == .success,
               let number = state as? NSNumber, number.doubleValue == 0 || number.doubleValue == 1 {
                control["value"] = number.intValue
            } else if stateRead != .success {
                readErrors += 1
                nativeReadErrors.insert(stateRead.rawValue)
            } else {
                // A successful nonbinary read cannot prove checked state. Keep
                // the named control available for reveal, then require a fresh bit.
                control["stateUnavailable"] = true
            }
        }
        controls.append(control)
        if mode == "click" || mode == "reveal" {
            if title == requestedTitle || description == requestedTitle { pressTargets.append(node) }
        } else if fillsFixtureField, isEndpointDialog, nodeRole == "AXTextField",
                  title == requestedTitle || description == requestedTitle || fieldLabel == requestedTitle {
            pressTargets.append(node)
        }
    }
    if depth >= 40 { depthLimited = true; continue }
    var childrenValue: CFTypeRef?
    let childrenRead = AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &childrenValue)
    if childrenRead == .success {
        if let children = childrenValue as? [AXUIElement] {
            pending.append(contentsOf: children.prefix(max(0, 512 - pending.count)).map { ($0, depth + 1, isToast, isEndpointDialog) })
        } else { readErrors += 1 }
    } else if childrenRead != .attributeUnsupported && childrenRead != .noValue {
        readErrors += 1
        nativeReadErrors.insert(childrenRead.rawValue)
    }
}
let nativeWindows = kernelOnly ? nil : CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
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
if mode == "click" || mode == "reveal" || fillsFixtureField {
    action = ["status": "refused", "method": fillsFixtureField ? "fixed-nonsecret-fixture-field" : mode == "click" ? "native-click" : "AXScrollToVisible", "matches": pressTargets.count, "requestedTitle": requestedTitle]
    let live = NSRunningApplication(processIdentifier: processId)
    let fillBirthMatches = !fillsFixtureField || (isTaskStagedBundle && fixtureBirth.count == 2 &&
        initialKernelIdentity?.birthSeconds == fixtureBirth[0] && initialKernelIdentity?.birthMicroseconds == fixtureBirth[1] &&
        initialKernelIdentity?.executable == expectedBundle + "/Contents/MacOS/Octant")
    if treeIdentityMatched, fillBirthMatches, !truncated, readErrors == 0, pressTargets.count == 1,
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
            if mode == "reveal", ["Data & storage", preferenceTitle, "Octant Harness", "Advanced", "Check and add", "Continue and verify tools (1 request)"].contains(requestedTitle),
               enabledRead == .success, binary(enabledValue) == true,
               namesRead == .success, !actionNamesTruncated,
               availableActions.contains("AXScrollToVisible"), live?.isActive == true,
               NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
               Date() < dispatchDeadline {
                let result = AXUIElementPerformAction(target, "AXScrollToVisible" as CFString)
                action["status"] = result == .success ? "acknowledged" : "uncertain"
                action["nativeError"] = result.rawValue
            }
            if mode == "click" || fillsFixtureField, enabledRead == .success, binary(enabledValue) == true,
               namesRead == .success, !actionNamesTruncated, live?.isActive == true,
               NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
               (fillsFixtureField || !["AXTextField", "AXTextArea", "AXComboBox"].contains(label(target, kAXRoleAttribute as CFString))),
               let targetBounds = bounds(target), targetBounds.width >= 12, targetBounds.height >= 12 {
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
                            if fillsFixtureField {
                                action["status"] = "field-focus-unconfirmed"
                                action["textDispatched"] = false
                                let focusDeadline = Date().addingTimeInterval(0.4)
                                var fieldHasFocus = false
                                if let element {
                                    repeat {
                                        var focus: CFTypeRef?
                                        if AXUIElementCopyAttributeValue(element, kAXFocusedUIElementAttribute as CFString, &focus) == .success,
                                           let focus, CFGetTypeID(focus) == AXUIElementGetTypeID(), CFEqual(focus, target) {
                                            fieldHasFocus = true; break
                                        }
                                        usleep(10_000)
                                    } while Date() < focusDeadline && Date() < dispatchDeadline
                                }
                                action["exactNonsecureFieldFocused"] = fieldHasFocus
                                if fieldHasFocus, isTaskStagedBundle, let original = initialKernelIdentity,
                                   original.birthSeconds == fixtureBirth[0], original.birthMicroseconds == fixtureBirth[1],
                                   original.executable == expectedBundle + "/Contents/MacOS/Octant",
                                   kernelIdentity(processId) == original,
                                   NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
                                   Date() < dispatchDeadline,
                                   let selectDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                                   let selectUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false),
                                   let textDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                                   let textUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
                                    selectDown.flags = .maskCommand
                                    selectUp.flags = .maskCommand
                                    selectDown.post(tap: .cghidEventTap)
                                    selectUp.post(tap: .cghidEventTap)
                                    let characters = Array(fixtureText.utf16)
                                    characters.withUnsafeBufferPointer { buffer in
                                        if let base = buffer.baseAddress {
                                            textDown.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
                                            textUp.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
                                        }
                                    }
                                    usleep(10_000)
                                    var finalFocus: CFTypeRef?
                                    if let element,
                                       AXUIElementCopyAttributeValue(element, kAXFocusedUIElementAttribute as CFString, &finalFocus) == .success,
                                       let finalFocus, CFGetTypeID(finalFocus) == AXUIElementGetTypeID(), CFEqual(finalFocus, target),
                                       NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
                                       kernelIdentity(processId) == original, Date() < dispatchDeadline {
                                        textDown.post(tap: .cghidEventTap)
                                        textUp.post(tap: .cghidEventTap)
                                        action["status"] = "text-dispatched"
                                        action["textDispatched"] = true
                                        action["characterCount"] = characters.count
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else { action["identityReadError"] = targetIdentityRead.rawValue }
    }
}
var dockObservation: [String: Any] = ["status": "not-requested"]
if (mode == "dock-read" || mode == "dock-click") && isTaskStagedBundle {
    dockObservation = ["status": mode == "dock-click" ? "refused" : "read-only", "interactionDispatched": false]
    let docks = NSWorkspace.shared.runningApplications.filter {
        $0.bundleIdentifier == "com.apple.dock" && $0.isTerminated == false &&
        $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == "/System/Library/CoreServices/Dock.app"
    }
    let live = NSRunningApplication(processIdentifier: processId)
    dockObservation["ownedAppIdentityMatched"] = treeIdentityMatched && matchingIds == [processId] && live?.isTerminated == false
    if treeIdentityMatched, matchingIds == [processId], docks.count == 1, let dock = docks.first {
        var groupPids = [pid_t](repeating: 0, count: 128)
        let groupCount = proc_listpgrppids(processId, &groupPids, Int32(groupPids.count * MemoryLayout<pid_t>.stride))
        let inventory = groupPids.prefix(max(0, min(Int(groupCount), 128))).compactMap { member -> [String: Any]? in
            guard let identity = kernelIdentity(member), identity.groupPid == UInt32(processId) else { return nil }
            return identity.evidence
        }
        dockObservation["ownedGroupKernelInventory"] = inventory
        dockObservation["ownedGroupKernelInventoryTruncated"] = groupCount >= 128
        dockObservation["ownedGroupKernelInventoryIncomplete"] = groupCount <= 0 || inventory.count != Int(groupCount)
        dockObservation["ownedGroupKernelCount"] = groupCount
        let dockElement = AXUIElementCreateApplication(dock.processIdentifier)
        var queue: [(AXUIElement, Int)] = [(dockElement, 0)]
        var cursor = 0, matches: [AXUIElement] = []
        var dockTruncated = false, dockErrors = Set<Int32>()
        let deadline = Date().addingTimeInterval(1)
        while cursor < queue.count, cursor < 128, Date() < deadline {
            let (node, depth) = queue[cursor]
            cursor += 1
            var urlValue: CFTypeRef?
            let urlRead = AXUIElementCopyAttributeValue(node, kAXURLAttribute as CFString, &urlValue)
            if urlRead == .success, let url = urlValue as? URL, url.isFileURL,
               url.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle {
                matches.append(node)
            } else if urlRead != .success && urlRead != .attributeUnsupported && urlRead != .noValue {
                dockErrors.insert(urlRead.rawValue)
            }
            if depth >= 8 { dockTruncated = true; continue }
            var children: CFTypeRef?
            let childrenRead = AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &children)
            if childrenRead == .success, let elements = children as? [AXUIElement] {
                if elements.count > 128 - queue.count { dockTruncated = true }
                queue.append(contentsOf: elements.prefix(max(0, 128 - queue.count)).map { ($0, depth + 1) })
            } else if childrenRead != .success && childrenRead != .attributeUnsupported && childrenRead != .noValue {
                dockErrors.insert(childrenRead.rawValue)
            }
        }
        dockObservation["dockPid"] = dock.processIdentifier
        dockObservation["visited"] = cursor
        dockObservation["truncated"] = dockTruncated || cursor < queue.count
        dockObservation["nativeReadErrors"] = dockErrors.sorted()
        dockObservation["exactOwnedBundleIconMatches"] = matches.count
        if !dockTruncated, cursor == queue.count, dockErrors.isEmpty, matches.count == 1, let icon = matches.first {
            var iconPid: pid_t = 0
            dockObservation["iconPidReadError"] = AXUIElementGetPid(icon, &iconPid).rawValue
            dockObservation["iconPid"] = iconPid
            // Read only the exact owned bundle's icon geometry. No other icon's
            // identity, label, URL or values are retained, and no action is sent.
            if iconPid == dock.processIdentifier, let frame = bounds(icon) {
                dockObservation["iconBounds"] = rectangle(frame)
                var enabled: CFTypeRef?, running: CFTypeRef?, iconRoleValue: CFTypeRef?, iconSubroleValue: CFTypeRef?, names: CFArray?
                let enabledRead = AXUIElementCopyAttributeValue(icon, kAXEnabledAttribute as CFString, &enabled)
                let runningRead = AXUIElementCopyAttributeValue(icon, kAXIsApplicationRunningAttribute as CFString, &running)
                let iconRoleRead = AXUIElementCopyAttributeValue(icon, kAXRoleAttribute as CFString, &iconRoleValue)
                let iconSubroleRead = AXUIElementCopyAttributeValue(icon, kAXSubroleAttribute as CFString, &iconSubroleValue)
                let namesRead = AXUIElementCopyActionNames(icon, &names)
                let namesList = names as? [String] ?? []
                let namesComplete = namesList.count <= 32 && namesList.allSatisfy { $0.count <= 256 }
                dockObservation["iconEnabledReadError"] = enabledRead.rawValue
                dockObservation["iconEnabled"] = binary(enabled).map { $0 as Any } ?? NSNull()
                dockObservation["iconRunningReadError"] = runningRead.rawValue
                dockObservation["iconRunning"] = binary(running).map { $0 as Any } ?? NSNull()
                dockObservation["iconRoleReadError"] = iconRoleRead.rawValue
                dockObservation["iconRole"] = iconRoleValue as? String ?? "unavailable"
                dockObservation["iconSubroleReadError"] = iconSubroleRead.rawValue
                dockObservation["iconSubrole"] = iconSubroleValue as? String ?? "unavailable"
                dockObservation["iconActionsReadError"] = namesRead.rawValue
                dockObservation["iconActions"] = namesList.prefix(32).map { String($0.prefix(256)) }
                dockObservation["iconActionsTruncated"] = !namesComplete
                let center = CGPoint(x: frame.midX, y: frame.midY)
                dockObservation["centerOnScreen"] = CGDisplayBounds(CGMainDisplayID()).contains(center)
                var hit: AXUIElement?
                let hitRead = AXUIElementCopyElementAtPosition(dockElement, Float(center.x), Float(center.y), &hit)
                var hitPid: pid_t = 0
                if let hit { _ = AXUIElementGetPid(hit, &hitPid) }
                var candidate = hit, belongs = false
                for _ in 0..<8 {
                    guard let current = candidate else { break }
                    if CFEqual(current, icon) { belongs = true; break }
                    var parent: CFTypeRef?
                    guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success,
                          let parent, CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
                    candidate = unsafeBitCast(parent, to: AXUIElement.self)
                }
                dockObservation["hitTestReadError"] = hitRead.rawValue
                dockObservation["hitOwnerPid"] = hitPid
                dockObservation["hitBelongsToExactIcon"] = belongs
                let pointWindows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
                let top = pointWindows.first {
                    (($0[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0 && cgBounds($0)?.contains(center) == true
                }
                dockObservation["pointWindowOwnerPid"] = (top?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
                dockObservation["pointWindowLayer"] = top?[kCGWindowLayer as String] ?? NSNull()
                dockObservation["postEventAccess"] = CGPreflightPostEventAccess()
                let birthParts = requestedTitle.split(separator: ":", omittingEmptySubsequences: false)
                let expectedBirth = birthParts.compactMap { UInt64($0) }
                let enabledPermitsDock = (enabledRead == .success && binary(enabled) == true) || enabledRead == .noValue
                let currentMatches = NSWorkspace.shared.runningApplications.filter {
                    $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle && !$0.isTerminated
                }
                if mode == "dock-click", birthParts.count == 2, expectedBirth.count == 2,
                   windowResult == .success, (windows as? NSArray)?.count == 0,
                   let original = initialKernelIdentity, original.pid == processId,
                   original.birthSeconds == expectedBirth[0], original.birthMicroseconds == expectedBirth[1],
                   original.executable == expectedBundle + "/Contents/MacOS/Octant",
                   currentMatches.count == 1, currentMatches.first?.processIdentifier == processId,
                   iconRoleRead == .success, (iconRoleValue as? String) == (kAXDockItemRole as String),
                   iconSubroleRead == .success, (iconSubroleValue as? String) == (kAXApplicationDockItemSubrole as String),
                   enabledPermitsDock, runningRead == .success, binary(running) == true,
                   namesRead == .success, namesComplete, namesList.contains(kAXPressAction as String),
                   frame.width >= 12, frame.height >= 12, CGDisplayBounds(CGMainDisplayID()).contains(frame),
                   hitRead == .success, hitPid == dock.processIdentifier, belongs,
                   (top?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == dock.processIdentifier,
                   (top?[kCGWindowLayer as String] as? NSNumber)?.intValue == 20,
                   CGPreflightPostEventAccess(), Date() < dispatchDeadline,
                   kernelIdentity(processId) == original,
                   let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: center, mouseButton: .left),
                   let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: center, mouseButton: .left) {
                    down.setIntegerValueField(.mouseEventClickState, value: 1)
                    up.setIntegerValueField(.mouseEventClickState, value: 1)
                    down.post(tap: .cghidEventTap)
                    usleep(50_000)
                    up.post(tap: .cghidEventTap)
                    dockObservation["status"] = "dispatched"
                    dockObservation["interactionDispatched"] = true
                    dockObservation["ownerKernelIdentity"] = original.evidence
                }
            }
        }
    }
}
var cleanupObservation: [String: Any] = ["status": "not-requested"]
if mode == "bundle-census" || mode == "bundle-cleanup" {
    if isTaskStagedBundle {
        let deadline = Date().addingTimeInterval(2.5)
        let graceful = Date().addingTimeInterval(1)
        var sent = Set<String>(), stopErrors = 0
        var census = bundleCensus(deadline)
        let initial = census.owned.map { $0.evidence }
        while mode == "bundle-cleanup", (!census.complete || !census.owned.isEmpty), Date() < deadline {
            let signal = Date() < graceful ? SIGTERM : SIGKILL
            for identity in census.owned {
                let key = "\(identity.pid):\(identity.birthSeconds):\(identity.birthMicroseconds):\(signal)"
                if sent.contains(key) { continue }
                // Revalidate kernel birth and exact canonical executable immediately
                // before each signal. Never signal Dock or a process by app name.
                guard let current = kernelIdentity(identity.pid), current == identity,
                      current.executable.hasPrefix(expectedBundle + "/") else { continue }
                sent.insert(key)
                if kill(identity.pid, signal) != 0 && errno != ESRCH { stopErrors += 1 }
            }
            usleep(50_000)
            census = bundleCensus(deadline)
        }
        let status = census.complete && census.owned.isEmpty && stopErrors == 0 ? "absent" :
            (mode == "bundle-census" && census.complete ? "owned-present" : "incomplete")
        cleanupObservation = ["status": status,
            "censusComplete": census.complete, "initialOwned": initial,
            "remainingOwned": census.owned.map { $0.evidence }, "signalCount": sent.count, "stopErrors": stopErrors,
            "readOnly": mode == "bundle-census"]
    } else { cleanupObservation = ["status": "refused-invalid-task-staging-root"] }
}
let evidence: [String: Any] = [
    "capturedPid": processId,
    "ownerKernelIdentity": initialKernelIdentity?.evidence ?? [:],
    "cleanupObservation": cleanupObservation,
    "diagnosticPid": ProcessInfo.processInfo.processIdentifier,
    "expectedStagedBundle": expectedBundle,
    "capturedExecutable": application?.executableURL?.path ?? "unavailable",
    "capturedBundle": capturedBundle ?? "unavailable",
    "stagedBundleMatches": matchingApplications.map { ["pid": $0.processIdentifier, "executable": $0.executableURL?.path ?? "unavailable"] },
    "nativeAxTrusted": kernelOnly ? (NSNull() as Any) : AXIsProcessTrusted(),
    "ownerAppActive": application?.isActive ?? false,
    "frontmostPid": kernelOnly ? (NSNull() as Any) : (NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0),
    "attributeNamesError": attributeResult.rawValue,
    "attributeNames": attributes as? [String] ?? [],
    "roleError": roleResult.rawValue, "role": role as? String ?? "unavailable",
    "attributeSets": attributeSets,
    "windowsError": windowResult.rawValue, "axWindowCount": (windows as? NSArray)?.count ?? -1,
    "interactiveControls": controls, "treeIdentityMatched": treeIdentityMatched,
    "treeVisited": next, "treeReadErrors": readErrors, "treeNativeErrors": nativeReadErrors.sorted(),
    "treeTruncated": truncated, "action": action, "dockObservation": dockObservation,
    "quitHintObserved": quitHintTitleSeen && quitHintDetailSeen,
    "quitHintTitleSeen": quitHintTitleSeen, "quitHintDetailSeen": quitHintDetailSeen,
    "quitToastBranches": quitToastBranches,
    "treeDepthLimited": depthLimited, "treeLabelsLimited": labelsLimited,
    "treeNodeLimited": pending.count >= 512,
    "treeTimeLimited": next < pending.count && Date() >= treeDeadline,
    "cgMetadataAvailable": nativeWindows != nil, "candidateWindowOwners": candidateWindows,
]
// Optional booleans are represented explicitly, not by reading arbitrary AX values.
let encoded = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])
FileHandle.standardOutput.write(encoded)
