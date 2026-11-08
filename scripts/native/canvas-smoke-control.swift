import AppKit
import ApplicationServices
import Foundation
import Vision

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
guard let application = NSRunningApplication(processIdentifier: pid), !application.isTerminated else {
    refuse("The owned application is no longer running.")
}
if mode == "click" || mode == "settings" {
    guard CGPreflightPostEventAccess() else { refuse("Native event delivery is unavailable; no permission was requested.") }
    _ = application.activate(options: [.activateIgnoringOtherApps])
}
let owned = window(pid)
let capture = Process()
capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
capture.arguments = ["-x", "-o", "-l", String(owned.id), imagePath]
do { try capture.run(); capture.waitUntilExit() }
catch { refuse("The owned-window capture could not start.") }
guard capture.terminationStatus == 0 else { refuse("The owned-window capture failed.") }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]
do { try VNImageRequestHandler(url: URL(fileURLWithPath: imagePath)).perform([request]) }
catch { refuse("The owned-window text could not be recognized.") }
let targets = (request.results ?? []).compactMap { result -> TextTarget? in
    guard let value = result.topCandidates(1).first else { return nil }
    return TextTarget(text: value.string,
        x: Double(owned.bounds.minX + result.boundingBox.midX * owned.bounds.width),
        y: Double(owned.bounds.minY + (1 - result.boundingBox.midY) * owned.bounds.height))
}
var clicked = false
if mode == "click" {
    let matches = targets.filter { $0.text.caseInsensitiveCompare(expected) == .orderedSame }
    guard matches.count == 1, let match = matches.first else { refuse("The current owned image has no unique exact text target: " + expected) }
    let current = window(pid)
    guard current.id == owned.id, current.bounds == owned.bounds else { refuse("The owned window moved after its capture.") }
    let point = CGPoint(x: match.x, y: match.y)
    let covering = windows().first { row in
        guard (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let data = row[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: data as CFDictionary) else { return false }
        return rect.contains(point)
    }
    guard let covering,
          (covering[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          (covering[kCGWindowNumber as String] as? NSNumber)?.uint32Value == owned.id else {
        refuse("Another native window covers the exact observed target.")
    }
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { refuse("Native pointer events are unavailable.") }
    down.post(tap: .cghidEventTap)
    usleep(50_000)
    up.post(tap: .cghidEventTap)
    clicked = true
} else if mode == "settings" {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 43, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 43, keyDown: false) else { refuse("Native keyboard events are unavailable.") }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.postToPid(pid)
    usleep(50_000)
    up.postToPid(pid)
} else if mode != "observe" { refuse("Unknown native controller operation.") }
do {
    let encoded = try JSONEncoder().encode(Observation(pid: pid, windowId: owned.id, texts: targets, clicked: clicked))
    FileHandle.standardOutput.write(encoded)
    print("")
} catch { refuse("The native observation could not be recorded.") }
