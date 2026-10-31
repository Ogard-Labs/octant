// Opens each push notification before the system draws it. The delivery path
// sends a placeholder alert and the content sealed to this phone; this
// extension replaces the placeholder with the opened text when a key it holds
// opens the content, and leaves the placeholder untouched otherwise. It sets
// no action and no attachment: a notification is awareness, and acting on a
// thread happens in the app, behind its own unlock.

import UserNotifications

class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var placeholder: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    placeholder = request.content
    guard let sealed = request.content.userInfo["octant"] as? [String: Any],
      let version = sealed["v"] as? Int,
      let encapsulatedKey = sealed["ek"] as? String,
      let ciphertext = sealed["ct"] as? String,
      let opened = SealedNotificationOpener.open(
        version: version, encapsulatedKey: encapsulatedKey, ciphertext: ciphertext,
        entries: NotificationKeyVault().entries()),
      let content = request.content.mutableCopy() as? UNMutableNotificationContent
    else {
      contentHandler(request.content)
      return
    }
    content.title = opened.title
    content.body = opened.body
    // Only the link stays: the sealed bytes are not needed past this point.
    content.userInfo = ["url": opened.deepLink]
    content.threadIdentifier = opened.hostId
    contentHandler(content)
  }

  /// Out of time: show the placeholder rather than nothing.
  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let placeholder { contentHandler(placeholder) }
  }
}
