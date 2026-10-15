// One request to a paired listener held to its certificate pin. It dials
// the address it is given, never a name, runs a TLS 1.3 handshake whose
// trust decision is only whether the served leaf's SubjectPublicKeyInfo
// hashes to one of the given pins, and writes the request only after that
// handshake passed. It parses nothing the listener sends: the reply's bytes
// go back to the shared client runtime as they arrive, one read at a time,
// and the runtime frames HTTP, so an event stream streams.
//
// Network.framework rather than URLSession: URLSession cannot dial an
// address while sending a name, and the platform's transport security rules
// do not govern this layer, so no arbitrary-loads exception is needed.
// This file imports nothing from Expo so it can be built and run against a
// real listener on a Mac.

import CryptoKit
import Foundation
import Network
import Security

public enum PinnedTlsOpening {
  /// The handshake passed the pin and the request was written.
  case opened(servedPin: String)
  /// The handshake refused the served key; nothing was written.
  case refused(servedPin: String?)
  case failed(reason: String)
}

public enum PinnedTlsRead {
  case data(Data)
  /// The listener closed the connection.
  case end
  case failed
}

public final class PinnedTlsExchange {
  /// A listener has this long to finish the handshake, as on the desktop.
  public static let handshakeTimeout: TimeInterval = 10
  /// The most one read hands back.
  public static let maxReadBytes = 64 * 1024

  private let queue = DispatchQueue(label: "sh.octant.pinned-tls")
  private let connection: NWConnection
  private let pinCheck: PinCheck
  private let request: Data
  private var opened: ((PinnedTlsOpening) -> Void)?
  private var isOpen = false
  private var closed = false
  private var handshakeTimer: DispatchWorkItem?

  /// The handshake's one trust decision and what it saw, read again before the first write.
  private final class PinCheck {
    let pins: Set<String>
    var servedPin: String?
    var accepted = false
    init(pins: Set<String>) { self.pins = pins }
  }

  public init(address: String, port: UInt16, serverName: String?, pins: [String], request: Data) {
    self.request = request
    let pinCheck = PinCheck(pins: Set(pins))
    self.pinCheck = pinCheck
    let tls = NWProtocolTLS.Options()
    let security = tls.securityProtocolOptions
    // TLS 1.2 renegotiation could present a second certificate after the
    // judged one; TLS 1.3 has none, and the listener speaks it.
    sec_protocol_options_set_min_tls_protocol_version(security, .TLSv13)
    if let serverName {
      sec_protocol_options_set_tls_server_name(security, serverName)
    }
    // The pin replaces platform chain, name, and date validation: the block
    // never consults the system's trust evaluation. It is set before the
    // parameters are made from these options, which copy them.
    sec_protocol_options_set_verify_block(
      security,
      { _, trust, complete in
        let pin = PinnedTlsExchange.leafPin(of: sec_trust_copy_ref(trust).takeRetainedValue())
        pinCheck.servedPin = pin
        pinCheck.accepted = pin.map { pinCheck.pins.contains($0) } ?? false
        complete(pinCheck.accepted)
      }, queue)
    let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
    // The address was judged private by the caller; a proxy would carry the
    // connection somewhere else.
    parameters.preferNoProxies = true
    connection = NWConnection(
      host: NWEndpoint.Host(address), port: NWEndpoint.Port(rawValue: port) ?? .https,
      using: parameters)
  }

  public func start(opened: @escaping (PinnedTlsOpening) -> Void) {
    queue.async { [self] in
      self.opened = opened
      let timer = DispatchWorkItem { [weak self] in self?.settle(.failed(reason: "handshake-failed")) }
      self.handshakeTimer = timer
      self.queue.asyncAfter(deadline: .now() + PinnedTlsExchange.handshakeTimeout, execute: timer)
      self.connection.stateUpdateHandler = { [weak self] state in self?.changed(to: state) }
      self.connection.start(queue: self.queue)
    }
  }

  /// The next bytes the listener sent, waiting for at least one.
  public func read(completion: @escaping (PinnedTlsRead) -> Void) {
    queue.async { [self] in
      guard isOpen, !closed else { return completion(closed ? .end : .failed) }
      connection.receive(minimumIncompleteLength: 1, maximumLength: PinnedTlsExchange.maxReadBytes) {
        [weak self] data, _, isComplete, error in
        if let data, !data.isEmpty { return completion(.data(data)) }
        if isComplete || self?.closed != false { return completion(.end) }
        completion(error == nil ? .end : .failed)
      }
    }
  }

