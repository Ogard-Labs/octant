import AppKit
import ApplicationServices
import Foundation
import Vision
import CoreImage

func refuse(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

struct OwnedWindow {
    let id: CGWindowID
    let bounds: CGRect
}

func windows() -> [[String: Any]] {
    guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        refuse("WindowServer observation is unavailable.")
    }
    return rows
}

func window(_ pid: pid_t) -> OwnedWindow {
    let candidates = windows().compactMap { row -> OwnedWindow? in
        guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let data = row[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: data as CFDictionary),
              bounds.width > 100, bounds.height > 100 else { return nil }
        return OwnedWindow(id: id, bounds: bounds)
    }
    guard let selected = candidates.max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) else {
        refuse("The exact owned PID has no visible WindowServer window.")
    }
    return selected
}

struct TextTarget: Codable {
    let text: String
    let x: Double
    let y: Double
}

struct Observation: Codable {
    let pid: Int32
    let windowId: UInt32
    let texts: [TextTarget]
    let clicked: Bool
    let pointerProof: String?
    let nativeText: String?
}

// An icon-only control has no text for the OCR pass to read; its accessible
// name is the button's description. This finds the owned process's buttons
// whose description equals the label and keeps those whose centre lies inside
// the owned window, so the caller applies the same uniqueness, window and
// hit-owner checks it applies to an OCR target. The tree walk is bounded.
func describedButtons(_ pid: pid_t, _ bounds: CGRect, _ description: String) -> [TextTarget] {
    let root = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    func text(_ node: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(node, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }
    var found: [TextTarget] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var visited = 0
    while !queue.isEmpty && visited < 6000 {
        let (node, depth) = queue.removeFirst()
        visited += 1
        // A control that opens a menu is exposed as a pop-up or menu button,
        // and some roles carry the accessible name as the title. The first
        // version matched plain buttons by description only and could not
        // find a menu's trigger.
        let role = text(node, kAXRoleAttribute as String)
        if role == kAXButtonRole || role == kAXPopUpButtonRole || role == kAXMenuButtonRole,
           text(node, kAXDescriptionAttribute as String) == description
            || text(node, kAXTitleAttribute as String) == description {
            var position: CFTypeRef?
            var size: CFTypeRef?
            var origin = CGPoint.zero
            var extent = CGSize.zero
            if AXUIElementCopyAttributeValue(node, kAXPositionAttribute as CFString, &position) == .success,
               AXUIElementCopyAttributeValue(node, kAXSizeAttribute as CFString, &size) == .success,
               let position, let size,
               CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID(),
               AXValueGetValue(position as! AXValue, .cgPoint, &origin),
               AXValueGetValue(size as! AXValue, .cgSize, &extent),
               extent.width > 0, extent.height > 0 {
                let centre = CGPoint(x: origin.x + extent.width / 2, y: origin.y + extent.height / 2)
                if bounds.contains(centre) {
                    found.append(TextTarget(text: description, x: Double(centre.x), y: Double(centre.y)))
                }
            }
        }
        guard depth < 40 else { continue }
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &children) == .success,
           let list = children as? [AXUIElement] {
            queue.append(contentsOf: list.map { ($0, depth + 1) })
        }
    }
    return found
}

