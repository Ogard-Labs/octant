// Parses direct v2 push notifications from a paired computer and shapes what
// Android displays and opens. Pure Kotlin with no Android dependencies so a
// desktop JVM test runs the exact same rules the messaging service runs.

package sh.octant.push

data class DirectNotification(
  val hostId: String,
  val kind: String,
  val title: String,
  val body: String,
  val deepLink: String,
)

object DirectNotificationParser {
  const val PLACEHOLDER_TITLE = "Octant"
  const val PLACEHOLDER_BODY = "A paired computer has an update"
  const val TITLE_MAXIMUM_BYTES = 80
  const val BODY_MAXIMUM_BYTES = 120

  private val threadKinds = setOf("completion", "waiting", "failure", "approval-needed")
  private val modes = setOf("chat", "work", "code")

  fun parse(
    data: Map<String, String>,
    forgottenHosts: Set<String> = emptySet(),
  ): DirectNotification? {
    if (data["v"] != "2") return null
    val kind = data["kind"] ?: return null
    val hostId = data["hostId"] ?: return null
    if (!isLinkSegment(hostId) || forgottenHosts.contains(hostId)) return null

    val threadId = data["threadId"]?.takeIf { it.isNotEmpty() }
    val mode = data["mode"]?.takeIf { it.isNotEmpty() }

    val deepLink =
      when (kind) {
        "move-waiting" -> {
          if (threadId != null || mode != null) return null
          "octant://hosts/$hostId/moves"
        }
        "device-joined" -> {
          if (threadId != null || mode != null) return null
          "octant://hosts/$hostId/new-devices"
        }
        in threadKinds -> {
          if (threadId != null) {
            if (!isLinkSegment(threadId)) return null
            if (mode != null && mode !in modes) return null
            val path = if (mode != null) "$mode/$threadId" else threadId
            "octant://hosts/$hostId/threads/$path"
          } else {
            if (mode != null) return null
            "octant://hosts/$hostId"
          }
        }
        else -> return null
      }

    val rawTitle = data["title"] ?: return null
    val rawBody = data["body"] ?: ""
    val title = displayText(rawTitle)
    val body = displayText(rawBody)
    if (title.isEmpty()) return null
    if (title.toByteArray(Charsets.UTF_8).size > TITLE_MAXIMUM_BYTES) return null
    if (body.toByteArray(Charsets.UTF_8).size > BODY_MAXIMUM_BYTES) return null

    return DirectNotification(
      hostId = hostId,
      kind = kind,
      title = title,
      body = body,
      deepLink = deepLink,
    )
  }

  private fun isLinkSegment(value: String): Boolean {
    if (value.isEmpty() || value.toByteArray(Charsets.UTF_8).size > 64) return false
    return value.all { ch ->
      ch in '0'..'9' || ch in 'A'..'Z' || ch in 'a'..'z' ||
        ch == '-' || ch == '_' || ch == '.' || ch == '~'
    }
  }

  fun displayText(value: String): String {
    val out = StringBuilder(value.length)
    var index = 0
    while (index < value.length) {
      val codePoint = value.codePointAt(index)
      val charCount = Character.charCount(codePoint)
      val type = Character.getType(codePoint)
      val drop =
        type == Character.CONTROL.toInt() ||
          type == Character.LINE_SEPARATOR.toInt() ||
          type == Character.PARAGRAPH_SEPARATOR.toInt() ||
          codePoint == 0x061C ||
          codePoint == 0x200E ||
          codePoint == 0x200F ||
          codePoint in 0x202A..0x202E ||
          codePoint in 0x2066..0x2069
      if (!drop) out.appendCodePoint(codePoint)
      index += charCount
    }
    return out.toString().trim()
  }
}