  public func cancel() {
    queue.async { [self] in
      settle(.failed(reason: "connection-failed"))
      closed = true
      connection.stateUpdateHandler = nil
      connection.cancel()
    }
  }

  private func changed(to state: NWConnection.State) {
    switch state {
    case .ready:
      handshakeTimer?.cancel()
      // The verify block is the only way to reach ready; this is the same
      // decision read again before the first byte.
      guard pinCheck.accepted, let servedPin = pinCheck.servedPin else {
        return settle(.refused(servedPin: pinCheck.servedPin))
      }
      connection.send(
        content: request,
        completion: .contentProcessed { [weak self] error in
          guard let self else { return }
          if error != nil { return self.settle(.failed(reason: "connection-failed")) }
          self.isOpen = true
          self.settle(.opened(servedPin: servedPin))
        })
    case .failed, .waiting:
      if let servedPin = pinCheck.servedPin, !pinCheck.accepted {
        settle(.refused(servedPin: servedPin))
      } else if pinCheck.servedPin == nil {
        settle(.failed(reason: "unreachable"))
      } else {
        settle(.failed(reason: "connection-failed"))
      }
    default:
      break
    }
  }

  /// Reports how opening went, once; anything but opened also closes the connection.
  private func settle(_ opening: PinnedTlsOpening) {
    guard let opened else { return }
    self.opened = nil
    handshakeTimer?.cancel()
    if case .opened = opening {
      opened(opening)
      return
    }
    closed = true
    connection.stateUpdateHandler = nil
    connection.cancel()
    opened(opening)
  }

  /// `sha256-` and the unpadded base64url SHA-256 of the leaf's DER SubjectPublicKeyInfo.
  static func leafPin(of trust: SecTrust) -> String? {
    guard
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = chain.first,
      let spki = subjectPublicKeyInfo(of: SecCertificateCopyData(leaf) as Data)
    else { return nil }
    let digest = Data(SHA256.hash(data: spki))
    let base64url = digest.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    return "sha256-\(base64url)"
  }

  /// The SubjectPublicKeyInfo element of an X.509 certificate, tag and length
  /// included. The platform hands out the key only in its own raw form, which
  /// differs by key type, so the certificate's DER is walked instead.
  static func subjectPublicKeyInfo(of certificate: Data) -> Data? {
    let bytes = [UInt8](certificate)
    // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { ... } ... }
    guard let outer = element(in: bytes, at: 0), outer.tag == 0x30,
      let tbs = element(in: bytes, at: outer.contentStart), tbs.tag == 0x30
    else { return nil }
    var offset = tbs.contentStart
    // [0] version is optional; then serialNumber, signature, issuer,
    // validity, subject, and subjectPublicKeyInfo.
    if let version = element(in: bytes, at: offset), version.tag == 0xA0 { offset = version.end }
    for _ in 0..<5 {
      guard let skipped = element(in: bytes, at: offset), skipped.end <= tbs.end else { return nil }
      offset = skipped.end
    }
    guard let spki = element(in: bytes, at: offset), spki.tag == 0x30, spki.end <= tbs.end else {
      return nil
    }
    return Data(bytes[offset..<spki.end])
  }

  private struct Element {
    let tag: UInt8
    let contentStart: Int
    let end: Int
  }

  private static func element(in bytes: [UInt8], at offset: Int) -> Element? {
    guard offset + 2 <= bytes.count else { return nil }
    let tag = bytes[offset]
    let first = Int(bytes[offset + 1])
    var length = 0
    var contentStart = offset + 2
    if first < 0x80 {
      length = first
    } else {
      let count = first & 0x7F
      guard count >= 1, count <= 4, offset + 2 + count <= bytes.count else { return nil }
      for index in 0..<count { length = (length << 8) | Int(bytes[offset + 2 + index]) }
      contentStart += count
    }
    let end = contentStart + length
    guard end <= bytes.count else { return nil }
    return Element(tag: tag, contentStart: contentStart, end: end)
  }
}
