// The phone's side of push notifications on iOS, as the Expo module the push
// port calls: the system's permission, the Apple push token, and one X25519
// notification key per paired computer. Opening a notification belongs to the
// notification service extension, which reads the same Keychain items.
//
// Push is reported unsupported on the Simulator, which has no Apple push
// token to give, and on iOS earlier than 17, whose CryptoKit cannot open the
// sealed content: a build that could register a token but never show what it
// receives would only ever show the placeholder.

import ExpoModulesCore
import UIKit
import UserNotifications

public class OctantPushModule: Module {
  private let vault = NotificationKeyVault()

  public func definition() -> ModuleDefinition {
    Name("OctantPush")

    Function("isSupported") { () -> Bool in
      #if targetEnvironment(simulator)
        return false
      #else
        // The build's config plugin writes this key only when the app was
        // made with the push entitlement and the extension; without them a
        // token could be asked for but never delivered to.
        let built = Bundle.main.object(forInfoDictionaryKey: "OctantPushEnabled") as? Bool
        return built == true && SealedNotificationOpener.canOpen
      #endif
    }

    // Answers `granted`, `denied`, or `undetermined`; a provisional or
    // ephemeral authorization delivers notifications, so it counts as granted.
    AsyncFunction("permissionStatus") { () async -> String in
      await Self.authorizationStatus()
    }

    AsyncFunction("requestPermission") { () async -> String in
      _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [
        .alert, .sound, .badge,
      ])
      return await Self.authorizationStatus()
    }

    // The Apple push token as lowercase hex, or nil when the system gave none
    // in ten seconds or the permission is not granted.
    AsyncFunction("devicePushToken") { () async -> String? in
      guard await Self.authorizationStatus() == "granted" else { return nil }
      return await PushTokenReceiver.shared.next(timeout: 10)
    }

    AsyncFunction("notificationPublicKey") { (hostId: String, deviceId: String) -> String? in
      self.vault.publicKey(hostId: hostId, deviceId: deviceId)
    }

    // Removes the notifications delivered for one computer and its key.
    // Delivered notifications carry the host id in their thread identifier,
    // which the extension sets once it has opened the content.
    AsyncFunction("forgetHost") { (hostId: String) async -> Bool in
      let center = UNUserNotificationCenter.current()
      let delivered = await center.deliveredNotifications()
      let identifiers = delivered.filter {
        $0.request.content.threadIdentifier == hostId
      }.map { $0.request.identifier }
      center.removeDeliveredNotifications(withIdentifiers: identifiers)
      return self.vault.forget(hostId: hostId)
    }
  }

  private static func authorizationStatus() async -> String {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    switch settings.authorizationStatus {
    case .authorized, .provisional, .ephemeral: return "granted"
    case .denied: return "denied"
    default: return "undetermined"
    }
  }
}

/// Hands the Apple push token to whoever asked for it. Apple answers a
/// registration through the app delegate, so the answer comes back here rather
/// than to the caller.
final class PushTokenReceiver {
  static let shared = PushTokenReceiver()

  private let lock = NSLock()
  private var waiting: [CheckedContinuation<String?, Never>] = []

  func deliver(_ token: String?) {
    lock.lock()
    let continuations = waiting
    waiting = []
    lock.unlock()
    for continuation in continuations { continuation.resume(returning: token) }
  }

  func next(timeout: TimeInterval) async -> String? {
    await withCheckedContinuation { continuation in
      lock.lock()
      waiting.append(continuation)
      lock.unlock()
      DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
      DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
        self?.deliver(nil)
      }
    }
  }
}

/// Receives Apple's registration answer, and shows a tapped notification's
/// thread by opening the app's own link, which the app's navigation already
/// parses. A notification that arrives while Octant is open is shown as a
/// banner; the extension has already replaced its placeholder by then.
public class OctantPushAppDelegateSubscriber: ExpoAppDelegateSubscriber, UNUserNotificationCenterDelegate {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Set before launch finishes, so a tap that launched the app is delivered.
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  public func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    PushTokenReceiver.shared.deliver(deviceToken.map { String(format: "%02x", $0) }.joined())
  }

  public func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    PushTokenReceiver.shared.deliver(nil)
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list])
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
      let link = response.notification.request.content.userInfo["url"] as? String,
      link.hasPrefix("octant://hosts/"), let url = URL(string: link)
    else { return }
    DispatchQueue.main.async { UIApplication.shared.open(url) }
  }
}
