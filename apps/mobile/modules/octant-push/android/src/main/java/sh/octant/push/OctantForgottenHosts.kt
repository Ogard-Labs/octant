// Non-secret list of host ids this phone removed or disabled notifications for,
// stored in app-private SharedPreferences so the messaging service drops late
// messages from a removed computer.

package sh.octant.push

import android.content.Context

object OctantForgottenHosts {
  private const val PREFS_NAME = "octant_push_forgotten_hosts"
  private const val HOSTS_KEY = "hosts"

  fun read(context: Context): Set<String> {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    return prefs.getStringSet(HOSTS_KEY, emptySet())?.toSet() ?: emptySet()
  }

  fun forget(context: Context, hostId: String): Boolean {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val next = HashSet(prefs.getStringSet(HOSTS_KEY, emptySet()) ?: emptySet())
    next.add(hostId)
    return prefs.edit().putStringSet(HOSTS_KEY, next).commit()
  }

  fun allow(context: Context, hostId: String) {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val current = prefs.getStringSet(HOSTS_KEY, emptySet()) ?: emptySet()
    if (!current.contains(hostId)) return
    val next = HashSet(current)
    next.remove(hostId)
    prefs.edit().putStringSet(HOSTS_KEY, next).apply()
  }
}
