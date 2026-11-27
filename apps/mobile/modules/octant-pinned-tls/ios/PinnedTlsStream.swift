// One request to a paired listener over bytes the app carries itself: the
// hub's device relay, whose WebSocket the shared client runtime holds. The
// TLS, its pin check, and what it writes are the direct exchange's own,
// unchanged: this runs a `PinnedTlsExchange` and gives it a connection whose
// far end is this object rather than the listener. Every ciphertext byte the
// exchange writes goes out to the app as a `send` event, and every byte the
// app hands back goes in, so the hub carries only ciphertext.
//
// iOS offers no public TLS 1.3 over app-supplied bytes: SecureTransport's
// I/O callbacks stop at TLS 1.2, and a Network.framework protocol framer
// sits above a real transport and cannot replace it. So the exchange's far
// end is a listener bound to the loopback address on a port the system
// picks, which accepts one connection, and only the one whose port is the
// exchange's own, and then stops listening. Nothing reaches it from off the
// device, and a connection from another process is closed unread.

import Foundation
import Network

public enum PinnedTlsStreamEvent {
  /// Ciphertext for the app to carry to the listener.
  case send(Data)
  /// The handshake passed the pin and the request was written.
  case opened(servedPin: String)
  /// The handshake refused the served key; nothing was written.
  case refused(servedPin: String?)
  case failed(reason: String)
  /// Reply bytes from the listener.
  case data(Data)
  /// The listener closed the connection.
  case end
}

public final class PinnedTlsStream {
  private let queue = DispatchQueue(label: "sh.octant.pinned-tls-stream")
  private let serverName: String?
  private let pins: [String]
  private let request: Data
  private let emit: (PinnedTlsStreamEvent) -> Void
  private var listener: NWListener?
  private var exchange: PinnedTlsExchange?
  private var carrier: NWConnection?
  /// Bytes the app handed over before the exchange's connection was accepted.
  private var pending: [Data] = []
  private var pendingEnd = false
  private var finished = false
  private var settled = false

  public init(
    serverName: String?, pins: [String], request: Data,
    events: @escaping (PinnedTlsStreamEvent) -> Void
  ) {
    self.serverName = serverName
    self.pins = pins
    self.request = request
    self.emit = events
  }

  public func begin() {
    queue.async { [self] in
      let parameters = NWParameters.tcp
      parameters.requiredInterfaceType = .loopback
      parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
      guard let listener = try? NWListener(using: parameters) else {
        return settle(.failed(reason: "connection-failed"))
      }
      self.listener = listener
      listener.newConnectionHandler = { [weak self] candidate in self?.consider(candidate) }
      listener.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        switch state {
        case .ready:
          guard let port = listener.port?.rawValue else {
            return self.settle(.failed(reason: "connection-failed"))
          }
          self.startExchange(port: port)
        case .failed:
          if self.carrier == nil { self.settle(.failed(reason: "connection-failed")) }
        default:
          break
        }
      }
      listener.start(queue: queue)
    }
  }

  /// Ciphertext the listener sent, as the app received it.
  public func receive(_ chunk: Data) {
    queue.async { [self] in
      guard !finished else { return }
      guard let carrier else { return pending.append(chunk) }
      carrier.send(content: chunk, completion: .contentProcessed { _ in })
    }
  }

  /// The app's carrier closed: no more ciphertext will come.
  public func receiveEnd() {
    queue.async { [self] in
      guard !finished else { return }
      guard let carrier else {
        pendingEnd = true
        return
      }
      carrier.send(content: nil, isComplete: true, completion: .contentProcessed { _ in })
    }
  }

  public func cancel() {
    queue.async { [self] in
      exchange?.cancel()
      finish(settled ? .end : .failed(reason: "connection-failed"))
    }
  }

  private func startExchange(port: UInt16) {
    let exchange = PinnedTlsExchange(
      address: "127.0.0.1", port: port, serverName: serverName, pins: pins, request: request)
    self.exchange = exchange
    exchange.start { [weak self] opening in
      guard let self else { return }
      self.queue.async {
        switch opening {
        case .opened(let servedPin):
          self.settle(.opened(servedPin: servedPin))
          self.readReply()
        case .refused(let servedPin):
          self.settle(.refused(servedPin: servedPin))
        case .failed(let reason):
          self.settle(.failed(reason: reason))
        }
      }
    }
  }

  /// Accepts the exchange's own connection, checked by its port, and closes any other.
  private func consider(_ candidate: NWConnection, attempt: Int = 0) {
    guard carrier == nil, !finished,
      case .hostPort(_, let remotePort) = candidate.endpoint, let exchange
    else { return candidate.cancel() }
    exchange.localPort { [weak self] port in
      guard let self else { return }
      self.queue.async {
        guard let port else {
          // The exchange's path may not name its port yet; it does within moments.
          if attempt < 50 {
            self.queue.asyncAfter(deadline: .now() + 0.01) {
              self.consider(candidate, attempt: attempt + 1)
            }
          } else {
            candidate.cancel()
          }
          return
        }
        guard port == remotePort.rawValue, self.carrier == nil else { return candidate.cancel() }
        self.carrier = candidate
        self.listener?.cancel()
        self.listener = nil
        candidate.start(queue: self.queue)
        for chunk in self.pending {
          candidate.send(content: chunk, completion: .contentProcessed { _ in })
        }
        self.pending = []
        if self.pendingEnd {
          candidate.send(content: nil, isComplete: true, completion: .contentProcessed { _ in })
        }
        self.carryOut(candidate)
      }
    }
  }

  /// What the exchange writes goes to the app as ciphertext.
  private func carryOut(_ carrier: NWConnection) {
    carrier.receive(minimumIncompleteLength: 1, maximumLength: PinnedTlsExchange.maxReadBytes) {
      [weak self] data, _, isComplete, error in
      guard let self, !self.finished else { return }
      if let data, !data.isEmpty { self.emit(.send(data)) }
      if isComplete || error != nil { return }
      self.carryOut(carrier)
    }
  }

  private func readReply() {
    exchange?.read { [weak self] next in
      guard let self else { return }
      self.queue.async {
        switch next {
        case .data(let chunk):
          guard !self.finished else { return }
          self.emit(.data(chunk))
          self.readReply()
        case .end:
          self.finish(.end)
        case .failed:
          self.finish(.failed(reason: "connection-failed"))
        }
      }
    }
  }

  /// Reports how opening went, once; anything but opened also ends the stream.
  private func settle(_ event: PinnedTlsStreamEvent) {
    guard !settled, !finished else { return }
    settled = true
    if case .opened = event { return emit(event) }
    finish(event)
  }

  private func finish(_ event: PinnedTlsStreamEvent) {
    guard !finished else { return }
    finished = true
    listener?.cancel()
    listener = nil
    carrier?.cancel()
    carrier = nil
    emit(event)
  }
}
