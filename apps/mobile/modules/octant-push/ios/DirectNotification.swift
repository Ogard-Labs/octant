// Parses direct v2 push notifications from a paired computer and shapes what
// the phone displays and opens. Shared by the keyless notification service
// extension and the app's module, importing only Foundation — no network, no
// Keychain, no cryptography.

import Foundation

/// What the notification displays and opens when tapped.
struct DirectNotification: Equatable {
  /// The computer that sent it; the system groups the notification under it so
  /// removing that computer can remove what it delivered.
  let hostId: String
  let kind: String
  let title: String
  let body: String
  let deepLink: String
}

enum DirectNotificationParser {
  static let placeholderTitle = "Octant"
  static let placeholderBody = "A paired computer has an update"
  static let titleMaximumBytes = 80
  static let bodyMaximumBytes = 120

  private static let threadKinds: Set<String> = [
    "completion", "waiting", "failure", "approval-needed",
  ]
  private static let modes: Set<String> = ["chat", "work", "code"]

  /// Validates the `octant` metadata dictionary and alert text from an APNs v2
  /// payload. Returns nil for malformed payloads, wrong versions, or a host the
  /// person removed from this phone.
  static func parse(
    octant: [String: Any],
    title rawTitle: String,
    body rawBody: String,
    forgottenHosts: Set<String> = []
  ) -> DirectNotification? {
    guard let version = octant["v"] as? Int, version == 2,
      let kind = octant["kind"] as? String,
      let hostId = octant["hostId"] as? String,
      isLinkSegment(hostId),
      !forgottenHosts.contains(hostId)
    else { return nil }

    let threadId = octant["threadId"] as? String
    let mode = octant["mode"] as? String
    if octant["threadId"] != nil && threadId == nil { return nil }
    if octant["mode"] != nil && mode == nil { return nil }

    let deepLink: String
    if kind == "move-waiting" {
      guard threadId == nil, mode == nil else { return nil }
      deepLink = "octant://hosts/\(hostId)/moves"
    } else if kind == "device-joined" {
      guard threadId == nil, mode == nil else { return nil }
      deepLink = "octant://hosts/\(hostId)/new-devices"
    } else if threadKinds.contains(kind) {
      if let threadId {
        guard isLinkSegment(threadId) else { return nil }
        if let mode, !modes.contains(mode) { return nil }
        let path = mode.map { "\($0)/\(threadId)" } ?? threadId
        deepLink = "octant://hosts/\(hostId)/threads/\(path)"
      } else {
        guard mode == nil else { return nil }
        deepLink = "octant://hosts/\(hostId)"
      }
    } else {
      return nil
    }

    let title = displayText(rawTitle)
    let body = displayText(rawBody)
    guard !title.isEmpty,
      title.utf8.count <= titleMaximumBytes,
      body.utf8.count <= bodyMaximumBytes
    else { return nil }

    return DirectNotification(
      hostId: hostId,
      kind: kind,
      title: title,
      body: body,
      deepLink: deepLink
    )
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

  /// Control characters, line and paragraph separators, and bidirectional
  /// override characters are removed so display text cannot spoof layout.
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
}

/// Non-secret list of host ids this phone removed or disabled notifications
/// for, stored in the shared status App Group so the keyless notification
/// extension can hide late alerts from a removed computer.
enum ForgottenHostStore {
  private static let suiteInfoKey = "OctantStatusAppGroup"
  private static let hostsKey = "forgottenHostIds"
  private static let maxEntries = 256

  private static func defaults() -> UserDefaults? {
    guard let suite = Bundle.main.object(forInfoDictionaryKey: suiteInfoKey) as? String,
      !suite.isEmpty
    else { return nil }
    return UserDefaults(suiteName: suite)
  }

  static func readForgottenHosts() -> Set<String> {
    guard let list = defaults()?.stringArray(forKey: hostsKey) else { return [] }
    return Set(list)
  }

  @discardableResult
  static func forget(hostId: String) -> Bool {
    guard let store = defaults() else { return true }
    var list = store.stringArray(forKey: hostsKey) ?? []
    if !list.contains(hostId) {
      list.append(hostId)
      if list.count > maxEntries {
        list.removeFirst(list.count - maxEntries)
      }
      store.set(list, forKey: hostsKey)
    }
    return true
  }

  static func allow(hostId: String) {
    guard let store = defaults() else { return }
    var list = store.stringArray(forKey: hostsKey) ?? []
    let before = list.count
    list.removeAll { $0 == hostId }
    if list.count != before {
      store.set(list, forKey: hostsKey)
    }
  }
}
