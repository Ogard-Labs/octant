import AppKit
import ApplicationServices
import Foundation
import Darwin
import Security

// Owned-runner native UI QA. Never requests a TCC permission or reads text-field
// values or credentials. Dock reads retain only the exact staged bundle icon.
guard (3...6).contains(CommandLine.arguments.count),
      let processId = Int32(CommandLine.arguments[1]), processId > 1 else { exit(2) }
let mode = CommandLine.arguments.count >= 4 ? CommandLine.arguments[3] : "diagnostic"
let fixedFolderModes = ["picker-fill-owned-location", "picker-go-owned-location", "picker-choose-owned-folder", "picker-create-owned-project"]
let fixesOwnedFolder = fixedFolderModes.contains(mode)
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
guard ["diagnostic", "read", "click", "reveal", "dock-read", "quit-hint", "dock-click", "bundle-census", "bundle-cleanup", "fill-name", "fill-address", "picker-metadata", "picker-location-prompt"].contains(mode) || fixesOwnedFolder,
      (mode == "click" || mode == "reveal" || mode == "dock-click" || fillsFixtureField || mode == "picker-metadata" || mode == "picker-location-prompt" || fixesOwnedFolder) == !requestedTitle.isEmpty,
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
// These purposes accept numeric pins only. The path comes from this owned
// controller's executable, never a caller-supplied directory or field value.
let folderPins = requestedTitle.split(separator: ":", omittingEmptySubsequences: false).compactMap { UInt64($0) }
func ownedFixturePath() -> String? {
    guard fixesOwnedFolder, folderPins.count == 11, requestedTitle.split(separator: ":", omittingEmptySubsequences: false).count == 11,
          let own = kernelIdentity(getpid()), own.executable.hasSuffix("/ax-controller") else { return nil }
    let root = URL(fileURLWithPath: own.executable).deletingLastPathComponent()
    guard root.lastPathComponent.hasPrefix("octant-browser-owner-native."),
          root.lastPathComponent.count <= 128, root.lastPathComponent.count > "octant-browser-owner-native.".count,
          root.deletingLastPathComponent().path == temporary else { return nil }
    let directories = [root, root.appendingPathComponent("home"), root.appendingPathComponent("home/owned-browser-project")]
    for (index, url) in directories.enumerated() {
        var metadata = stat()
        guard url.resolvingSymlinksInPath().standardizedFileURL.path == url.path,
              lstat(url.path, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_uid == geteuid(), metadata.st_dev >= 0,
              UInt64(metadata.st_dev) == folderPins[5 + 2 * index], metadata.st_ino == folderPins[6 + 2 * index] else { return nil }
        if index == 0 && metadata.st_mode & 0o077 != 0 { return nil }
    }
    let path = directories[2].path
    return path.utf8.count < Int(PATH_MAX) ? path : nil
}
var fixedFolderNativeStatuses: [String: Int32] = [:]
var fixedFolderWindowAncestryUsed = false
var fixedFolderSheetFrameAdmitted = false
var fixedFolderKeyboardFocusProof: Bool?
var fixedFolderKeyboardFocusChecks: [String: Any] = [:]
var fixedFolderGeometry: [String: Any] = ["targetInsideResolvedWindow": NSNull(), "centerOnScreen": NSNull(),
    "topPointOwnerMatched": NSNull(), "topFrameMatched": NSNull()]
var fixedFolderSheetGeometry: [String: Any] = ["topLevelMatchesInnerSheet": NSNull(), "targetInsideInnerSheet": NSNull(),
    "topFrameMatchesInnerSheet": NSNull(), "topFrameMatchesOuterSheet": NSNull()]
let unknownFixedFolderHitChecks: [String: Any] = ["firstPidReadStatus": NSNull(), "firstOwnerMatched": NSNull(),
    "firstExactTargetMatched": NSNull(), "lastPidReadStatus": NSNull(), "lastOwnerMatched": NSNull(),
    "lastExactTargetMatched": NSNull(), "parentReadStatus": NSNull(), "visited": NSNull(), "termination": NSNull(),
    "finalFieldCurrent": NSNull(), "finalDeadline": NSNull(), "finalFixture": NSNull(), "finalOwnerKernel": NSNull(),
    "finalOwnerLive": NSNull(), "finalOwnerBundle": NSNull(), "finalFrontmost": NSNull(),
    "finalAxTrusted": NSNull(), "finalPostPermission": NSNull()]
var fixedFolderHitChecks = unknownFixedFolderHitChecks
func fixedFolderFrame(_ node: AXUIElement) -> CGRect? {
    var position: CFTypeRef?, size: CFTypeRef?
    let positionStatus = AXUIElementCopyAttributeValue(node, kAXPositionAttribute as CFString, &position)
    let sizeStatus = AXUIElementCopyAttributeValue(node, kAXSizeAttribute as CFString, &size)
    fixedFolderNativeStatuses["position"] = positionStatus.rawValue
    fixedFolderNativeStatuses["size"] = sizeStatus.rawValue
    guard positionStatus == .success, sizeStatus == .success,
          let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions),
          [point.x, point.y, dimensions.width, dimensions.height].allSatisfy({ $0.isFinite }),
          dimensions.width >= 12, dimensions.height >= 12 else { return nil }
    return CGRect(origin: point, size: dimensions)
}
func fixedFolderInputPoint(_ target: AXUIElement, _ deadline: Date, _ admit: (AXUIElement) -> Bool, _ expectedFieldRoot: AXUIElement? = nil,
    _ expectedFieldSheets: [AXUIElement] = [], _ fieldCurrent: (() -> Bool)? = nil) -> CGPoint? {
    fixedFolderGeometry = ["targetInsideResolvedWindow": NSNull(), "centerOnScreen": NSNull(),
        "topPointOwnerMatched": NSNull(), "topFrameMatched": NSNull()]
    fixedFolderSheetGeometry = ["topLevelMatchesInnerSheet": NSNull(), "targetInsideInnerSheet": NSNull(),
        "topFrameMatchesInnerSheet": NSNull(), "topFrameMatchesOuterSheet": NSNull()]
    fixedFolderSheetFrameAdmitted = false
    fixedFolderKeyboardFocusProof = nil
    fixedFolderKeyboardFocusChecks = [:]
    fixedFolderHitChecks = unknownFixedFolderHitChecks
    guard admit(target), Date() < deadline, ownedFixturePath() != nil, AXIsProcessTrusted(), CGPreflightPostEventAccess(),
          kernelIdentity(processId) == initialKernelIdentity,
          NSRunningApplication(processIdentifier: processId)?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
          let targetFrame = fixedFolderFrame(target) else { return nil }
    var targetPid: pid_t = 0, windowPid: pid_t = 0, windowRaw: CFTypeRef?
    let targetStatus = AXUIElementGetPid(target, &targetPid)
    let windowStatus = AXUIElementCopyAttributeValue(target, kAXWindowAttribute as CFString, &windowRaw)
    fixedFolderNativeStatuses["targetPid"] = targetStatus.rawValue
    fixedFolderNativeStatuses["targetWindow"] = windowStatus.rawValue
    guard targetStatus == .success, targetPid == processId else { return nil }
    var resolvedWindow: AXUIElement?, ancestryWindow = false
    if windowStatus == .success, let windowRaw, CFGetTypeID(windowRaw) == AXUIElementGetTypeID() {
        resolvedWindow = unsafeBitCast(windowRaw, to: AXUIElement.self)
    } else if windowStatus == .noValue, let expectedFieldRoot,
              mode == "picker-fill-owned-location" || mode == "picker-go-owned-location" {
        // The actual location field returned no AXWindow. Resolve only its
        // already-proved owned root through parents, never a foreign service.
        var fieldRole: CFTypeRef?, fieldSubrole: CFTypeRef?
        let roleStatus = AXUIElementCopyAttributeValue(target, kAXRoleAttribute as CFString, &fieldRole)
        let subroleStatus = AXUIElementCopyAttributeValue(target, kAXSubroleAttribute as CFString, &fieldSubrole)
        fixedFolderNativeStatuses["windowFieldRole"] = roleStatus.rawValue
        fixedFolderNativeStatuses["windowFieldSubrole"] = subroleStatus.rawValue
        guard roleStatus == .success, (fieldRole as? String) == "AXTextField",
              subroleStatus == .success || subroleStatus == .noValue || subroleStatus == .attributeUnsupported,
              !["AXSearchField", "AXSecureTextField"].contains(fieldSubrole as? String ?? "") else { return nil }
        var cursor = target, visited = Set<CFHashCode>()
        for _ in 0..<40 {
            var pid: pid_t = 0
            guard admit(cursor), Date() < deadline, visited.insert(CFHash(cursor)).inserted else { return nil }
            let status = AXUIElementGetPid(cursor, &pid)
            fixedFolderNativeStatuses["windowAncestorPid"] = status.rawValue
            guard status == .success, pid == processId else { return nil }
            if CFEqual(cursor, expectedFieldRoot) {
                var role: CFTypeRef?
                let status = AXUIElementCopyAttributeValue(cursor, kAXRoleAttribute as CFString, &role)
                fixedFolderNativeStatuses["windowAncestorRole"] = status.rawValue
                guard status == .success, (role as? String) == "AXWindow" else { return nil }
                resolvedWindow = cursor; ancestryWindow = true; break
            }
            var parent: CFTypeRef?
            let parentStatus = AXUIElementCopyAttributeValue(cursor, kAXParentAttribute as CFString, &parent)
            fixedFolderNativeStatuses["windowAncestorParent"] = parentStatus.rawValue
            guard parentStatus == .success, let parent, CFGetTypeID(parent) == AXUIElementGetTypeID() else { return nil }
            cursor = unsafeBitCast(parent, to: AXUIElement.self)
        }
    }
    guard let window = resolvedWindow, admit(window), let element else { return nil }
    var currentWindows: CFTypeRef?
    let listStatus = AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &currentWindows)
    fixedFolderNativeStatuses["windowLiveList"] = listStatus.rawValue
    guard listStatus == .success, (currentWindows as? [AXUIElement])?.contains(where: { CFEqual($0, window) }) == true,
          AXUIElementGetPid(window, &windowPid) == .success, windowPid == processId else { return nil }
    if ancestryWindow { fixedFolderWindowAncestryUsed = true }
    guard let windowFrame = fixedFolderFrame(window) else { return nil }
    let targetInsideWindow = windowFrame.contains(targetFrame)
    fixedFolderGeometry["targetInsideResolvedWindow"] = targetInsideWindow
    guard targetInsideWindow else { return nil }
    let point = CGPoint(x: targetFrame.midX, y: targetFrame.midY)
    let centerOnScreen = CGDisplayBounds(CGMainDisplayID()).contains(point)
    fixedFolderGeometry["centerOnScreen"] = centerOnScreen
    guard centerOnScreen else { return nil }
    let top = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).first { row in
        guard ((row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0,
              let values = row[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: values as CFDictionary) else { return false }
        return frame.contains(point)
    }
    fixedFolderGeometry["topPointOwnerMatched"] = (top?[kCGWindowOwnerPID as String] as? NSNumber).map { ($0.int32Value == processId) as Any } ?? NSNull()
    if let values = top?[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: values as CFDictionary) {
        fixedFolderGeometry["topFrameMatched"] = abs(frame.minX - windowFrame.minX) <= 2 && abs(frame.minY - windowFrame.minY) <= 2 &&
            abs(frame.width - windowFrame.width) <= 2 && abs(frame.height - windowFrame.height) <= 2
    }
    // A location sheet's frame can differ from its attached root. Only the
    // fixed field may use its independently proved inner sheet's frame.
    if (mode == "picker-fill-owned-location" || mode == "picker-go-owned-location"), expectedFieldSheets.count == 2,
       let expectedFieldRoot, CFEqual(window, expectedFieldRoot),
       fixedFolderGeometry["topFrameMatched"] as? Bool == false,
       (top?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processId,
       let values = top?[kCGWindowBounds as String] as? [String: Any], let topFrame = CGRect(dictionaryRepresentation: values as CFDictionary),
       fieldCurrent?() == true, Date() < deadline, ownedFixturePath() != nil,
       NSWorkspace.shared.frontmostApplication?.processIdentifier == processId, AXIsProcessTrusted(), CGPreflightPostEventAccess() {
        let inner = expectedFieldSheets[0], outer = expectedFieldSheets[1]
        var child = target
        for (index, sheet) in expectedFieldSheets.enumerated() {
            var pid: pid_t = 0, parent: CFTypeRef?, role: CFTypeRef?
            guard admit(sheet), Date() < deadline else { return nil }
            let pidStatus = AXUIElementGetPid(sheet, &pid)
            fixedFolderNativeStatuses["diagnosticSheet\(index)Pid"] = pidStatus.rawValue
            guard pidStatus == .success, pid == processId else { return nil }
            let roleStatus = AXUIElementCopyAttributeValue(sheet, kAXRoleAttribute as CFString, &role)
            fixedFolderNativeStatuses["diagnosticSheet\(index)Role"] = roleStatus.rawValue
            guard roleStatus == .success, (role as? String) == "AXSheet" else { return nil }
            var childPid: pid_t = 0
            let childStatus = AXUIElementGetPid(child, &childPid)
            fixedFolderNativeStatuses["diagnosticSheet\(index)ChildPid"] = childStatus.rawValue
            guard childStatus == .success, childPid == processId else { return nil }
            let parentStatus = AXUIElementCopyAttributeValue(child, kAXParentAttribute as CFString, &parent)
            fixedFolderNativeStatuses["diagnosticSheet\(index)Parent"] = parentStatus.rawValue
            guard parentStatus == .success, let parent, CFGetTypeID(parent) == AXUIElementGetTypeID(), CFEqual(parent, sheet) else { return nil }
            child = sheet
        }
        var topLevelRaw: CFTypeRef?, targetPid: pid_t = 0
        guard AXUIElementGetPid(target, &targetPid) == .success, targetPid == processId else { return nil }
        let topLevelStatus = AXUIElementCopyAttributeValue(target, kAXTopLevelUIElementAttribute as CFString, &topLevelRaw)
        fixedFolderNativeStatuses["diagnosticTopLevel"] = topLevelStatus.rawValue
        var topLevelMatches: Bool?
        if topLevelStatus == .success {
            guard let topLevelRaw, CFGetTypeID(topLevelRaw) == AXUIElementGetTypeID() else { return nil }
            let topLevel = unsafeBitCast(topLevelRaw, to: AXUIElement.self)
            var topLevelPid: pid_t = 0
            guard admit(topLevel) else { return nil }
            let topLevelPidStatus = AXUIElementGetPid(topLevel, &topLevelPid)
            fixedFolderNativeStatuses["diagnosticTopLevelPid"] = topLevelPidStatus.rawValue
            guard topLevelPidStatus == .success, topLevelPid == processId else { return nil }
            topLevelMatches = CFEqual(topLevel, inner)
        } else if topLevelStatus != .noValue && topLevelStatus != .attributeUnsupported { return nil }
        let innerFrameResult = fixedFolderFrame(inner)
        fixedFolderNativeStatuses["diagnosticInnerPosition"] = fixedFolderNativeStatuses["position"]
        fixedFolderNativeStatuses["diagnosticInnerSize"] = fixedFolderNativeStatuses["size"]
        let outerFrameResult = fixedFolderFrame(outer)
        fixedFolderNativeStatuses["diagnosticOuterPosition"] = fixedFolderNativeStatuses["position"]
        fixedFolderNativeStatuses["diagnosticOuterSize"] = fixedFolderNativeStatuses["size"]
        guard let innerFrame = innerFrameResult, let outerFrame = outerFrameResult else { return nil }
        func frameMatches(_ frame: CGRect) -> Bool {
            return abs(topFrame.minX - frame.minX) <= 2 && abs(topFrame.minY - frame.minY) <= 2 &&
                abs(topFrame.width - frame.width) <= 2 && abs(topFrame.height - frame.height) <= 2
        }
        guard fieldCurrent?() == true, Date() < deadline, ownedFixturePath() != nil,
              kernelIdentity(processId) == initialKernelIdentity,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
              AXIsProcessTrusted(), CGPreflightPostEventAccess() else { return nil }
        fixedFolderSheetGeometry = ["topLevelMatchesInnerSheet": topLevelMatches.map { $0 as Any } ?? NSNull(),
            "targetInsideInnerSheet": innerFrame.contains(targetFrame),
            "topFrameMatchesInnerSheet": frameMatches(innerFrame), "topFrameMatchesOuterSheet": frameMatches(outerFrame)]
        fixedFolderSheetFrameAdmitted = innerFrame.contains(targetFrame) && frameMatches(innerFrame)
    }
    guard (top?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processId,
          let values = top?[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: values as CFDictionary),
          (abs(frame.minX - windowFrame.minX) <= 2 && abs(frame.minY - windowFrame.minY) <= 2 &&
           abs(frame.width - windowFrame.width) <= 2 && abs(frame.height - windowFrame.height) <= 2) || fixedFolderSheetFrameAdmitted else { return nil }
    let usesOwnedLocationKeyboardFocus = (mode == "picker-fill-owned-location" || mode == "picker-go-owned-location") &&
        expectedFieldRoot != nil && expectedFieldSheets.count == 2 && fieldCurrent != nil
    if usesOwnedLocationKeyboardFocus {
        fixedFolderKeyboardFocusProof = false
        guard fixedFolderSheetFrameAdmitted, let expectedFieldRoot, CFEqual(window, expectedFieldRoot) else { return nil }
        // These fixed key pairs go to the current field, not the mouse-hit
        // ancestor. Keep the exact focus/sheet proof separate from mouse hits.
        func keyboardCheck(_ key: String, _ value: Bool) -> Bool {
            fixedFolderKeyboardFocusChecks[key] = value
            return value
        }
        let live = NSRunningApplication(processIdentifier: processId)
        guard keyboardCheck("exactFocusedFieldAndSheets", fieldCurrent?() == true),
              keyboardCheck("deadline", Date() < deadline),
              keyboardCheck("fixture", ownedFixturePath() != nil),
              keyboardCheck("ownerKernel", kernelIdentity(processId) == initialKernelIdentity),
              keyboardCheck("ownerLive", live?.isTerminated == false),
              keyboardCheck("ownerBundle", live?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle),
              keyboardCheck("frontmost", NSWorkspace.shared.frontmostApplication?.processIdentifier == processId),
              keyboardCheck("axTrusted", AXIsProcessTrusted()),
              keyboardCheck("postPermission", CGPreflightPostEventAccess()) else { return nil }
        fixedFolderKeyboardFocusProof = true
        return point
    }
    var hit: AXUIElement?
    let hitStatus = AXUIElementCopyElementAtPosition(element, Float(point.x), Float(point.y), &hit)
    fixedFolderNativeStatuses["hitTest"] = hitStatus.rawValue
    guard hitStatus == .success, let hit else { return nil }
    var cursor = hit, seen = Set<CFHashCode>()
    fixedFolderHitChecks["visited"] = 0
    func recordedHitCheck(_ key: String, _ value: Bool) -> Bool {
        fixedFolderHitChecks[key] = value
        return value
    }
    for index in 0..<40 {
        var pid: pid_t = 0
        guard admit(cursor), Date() < deadline, seen.insert(CFHash(cursor)).inserted else {
            fixedFolderHitChecks["termination"] = "admission-time-or-cycle-refused"; return nil
        }
        fixedFolderHitChecks["visited"] = index + 1
        let pidStatus = AXUIElementGetPid(cursor, &pid)
        fixedFolderHitChecks["lastPidReadStatus"] = pidStatus.rawValue
        fixedFolderHitChecks["lastOwnerMatched"] = pidStatus == .success ? (pid == processId) as Any : NSNull()
        if index == 0 {
            fixedFolderHitChecks["firstPidReadStatus"] = pidStatus.rawValue
            fixedFolderHitChecks["firstOwnerMatched"] = fixedFolderHitChecks["lastOwnerMatched"]
        }
        guard pidStatus == .success, pid == processId else {
            fixedFolderHitChecks["termination"] = pidStatus == .success ? "owner-mismatch" : "pid-read-failed"; return nil
        }
        let exactTarget = CFEqual(cursor, target)
        fixedFolderHitChecks["lastExactTargetMatched"] = exactTarget
        if index == 0 { fixedFolderHitChecks["firstExactTargetMatched"] = exactTarget }
        if exactTarget {
            let live = NSRunningApplication(processIdentifier: processId)
            guard (!fixedFolderSheetFrameAdmitted || recordedHitCheck("finalFieldCurrent", fieldCurrent?() == true)),
                  recordedHitCheck("finalDeadline", Date() < deadline),
                  recordedHitCheck("finalFixture", ownedFixturePath() != nil),
                  recordedHitCheck("finalOwnerKernel", kernelIdentity(processId) == initialKernelIdentity),
                  recordedHitCheck("finalOwnerLive", live?.isTerminated == false),
                  recordedHitCheck("finalOwnerBundle", live?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle),
                  recordedHitCheck("finalFrontmost", NSWorkspace.shared.frontmostApplication?.processIdentifier == processId),
                  recordedHitCheck("finalAxTrusted", AXIsProcessTrusted()),
                  recordedHitCheck("finalPostPermission", CGPreflightPostEventAccess()) else {
                fixedFolderHitChecks["termination"] = "final-admission-refused"; return nil
            }
            fixedFolderHitChecks["termination"] = "point-proof-complete"
            return point
        }
        var parent: CFTypeRef?
        let parentStatus = AXUIElementCopyAttributeValue(cursor, kAXParentAttribute as CFString, &parent)
        fixedFolderHitChecks["parentReadStatus"] = parentStatus.rawValue
        guard parentStatus == .success, let parent, CFGetTypeID(parent) == AXUIElementGetTypeID() else {
            fixedFolderHitChecks["termination"] = "parent-unavailable"; return nil
        }
        cursor = unsafeBitCast(parent, to: AXUIElement.self)
    }
    fixedFolderHitChecks["termination"] = "depth-bound"
    return nil
}
func fixedFolderButtonEnabled(_ target: AXUIElement) -> Bool {
    var enabled: CFTypeRef?, actions: CFArray?, pid: pid_t = 0
    guard AXUIElementGetPid(target, &pid) == .success, pid == processId,
          AXUIElementCopyAttributeValue(target, kAXEnabledAttribute as CFString, &enabled) == .success,
          let enabled, CFGetTypeID(enabled) == CFBooleanGetTypeID(), CFEqual(enabled, kCFBooleanTrue),
          AXUIElementCopyActionNames(target, &actions) == .success,
          let names = actions as? [String], names.count <= 32, names.contains("AXPress") else { return false }
    return true
}
if mode == "picker-create-owned-project" {
    let deadline = Date().addingTimeInterval(3)
    var receipt: [String: Any] = ["status": "blocked", "rawValueCaptured": false, "directoryLabelsRead": false,
        "projectCreationDispatched": false, "namedReaderReopened": false]
    var errors: [[String: Any]] = [], seen = Set<CFHashCode>()
    func ownerCurrent() -> Bool {
        return folderPins.count == 11 && initialKernelIdentity?.birthSeconds == folderPins[0] &&
            initialKernelIdentity?.birthMicroseconds == folderPins[1] &&
            initialKernelIdentity?.executable == expectedBundle + "/Contents/MacOS/Octant" &&
            kernelIdentity(processId) == initialKernelIdentity && isTaskStagedBundle && treeIdentityMatched &&
            matchingIds == [processId] && ownedFixturePath() != nil && Date() < deadline
    }
    func admit(_ node: AXUIElement) -> Bool {
        if seen.contains(CFHash(node)) { return Date() < deadline }
        guard seen.count < 512, Date() < deadline else { return false }
        seen.insert(CFHash(node)); return true
    }
    func fixedText(_ node: AXUIElement, _ attribute: CFString) -> String? {
        var raw: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(node, attribute, &raw)
        if status != .success && status != .noValue && status != .attributeUnsupported {
            errors.append(["status": status.rawValue]); return nil
        }
        return status == .success ? raw as? String : nil
    }
    // No picker or general named-control reader is used here. Only roles are
    // walked until the fixed Create Project dialog is proved inside this app.
    var targets: [AXUIElement] = [], folderTargets: [AXUIElement] = [], dialogs: [AXUIElement] = []
    var selectedFolders = 0, complete = true
    var queue = (ownerCurrent() && windowResult == .success ? (windows as? [AXUIElement] ?? []) : []).map { (node: $0, depth: 0, dialog: false) }
    var index = 0
    if queue.count > 512 { complete = false }
    while complete, index < queue.count, ownerCurrent() {
        let entry = queue[index]; index += 1
        guard admit(entry.node) else { complete = false; break }
        var pid: pid_t = 0
        let status = AXUIElementGetPid(entry.node, &pid)
        guard status == .success, pid == processId else { errors.append(["status": status.rawValue]); complete = false; break }
        guard let role = fixedText(entry.node, kAXRoleAttribute as CFString), role.hasPrefix("AX"), role.count <= 64 else { complete = false; break }
        let subrole = fixedText(entry.node, kAXSubroleAttribute as CFString) ?? ""
        if role == "AXSheet" { complete = false; break }
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" { continue }
        let isCreateDialog = subrole == "AXApplicationDialog" && fixedText(entry.node, kAXTitleAttribute as CFString) == "Create Project"
        if isCreateDialog { dialogs.append(entry.node) }
        let inDialog = entry.dialog || isCreateDialog
        if inDialog, role == "AXButton" {
            let text = fixedText(entry.node, kAXTitleAttribute as CFString)
            if text == "owned-browser-project" || text == "owned-browser-project Change" { selectedFolders += 1; folderTargets.append(entry.node) }
            if text == "Create Project" {
                var enabled: CFTypeRef?
                let enabledStatus = AXUIElementCopyAttributeValue(entry.node, kAXEnabledAttribute as CFString, &enabled)
                if enabledStatus == .success, let enabled, CFGetTypeID(enabled) == CFBooleanGetTypeID(), CFEqual(enabled, kCFBooleanTrue) {
                    targets.append(entry.node)
                } else { errors.append(["status": enabledStatus.rawValue]); complete = false; break }
            }
        }
        guard entry.depth < 40 else { complete = false; break }
        var children: CFTypeRef?
        let childStatus = AXUIElementCopyAttributeValue(entry.node, kAXChildrenAttribute as CFString, &children)
        if childStatus == .success {
            guard let nodes = children as? [AXUIElement], queue.count + nodes.count <= 512 else { complete = false; break }
            queue.append(contentsOf: nodes.map { (node: $0, depth: entry.depth + 1, dialog: inDialog) })
        } else if childStatus != .noValue && childStatus != .attributeUnsupported {
            errors.append(["status": childStatus.rawValue]); complete = false; break
        }
    }
    receipt["nativeErrors"] = errors
    receipt["uniqueEnabledCreateProject"] = targets.count == 1
    receipt["uniqueOwnedFolderDisplayName"] = selectedFolders == 1
    receipt["complete"] = complete && index == queue.count
    func stillInsideDialog(_ child: AXUIElement, _ dialog: AXUIElement) -> Bool {
        var cursor = child, visited = Set<CFHashCode>()
        for _ in 0..<40 {
            var pid: pid_t = 0
            guard ownerCurrent(), admit(cursor), visited.insert(CFHash(cursor)).inserted,
                  AXUIElementGetPid(cursor, &pid) == .success, pid == processId else { return false }
            if CFEqual(cursor, dialog) { return true }
            var raw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(cursor, kAXParentAttribute as CFString, &raw) == .success,
                  let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return false }
            cursor = unsafeBitCast(raw, to: AXUIElement.self)
        }
        return false
    }
    if complete, index == queue.count, errors.isEmpty, selectedFolders == 1, folderTargets.count == 1,
       dialogs.count == 1, let dialog = dialogs.first, let folder = folderTargets.first,
       targets.count == 1, let target = targets.first,
       ownerCurrent(), stillInsideDialog(target, dialog), stillInsideDialog(folder, dialog),
       fixedText(dialog, kAXTitleAttribute as CFString) == "Create Project",
       fixedText(target, kAXTitleAttribute as CFString) == "Create Project", fixedFolderButtonEnabled(target),
       let point = fixedFolderInputPoint(target, deadline, admit),
       let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
       let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left),
       ownerCurrent(), stillInsideDialog(target, dialog), stillInsideDialog(folder, dialog),
       fixedText(target, kAXTitleAttribute as CFString) == "Create Project", fixedFolderButtonEnabled(target),
       ["owned-browser-project", "owned-browser-project Change"].contains(fixedText(folder, kAXTitleAttribute as CFString) ?? ""),
       errors.isEmpty, fixedFolderInputPoint(target, deadline, admit) == point {
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        receipt["projectCreationDispatched"] = true; receipt["status"] = "dispatched"
    }
    receipt["hitChecks"] = fixedFolderHitChecks
    receipt["geometryChecks"] = fixedFolderGeometry
    receipt["nativeStatuses"] = fixedFolderNativeStatuses
    receipt["capturedPid"] = processId
    receipt["capturedIdentityMatched"] = ownerCurrent()
    receipt["fixtureIdentityMatched"] = ownedFixturePath() != nil
    receipt["timeLimitReached"] = Date() >= deadline
    receipt["metadataNodes"] = seen.count
    if let data = try? JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text) }
    else { exit(2) }
    exit(0)
}
if mode == "picker-metadata" || mode == "picker-location-prompt" || (fixesOwnedFolder && mode != "picker-create-owned-project") {
    // The native chooser may expose filesystem names through ordinary labels.
    // This separate read path never requests titles, descriptions or values.
    let parts = requestedTitle.split(separator: ":", omittingEmptySubsequences: false)
    let birth = parts.compactMap { UInt64($0) }
    let admitted = isTaskStagedBundle && treeIdentityMatched && matchingIds == [processId] &&
        parts.count == (fixesOwnedFolder ? 11 : 2) && birth.count == parts.count &&
        initialKernelIdentity?.birthSeconds == birth[0] && initialKernelIdentity?.birthMicroseconds == birth[1] &&
        initialKernelIdentity?.executable == expectedBundle + "/Contents/MacOS/Octant"
    let deadline = Date().addingTimeInterval(3)
    struct PickerNode {
        let node: AXUIElement
        let depth: Int
        let parentRow: Int?
        let windowIndex: Int
        let sheetRow: Int?
    }
    var queue = (admitted && windowResult == .success ? (windows as? [AXUIElement] ?? []) : []).enumerated().map {
        PickerNode(node: $0.element, depth: 0, parentRow: nil, windowIndex: $0.offset, sheetRow: nil)
    }
    var seen = Set<CFHashCode>(), processes = Set<pid_t>()
    var ownedWindowRoots = Set<Int>(), ownedSheets = Set<Int>()
    var rows: [[String: Any]] = [], processRows: [[String: Any]] = []
    var retainedNodes: [AXUIElement] = [], parentRows: [Int?] = []
    var promptDispatched = false, fixedControlLabelsCompared = false, fixedOwnedFieldCompared = false
    var fixedFolder: [String: Any] = ["status": fixesOwnedFolder ? "blocked" : "not-requested",
        "rawValueCaptured": false, "typingDispatched": false, "goDispatched": false, "chooserDispatched": false]
    var locationPrompt: [String: Any] = ["status": "not-requested", "interactionDispatched": false, "typingDispatched": false,
        "confirmationDispatched": false, "selectionDispatched": false, "fieldValuesRead": false,
        "directoryLabelsRead": false]
    if mode == "picker-location-prompt" { locationPrompt["status"] = "blocked" }
    var serviceSubtree: [String: Any] = ["status": "not-observed", "roles": [],
        "interactionDispatched": false, "labelsOrValuesRead": false]
    var serviceNode: [String: Any] = ["status": "not-observed", "childrenTraversed": false,
        "codeSigningVerified": false, "interactionDispatched": false]
    var index = 0, errors = 0
    var pickerNativeErrors: [[String: Any]] = []
    func recordPickerError(_ stage: String, _ error: AXError) {
        if pickerNativeErrors.count < 512 { pickerNativeErrors.append(["stage": stage, "status": error.rawValue]) }
    }
    var depthCut = false, nodeCut = queue.count > 512, foreignPid = false, dialogSeen = false
    queue = Array(queue.prefix(512))
    func roleOnly(_ node: AXUIElement, _ attribute: CFString) -> String {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(node, attribute, &value)
        if result != .success && result != .noValue && result != .attributeUnsupported {
            errors += 1; recordPickerError("role-or-subrole", result)
        }
        guard result == .success, let text = value as? String,
              text.hasPrefix("AX"), text.count <= 64,
              text.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) }) else { return "" }
        return text
    }
    while index < queue.count && index < 512 && Date() < deadline {
        let entry = queue[index]; index += 1
        let node = entry.node, depth = entry.depth
        guard seen.insert(CFHash(node)).inserted else { continue }
        var nodePid: pid_t = 0
        let pidRead = AXUIElementGetPid(node, &nodePid)
        if pidRead != .success || nodePid <= 1 { errors += 1; break }
        if processes.insert(nodePid).inserted {
            let identity = kernelIdentity(nodePid)
            let running = NSRunningApplication(processIdentifier: nodePid)
            let bundleId = running?.bundleIdentifier ?? ""
            let safeBundleId = bundleId.count <= 256 && !bundleId.isEmpty && bundleId.unicodeScalars.allSatisfy {
                CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "-"
            } ? bundleId : "unavailable"
            processRows.append(["pid": nodePid,
                "birthSeconds": identity.map { $0.birthSeconds as Any } ?? NSNull(),
                "birthMicroseconds": identity.map { $0.birthMicroseconds as Any } ?? NSNull(),
                "serviceBundleIdentifier": safeBundleId,
                "capturedApp": nodePid == processId])
        }
        if nodePid != processId {
            foreignPid = true
            serviceNode["status"] = "unconfirmed"
            serviceNode["reason"] = "requires-owned-sheet-and-exact-observed-service"
            // The only possible service subtree starts at this node reached
            // through the captured app's sheet; never create a service AX root.
            if let sheetRow = entry.sheetRow, ownedSheets.contains(sheetRow),
               ownedWindowRoots.contains(entry.windowIndex), entry.parentRow != nil,
               let identity = kernelIdentity(nodePid),
               (!fixesOwnedFolder || (folderPins[2] == UInt64(nodePid) && folderPins[3] == identity.birthSeconds && folderPins[4] == identity.birthMicroseconds && ownedFixturePath() != nil)),
               let service = NSRunningApplication(processIdentifier: nodePid),
               !service.isTerminated,
               service.bundleIdentifier == "com.apple.appkit.xpc.openAndSavePanelService",
               let bundlePath = service.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path,
               bundlePath.hasPrefix("/"), !bundlePath.contains("\0"), bundlePath.utf8.count <= 4096,
               identity.executable.hasPrefix("/"), !identity.executable.contains("\0"), identity.executable.utf8.count <= 4096,
               kernelIdentity(processId) == initialKernelIdentity, Date() < deadline {
                let fixedBundle = "/System/Library/Frameworks/AppKit.framework/Versions/C/XPCServices/com.apple.appkit.xpc.openAndSavePanelService.xpc"
                let fixedExecutable = fixedBundle + "/Contents/MacOS/com.apple.appkit.xpc.openAndSavePanelService"
                var signatureSteps: [[String: Any]] = []
                serviceSubtree["status"] = "blocked"
                serviceSubtree["reason"] = "signature-or-association-unconfirmed"
                func signatureStep(_ stage: String, _ status: OSStatus) -> Bool {
                    signatureSteps.append(["stage": stage, "status": status])
                    return status == errSecSuccess && Date() < deadline
                }
                func signaturesValid() -> Bool {
                    guard bundlePath == fixedBundle, identity.executable == fixedExecutable,
                          Date() < deadline else { return false }
                    var requirement: SecRequirement?
                    guard signatureStep("requirement", SecRequirementCreateWithString(
                        #"anchor apple and identifier "com.apple.appkit.xpc.openAndSavePanelService""# as CFString,
                        [], &requirement)), let requirement else { return false }
                    for (stage, path) in [("bundle", fixedBundle), ("executable", fixedExecutable)] {
                        var code: SecStaticCode?
                        guard Date() < deadline,
                              signatureStep(stage + "-create", SecStaticCodeCreateWithPath(
                                URL(fileURLWithPath: path) as CFURL, [], &code)), let code,
                              signatureStep(stage + "-validate", SecStaticCodeCheckValidity(code,
                                SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode),
                                requirement)) else { return false }
                    }
                    var runningCode: SecCode?
                    guard Date() < deadline,
                          signatureStep("process-create", SecCodeCopyGuestWithAttributes(nil,
                            [kSecGuestAttributePid: NSNumber(value: nodePid)] as CFDictionary, [], &runningCode)),
                          let runningCode,
                          signatureStep("process-validate", SecCodeCheckValidity(runningCode, [], requirement)) else { return false }
                    var runningStatic: SecStaticCode?, runningPath: CFURL?
                    guard signatureStep("process-static", SecCodeCopyStaticCode(runningCode, [], &runningStatic)),
                          let runningStatic,
                          signatureStep("process-path", SecCodeCopyPath(runningStatic, [], &runningPath)),
                          let runningPath else { return false }
                    return (runningPath as URL).resolvingSymlinksInPath().standardizedFileURL.path == fixedBundle
                }
                func identitiesUnchanged() -> Bool {
                    let currentService = NSRunningApplication(processIdentifier: nodePid)
                    let currentOwner = NSRunningApplication(processIdentifier: processId)
                    return Date() < deadline && kernelIdentity(nodePid) == identity &&
                        kernelIdentity(processId) == initialKernelIdentity && currentService?.isTerminated == false &&
                        currentService?.bundleIdentifier == service.bundleIdentifier &&
                        currentService?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == fixedBundle &&
                        currentOwner?.isTerminated == false &&
                        currentOwner?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle
                }
                func associationUnchanged() -> Bool {
                    guard identitiesUnchanged(), let element else { return false }
                    var child = node, cursor = entry.parentRow, chain: [Int] = []
                    while let row = cursor {
                        guard Date() < deadline, chain.count < 40, retainedNodes.indices.contains(row),
                              !chain.contains(row) else { return false }
                        let parent = retainedNodes[row]
                        var parentPid: pid_t = 0, childPid: pid_t = 0
                        var children: CFTypeRef?
                        let pidStatus = AXUIElementGetPid(parent, &parentPid)
                        let childStatus = AXUIElementGetPid(child, &childPid)
                        let childrenStatus = AXUIElementCopyAttributeValue(parent, kAXChildrenAttribute as CFString, &children)
                        if pidStatus != .success || childStatus != .success || childrenStatus != .success {
                            if pidStatus != .success { recordPickerError("ancestor-pid", pidStatus) }
                            if childStatus != .success { recordPickerError("associated-child-pid", childStatus) }
                            if childrenStatus != .success { recordPickerError("ancestor-children", childrenStatus) }
                            errors += 1; return false
                        }
                        guard parentPid == processId, childPid == (chain.isEmpty ? nodePid : processId),
                              let children = children as? [AXUIElement], children.count <= 512,
                              children.contains(where: { CFEqual($0, child) }) else { return false }
                        chain.append(row); child = parent; cursor = parentRows[row]
                    }
                    guard chain.contains(sheetRow), let root = chain.last,
                          parentRows[root] == nil, roleOnly(retainedNodes[sheetRow], kAXRoleAttribute as CFString) == "AXSheet",
                          roleOnly(retainedNodes[root], kAXRoleAttribute as CFString) == "AXWindow" else { return false }
                    var currentWindows: CFTypeRef?
                    let status = AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &currentWindows)
                    if status != .success { errors += 1; recordPickerError("owner-windows", status); return false }
                    return (currentWindows as? [AXUIElement])?.contains(where: { CFEqual($0, retainedNodes[root]) }) == true && identitiesUnchanged()
                }
                let priorErrors = errors
                let signatureVerified = signaturesValid()
                serviceSubtree["signatureSteps"] = signatureSteps
                serviceSubtree["codeSigningVerified"] = signatureVerified
                if signatureVerified, associationUnchanged(), errors == priorErrors {
                    let serviceRole = roleOnly(node, kAXRoleAttribute as CFString)
                    let serviceSubrole = roleOnly(node, kAXSubroleAttribute as CFString)
                    let roleConfirmed = !serviceRole.isEmpty && errors == priorErrors
                    serviceNode = ["status": roleConfirmed ? "observed" : "unconfirmed", "pid": nodePid, "uid": geteuid(),
                        "birthSeconds": identity.birthSeconds, "birthMicroseconds": identity.birthMicroseconds,
                        "kernelCanonicalExecutable": identity.executable, "canonicalBundlePath": bundlePath,
                        "serviceBundleIdentifier": service.bundleIdentifier ?? "unavailable",
                        "role": serviceRole, "subrole": serviceSubrole,
                        "parentRow": entry.parentRow.map { $0 as Any } ?? NSNull(),
                        "rootWindowIndex": entry.windowIndex, "ownedSheetRow": sheetRow,
                        "sheetOwnerPid": processId, "identityRechecked": true,
                        "childrenTraversed": false, "codeSigningVerified": true, "interactionDispatched": false]
                    if mode == "picker-location-prompt" || fixesOwnedFolder {
                        let sheet = retainedNodes[sheetRow]
                        var knownMetadataNodes = Set(queue.map { CFHash($0.node) })
                        var newMetadataNodes = 0
                        func admitMetadataNode(_ candidate: AXUIElement) -> Bool {
                            guard Date() < deadline else { return false }
                            if knownMetadataNodes.contains(CFHash(candidate)) { return true }
                            guard queue.count + newMetadataNodes < 512 else { nodeCut = true; return false }
                            knownMetadataNodes.insert(CFHash(candidate)); newMetadataNodes += 1
                            return true
                        }
                        func axNode(_ value: CFTypeRef?) -> AXUIElement? {
                            guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
                            let candidate = unsafeBitCast(value, to: AXUIElement.self)
                            return admitMetadataNode(candidate) ? candidate : nil
                        }
                        func focusInSheet() -> (node: AXUIElement, role: String, subrole: String, ancestors: [AXUIElement])? {
                            let errorsAtEntry = errors
                            guard identitiesUnchanged(), let element else { return nil }
                            var raw: CFTypeRef?
                            let status = AXUIElementCopyAttributeValue(element, kAXFocusedUIElementAttribute as CFString, &raw)
                            guard status == .success, let focused = axNode(raw) else {
                                errors += 1; recordPickerError("picker-focus", status); return nil
                            }
                            var cursor = focused, reached = false, ancestry = Set<CFHashCode>()
                            var ancestors: [AXUIElement] = []
                            let ancestorAllowance = max(0, 40 - (rows[sheetRow]["depth"] as? Int ?? 40))
                            for _ in 0..<ancestorAllowance {
                                guard Date() < deadline, ancestry.insert(CFHash(cursor)).inserted else { return nil }
                                var pid: pid_t = 0
                                let pidStatus = AXUIElementGetPid(cursor, &pid)
                                guard pidStatus == .success, pid == processId else {
                                    if pidStatus != .success { errors += 1; recordPickerError("focus-ancestor-pid", pidStatus) }
                                    return nil
                                }
                                ancestors.append(cursor)
                                if CFEqual(cursor, sheet) { reached = true; break }
                                var parent: CFTypeRef?
                                let parentStatus = AXUIElementCopyAttributeValue(cursor, kAXParentAttribute as CFString, &parent)
                                guard parentStatus == .success, let next = axNode(parent) else {
                                    errors += 1; recordPickerError("focus-ancestor-parent", parentStatus); return nil
                                }
                                cursor = next
                            }
                            guard reached else { return nil }
                            let role = roleOnly(focused, kAXRoleAttribute as CFString)
                            let subrole = roleOnly(focused, kAXSubroleAttribute as CFString)
                            guard !role.isEmpty, role != "AXSecureTextField", subrole != "AXSecureTextField",
                                  errors == errorsAtEntry else { return nil }
                            return (focused, role, subrole, ancestors)
                        }
                        func fixedLabel(_ candidate: AXUIElement, _ attribute: CFString, _ expected: String) -> Bool {
                            // Called only for a direct owned-sheet button or the
                            // nested prompt sheet, never a file-list item/field.
                            fixedControlLabelsCompared = true
                            var raw: CFTypeRef?
                            let status = AXUIElementCopyAttributeValue(candidate, attribute, &raw)
                            if status != .success && status != .noValue && status != .attributeUnsupported {
                                errors += 1; recordPickerError("fixed-picker-control-label", status)
                            }
                            return status == .success && (raw as? String) == expected
                        }
                        var directChildren: CFTypeRef?, defaultRaw: CFTypeRef?
                        let childrenStatus = AXUIElementCopyAttributeValue(sheet, kAXChildrenAttribute as CFString, &directChildren)
                        let defaultStatus = AXUIElementCopyAttributeValue(sheet, kAXDefaultButtonAttribute as CFString, &defaultRaw)
                        var cancelButtons = 0, chooserButtons = 0, defaultButtons = 0, controlsComplete = true
                        var enabledChooserTargets: [AXUIElement] = []
                        let defaultButton = defaultStatus == .success ? axNode(defaultRaw) : nil
                        if defaultStatus != .success && defaultStatus != .noValue {
                            errors += 1; recordPickerError("picker-default-button", defaultStatus)
                        }
                        if defaultStatus == .success && defaultButton == nil { controlsComplete = false }
                        if childrenStatus == .success,
                           let children = directChildren as? [AXUIElement], children.count <= 512 {
                            for child in children {
                                guard admitMetadataNode(child) else { controlsComplete = false; break }
                                var pid: pid_t = 0
                                let pidStatus = AXUIElementGetPid(child, &pid)
                                guard pidStatus == .success, pid == processId else {
                                    controlsComplete = false
                                    if pidStatus != .success { errors += 1; recordPickerError("sheet-control-pid", pidStatus) }
                                    break
                                }
                                guard roleOnly(child, kAXRoleAttribute as CFString) == "AXButton" else { continue }
                                var enabled: CFTypeRef?
                                let enabledStatus = AXUIElementCopyAttributeValue(child, kAXEnabledAttribute as CFString, &enabled)
                                let enabledValue: Bool? = enabledStatus == .success ? enabled.flatMap {
                                    CFGetTypeID($0) == CFBooleanGetTypeID() ? CFEqual($0, kCFBooleanTrue) : nil
                                } : nil
                                if enabledStatus != .success && enabledStatus != .noValue && enabledStatus != .attributeUnsupported {
                                    errors += 1; recordPickerError("sheet-control-enabled", enabledStatus)
                                }
                                if fixedLabel(child, kAXTitleAttribute as CFString, "Cancel"), enabledValue == true { cancelButtons += 1 }
                                if fixedLabel(child, kAXTitleAttribute as CFString, "Open") || fixedLabel(child, kAXTitleAttribute as CFString, "Choose") {
                                    chooserButtons += 1
                                    if enabledValue == true { enabledChooserTargets.append(child) }
                                    locationPrompt["chooserButtonEnabled"] = enabledValue.map { $0 as Any } ?? NSNull()
                                    locationPrompt["chooserButtonEnabledStatus"] = enabledStatus.rawValue
                                    if let defaultButton, CFEqual(child, defaultButton) {
                                        defaultButtons += 1
                                        locationPrompt["defaultButtonEnabled"] = enabledValue.map { $0 as Any } ?? NSNull()
                                    }
                                }
                            }
                        }
                        locationPrompt["directControlsComplete"] = controlsComplete
                        locationPrompt["cancelButtonUniqueAndEnabled"] = cancelButtons == 1
                        locationPrompt["fixedChooserButtonUnique"] = chooserButtons == 1
                        locationPrompt["fixedDefaultButtonUnique"] = defaultButtons == 1
                        locationPrompt["defaultIdentity"] = defaultButtons == 1 ? "observed" : "unknown"
                        locationPrompt["childrenStatus"] = childrenStatus.rawValue
                        locationPrompt["defaultStatus"] = defaultStatus.rawValue
                        let beforeFocus = focusInSheet()
                        locationPrompt["beforeFocusRole"] = beforeFocus?.role ?? ""
                        locationPrompt["beforeFocusSubrole"] = beforeFocus?.subrole ?? ""
                        locationPrompt["frontmostOwned"] = NSWorkspace.shared.frontmostApplication?.processIdentifier == processId
                        // The fixed chord opens a location prompt; it does not press
                        // the chooser/default button or confirm any selection.
                        if mode == "picker-location-prompt", roleConfirmed, errors == priorErrors, controlsComplete, cancelButtons == 1, chooserButtons == 1,
                           let beforeFocus, associationUnchanged(), AXIsProcessTrusted(), CGPreflightPostEventAccess(),
                           NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
                           let freshFocus = focusInSheet(), CFEqual(freshFocus.node, beforeFocus.node),
                           Date() < deadline,
                           let down = CGEvent(keyboardEventSource: nil, virtualKey: 5, keyDown: true),
                           let up = CGEvent(keyboardEventSource: nil, virtualKey: 5, keyDown: false) {
                            down.flags = [.maskCommand, .maskShift]; up.flags = [.maskCommand, .maskShift]
                            // One fixed ordinary Go-to-Folder chord, never text,
                            // an arbitrary key, confirmation, or a retry.
                            guard identitiesUnchanged(), associationUnchanged(), errors == priorErrors, AXIsProcessTrusted(), CGPreflightPostEventAccess(),
                                  NSWorkspace.shared.frontmostApplication?.processIdentifier == processId,
                                  let finalFocus = focusInSheet(), CFEqual(finalFocus.node, beforeFocus.node), errors == priorErrors, Date() < deadline else {
                                locationPrompt["status"] = "blocked-final-dispatch-guard"
                                break
                            }
                            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
                            promptDispatched = true
                            locationPrompt["status"] = "dispatched-observation-unconfirmed"
                            // Let the presented sheet establish its initial focus ancestry.
                            Thread.sleep(forTimeInterval: min(0.2, max(0, deadline.timeIntervalSinceNow)))
                            var firstChangedChainRecorded = false
                            while Date() < deadline, errors == priorErrors, identitiesUnchanged() {
                                let observedFocus = focusInSheet()
                                locationPrompt["focusedRole"] = observedFocus?.role ?? ""
                                locationPrompt["focusedSubrole"] = observedFocus?.subrole ?? ""
                                if let focused = observedFocus, focused.role == "AXTextField", focused.subrole != "AXSearchField",
                                   !CFEqual(focused.node, beforeFocus.node) {
                                    if !firstChangedChainRecorded {
                                        firstChangedChainRecorded = true
                                        var chainRows: [[String: Any]] = [], complete = true
                                        // Reuse only the nodes of the just-verified
                                        // owned-PID focus walk; never read labels.
                                        for (distance, ancestor) in focused.ancestors.enumerated() {
                                            guard Date() < deadline, admitMetadataNode(ancestor) else { complete = false; break }
                                            var ancestorPid: pid_t = 0
                                            let status = AXUIElementGetPid(ancestor, &ancestorPid)
                                            guard status == .success, ancestorPid == processId else {
                                                if status != .success { errors += 1; recordPickerError("prompt-chain-pid", status) }
                                                complete = false; break
                                            }
                                            let role = roleOnly(ancestor, kAXRoleAttribute as CFString)
                                            let subrole = roleOnly(ancestor, kAXSubroleAttribute as CFString)
                                            guard !role.isEmpty, errors == priorErrors, identitiesUnchanged() else { complete = false; break }
                                            chainRows.append(["distanceFromFocusedField": distance, "role": role, "subrole": subrole])
                                            if role == "AXSecureTextField" || subrole == "AXSecureTextField" { complete = false; break }
                                        }
                                        locationPrompt["firstChangedFocusParentChain"] = chainRows
                                        locationPrompt["firstChangedFocusParentChainComplete"] = complete
                                        if !complete { break }
                                    }
                                    var parentRaw: CFTypeRef?
                                    let parentStatus = AXUIElementCopyAttributeValue(focused.node, kAXParentAttribute as CFString, &parentRaw)
                                    locationPrompt["focusedParentStatus"] = parentStatus.rawValue
                                    let parent = parentStatus == .success ? axNode(parentRaw) : nil
                                    var parentPid: pid_t = 0
                                    let parentPidStatus = parent.map { AXUIElementGetPid($0, &parentPid) } ?? .invalidUIElement
                                    locationPrompt["focusedParentPidStatus"] = parentPidStatus.rawValue
                                    guard parentPidStatus == .success, parentPid == processId else {
                                        if parentPidStatus != .success {
                                            errors += 1; recordPickerError("prompt-parent-pid", parentPidStatus)
                                        }
                                        locationPrompt["status"] = "refused-prompt-parent-identity"
                                        break
                                    }
                                    var parentRole = "", parentSubrole = ""
                                    var longFixedTitle: Bool?, shortFixedTitle: Bool?
                                    if parentStatus == .success, let parent {
                                        parentRole = roleOnly(parent, kAXRoleAttribute as CFString)
                                        parentSubrole = roleOnly(parent, kAXSubroleAttribute as CFString)
                                        if !CFEqual(parent, sheet), parentRole == "AXSheet" {
                                            longFixedTitle = fixedLabel(parent, kAXTitleAttribute as CFString, "Go to the folder:")
                                            if longFixedTitle == false {
                                                shortFixedTitle = fixedLabel(parent, kAXTitleAttribute as CFString, "Go to Folder")
                                            }
                                        }
                                    }
                                    locationPrompt["focusedParentRole"] = parentRole
                                    locationPrompt["focusedParentSubrole"] = parentSubrole
                                    locationPrompt["fixedLongPromptTitleMatched"] = longFixedTitle.map { $0 as Any } ?? NSNull()
                                    locationPrompt["fixedShortPromptTitleMatched"] = shortFixedTitle.map { $0 as Any } ?? NSNull()
                                    let observedSequence = focused.ancestors.count == 3 && CFEqual(focused.ancestors[2], sheet) &&
                                        parent.map { CFEqual(focused.ancestors[1], $0) } == true && parentRole == "AXSheet"
                                    locationPrompt["observedNestedLocationSequence"] = observedSequence
                                    if parentStatus == .success, let parent, !CFEqual(parent, sheet), parentRole == "AXSheet",
                                       observedSequence, associationUnchanged(), errors == priorErrors {
                                        locationPrompt["status"] = "observed"
                                        locationPrompt["focusedRole"] = focused.role
                                        locationPrompt["focusedSubrole"] = focused.subrole
                                        locationPrompt["nestedFixedPromptMatched"] = longFixedTitle == true || shortFixedTitle == true
                                        locationPrompt["identityAndAssociationRechecked"] = true
                                        break
                                    }
                                    if parentStatus != .success { errors += 1; recordPickerError("prompt-focused-parent", parentStatus) }
                                }
                                Thread.sleep(forTimeInterval: 0.05)
                            }
                        }
                        if fixesOwnedFolder, let fixturePath = ownedFixturePath(), errors == priorErrors {
                            func nestedLocation(_ focus: (node: AXUIElement, role: String, subrole: String, ancestors: [AXUIElement])) -> Bool {
                                guard focus.role == "AXTextField", focus.subrole != "AXSearchField", focus.ancestors.count == 3,
                                      CFEqual(focus.ancestors[2], sheet), !CFEqual(focus.ancestors[1], sheet) else { return false }
                                var pid: pid_t = 0
                                return AXUIElementGetPid(focus.ancestors[1], &pid) == .success && pid == processId &&
                                    roleOnly(focus.ancestors[1], kAXRoleAttribute as CFString) == "AXSheet" && errors == priorErrors
                            }
                            func onlyOriginalSheet(_ focus: (node: AXUIElement, role: String, subrole: String, ancestors: [AXUIElement])) -> Bool {
                                guard focus.role != "AXTextField", focus.ancestors.last.map({ CFEqual($0, sheet) }) == true else { return false }
                                var sheets = 0
                                for ancestor in focus.ancestors {
                                    var pid: pid_t = 0
                                    guard Date() < deadline, AXUIElementGetPid(ancestor, &pid) == .success, pid == processId else { return false }
                                    if roleOnly(ancestor, kAXRoleAttribute as CFString) == "AXSheet" { sheets += 1 }
                                }
                                return sheets == 1 && errors == priorErrors
                            }
                            func fieldReady(_ field: AXUIElement) -> Bool {
                                guard ownedFixturePath() == fixturePath, associationUnchanged(),
                                      let focus = focusInSheet(), CFEqual(focus.node, field), nestedLocation(focus),
                                      let rootWindows = windows as? [AXUIElement], rootWindows.indices.contains(entry.windowIndex),
                                      fixedFolderInputPoint(field, deadline, admitMetadataNode, rootWindows[entry.windowIndex],
                                        [focus.ancestors[1], focus.ancestors[2]], {
                                            guard ownedFixturePath() == fixturePath, identitiesUnchanged(), associationUnchanged(),
                                                  let fresh = focusInSheet(), CFEqual(fresh.node, field), nestedLocation(fresh),
                                                  CFEqual(fresh.ancestors[1], focus.ancestors[1]), CFEqual(fresh.ancestors[2], focus.ancestors[2]),
                                                  errors == priorErrors else { return false }
                                            return true
                                        }) != nil,
                                      identitiesUnchanged(), errors == priorErrors else { return false }
                                fixedFolder["fieldFocusIdentityGeometryMatched"] = true
                                return true
                            }
                            func exactOwnedValue(_ field: AXUIElement) -> Bool {
                                guard fieldReady(field) else { return false }
                                var raw: CFTypeRef?, pid: pid_t = 0
                                guard AXUIElementGetPid(field, &pid) == .success, pid == processId else { return false }
                                let status = AXUIElementCopyAttributeValue(field, kAXValueAttribute as CFString, &raw)
                                fixedOwnedFieldCompared = true
                                fixedFolder["fixedOwnedFieldValueCompared"] = true
                                fixedFolder["valueReadStatus"] = status.rawValue
                                if status != .success { errors += 1; recordPickerError("owned-location-value", status) }
                                let equal = status == .success && (raw as? String) == fixturePath
                                fixedFolder["fixedOwnedFieldValueMatched"] = equal
                                return equal && fieldReady(field)
                            }
                            if mode == "picker-fill-owned-location", let focus = focusInSheet(), nestedLocation(focus), fieldReady(focus.node),
                               let selectDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                               let selectUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false),
                               let textDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                               let textUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
                                selectDown.flags = .maskCommand; selectUp.flags = .maskCommand
                                let utf16 = Array(fixturePath.utf16)
                                utf16.withUnsafeBufferPointer { buffer in
                                    if let base = buffer.baseAddress {
                                        textDown.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
                                        textUp.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
                                    }
                                }
                                if fieldReady(focus.node) {
                                    selectDown.postToPid(processId); selectUp.postToPid(processId)
                                    fixedFolder["status"] = "select-all-dispatched-no-text"
                                    if fieldReady(focus.node) {
                                        textDown.postToPid(processId); textUp.postToPid(processId)
                                        fixedFolder["typingDispatched"] = true
                                        fixedFolder["status"] = "typed-value-unconfirmed"
                                        // Allow the ordinary posted key pair to be
                                        // consumed before the one equality read.
                                        Thread.sleep(forTimeInterval: 0.05)
                                        while Date() < deadline, errors == priorErrors {
                                            if exactOwnedValue(focus.node) { fixedFolder["status"] = "completed"; break }
                                            // A mismatch is a refusal, never a text retry.
                                            break
                                        }
                                    }
                                }
                            }
                            if mode == "picker-go-owned-location", let focus = focusInSheet(), nestedLocation(focus),
                               exactOwnedValue(focus.node), fieldReady(focus.node),
                               let down = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true),
                               let up = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false) {
                                if fieldReady(focus.node) {
                                    down.postToPid(processId); up.postToPid(processId)
                                    fixedFolder["goDispatched"] = true
                                    fixedFolder["status"] = "go-dispatched-shape-unconfirmed"
                                    while Date() < deadline, errors == priorErrors, identitiesUnchanged() {
                                        if let after = focusInSheet() {
                                            fixedFolder["postGoFocusRole"] = after.role
                                            fixedFolder["postGoFocusSubrole"] = after.subrole
                                            if onlyOriginalSheet(after), associationUnchanged(), ownedFixturePath() == fixturePath {
                                                fixedFolder["postGoOriginalChooserObserved"] = true
                                                fixedFolder["status"] = "completed"; break
                                            }
                                        }
                                        Thread.sleep(forTimeInterval: 0.05)
                                    }
                                }
                            }
                            if mode == "picker-choose-owned-folder", controlsComplete, cancelButtons == 1, chooserButtons == 1,
                               enabledChooserTargets.count == 1, let target = enabledChooserTargets.first,
                               let focus = focusInSheet(), onlyOriginalSheet(focus), associationUnchanged(),
                               fixedFolderButtonEnabled(target),
                               let point = fixedFolderInputPoint(target, deadline, admitMetadataNode),
                               let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                               let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left),
                               ownedFixturePath() == fixturePath, let finalFocus = focusInSheet(), onlyOriginalSheet(finalFocus),
                               associationUnchanged(), errors == priorErrors, fixedFolderButtonEnabled(target),
                               fixedLabel(target, kAXTitleAttribute as CFString, "Open") || fixedLabel(target, kAXTitleAttribute as CFString, "Choose"),
                               errors == priorErrors, fixedFolderInputPoint(target, deadline, admitMetadataNode) == point,
                               identitiesUnchanged(), errors == priorErrors {
                                down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
                                fixedFolder["chooserDispatched"] = true; fixedFolder["status"] = "dispatched"
                            }
                            fixedFolder["hitChecks"] = fixedFolderHitChecks
                            fixedFolder["keyboardFocusProof"] = fixedFolderKeyboardFocusProof.map { $0 as Any } ?? NSNull()
                            fixedFolder["keyboardFocusChecks"] = fixedFolderKeyboardFocusChecks
                            fixedFolder["fieldSheetFrameAdmitted"] = fixedFolderSheetFrameAdmitted
                            fixedFolder["ownedSheetFrameChecks"] = fixedFolderSheetGeometry
                            fixedFolder["geometryChecks"] = fixedFolderGeometry
                            fixedFolder["owningWindowFromBoundedParentProof"] = fixedFolderWindowAncestryUsed
                            fixedFolder["nativeStatuses"] = fixedFolderNativeStatuses
                            fixedFolder["fixtureIdentityMatched"] = ownedFixturePath() == fixturePath
                            fixedFolder["sharedMetadataNodes"] = queue.count + newMetadataNodes
                            fixedFolder["timeLimitReached"] = Date() >= deadline
                            fixedFolder["codeSigningVerified"] = signatureVerified
                            fixedFolder["signatureSteps"] = signatureSteps
                        }
                        locationPrompt["sharedMetadataNodes"] = queue.count + newMetadataNodes
                        locationPrompt["nodeLimitReached"] = nodeCut
                        locationPrompt["timeLimitReached"] = Date() >= deadline
                        locationPrompt["interactionDispatched"] = promptDispatched
                        locationPrompt["signatureSteps"] = signatureSteps
                        locationPrompt["codeSigningVerified"] = signatureVerified
                    } else {
                        var subtreeRows: [[String: Any]] = []
                        var subtree = [(node: node, depth: entry.depth, parent: Optional<Int>.none)]
                        var subtreeIndex = 0, complete = !serviceRole.isEmpty && errors == priorErrors
                        // Reuse the original shared node/depth/deadline allowance,
                        // including nodes already queued in the captured app.
                        seen.remove(CFHash(node))
                        while complete && subtreeIndex < subtree.count && Date() < deadline {
                            let current = subtree[subtreeIndex]; subtreeIndex += 1
                            guard identitiesUnchanged() else { complete = false; break }
                            var currentPid: pid_t = 0
                            let pidStatus = AXUIElementGetPid(current.node, &currentPid)
                            if pidStatus != .success { errors += 1; recordPickerError("descendant-pid", pidStatus); complete = false; break }
                            guard currentPid == nodePid else { complete = false; break }
                            guard seen.insert(CFHash(current.node)).inserted else { continue }
                            let role = roleOnly(current.node, kAXRoleAttribute as CFString)
                            let subrole = roleOnly(current.node, kAXSubroleAttribute as CFString)
                            guard !role.isEmpty, errors == priorErrors, identitiesUnchanged() else { complete = false; break }
                            let row = subtreeRows.count
                            subtreeRows.append(["role": role, "subrole": subrole, "depth": current.depth,
                                "parentRow": current.parent.map { $0 as Any } ?? NSNull()])
                            if role == "AXSecureTextField" || subrole == "AXSecureTextField" { continue }
                            if current.depth >= 40 { depthCut = true; complete = false; break }
                            var children: CFTypeRef?
                            let status = AXUIElementCopyAttributeValue(current.node, kAXChildrenAttribute as CFString, &children)
                            serviceNode["childrenTraversed"] = true
                            if status == .success {
                                guard let children = children as? [AXUIElement] else { errors += 1; complete = false; break }
                                let remaining = max(0, 512 - queue.count - subtree.count + 1)
                                if children.count > remaining { nodeCut = true; complete = false; break }
                                subtree.append(contentsOf: children.map { (node: $0, depth: current.depth + 1, parent: Optional(row)) })
                            } else if status != .noValue && status != .attributeUnsupported {
                                errors += 1; recordPickerError("descendant-children", status); complete = false; break
                            }
                        }
                        let finalAssociation = associationUnchanged() && errors == priorErrors
                        complete = complete && subtreeIndex == subtree.count && Date() < deadline && finalAssociation
                        serviceSubtree["status"] = complete ? "observed" : "blocked"
                        serviceSubtree["reason"] = complete ? "role-only-subtree-observed" : "identity-association-read-or-limit-unconfirmed"
                        // Never retain a subtree whose association drifted.
                        serviceSubtree["roles"] = finalAssociation ? subtreeRows : []
                        serviceSubtree["identityAndAssociationRechecked"] = finalAssociation
                        serviceSubtree["complete"] = complete
                        serviceSubtree["depthLimitReached"] = depthCut
                        serviceSubtree["nodeLimitReached"] = nodeCut
                        serviceSubtree["timeLimitReached"] = Date() >= deadline
                        serviceSubtree["sharedQueuedNodes"] = queue.count + subtree.count - 1
                        if !finalAssociation {
                            serviceNode["status"] = "unconfirmed"
                            serviceNode["identityRechecked"] = false
                            serviceNode.removeValue(forKey: "role"); serviceNode.removeValue(forKey: "subrole")
                        }
                    }
                }
            }
            break
        }
        let nodeRole = roleOnly(node, kAXRoleAttribute as CFString)
        let subrole = roleOnly(node, kAXSubroleAttribute as CFString)
        if nodeRole.isEmpty { errors += 1; break }
        if depth == 0 {
            if nodeRole != "AXWindow" { errors += 1; break }
            ownedWindowRoots.insert(entry.windowIndex)
        }
        let rowIndex = rows.count
        retainedNodes.append(node); parentRows.append(entry.parentRow)
        rows.append(["pid": nodePid, "role": nodeRole, "subrole": subrole, "depth": depth,
            "parentRow": entry.parentRow.map { $0 as Any } ?? NSNull(), "rootWindowIndex": entry.windowIndex])
        let sheetRow = nodeRole == "AXSheet" ? rowIndex : entry.sheetRow
        if nodeRole == "AXSheet" { ownedSheets.insert(rowIndex) }
        if nodeRole == "AXSheet" || nodeRole == "AXDialog" ||
            ["AXDialog", "AXSystemDialog", "AXApplicationDialog"].contains(subrole) { dialogSeen = true }
        if nodeRole == "AXSecureTextField" || subrole == "AXSecureTextField" { continue }
        if depth >= 40 { depthCut = true; continue }
        var children: CFTypeRef?
        let read = AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &children)
        if read == .success {
            if let children = children as? [AXUIElement] {
                let remaining = max(0, 512 - queue.count)
                if children.count > remaining { nodeCut = true }
                queue.append(contentsOf: children.prefix(remaining).map {
                    PickerNode(node: $0, depth: depth + 1, parentRow: rowIndex, windowIndex: entry.windowIndex, sheetRow: sheetRow)
                })
            } else { errors += 1 }
        } else if read != .noValue && read != .attributeUnsupported { errors += 1 }
    }
    let live = NSRunningApplication(processIdentifier: processId)
    let unchanged = admitted && kernelIdentity(processId) == initialKernelIdentity && live?.isTerminated == false &&
        live?.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == expectedBundle
    let ownedWindows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).compactMap { row -> [String: Any]? in
        guard let pid = row[kCGWindowOwnerPID as String] as? NSNumber,
              pid.int32Value == processId || processes.contains(pid.int32Value) else { return nil }
        return ["ownerPid": pid, "windowId": row[kCGWindowNumber as String] ?? NSNull(),
            "layer": row[kCGWindowLayer as String] ?? NSNull()]
    }
    let output: [String: Any] = ["capturedPid": processId, "capturedIdentityMatched": unchanged,
        "nativeAxTrusted": AXIsProcessTrusted(), "windowsError": windowResult.rawValue,
        "windowOwnership": Array(ownedWindows.prefix(64)), "windowOwnershipTruncated": ownedWindows.count > 64,
        "processes": processRows, "roles": rows, "readErrors": errors,
        "associatedServiceNode": serviceNode, "serviceSubtree": serviceSubtree, "nativeErrors": pickerNativeErrors,
        "locationPrompt": locationPrompt, "fixedControlLabelsCompared": fixedControlLabelsCompared,
        "fixedFolder": fixedFolder,
        "dialogOrSheetObserved": dialogSeen, "foreignPidBoundaryObserved": foreignPid,
        "truncated": depthCut || nodeCut || foreignPid || index < queue.count,
        "depthLimitReached": depthCut, "nodeLimitReached": nodeCut,
        "timeLimitReached": Date() >= deadline && index < queue.count,
        "interactionDispatched": promptDispatched, "labelsOrValuesRead": fixedControlLabelsCompared,
        "fieldValuesRead": fixedOwnedFieldCompared, "rawValueCaptured": false, "directoryLabelsRead": false]
    if let encoded = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]),
       let text = String(data: encoded, encoding: .utf8) { print(text) }
    else { exit(2) }
    exit(0)
}
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
        if mode == "read", nodeRole == "AXButton", title == "Continue" {
            var ownerPid: pid_t = 0, enabled: CFTypeRef?
            let ownerStatus = AXUIElementGetPid(node, &ownerPid)
            control["continueOwnerReadError"] = ownerStatus.rawValue
            control["continueOwnerMatched"] = ownerStatus == .success && ownerPid == processId
            control["continueEnabled"] = NSNull()
            control["continueEnabledReadError"] = NSNull()
            if ownerStatus == .success, ownerPid == processId {
                let status = AXUIElementCopyAttributeValue(node, kAXEnabledAttribute as CFString, &enabled)
                control["continueEnabledReadError"] = status.rawValue
                if status == .success, let enabled, CFGetTypeID(enabled) == CFBooleanGetTypeID() {
                    control["continueEnabled"] = CFEqual(enabled, kCFBooleanTrue)
                } else if status != .success && status != .noValue && status != .attributeUnsupported {
                    readErrors += 1; nativeReadErrors.insert(status.rawValue)
                }
            } else {
                readErrors += 1
                if ownerStatus != .success { nativeReadErrors.insert(ownerStatus.rawValue) }
            }
        }
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
            if mode == "reveal", ["Data & storage", preferenceTitle, "Octant Harness", "Add endpoint", "OpenAI-compatible", "OpenAI-compatible Any service that speaks the OpenAI API: a gateway, a router, or a local server.", "Advanced", "It takes no key", "It takes no key Only for a server on this computer, such as one at 127.0.0.1.", "Check and add", "Continue and verify tools (1 request)", "Back to app", "Work", "In a folder", "Home", "Choose a folder…", "Choose a folder"].contains(requestedTitle),
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
                            (($0[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0 &&
                            cgBounds($0)?.contains(center) == true
                        }
                        let topPid = (top?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
                        action["pointWindowOwnerPid"] = topPid
                        action["pointWindowLayer"] = (top?[kCGWindowLayer as String] as? NSNumber).map { $0 as Any } ?? NSNull()
                        let coveringAlpha = (top?[kCGWindowAlpha as String] as? NSNumber)?.doubleValue
                        action["pointWindowAlpha"] = coveringAlpha.flatMap {
                            $0.isFinite && (0...1).contains($0) ? $0 as Any : nil
                        } ?? NSNull()
                        action["pointWindowOwnerMatched"] = (top?[kCGWindowOwnerPID as String] as? NSNumber).map {
                            ($0.int32Value == processId) as Any
                        } ?? NSNull()
                        action["pointWindowContainsOwnedWindow"] = top.flatMap { cgBounds($0) }.map {
                            $0.contains(windowBounds) as Any
                        } ?? NSNull()
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
