// How an Android phone protects what Octant shows and keeps, as the Expo
// module the app's device protection ports call: the secure-window flag that
// keeps the window out of screenshots, screen recording, and the recents
// preview, and where the keystore holds the keys behind Octant's secure
// storage.

package sh.octant.deviceprotection

import android.view.WindowManager
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OctantDeviceProtectionModule : Module() {
  // Starts set, so a window shown before the app's JavaScript runs, or after
  // it failed, is protected rather than open. Only the person's choice in
  // Settings clears it, for the rest of that launch.
  @Volatile private var secureWindow = true

  override fun definition() = ModuleDefinition {
    Name("OctantDeviceProtection")

    // A recreated activity has a fresh window without the flag; the choice is
    // applied again whenever the activity returns to the foreground.
    OnActivityEntersForeground { applySecureWindow() }

    AsyncFunction("setSecureWindow") { secure: Boolean ->
      secureWindow = secure
      applySecureWindow()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("keyStorageProtection") { KeyStorageProbe.protection() }
  }

  /** Applies the current choice to the activity's window; runs on the main thread. */
  private fun applySecureWindow(): String {
    val window = appContext.currentActivity?.window ?: return "unavailable"
    if (secureWindow) {
      window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    } else {
      window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }
    return "applied"
  }
}
