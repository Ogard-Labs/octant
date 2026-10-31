// The phone's side of push notifications on Android, as the Expo module the
// push port calls: whether this build can receive push at all, the
// notification setting, the Firebase token, and one X25519 notification key
// per paired computer. Opening a notification belongs to the messaging
// service, which reads the same key store.
//
// Push is reported unsupported when the build carries no Firebase project
// (`google-services.json`), which is how a build made without the maintainer's
// push account behaves: it offers no notifications rather than failing later.

package sh.octant.push

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OctantPushModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "The React context is gone." }

  override fun definition() = ModuleDefinition {
    Name("OctantPush")

    Function("isSupported") { FirebaseApp.getApps(context).isNotEmpty() }

    // Answers `granted` or `denied`. Android 13 and later also ask at run time,
    // which the app does through its own permission request before this.
    AsyncFunction("permissionStatus") {
      if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"
    }

    AsyncFunction("requestPermission") {
      if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"
    }

    // The Firebase token, or null when Firebase gave none.
    AsyncFunction("devicePushToken") { promise: Promise ->
      if (FirebaseApp.getApps(context).isEmpty()) {
        promise.resolve(null)
        return@AsyncFunction
      }
      FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
        promise.resolve(if (task.isSuccessful) task.result else null)
      }
    }

    AsyncFunction("notificationPublicKey") { hostId: String, deviceId: String ->
      NotificationKeyVault(context).publicKey(hostId, deviceId)
    }

    // Removes the notifications posted for one computer and its key.
    AsyncFunction("forgetHost") { hostId: String ->
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      for (active in manager.activeNotifications) {
        if (active.tag == hostId) manager.cancel(active.tag, active.id)
      }
      NotificationKeyVault(context).forget(hostId)
    }
  }
}
