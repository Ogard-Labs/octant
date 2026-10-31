// The phone's notification keys, one X25519 key pair per paired computer,
// kept in the Keychain where both the app and its notification service
// extension can read them. The extension runs in its own process, often while
// the phone is locked, so the items are readable after the first unlock and
// never restored onto another device. They sit in a Keychain access group the
// build writes into both targets' Info.plist (`OctantKeychainAccessGroup`),
// so the group carries the team prefix without the source naming a team.

import CryptoKit
import Foundation
import Security

final class NotificationKeyVault {
  private static let service = "sh.octant.push-keys"
  private static let accessGroupKey = "OctantKeychainAccessGroup"

  private let accessGroup: String?

  /// The group this build's Info.plist names; none in a build that does not
  /// declare one (a unit test), which uses the process's default group.
  init(bundle: Bundle = .main) {
    accessGroup = bundle.object(forInfoDictionaryKey: NotificationKeyVault.accessGroupKey) as? String
  }

  private struct Stored: Codable {
    let deviceId: String
    /// The raw private key, unpadded base64url.
    let key: String
  }

  private func query(hostId: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: NotificationKeyVault.service,
    ]
    if let hostId { query[kSecAttrAccount as String] = hostId }
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }

  /// The public half of the key for one computer and this device id, made on
  /// first use. A key made for another device id is replaced, since sealed
  /// content binds the device id and the old key could never open it.
  func publicKey(hostId: String, deviceId: String) -> String? {
    if let existing = entry(hostId: hostId), existing.deviceId == deviceId {
      return SealedNotificationOpener.base64URLEncode(existing.privateKey.publicKey.rawRepresentation)
    }
    let key = Curve25519.KeyAgreement.PrivateKey()
    let stored = Stored(
      deviceId: deviceId,
      key: SealedNotificationOpener.base64URLEncode(key.rawRepresentation))
    guard let data = try? JSONEncoder().encode(stored) else { return nil }
    forget(hostId: hostId)
    var item = query(hostId: hostId)
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { return nil }
    return SealedNotificationOpener.base64URLEncode(key.publicKey.rawRepresentation)
  }

  func entry(hostId: String) -> NotificationKeyEntry? {
    var lookup = query(hostId: hostId)
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    else { return nil }
    return decode(hostId: hostId, data: data)
  }

  /// Every held key, for the extension, which does not know the host.
  func entries() -> [NotificationKeyEntry] {
    var lookup = query(hostId: nil)
    lookup[kSecReturnAttributes as String] = true
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess,
      let rows = result as? [[String: Any]]
    else { return [] }
    return rows.compactMap { row in
      guard let hostId = row[kSecAttrAccount as String] as? String,
        let data = row[kSecValueData as String] as? Data
      else { return nil }
      return decode(hostId: hostId, data: data)
    }
  }

  private func decode(hostId: String, data: Data) -> NotificationKeyEntry? {
    guard let stored = try? JSONDecoder().decode(Stored.self, from: data),
      let raw = SealedNotificationOpener.base64URLDecode(stored.key),
      let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
    else { return nil }
    return NotificationKeyEntry(hostId: hostId, deviceId: stored.deviceId, privateKey: key)
  }

  @discardableResult
  func forget(hostId: String) -> Bool {
    let status = SecItemDelete(query(hostId: hostId) as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}