guard CommandLine.arguments.count >= 2 else { refuse("Supply preflight, observe, click or settings.") }
let mode = CommandLine.arguments[1]
if mode == "preflight" {
    guard CGPreflightPostEventAccess() else { refuse("Native event delivery is not already permitted; no permission was requested.") }
    print("{\"nativeEventPermission\":true}")
    exit(0)
}
guard CommandLine.arguments.count >= 5, let pid = Int32(CommandLine.arguments[2]), pid > 1 else {
    refuse("Supply the exact owned process, screenshot path and expected label.")
}
let imagePath = CommandLine.arguments[3]
let expected = CommandLine.arguments[4]
let controllerApplication = NSApplication.shared
_ = controllerApplication.setActivationPolicy(.prohibited)
guard let application = NSRunningApplication(processIdentifier: pid), !application.isTerminated else {
    refuse("The owned application is no longer running.")
}
if mode == "choose-native-menu-item" || mode == "click" || mode == "hover" || mode == "click-described" || mode == "fill" || mode == "fill-private" || mode == "toggle-before-field" || mode == "focus-before-text" || mode == "scroll-top" || mode == "scroll-bottom" || mode == "enter" || mode == "end" || mode == "escape" || mode == "settings" {
    guard CGPreflightPostEventAccess() else { refuse("Native event delivery is unavailable; no permission was requested.") }
    _ = application.activate(options: [.activateIgnoringOtherApps])
}
let owned = window(pid)
guard owned.bounds.integral == owned.bounds else { refuse("The owned window does not have integral capture bounds.") }
let capture = Process()
capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
// A native menu is a separate WindowServer surface. Capture only the owned
// primary window's current rectangle so its menu is visible too; clicks still
// revalidate the primary window and the actual frontmost owner at the target.
let rectangle = [owned.bounds.minX, owned.bounds.minY, owned.bounds.width, owned.bounds.height].map { String(Int($0)) }.joined(separator: ",")
capture.arguments = ["-x", "-R", rectangle, imagePath]
do { try capture.run(); capture.waitUntilExit() }
catch { refuse("The owned-window capture could not start.") }
guard capture.terminationStatus == 0 else { refuse("The owned-window capture failed.") }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]
do {
    if mode == "observe-detail" {
        guard let original = CIImage(contentsOf: URL(fileURLWithPath: imagePath)) else { refuse("The owned detail image is unavailable.") }
        let enlarged = original.applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: 2.0, kCIInputAspectRatioKey: 1.0])
        guard let image = CIContext(options: [.useSoftwareRenderer: true]).createCGImage(enlarged, from: enlarged.extent) else {
            refuse("The owned detail observation could not be prepared.")
        }
        request.minimumTextHeight = 0.005
        try VNImageRequestHandler(cgImage: image).perform([request])
    } else { try VNImageRequestHandler(url: URL(fileURLWithPath: imagePath)).perform([request]) }
}
catch { refuse("The owned-window text could not be recognized.") }
let targets = (request.results ?? []).compactMap { result -> TextTarget? in
    guard let value = result.topCandidates(1).first else { return nil }
    return TextTarget(text: value.string,
        x: Double(owned.bounds.minX + result.boundingBox.midX * owned.bounds.width),
        y: Double(owned.bounds.minY + (1 - result.boundingBox.midY) * owned.bounds.height))
}
var clicked = false
var pointerProof: String?
var nativeText: String?
if mode == "read-text" || mode == "choose-native-menu-item" || mode == "click" || mode == "hover" || mode == "click-described" || mode == "fill" || mode == "fill-private" || mode == "toggle-before-field" || mode == "focus-before-text" || mode == "scroll-top" || mode == "scroll-bottom" {
    guard !expected.isEmpty else { refuse("Supply a nonempty observed text target.") }
    let rowContext = mode == "click" && CommandLine.arguments.count == 6 ? CommandLine.arguments[5] : nil
    let observedRows = (request.results ?? []).filter { result in
        rowContext == nil || result.topCandidates(1).first?.string == rowContext
    }
    if rowContext != nil && observedRows.count != 1 { refuse("The current owned image has no unique exact contextual row.") }
    let partialMatches = observedRows.flatMap { result -> [TextTarget] in
        guard let value = result.topCandidates(1).first else { return [] }
        var matches: [TextTarget] = []
        var remaining = value.string.startIndex..<value.string.endIndex
        while let range = value.string.range(of: expected, options: .caseInsensitive, range: remaining) {
            guard let box = try? value.boundingBox(for: range) else { return [] }
            matches.append(TextTarget(text: expected,
                x: Double(owned.bounds.minX + box.boundingBox.midX * owned.bounds.width),
                y: Double(owned.bounds.minY + (1 - box.boundingBox.midY) * owned.bounds.height)))
            remaining = range.upperBound..<value.string.endIndex
        }
        return matches
    }
    let exactMatches = targets.filter { $0.text.caseInsensitiveCompare(expected) == .orderedSame && (rowContext == nil || $0.text == rowContext) }
    if mode == "click-described" && !AXIsProcessTrusted() {
        refuse("Native accessibility is not already trusted; no permission was requested.")
    }
    let matches = mode == "click-described"
        ? describedButtons(pid, owned.bounds, expected)
        : (exactMatches.isEmpty ? partialMatches : exactMatches)
    guard matches.count == 1, let match = matches.first else { refuse("The current owned image has no unique exact text target: " + expected) }
    let current = window(pid)
    guard current.id == owned.id, current.bounds == owned.bounds else { refuse("The owned window moved after its capture.") }
    let point = CGPoint(x: match.x, y: match.y)
    guard let primary = NSScreen.screens.first(where: {
        ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == CGMainDisplayID()
    }) else { refuse("The primary screen coordinate mapping is unavailable.") }
    // AppKit's actual mouse-down hit test skips windows that ignore input or
    // are transparent at this point. Rectangular WindowServer bounds do not.
    let hit = NSWindow.windowNumber(at: CGPoint(x: point.x, y: primary.frame.height - point.y), belowWindowWithWindowNumber: 0)
    let covering = windows().first { (row: [String: Any]) in
        (row[kCGWindowNumber as String] as? NSNumber)?.intValue == hit
    }
    var hitOwner = (covering?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
    if hit > 0 && hitOwner != nil { pointerProof = "appkit-mouse-down-window" }
    if hit <= 0 && AXIsProcessTrusted() {
        let system = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        if AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element) == .success,
           let element {
            var owner: pid_t = 0
            if AXUIElementGetPid(element, &owner) == .success && owner > 1 {
                hitOwner = owner
                pointerProof = "accessibility-hit-owner"
            }
        }
    }
    guard hitOwner == pid else {
        let direct = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0)
        let display = CGDisplayBounds(CGMainDisplayID())
        let diagnostic: [String: Any] = ["hit": hit, "directCoordinateHit": direct,
            "point": [point.x, point.y],
            "accessibilityTrusted": AXIsProcessTrusted(), "hitOwner": hitOwner ?? -1,
            "primaryFrame": [primary.frame.minX, primary.frame.minY, primary.frame.width, primary.frame.height],
            "quartzDisplay": [display.minX, display.minY, display.width, display.height],
            "ownedBounds": [owned.bounds.minX, owned.bounds.minY, owned.bounds.width, owned.bounds.height]]
        if let data = try? JSONSerialization.data(withJSONObject: diagnostic), let message = String(data: data, encoding: .utf8) {
            FileHandle.standardError.write(Data((message + "\n").utf8))
        }
        let owner = (covering?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
        let layer = (covering?[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
        let identifier = (covering?[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0
        let scene: [[String: Any]] = windows().compactMap { row in
            guard let data = row[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: data as CFDictionary), rect.contains(point) else { return nil }
            return ["owner": row[kCGWindowOwnerPID as String] ?? -1,
                "window": row[kCGWindowNumber as String] ?? 0,
                "layer": row[kCGWindowLayer as String] ?? -1,
                "alpha": row[kCGWindowAlpha as String] ?? -1,
                "bounds": [rect.minX, rect.minY, rect.width, rect.height]]
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["point": [point.x, point.y], "primary": owned.id, "windowsAtTarget": scene]),
           let message = String(data: data, encoding: .utf8) {
            FileHandle.standardError.write(Data((message + "\n").utf8))
        }
        refuse("Another native window covers the exact observed target: owner=\(owner), layer=\(layer), window=\(identifier).")
    }
    if mode == "read-text" {
        guard AXIsProcessTrusted() else { refuse("Native text accessibility is not already trusted.") }
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success,
              let element else { refuse("The exact owned native text is unavailable.") }
        var owner: pid_t = 0
        var role: CFTypeRef?
        var value: CFTypeRef?
        guard AXUIElementGetPid(element, &owner) == .success, owner == pid,
              AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
              role as? String == kAXStaticTextRole,
              AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
              let text = value as? String, text.utf8.count <= 2048 else {
            refuse("The observed target does not expose bounded owned native static text.")
        }
        nativeText = text
        pointerProof = "owned-native-static-text-read"
    } else if mode == "choose-native-menu-item" {
        guard CommandLine.arguments.count == 6, AXIsProcessTrusted() else {
            refuse("Native menu accessibility is not already trusted; no permission was requested.")
        }
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success,
              let element else { refuse("The exact native menu element is unavailable.") }
        var owner: pid_t = 0
        var role: CFTypeRef?
        var title: CFTypeRef?
        guard AXUIElementGetPid(element, &owner) == .success, owner == pid,
              AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
              role as? String == kAXMenuItemRole,
              AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &title) == .success,
              title as? String == CommandLine.arguments[5] else {
            refuse("The observed target is not the exact owned native menu item.")
        }
        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
            refuse("The exact owned native menu action was refused.")
        }
        pointerProof = "owned-native-menu-item-press"
        clicked = true
    } else if mode == "hover" {
        // Only moves the pointer: resting it on owned content closes a hover
        // card a previous click left open over the text the next stage reads.
        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else { refuse("Native pointer events are unavailable.") }
        move.post(tap: .cghidEventTap)
    } else {
        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
              let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { refuse("Native pointer events are unavailable.") }
        down.setIntegerValueField(.mouseEventClickState, value: 1)
        up.setIntegerValueField(.mouseEventClickState, value: 1)
        move.post(tap: .cghidEventTap)
        usleep(75_000)
        down.post(tap: .cghidEventTap)
        usleep(50_000)
        up.post(tap: .cghidEventTap)
        clicked = true
    }
    if mode == "scroll-top" || mode == "scroll-bottom" {
        for _ in 0..<3 {
            guard let scroll = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: mode == "scroll-top" ? 200 : -200, wheel2: 0, wheel3: 0) else { refuse("Native scrolling is unavailable.") }
            scroll.location = point
            scroll.post(tap: .cghidEventTap)
            usleep(100_000)
        }
    } else if mode == "toggle-before-field" || mode == "focus-before-text" {
        guard let previousDown = CGEvent(keyboardEventSource: nil, virtualKey: 48, keyDown: true),
              let previousUp = CGEvent(keyboardEventSource: nil, virtualKey: 48, keyDown: false),
              let spaceDown = CGEvent(keyboardEventSource: nil, virtualKey: 49, keyDown: true),
              let spaceUp = CGEvent(keyboardEventSource: nil, virtualKey: 49, keyDown: false) else { refuse("Native keyboard input is unavailable.") }
        previousDown.flags = .maskShift
        previousUp.flags = .maskShift
        previousDown.postToPid(pid)
        previousUp.postToPid(pid)
        if mode == "toggle-before-field" {
            spaceDown.flags = []
            spaceUp.flags = []
            spaceDown.postToPid(pid)
            spaceUp.postToPid(pid)
        }
    } else if mode == "fill" || mode == "fill-private" {
        guard CommandLine.arguments.count == 6 else { refuse("Supply the fixture field value.") }
        let value: String
        if mode == "fill-private" {
            guard let data = FileManager.default.contents(atPath: CommandLine.arguments[5]), data.count <= 2048,
                  let text = String(data: data, encoding: .utf8) else { refuse("The private fixture input is unavailable.") }
            value = text
        } else { value = CommandLine.arguments[5] }
        guard !value.isEmpty, value.utf16.count <= 2048 else { refuse("The fixture field value is empty or too long.") }
        guard let selectDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let selectUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false),
              let textDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let textUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { refuse("Native text input is unavailable.") }
        selectDown.flags = .maskCommand
        selectUp.flags = .maskCommand
        selectDown.postToPid(pid)
        selectUp.postToPid(pid)
        let units = Array(value.utf16)
        units.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { refuse("The fixture field value is empty.") }
            textDown.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base)
            textUp.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base)
        }
        textDown.postToPid(pid)
        textUp.postToPid(pid)
    }
} else if mode == "enter" || mode == "end" || mode == "escape" {
    guard targets.contains(where: { $0.text.localizedCaseInsensitiveContains(expected) }) else {
        refuse("The expected keyboard context is absent from the current owned image.")
    }
    let key: CGKeyCode = mode == "end" ? 119 : mode == "escape" ? 53 : 36
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else { refuse("Native keyboard input is unavailable.") }
    down.postToPid(pid)
    up.postToPid(pid)
} else if mode == "settings" {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 43, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 43, keyDown: false) else { refuse("Native keyboard events are unavailable.") }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.postToPid(pid)
    usleep(50_000)
    up.postToPid(pid)
} else if mode != "observe" && mode != "observe-detail" { refuse("Unknown native controller operation.") }
do {
    let encoded = try JSONEncoder().encode(Observation(pid: pid, windowId: owned.id, texts: targets, clicked: clicked, pointerProof: pointerProof, nativeText: nativeText))
    try encoded.write(to: URL(fileURLWithPath: imagePath + ".json"), options: .atomic)
    FileHandle.standardOutput.write(encoded)
    print("")
} catch { refuse("The native observation could not be recorded.") }
