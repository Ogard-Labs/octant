import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

private enum DisplayFailure: Error { case refused }

private func unlockedDesktop() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          session[kCGSessionOnConsoleKey as String] as? Bool == true,
          session["CGSSessionScreenIsLocked"] as? Bool != true,
          session["kCGSessionLoginDoneKey"] as? Bool == true else { return false }
    return CGPreflightScreenCaptureAccess() && AXIsProcessTrusted()
}

// The browser names a physical position in the last main-display geometry.
// A display unplugged, resized or replaced after capture refuses that input.
private func geometry(_ display: CGDirectDisplayID, _ bounds: CGRect) -> String {
    "\(display):\(bounds.origin.x):\(bounds.origin.y):\(bounds.width):\(bounds.height):\(CGDisplayPixelsWide(display)):\(CGDisplayPixelsHigh(display))"
}

private let keys: [String: CGKeyCode] = [
    "KeyA":0,"KeyS":1,"KeyD":2,"KeyF":3,"KeyH":4,"KeyG":5,"KeyZ":6,"KeyX":7,"KeyC":8,"KeyV":9,
    "KeyB":11,"KeyQ":12,"KeyW":13,"KeyE":14,"KeyR":15,"KeyY":16,"KeyT":17,"Digit1":18,"Digit2":19,
    "Digit3":20,"Digit4":21,"Digit6":22,"Digit5":23,"Equal":24,"Digit9":25,"Digit7":26,"Minus":27,
    "Digit8":28,"Digit0":29,"BracketRight":30,"KeyO":31,"KeyU":32,"BracketLeft":33,"KeyI":34,"KeyP":35,
    "Enter":36,"KeyL":37,"KeyJ":38,"Quote":39,"KeyK":40,"Semicolon":41,"Backslash":42,"Comma":43,
    "Slash":44,"KeyN":45,"KeyM":46,"Period":47,"Tab":48,"Space":49,"Backquote":50,"Backspace":51,"Escape":53,
    "F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,
    "F11":103,"F12":111,"Home":115,"PageUp":116,"Delete":117,"End":119,"PageDown":121,"ArrowLeft":123,
    "ArrowRight":124,"ArrowDown":125,"ArrowUp":126
]

private func input(_ event: [String: Any], in bounds: CGRect) throws {
    func coordinate(_ key: String, _ length: CGFloat) throws -> CGFloat {
        guard let n = event[key] as? Double, n.isFinite, (0...1).contains(n) else { throw DisplayFailure.refused }
        return n * max(0, length - 1)
    }
    func point(_ x: String, _ y: String) throws -> CGPoint {
        CGPoint(x: bounds.minX + (try coordinate(x, bounds.width)), y: bounds.minY + (try coordinate(y, bounds.height)))
    }
    let source = CGEventSource(stateID: .privateState)
    func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) throws {
        guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw DisplayFailure.refused }
        e.setIntegerValueField(.mouseEventClickState, value: clicks)
        e.post(tap: .cghidEventTap)
    }
    switch event["kind"] as? String {
    case "click", "double-click", "right-click", "drag":
        let start = try point("x","y")
        let drag = event["kind"] as? String == "drag"
        let end = drag ? try point("endX","endY") : start
        let right = event["kind"] as? String == "right-click"
        let button: CGMouseButton = right ? .right : .left
        let count = event["kind"] as? String == "double-click" ? 2 : 1
        do {
            let click = count
            try mouse(right ? .rightMouseDown : .leftMouseDown, start, button, clicks: Int64(click))
            if drag { try mouse(.leftMouseDragged, end, button) }
            try mouse(right ? .rightMouseUp : .leftMouseUp, end, button, clicks: Int64(click))
        }
    case "scroll":
        let location = try point("x","y")
        guard let x = event["deltaX"] as? Int32, let y = event["deltaY"] as? Int32,
              (-10000...10000).contains(x), (-10000...10000).contains(y),
              let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -y, wheel2: -x, wheel3: 0)
        else { throw DisplayFailure.refused }
        e.location = location
        e.post(tap: .cghidEventTap)
    case "key", "text":
        let typing = event["kind"] as? String == "text"
        let value = event["text"] as? String ?? ""
        guard let code = typing ? CGKeyCode(0) : keys[event["code"] as? String ?? ""],
              !typing || (!value.isEmpty && value.utf16.count <= 4096) else { throw DisplayFailure.refused }
        var flags = CGEventFlags()
        for (key, flag): (String, CGEventFlags) in [("meta",.maskCommand),("shift",.maskShift),("ctrl",.maskControl),("alt",.maskAlternate)] {
            if event[key] as? Bool == true { flags.insert(flag) }
        }
        for down in [true,false] {
            guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { throw DisplayFailure.refused }
            e.flags = flags
            if typing {
                let chars = Array(value.utf16)
                e.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            }
            e.post(tap: .cghidEventTap)
        }
    default: throw DisplayFailure.refused
    }
}

@available(macOS 14.0, *)
private func operate() async throws -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 32768, let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          unlockedDesktop() else { throw DisplayFailure.refused }
    let id = CGMainDisplayID()
    let bounds = CGDisplayBounds(id)
    let layout = geometry(id, bounds)
    guard !bounds.isEmpty else { throw DisplayFailure.refused }
    if request["action"] as? String == "input" {
        guard request["geometry"] as? String == layout, let event = request["event"] as? [String: Any] else { throw DisplayFailure.refused }
        try input(event, in: bounds)
        return ["status":"delivered"]
    }
    guard request["action"] as? String == "frame" else { throw DisplayFailure.refused }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == id }) else { throw DisplayFailure.refused }
    let configuration = SCStreamConfiguration()
    let scale = min(1, 1440 / max(bounds.width,bounds.height))
    configuration.width = max(1,Int(bounds.width * scale))
    configuration.height = max(1,Int(bounds.height * scale))
    configuration.showsCursor = true
    let picture = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration)
    guard unlockedDesktop(), layout == geometry(CGMainDisplayID(),CGDisplayBounds(CGMainDisplayID())),
          let jpeg = NSBitmapImageRep(cgImage: picture).representation(using: .jpeg, properties: [.compressionFactor: 0.7]),
          jpeg.count <= 1572864 else { throw DisplayFailure.refused }
    return ["status":"host-frame","jpeg":jpeg.base64EncodedString(),"geometry":layout]
}

func runHostDisplayCommand() -> Never {
    // macOS permissions may outlive an Octant view. Only the hosting app
    // may start the whole-display command using its bundled helper.
    let helper = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
    guard let parent = NSRunningApplication(processIdentifier: getppid()),
          let bundle = parent.bundleURL?.standardizedFileURL.resolvingSymlinksInPath(),
          let id = parent.bundleIdentifier,
          ["app.octant.desktop", "app.octant.desktop.nightly"].contains(id),
          helper.path.hasPrefix(bundle.appendingPathComponent("Contents/Resources").path + "/"),
          parent.executableURL?.standardizedFileURL.resolvingSymlinksInPath() == Bundle(url: bundle)?.executableURL?.standardizedFileURL.resolvingSymlinksInPath()
    else { exit(1) }
    Task {
        let answer = (try? await operate()) ?? ["status":"refused","reason":"view-ended"]
        if let data = try? JSONSerialization.data(withJSONObject: answer) { FileHandle.standardOutput.write(data) }
        exit(0)
    }
    dispatchMain()
}
