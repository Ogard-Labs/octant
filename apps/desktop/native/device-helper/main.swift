import Darwin
import Foundation

// Octant device helper: delivers touch, keyboard and hardware-button input to
// one booted Simulator. It speaks length-prefixed JSON on stdin/stdout (a
// 4-byte big-endian length, then one JSON object), answers every request with
// exactly one response, and exits when stdin closes so it never outlives the
// desktop process that owns it.

private let protocolVersion = 1
private let maximumFrameBytes = 262_144
private let tapHold: TimeInterval = 0.06
private let swipeStep: TimeInterval = 0.016

private struct Refusal: Error {
    let code: String
    let message: String
}

private func readExactly(_ count: Int) -> Data? {
    var data = Data(capacity: count)
    var buffer = [UInt8](repeating: 0, count: count)
    while data.count < count {
        let received = read(STDIN_FILENO, &buffer, count - data.count)
        if received < 0 && errno == EINTR { continue }
        if received <= 0 { return nil }
        data.append(buffer, count: received)
    }
    return data
}

private func readRequest() throws -> [String: Any]? {
    guard let header = readExactly(4) else { return nil }
    let length = header.reduce(0) { ($0 << 8) | Int($1) }
    guard length > 0, length <= maximumFrameBytes else {
        throw Refusal(code: "malformed", message: "frame length \(length) is out of range")
    }
    guard let payload = readExactly(length) else { return nil }
    guard let request = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
        throw Refusal(code: "malformed", message: "the frame is not a JSON object")
    }
    return request
}

private func writeResponse(_ response: [String: Any]) {
    guard let payload = try? JSONSerialization.data(withJSONObject: response) else { return }
    var frame = Data()
    withUnsafeBytes(of: UInt32(payload.count).bigEndian) { frame.append(contentsOf: $0) }
    frame.append(payload)
    frame.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let written = write(STDOUT_FILENO, bytes.baseAddress! + offset, bytes.count - offset)
            if written < 0 && errno == EINTR { continue }
            if written <= 0 { exit(0) }
            offset += written
        }
    }
}

/// A JSON number, and not a JSON boolean: `JSONSerialization` hands both back
/// as `NSNumber`, so `true` would otherwise pass for 1.
private func number(_ value: Any?) -> NSNumber? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
        return nil
    }
    return number
}

/// A whole number in `range`; a fraction is refused rather than truncated.
private func whole(_ value: Any?, in range: ClosedRange<Double>) -> UInt64? {
    guard let raw = number(value)?.doubleValue, raw.isFinite, raw == raw.rounded(), range.contains(raw)
    else { return nil }
    return UInt64(raw)
}

private func unit(_ request: [String: Any], _ key: String) throws -> Double {
    guard let value = number(request[key])?.doubleValue, value.isFinite, (0...1).contains(value)
    else { throw Refusal(code: "malformed", message: "\(key) must be a number from 0 to 1") }
    return value
}

private final class Session {
    private let udid: String
    private let developerDirectory: String
    private var simulator: SimulatorBridge?
    private var input: GuestInputConnection?

    init(udid: String, developerDirectory: String) {
        self.udid = udid
        self.developerDirectory = developerDirectory
    }

    private func bridge() throws -> SimulatorBridge {
        if let simulator { return simulator }
        let found = try SimulatorBridge.device(udid: udid, developerDirectory: developerDirectory)
        simulator = found
        return found
    }

    /// The open connection, or a fresh one when the last was invalidated — a
    /// Simulator that rebooted takes its input port with it.
    private func connection() throws -> GuestInputConnection {
        if let input, input.isUsable { return input }
        input?.close()
        let opened = try GuestInputConnection.open(to: try bridge())
        input = opened
        return opened
    }

