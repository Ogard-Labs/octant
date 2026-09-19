import Darwin
import Foundation
import XPC

enum InputRefusal: Error {
    case xpcSymbolsUnavailable
    case connectionFailed
    case daemonUnresponsive(String)
}

/// A live XPC connection to the guest's input daemon.
///
/// From CoreSimulator 1155.4 the guest hands touch, keyboard and button input
/// to a demand-launched daemon; the older host-side HID client still accepts
/// messages and then drops them, which is why a tap sent that way reports
/// success and moves nothing. Messages are plain XPC dictionaries, built from
/// the vendored wire models.
///
/// The connection recipe and the liveness barrier follow the MIT-licensed
/// transport the wire models come from (see `vendor/simulator-hid/README.md`).
final class GuestInputConnection {
    static let serviceName = "com.apple.coredevice.feature.remote.hid.digitizer"

    private static let livenessTimeout = DispatchTimeInterval.seconds(4)
    private static let livenessAttempts = 3
    private static let livenessBackoff: TimeInterval = 2
    /// Time the daemon is given to consume what was sent before the caller is
    /// told the input landed; without it a capture taken right after can show
    /// the screen from before the input.
    private static let drain: TimeInterval = 0.08

    private let connection: xpc_connection_t
    private var invalidated = false
    private let lock = NSLock()

    var isUsable: Bool { lock.withLock { !invalidated } }

    private init(connection: xpc_connection_t) {
        self.connection = connection
    }

    /// Connects and proves a daemon answers. Every step of building the
    /// connection succeeds against a daemon that cannot run, and a send to one
    /// reports no error, so an answered barrier is the only evidence there is.
    /// Retried because the daemon's start races the guest's boot.
    static func open(to simulator: SimulatorBridge) throws -> GuestInputConnection {
        var lastFailure = "no reply"
        for attempt in 1...livenessAttempts {
            let candidate = try connect(to: simulator)
            switch candidate.confirmLiveness() {
            case .none:
                return candidate
            case .some(let failure):
                lastFailure = failure
                candidate.close()
            }
            if attempt < livenessAttempts { Thread.sleep(forTimeInterval: livenessBackoff) }
        }
        throw InputRefusal.daemonUnresponsive(lastFailure)
    }

    private static func connect(to simulator: SimulatorBridge) throws -> GuestInputConnection {
        typealias EndpointFromPort = @convention(c) (mach_port_t, UInt64, UInt64) -> xpc_object_t?
        typealias EnableSimToHost = @convention(c) (xpc_connection_t) -> Void
        guard let process = dlopen(nil, RTLD_NOW),
            let endpointSymbol = dlsym(process, "xpc_endpoint_create_mach_port_4sim"),
            let enableSymbol = dlsym(process, "xpc_connection_enable_sim2host_4sim")
        else { throw InputRefusal.xpcSymbolsUnavailable }
        let endpointFromPort = unsafeBitCast(endpointSymbol, to: EndpointFromPort.self)
        let enableSimToHost = unsafeBitCast(enableSymbol, to: EnableSimToHost.self)

        let port = try simulator.guestServicePort(named: serviceName)
        guard let endpoint = endpointFromPort(port, 0, 0) else { throw InputRefusal.connectionFailed }
        let connection = xpc_connection_create_from_endpoint(endpoint)
        let opened = GuestInputConnection(connection: connection)
        // Without this the daemon sees a peer and never the payload.
        enableSimToHost(connection)
        xpc_connection_set_event_handler(connection) { [weak opened] event in
            guard xpc_get_type(event) == XPC_TYPE_ERROR else { return }
            opened?.lock.withLock { opened?.invalidated = true }
        }
        xpc_connection_resume(connection)
        return opened
    }

    func close() {
        lock.withLock { invalidated = true }
        xpc_connection_cancel(connection)
    }

    func touch(phase: DigitizerEventType, x: Double, y: Double) throws {
        try send(
            "IndigoDigitizerEvent",
            IndigoDigitizerEvent(pointOne: DigitizerPoint(x: x, y: y), eventType: phase))
    }

    func key(usage: UInt64, state: HIDButtonState) throws {
        try send("IndigoKeyboardButtonEvent", IndigoKeyboardButtonEvent(usageCode: usage, state: state))
    }

    func button(page: UInt64, code: UInt64, state: HIDButtonState) throws {
        try send("IndigoButtonEvent", IndigoButtonEvent(usagePage: page, usageCode: code, state: state))
    }

    func settle() {
        Thread.sleep(forTimeInterval: Self.drain)
    }

    private func send(_ messageType: String, _ payload: some Encodable) throws {
        let message = try XPCEncoder().encode(
            DTUHIDMessage(
                messageType: messageType, featureIdentifier: Self.serviceName, payload: payload))
        let written = DispatchSemaphore(value: 0)
        xpc_connection_send_message(connection, message)
        xpc_connection_send_barrier(connection) { written.signal() }
        _ = written.wait(timeout: .now() + .seconds(2))
    }

    /// A barrier carrying keyboard usage 0 — "no event" — so the daemon answers
    /// without the guest seeing a key. Returns why it failed, or nil when a
    /// daemon answered.
    private func confirmLiveness() -> String? {
        guard
            let probe = try? XPCEncoder().encode(
                DTUHIDMessage(
                    messageType: "IndigoKeyboardButtonEvent",
                    featureIdentifier: Self.serviceName,
                    isBarrier: true,
                    payload: IndigoKeyboardButtonEvent(usageCode: 0, state: .up)))
        else { return "the liveness probe could not be encoded" }
        let answered = DispatchSemaphore(value: 0)
        var failure: String?
        xpc_connection_send_message_with_reply(
            connection, probe, DispatchQueue.global(qos: .userInitiated)
        ) { reply in
            if xpc_get_type(reply) == XPC_TYPE_ERROR {
                failure =
                    xpc_dictionary_get_string(reply, XPC_ERROR_KEY_DESCRIPTION)
                    .map { String(cString: $0) } ?? "unknown XPC error"
            }
            answered.signal()
        }
        guard answered.wait(timeout: .now() + Self.livenessTimeout) == .success else {
            return "no reply within 4 seconds"
        }
        if failure == nil { Thread.sleep(forTimeInterval: 0.2) }
        return failure
    }
}
