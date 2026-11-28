// Receives the data-only v2 message a paired computer sends directly through
// FCM, validates its fields and display text, and posts the notification
// itself. Messages from a computer the person removed from this phone are
// dropped. Tapping opens the deep link in the app, behind its own unlock.

package sh.octant.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class OctantMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    // Live-status snapshots are handled separately from alert notifications.
    if (data["type"] == "live-status") return
    val forgotten = OctantForgottenHosts.read(this)
    val hostId = data["hostId"]
    if (hostId != null && forgotten.contains(hostId)) return
    val parsed = DirectNotificationParser.parse(data, forgotten)
    post(this, parsed)
  }

  // A new token is noticed the next time the app opens, which compares it with
  // the one it registered; nothing is sent from here.
  override fun onNewToken(token: String) {}

  companion object {
    private const val CHANNEL_ID = "octant-threads"

    fun post(context: Context, parsed: DirectNotification?) {
      val manager = NotificationManagerCompat.from(context)
      if (!manager.areNotificationsEnabled()) return
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Thread updates", NotificationManager.IMPORTANCE_HIGH)
        )
      }
      val builder =
        NotificationCompat.Builder(context, CHANNEL_ID)
          .setSmallIcon(context.applicationInfo.icon)
          .setContentTitle(parsed?.title ?: DirectNotificationParser.PLACEHOLDER_TITLE)
          .setContentText(parsed?.body ?: DirectNotificationParser.PLACEHOLDER_BODY)
          .setAutoCancel(true)
      // A thread keeps one notification: the next update replaces it.
      var tag: String? = null
      var id = 0
      if (parsed != null) {
        tag = parsed.hostId
        id =
          if (parsed.deepLink.endsWith("/new-devices")) {
            (parsed.deepLink + "\n" + parsed.title + "\n" + parsed.body).hashCode()
          } else {
            parsed.deepLink.hashCode()
          }
        val open =
          Intent(Intent.ACTION_VIEW, Uri.parse(parsed.deepLink))
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        builder.setContentIntent(
          PendingIntent.getActivity(
            context,
            id,
            open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
          )
        )
      }
      try {
        manager.notify(tag, id, builder.build())
      } catch (_: SecurityException) {
        // Notifications were switched off between the check and the post.
      }
    }
  }
}
