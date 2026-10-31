// Receives the data-only message the push gateway sends, opens the sealed
// content, and posts the notification itself. Google never draws a
// notification from this message, so what the lock screen shows is whatever
// this receiver decides: the opened text, or, when no held key opens the
// content, the same placeholder the iPhone shows. The notification carries
// no action: tapping it opens the thread's link, and acting on the thread
// happens in the app, behind its own unlock.

package sh.octant.push

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class OctantMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    val opened =
      SealedNotificationOpener.open(data["v"], data["ek"], data["ct"], NotificationKeyVault(this).keys())
    post(this, opened)
  }

  // A new token is noticed the next time the app opens, which compares it with
  // the one it registered; nothing is sent from here.
  override fun onNewToken(token: String) {}

  companion object {
    private const val CHANNEL_ID = "octant-threads"
    private const val PLACEHOLDER_TITLE = "Octant"
    private const val PLACEHOLDER_BODY = "A paired computer has an update"

    fun post(context: Context, opened: OpenedNotification?) {
      val manager = NotificationManagerCompat.from(context)
      if (!manager.areNotificationsEnabled()) return
      manager.createNotificationChannel(
        NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_HIGH)
          .setName("Thread updates")
          .build()
      )
      val builder =
        NotificationCompat.Builder(context, CHANNEL_ID)
          .setSmallIcon(context.applicationInfo.icon)
          .setContentTitle(opened?.title ?: PLACEHOLDER_TITLE)
          .setContentText(opened?.body ?: PLACEHOLDER_BODY)
          .setAutoCancel(true)
      // A thread keeps one notification: the next update replaces it.
      var tag: String? = null
      var id = 0
      if (opened != null) {
        tag = opened.hostId
        id = opened.deepLink.hashCode()
        val open =
          Intent(Intent.ACTION_VIEW, Uri.parse(opened.deepLink))
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
      } catch (error: SecurityException) {
        // Notifications were switched off between the check and the post.
      }
    }
  }
}
