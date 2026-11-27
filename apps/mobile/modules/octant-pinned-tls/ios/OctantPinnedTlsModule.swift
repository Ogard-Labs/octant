// The phone's pinned listener transport, as the Expo module the client
// runtime's exchange port calls: open an exchange, then read its reply one
// chunk at a time. Bytes cross as base64 strings. A stream is the same
// exchange over bytes the app carries through the hub's relay: the app
// pushes the listener's ciphertext in and pulls events, ciphertext to send
// among them, one at a time.

import ExpoModulesCore
import Foundation

public class OctantPinnedTlsModule: Module {
  private var running: [String: PinnedTlsExchange] = [:]
  private var streams: [String: (stream: PinnedTlsStream, inbox: StreamInbox)] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("OctantPinnedTls")

    AsyncFunction("resolve") { (hostname: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        promise.resolve(Self.addresses(of: hostname))
      }
    }

    AsyncFunction("open") {
      (id: String, address: String, port: Int, serverName: String?, pins: [String], request: String,
        promise: Promise) in
      guard let bytes = Data(base64Encoded: request), let port = UInt16(exactly: port) else {
        promise.resolve(["status": "failed", "reason": "connection-failed"])
        return
      }
      let exchange = PinnedTlsExchange(
        address: address, port: port, serverName: serverName, pins: pins, request: bytes)
      self.lock.withLock { self.running[id] = exchange }
      exchange.start { opening in
        switch opening {
        case .opened(let servedPin):
          promise.resolve(["status": "opened", "servedPin": servedPin])
        case .refused(let servedPin):
          self.forget(id)
          var refused: [String: Any] = ["status": "refused"]
          if let servedPin { refused["servedPin"] = servedPin }
          promise.resolve(refused)
        case .failed(let reason):
          self.forget(id)
          promise.resolve(["status": "failed", "reason": reason])
        }
      }
    }

    AsyncFunction("read") { (id: String, promise: Promise) in
      guard let exchange = self.lock.withLock({ self.running[id] }) else {
        promise.resolve(["status": "end"])
        return
      }
      exchange.read { next in
        switch next {
        case .data(let chunk):
          promise.resolve(["status": "data", "chunk": chunk.base64EncodedString()])
        case .end:
          self.forget(id)
          promise.resolve(["status": "end"])
        case .failed:
          self.forget(id)
          promise.resolve(["status": "failed"])
        }
      }
    }

    Function("cancel") { (id: String) in
      self.lock.withLock { self.running.removeValue(forKey: id) }?.cancel()
    }

    Function("streamOpen") { (id: String, serverName: String?, pins: [String], request: String) in
      // A request that does not decode opens nothing; its pull then reads as ended.
      guard let bytes = Data(base64Encoded: request) else { return }
      let inbox = StreamInbox()
      let stream = PinnedTlsStream(serverName: serverName, pins: pins, request: bytes) { event in
        switch event {
        case .send(let chunk): inbox.put(["status": "send", "chunk": chunk.base64EncodedString()])
        case .opened(let servedPin): inbox.put(["status": "opened", "servedPin": servedPin])
        case .refused(let servedPin):
          var refused: [String: Any] = ["status": "refused"]
          if let servedPin { refused["servedPin"] = servedPin }
          inbox.put(refused)
        case .failed(let reason): inbox.put(["status": "failed", "reason": reason])
        case .data(let chunk): inbox.put(["status": "data", "chunk": chunk.base64EncodedString()])
        case .end: inbox.put(["status": "end"])
        }
      }
      self.lock.withLock { self.streams[id] = (stream, inbox) }
      stream.begin()
    }

    Function("streamPush") { (id: String, chunk: String) in
      guard let bytes = Data(base64Encoded: chunk) else { return }
      self.lock.withLock { self.streams[id] }?.stream.receive(bytes)
    }

    Function("streamPushEnd") { (id: String) in
      self.lock.withLock { self.streams[id] }?.stream.receiveEnd()
    }

    AsyncFunction("streamPull") { (id: String, promise: Promise) in
      guard let held = self.lock.withLock({ self.streams[id] }) else {
        promise.resolve(["status": "end"])
        return
      }
      held.inbox.take { event in
        let status = event["status"] as? String
        if status != "send" && status != "opened" && status != "data" {
          self.lock.withLock { _ = self.streams.removeValue(forKey: id) }
        }
        promise.resolve(event)
      }
    }

    Function("streamCancel") { (id: String) in
      self.lock.withLock { self.streams.removeValue(forKey: id) }?.stream.cancel()
    }
  }

  private func forget(_ id: String) {
    lock.withLock { _ = running.removeValue(forKey: id) }
  }

  /// Every address the system resolver gives for the name, as IP literals.
  private static func addresses(of hostname: String) -> [String] {
    var hints = addrinfo()
    hints.ai_socktype = SOCK_STREAM
    var list: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(hostname, nil, &hints, &list) == 0 else { return [] }
    defer { freeaddrinfo(list) }
    var found: [String] = []
    var cursor = list
    while let entry = cursor {
      var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      if getnameinfo(
        entry.pointee.ai_addr, entry.pointee.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0,
        NI_NUMERICHOST) == 0
      {
        let address = String(cString: buffer)
        if !found.contains(address) { found.append(address) }
      }
      cursor = entry.pointee.ai_next
    }
    return found
  }
}

/// A stream's events in order, handed to one waiting pull at a time.
private final class StreamInbox {
  private let lock = NSLock()
  private var queued: [[String: Any]] = []
  private var waiting: [([String: Any]) -> Void] = []

  func put(_ event: [String: Any]) {
    let taker: (([String: Any]) -> Void)? = lock.withLock {
      if waiting.isEmpty {
        queued.append(event)
        return nil
      }
      return waiting.removeFirst()
    }
    taker?(event)
  }

  func take(_ completion: @escaping ([String: Any]) -> Void) {
    let event: [String: Any]? = lock.withLock {
      if queued.isEmpty {
        waiting.append(completion)
        return nil
      }
      return queued.removeFirst()
    }
    if let event { completion(event) }
  }
}