    func handle(_ request: [String: Any]) throws -> [String: Any] {
        guard let operation = request["op"] as? String else {
            throw Refusal(code: "malformed", message: "op is required")
        }
        switch operation {
        case "hello":
            let simulator = try bridge()
            var device: [String: Any] = ["name": simulator.name, "state": simulator.stateDescription]
            if let screen = simulator.screenPixelSize {
                device["screen"] = ["width": Int(screen.width), "height": Int(screen.height)]
            }
            return ["protocol": protocolVersion, "device": device]
        case "touch":
            guard let phaseName = request["phase"] as? String,
                let phase = ["down": DigitizerEventType.start, "move": .position, "up": .end][phaseName]
            else { throw Refusal(code: "malformed", message: "phase must be down, move or up") }
            try connection().touch(phase: phase, x: try unit(request, "x"), y: try unit(request, "y"))
            return [:]
        case "tap":
            let x = try unit(request, "x")
            let y = try unit(request, "y")
            let input = try connection()
            try input.touch(phase: .start, x: x, y: y)
            Thread.sleep(forTimeInterval: tapHold)
            try input.touch(phase: .end, x: x, y: y)
            input.settle()
            return [:]
        case "swipe":
            let fromX = try unit(request, "fromX")
            let fromY = try unit(request, "fromY")
            let toX = try unit(request, "toX")
            let toY = try unit(request, "toY")
            let duration = min(max(number(request["durationMs"])?.doubleValue ?? 250, 50), 5_000)
            let steps = max(Int((duration / 1_000) / swipeStep), 2)
            let input = try connection()
            try input.touch(phase: .start, x: fromX, y: fromY)
            for step in 1...steps {
                Thread.sleep(forTimeInterval: swipeStep)
                let progress = Double(step) / Double(steps)
                try input.touch(
                    phase: .position,
                    x: fromX + (toX - fromX) * progress,
                    y: fromY + (toY - fromY) * progress)
            }
            try input.touch(phase: .end, x: toX, y: toY)
            input.settle()
            return [:]
        case "key":
            let usage: UInt64
            if let name = request["key"] as? String {
                guard let named = KeyUsages.named[name.lowercased()] else {
                    throw Refusal(code: "unsupported-key", message: "no key is named \(name)")
                }
                usage = named
            } else if let raw = whole(request["usage"], in: 1...255) {
                usage = raw
            } else {
                throw Refusal(code: "malformed", message: "key, or a whole usage from 1 to 255, is required")
            }
            // Absent means none. Present but not a list of whole usages is a
            // mistake, not a request for no modifiers.
            var modifiers: [UInt64] = []
            if let given = request["modifiers"] {
                guard let list = given as? [Any] else {
                    throw Refusal(code: "malformed", message: "modifiers must be a list")
                }
                for item in list {
                    guard let usage = whole(item, in: 224...231) else {
                        throw Refusal(code: "malformed", message: "modifiers must be whole usages 224 to 231")
                    }
                    modifiers.append(usage)
                }
            }
            let input = try connection()
            for modifier in modifiers { try input.key(usage: modifier, state: .down) }
            try input.key(usage: usage, state: .down)
            try input.key(usage: usage, state: .up)
            for modifier in modifiers.reversed() { try input.key(usage: modifier, state: .up) }
            input.settle()
            return [:]
        case "text":
            guard let text = request["text"] as? String, !text.isEmpty else {
                throw Refusal(code: "malformed", message: "text is required")
            }
            // Resolved before anything is sent, so a refused string types nothing,
            // and before the device is asked anything, so it costs nothing.
            guard let strokes = KeyUsages.strokes(for: text) else {
                // The character is not named: a refusal can reach a log, and
                // typed text never does.
                throw Refusal(
                    code: "unsupported-character",
                    message: "only letters, digits, spaces and new lines can be typed")
            }
            // Key positions are only letters on a keyboard laid out like a US
            // one. On any other layout the same keys type other characters, and
            // nothing would report it, so the layout is checked before a key goes.
            guard let keyboard = try bridge().keyboardIdentifier else {
                throw Refusal(
                    code: "keyboard-layout-unknown",
                    message: "the Simulator's keyboard layout could not be read; show its keyboard once, then retry")
            }
            guard KeyUsages.typesAsUSPositions(keyboardIdentifier: keyboard) else {
                throw Refusal(
                    code: "keyboard-layout-unsupported",
                    message: "typing needs a QWERTY Simulator keyboard; this one would type other characters")
            }
            let input = try connection()
            for stroke in strokes {
                if stroke.shifted { try input.key(usage: KeyUsages.leftShift, state: .down) }
                try input.key(usage: stroke.usage, state: .down)
                try input.key(usage: stroke.usage, state: .up)
                if stroke.shifted { try input.key(usage: KeyUsages.leftShift, state: .up) }
            }
            input.settle()
            return ["keys": strokes.count]
        case "keyboard":
            // Whether text would be typed on a Simulator whose keyboard is
            // recorded as `identifier`. Asks nothing of any device.
            guard let identifier = request["identifier"] as? String, !identifier.isEmpty else {
                throw Refusal(code: "malformed", message: "identifier is required")
            }
            return ["typed": KeyUsages.typesAsUSPositions(keyboardIdentifier: identifier)]
        case "button":
            guard let name = request["button"] as? String, let button = HardwareButton(rawValue: name)
            else { throw Refusal(code: "unsupported-key", message: "button must be home or lock") }
            let input = try connection()
            try input.button(page: button.usage.page, code: button.usage.code, state: .down)
            Thread.sleep(forTimeInterval: tapHold)
            try input.button(page: button.usage.page, code: button.usage.code, state: .up)
            input.settle()
            return [:]
        default:
            throw Refusal(code: "malformed", message: "unknown op \(operation)")
        }
    }
}

