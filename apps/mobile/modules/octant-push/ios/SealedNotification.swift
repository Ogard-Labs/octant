// Opening what a paired computer sealed for this phone, and shaping what the
// phone shows from it. Shared by the notification service extension, which
// opens each notification before the system draws it, and the app's module,
// so both read one rule. It imports only Foundation and CryptoKit because the
// extension cannot load the app's modules.
//
// The construction is HPKE (RFC 9180) base mode with DHKEM(X25519,
// HKDF-SHA256), HKDF-SHA256, and AES-256-GCM, single-shot, with the host id
// and device id bound into the info. The envelope names no host, so every key
// this phone holds is tried and the one whose authentication tag verifies is
// the host that sealed it. Anything that does not open, or opens to content
// that breaks a rule below, leaves the placeholder alone: nothing else is shown.

import CryptoKit
import Foundation

/// One computer's notification key as the phone holds it.
struct NotificationKeyEntry {
  let hostId: String
  let deviceId: String
  let privateKey: Curve25519.KeyAgreement.PrivateKey
}

/// What replaces the placeholder: display text and the thread to open.
struct OpenedNotification: Equatable {
  /// The computer that sealed it; the system groups the notification under it
  /// so removing that computer can remove what it delivered.
  let hostId: String
  let title: String
  let body: String
  let deepLink: String
}

enum SealedNotificationOpener {
  /// The host pads every seal to this size, so a ciphertext of any other
  /// length was not sealed by a host that follows the specification.
  static let plaintextBytes = 2_048
  static let tagBytes = 16
  static let titleMaximumBytes = 80
  static let bodyMaximumBytes = 120

  static func info(hostId: String, deviceId: String) -> Data {
    Data("octant-push-v1\n\(hostId)\n\(deviceId)".utf8)
  }

  /// Whether this system can open sealed content at all: CryptoKit's HPKE
  /// arrived with iOS 17.
  static var canOpen: Bool {
    if #available(iOS 17.0, macOS 14.0, *) { return true }
    return false
  }

  /// Opens one notification with whichever held key verifies it.
  static func open(
    version: Int,
    encapsulatedKey: String,
    ciphertext: String,
    entries: [NotificationKeyEntry]
  ) -> OpenedNotification? {
    guard #available(iOS 17.0, macOS 14.0, *) else { return nil }
    guard version == 1,
      let enc = base64URLDecode(encapsulatedKey), enc.count == 32,
      let sealed = base64URLDecode(ciphertext), sealed.count == plaintextBytes + tagBytes
    else { return nil }
    for entry in entries {
      guard let plaintext = hpkeOpen(entry: entry, enc: enc, ciphertext: sealed) else { continue }
      return shape(plaintext, for: entry)
    }
    return nil
  }

  @available(iOS 17.0, macOS 14.0, *)
  private static func hpkeOpen(entry: NotificationKeyEntry, enc: Data, ciphertext: Data) -> Data? {
    let suite = HPKE.Ciphersuite(
      kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_256)
    do {
      var recipient = try HPKE.Recipient(
        privateKey: entry.privateKey,
        ciphersuite: suite,
        info: info(hostId: entry.hostId, deviceId: entry.deviceId),
        encapsulatedKey: enc)
      return try recipient.open(ciphertext, authenticating: Data())
    } catch {
      return nil
    }
  }

  private struct Content: Decodable {
    let kind: String
    let hostId: String
    let threadId: String
    let mode: String?
    let title: String
    let body: String
  }

  private static let kinds: Set<String> = ["completion", "waiting", "failure", "approval-needed"]
  private static let modes: Set<String> = ["chat", "work", "code"]

  /// The phone's own check of what the host sealed. The host redacts first;
  /// this keeps a host that does not, or content meant for another computer,
  /// from reaching the lock screen or the deep link.
  static func shape(_ plaintext: Data, for entry: NotificationKeyEntry) -> OpenedNotification? {
    guard let content = try? JSONDecoder().decode(Content.self, from: plaintext),
      kinds.contains(content.kind),
      content.hostId == entry.hostId,
      isLinkSegment(content.hostId), isLinkSegment(content.threadId)
    else { return nil }
    if let mode = content.mode, !modes.contains(mode) { return nil }
    let title = displayText(content.title)
    let body = displayText(content.body)
    guard !title.isEmpty,
      title.utf8.count <= titleMaximumBytes, body.utf8.count <= bodyMaximumBytes
    else { return nil }
    let path = content.mode.map { "\($0)/\(content.threadId)" } ?? content.threadId
    return OpenedNotification(
      hostId: content.hostId, title: title, body: body,
      deepLink: "octant://hosts/\(content.hostId)/threads/\(path)")
  }

  /// A thread or host id goes into a link, so it holds only characters a path
  /// segment needs and is bounded.
  private static func isLinkSegment(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= 64 else { return false }
    return value.unicodeScalars.allSatisfy {
      ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x41 && $0.value <= 0x5A)
        || ($0.value >= 0x61 && $0.value <= 0x7A) || $0 == "-" || $0 == "_" || $0 == "."
        || $0 == "~"
    }
  }

  /// Control characters, line and paragraph separators, and the characters
  /// that reorder or hide text are removed, so display text cannot disguise
  /// itself or break the notification's layout.
  static func displayText(_ value: String) -> String {
    var kept = String.UnicodeScalarView()
    for scalar in value.unicodeScalars {
      switch scalar.properties.generalCategory {
      case .control, .lineSeparator, .paragraphSeparator: continue
      default: break
      }
      switch scalar.value {
      case 0x061C, 0x200E, 0x200F, 0x202A...0x202E, 0x2066...0x2069: continue
      default: kept.append(scalar)
      }
    }
    return String(kept).trimmingCharacters(in: .whitespaces)
  }

  static func base64URLDecode(_ value: String) -> Data? {
    let valid = value.unicodeScalars.allSatisfy { scalar in
      (scalar.value >= 0x30 && scalar.value <= 0x39) || (scalar.value >= 0x41 && scalar.value <= 0x5A)
        || (scalar.value >= 0x61 && scalar.value <= 0x7A) || scalar == "-" || scalar == "_"
    }
    guard valid else { return nil }
    var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while text.count % 4 != 0 { text += "=" }
    return Data(base64Encoded: text)
  }

  static func base64URLEncode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
