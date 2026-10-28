// How an iPhone protects what Octant shows and keeps, as the Expo module the
// app's device protection ports call. iOS has no secure-window flag and no
// public way to keep a screenshot from showing an app, so the protection is
// a cover over the app in the app switcher's snapshot and while the screen is
// recorded or mirrored; Settings says that a screenshot is not blocked rather
// than claiming it. The module also reports whether the Keychain that holds
// Octant's keys is protected by a Secure Enclave.

import CryptoKit
import ExpoModulesCore
import UIKit

public class OctantDeviceProtectionModule: Module {
  private let cover = PrivacyCover()

  public func definition() -> ModuleDefinition {
    Name("OctantDeviceProtection")

    // Starts on, so a snapshot taken before the app's JavaScript runs, or
    // after it failed, shows the cover rather than the app. Only the person's
    // choice in Settings turns it off, for the rest of that launch.
    OnCreate {
      DispatchQueue.main.async { self.cover.start() }
    }

    AsyncFunction("setSecureWindow") { (secure: Bool) -> String in
      self.cover.setEnabled(secure)
      return "applied"
    }.runOnQueue(.main)

    // The Keychain encrypts each item under keys the Secure Enclave protects
    // where the device has one; the Simulator has none. The app writes its
    // items readable only while unlocked and never restored onto another
    // device (`src/hosts/expoSecureStorage.ts`).
    AsyncFunction("keyStorageProtection") { () -> String in
      SecureEnclave.isAvailable ? "secure-hardware" : "software"
    }
  }
}

/// Covers each of the app's window scenes with an opaque window while the
/// scene is not active, which is when iOS takes the app switcher's snapshot,
/// or while its screen is recorded, mirrored, or otherwise captured. Every
/// call runs on the main thread: UIKit posts these notifications there and
/// the module calls in on the main queue.
final class PrivacyCover {
  private struct Cover {
    let window: UIWindow
    let message: UILabel
  }

  private var enabled = true
  private var started = false
  /// Scenes that resigned active and have not become active again.
  private var inactive = Set<ObjectIdentifier>()
  private var covers: [ObjectIdentifier: Cover] = [:]
  private var observers: [NSObjectProtocol] = []

  func start() {
    if started { return }
    started = true
    observe(UIScene.willDeactivateNotification) { cover, note in
      if let scene = note.object as? UIScene { cover.inactive.insert(ObjectIdentifier(scene)) }
    }
    observe(UIScene.didActivateNotification) { cover, note in
      if let scene = note.object as? UIScene { cover.inactive.remove(ObjectIdentifier(scene)) }
    }
    observe(UIScene.didDisconnectNotification) { cover, note in
      if let scene = note.object as? UIScene { cover.inactive.remove(ObjectIdentifier(scene)) }
    }
    // The app-level pair also covers a launch whose scenes post nothing.
    observe(UIApplication.willResignActiveNotification) { cover, _ in
      for scene in cover.windowScenes() { cover.inactive.insert(ObjectIdentifier(scene)) }
    }
    observe(UIApplication.didBecomeActiveNotification) { cover, _ in
      for scene in cover.windowScenes() where scene.activationState == .foregroundActive {
        cover.inactive.remove(ObjectIdentifier(scene))
      }
    }
    observe(UIScreen.capturedDidChangeNotification) { _, _ in }
    for scene in windowScenes() where scene.activationState != .foregroundActive {
      inactive.insert(ObjectIdentifier(scene))
    }
    update()
  }

  func setEnabled(_ secure: Bool) {
    start()
    enabled = secure
    update()
  }

  /// Observes on the posting thread (`queue: nil`), so the cover is in place
  /// before the notification returns and iOS takes its snapshot.
  private func observe(
    _ name: Notification.Name, _ record: @escaping (PrivacyCover, Notification) -> Void
  ) {
    observers.append(
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) {
        [weak self] note in
        guard let self else { return }
        record(self, note)
        self.update()
      })
  }

  private func windowScenes() -> [UIWindowScene] {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
  }

  private func update() {
    let scenes = windowScenes()
    let connected = Set(scenes.map { ObjectIdentifier($0) })
    for (id, cover) in covers where !connected.contains(id) {
      cover.window.isHidden = true
      covers[id] = nil
    }
    for scene in scenes {
      let id = ObjectIdentifier(scene)
      // `isCaptured` covers recording, AirPlay mirroring, and a wired capture.
      let captured = scene.screen.isCaptured
      if enabled && (captured || inactive.contains(id)) {
        let cover = covers[id] ?? makeCover(on: scene)
        covers[id] = cover
        cover.message.isHidden = !captured
        cover.window.isHidden = false
      } else if let cover = covers.removeValue(forKey: id) {
        cover.window.isHidden = true
      }
    }
  }

  /// An opaque window above the app's own. While the screen is captured it
  /// says why Octant is hidden and how to show it; in the app switcher it is
  /// blank.
  private func makeCover(on scene: UIWindowScene) -> Cover {
    let window = UIWindow(windowScene: scene)
    window.windowLevel = .alert + 1
    let controller = UIViewController()
    controller.view.backgroundColor = .systemBackground
    let message = UILabel()
    message.text =
      "Octant is hidden while this screen is recorded or shared. To show it, stop the recording, or first choose standard capture in Computers › Privacy & security."
    message.numberOfLines = 0
    message.textAlignment = .center
    message.textColor = .secondaryLabel
    message.font = .preferredFont(forTextStyle: .body)
    message.adjustsFontForContentSizeCategory = true
    message.translatesAutoresizingMaskIntoConstraints = false
    controller.view.addSubview(message)
    NSLayoutConstraint.activate([
      message.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor),
      message.leadingAnchor.constraint(equalTo: controller.view.layoutMarginsGuide.leadingAnchor),
      message.trailingAnchor.constraint(
        equalTo: controller.view.layoutMarginsGuide.trailingAnchor),
    ])
    window.rootViewController = controller
    return Cover(window: window, message: message)
  }
}