private func refusal(for error: Error) -> Refusal {
    switch error {
    case let refusal as Refusal: return refusal
    case BridgeRefusal.toolchainUnavailable(let detail):
        return Refusal(code: "toolchain-unavailable", message: detail)
    case BridgeRefusal.noSuchDevice:
        return Refusal(code: "no-such-device", message: "no Simulator has that identifier")
    case BridgeRefusal.notBooted(let state):
        return Refusal(code: "not-booted", message: "the Simulator is \(state)")
    case BridgeRefusal.inputServiceUnavailable(let detail):
        return Refusal(code: "input-service-unavailable", message: detail)
    case InputRefusal.xpcSymbolsUnavailable:
        return Refusal(code: "input-service-unavailable", message: "this macOS has no Simulator XPC bridge")
    case InputRefusal.connectionFailed:
        return Refusal(code: "input-service-unavailable", message: "the input connection could not be built")
    case InputRefusal.daemonUnresponsive(let detail):
        return Refusal(code: "daemon-unresponsive", message: detail)
    case InputRefusal.sendStalled:
        return Refusal(
            code: "send-stalled",
            message: "the input was not seen leaving within 2 seconds; whether it arrived is unknown")
    default:
        return Refusal(code: "failed", message: String(describing: error))
    }
}

/// The developer directory the workbench's own commands use. Those run with an
/// environment that does not carry `DEVELOPER_DIR`, so `simctl` and discovery
/// follow `xcode-select`; honouring the variable here would open a different
/// toolchain's device set and answer "no such device" for a Simulator the
/// workbench had just listed. Xcode is often installed beside a beta or under
/// another name, so a fixed path would be wrong too.
private func selectedDeveloperDirectory() -> String {
    let select = Process()
    select.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    select.arguments = ["-p"]
    var environment = ProcessInfo.processInfo.environment
    environment.removeValue(forKey: "DEVELOPER_DIR")
    select.environment = environment
    let output = Pipe()
    select.standardOutput = output
    select.standardError = FileHandle.nullDevice
    if (try? select.run()) != nil {
        let data = output.fileHandleForReading.readDataToEndOfFile()
        select.waitUntilExit()
        let path = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if select.terminationStatus == 0, !path.isEmpty { return path }
    }
    return "/Applications/Xcode.app/Contents/Developer"
}

private func run() -> Int32 {
    let arguments = CommandLine.arguments
    guard arguments.count == 2, UUID(uuidString: arguments[1]) != nil else {
        FileHandle.standardError.write(Data("usage: octant-device-helper <simulator-udid>\n".utf8))
        return 64
    }
    let session = Session(udid: arguments[1], developerDirectory: selectedDeveloperDirectory())
    signal(SIGPIPE, SIG_IGN)
    while true {
        var identifier: Any = NSNull()
        do {
            guard let request = try readRequest() else { return 0 }
            identifier = request["id"] ?? NSNull()
            var response = try session.handle(request)
            response["id"] = identifier
            response["ok"] = true
            writeResponse(response)
        } catch {
            let refused = refusal(for: error)
            writeResponse(["id": identifier, "ok": false, "code": refused.code, "message": refused.message])
            // A frame that cannot be parsed leaves the stream position unknown.
            if refused.code == "malformed", identifier is NSNull { return 65 }
        }
    }
}

exit(run())
