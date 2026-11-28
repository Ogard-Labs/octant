// Keyless notification service extension. Holds no Keychain item, no
// cryptography, and makes no network calls. It checks the v2 `octant` metadata
// against this phone's rules, builds the deep link, sets `threadIdentifier`,
// and replaces alert text with a generic placeholder for malformed payloads or
// computers the person removed from this phone.

import UserNotifications

class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let placeholder = Self.placeholderContent(from: request.content)
    self.fallback = placeholder

    guard let octant = request.content.userInfo["octant"] as? [String: Any],
      let parsed = DirectNotificationParser.parse(
        octant: octant,
        title: request.content.title,
        body: request.content.body,
        forgottenHosts: ForgottenHostStore.readForgottenHosts()
      ),
      let content = request.content.mutableCopy() as? UNMutableNotificationContent
    else {
      contentHandler(placeholder)
      return
    }
    content.title = parsed.title
    content.body = parsed.body
    content.userInfo = ["url": parsed.deepLink]
    content.threadIdentifier = parsed.hostId
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let fallback { contentHandler(fallback) }
  }

  private static func placeholderContent(
    from original: UNNotificationContent
  ) -> UNNotificationContent {
    guard let mutable = original.mutableCopy() as? UNMutableNotificationContent else {
      return original
    }
    mutable.title = DirectNotificationParser.placeholderTitle
    mutable.body = DirectNotificationParser.placeholderBody
    mutable.threadIdentifier = ""
    mutable.userInfo = [:]
    return mutable
  }
}
