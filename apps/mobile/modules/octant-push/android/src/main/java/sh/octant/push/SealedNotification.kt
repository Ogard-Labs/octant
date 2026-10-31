// Opening what a paired computer sealed for this phone, and shaping what the
// phone shows from it, as the Android receiver does it. The rules match the
// iPhone's notification service extension rule for rule: the same size check,
// the same content checks, the same removal of control and reordering
// characters, and the same deep link. It uses no Android class, so a desktop
// JVM runs it in the host-sealing test.

package sh.octant.push

class NotificationKey(val hostId: String, val deviceId: String, val privateKey: ByteArray)

/** What replaces the placeholder: display text and the thread to open. */
data class OpenedNotification(
  val hostId: String,
  val title: String,
  val body: String,
  val deepLink: String,
)

object SealedNotificationOpener {
  /** The host pads every seal to this size; any other length was not sealed to the rules. */
  private const val PLAINTEXT_BYTES = 2_048
  private const val TAG_BYTES = 16
  private const val TITLE_MAXIMUM_BYTES = 80
  private const val BODY_MAXIMUM_BYTES = 120

  private val kinds = setOf("completion", "waiting", "failure", "approval-needed")
  private val modes = setOf("chat", "work", "code")

  fun info(hostId: String, deviceId: String): ByteArray =
    "octant-push-v1\n$hostId\n$deviceId".toByteArray(Charsets.UTF_8)

  /** Opens one notification with whichever held key verifies it. */
  fun open(
    version: String?,
    encapsulatedKey: String?,
    ciphertext: String?,
    keys: List<NotificationKey>,
  ): OpenedNotification? {
    if (version != "1" || encapsulatedKey == null || ciphertext == null) return null
    val enc = Base64Url.decode(encapsulatedKey) ?: return null
    val sealed = Base64Url.decode(ciphertext) ?: return null
    if (enc.size != X25519.KEY_BYTES || sealed.size != PLAINTEXT_BYTES + TAG_BYTES) return null
    for (key in keys) {
      val plaintext =
        Hpke.open(key.privateKey, enc, info(key.hostId, key.deviceId), ByteArray(0), sealed)
          ?: continue
      return shape(plaintext, key)
    }
    return null
  }

  /**
   * The phone's own check of what the host sealed. The host redacts first;
   * this keeps a host that does not, or content meant for another computer,
   * from reaching the lock screen or the deep link.
   */
  fun shape(plaintext: ByteArray, key: NotificationKey): OpenedNotification? {
    val content = FlatJson.parseStringObject(String(plaintext, Charsets.UTF_8)) ?: return null
    val kind = content["kind"] ?: return null
    val hostId = content["hostId"] ?: return null
    val threadId = content["threadId"] ?: return null
    val mode = content["mode"]
    if (kind !in kinds || hostId != key.hostId) return null
    if (!isLinkSegment(hostId) || !isLinkSegment(threadId)) return null
    if (mode != null && mode !in modes) return null
    val title = displayText(content["title"] ?: return null)
    val body = displayText(content["body"] ?: return null)
    if (title.isEmpty()) return null
    if (title.toByteArray(Charsets.UTF_8).size > TITLE_MAXIMUM_BYTES) return null
    if (body.toByteArray(Charsets.UTF_8).size > BODY_MAXIMUM_BYTES) return null
    val path = if (mode == null) threadId else "$mode/$threadId"
    return OpenedNotification(hostId, title, body, "octant://hosts/$hostId/threads/$path")
  }

  /** A host or thread id goes into a link, so it holds only characters a path segment needs. */
  private fun isLinkSegment(value: String): Boolean =
    value.isNotEmpty() &&
      value.toByteArray(Charsets.UTF_8).size <= 64 &&
      value.all {
        it in '0'..'9' || it in 'A'..'Z' || it in 'a'..'z' || it == '-' || it == '_' ||
          it == '.' || it == '~'
      }

  /**
   * Control characters, line and paragraph separators, and the characters that
   * reorder or hide text are removed, so display text cannot disguise itself
   * or break the notification's layout.
   */
  fun displayText(value: String): String {
    val kept = StringBuilder()
    var index = 0
    while (index < value.length) {
      val codePoint = value.codePointAt(index)
      index += Character.charCount(codePoint)
      val type = Character.getType(codePoint)
      if (
        type == Character.CONTROL.toInt() ||
          type == Character.LINE_SEPARATOR.toInt() ||
          type == Character.PARAGRAPH_SEPARATOR.toInt()
      ) {
        continue
      }
      if (
        codePoint == 0x061C ||
          codePoint == 0x200E ||
          codePoint == 0x200F ||
          codePoint in 0x202A..0x202E ||
          codePoint in 0x2066..0x2069
      ) {
        continue
      }
      kept.appendCodePoint(codePoint)
    }
    return kept.toString().trim { it == ' ' || Character.getType(it) == Character.SPACE_SEPARATOR.toInt() }
  }
}

object Base64Url {
  private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

  /** Unpadded base64url; null for any other character or an impossible length. */
  fun decode(text: String): ByteArray? {
    if (text.length % 4 == 1) return null
    val out = java.io.ByteArrayOutputStream()
    var buffer = 0
    var bits = 0
    for (character in text) {
      val value = ALPHABET.indexOf(character)
      if (value < 0) return null
      buffer = (buffer shl 6) or value
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out.write((buffer shr bits) and 0xFF)
      }
    }
    return out.toByteArray()
  }

  fun encode(bytes: ByteArray): String {
    val out = StringBuilder()
    var buffer = 0
    var bits = 0
    for (byte in bytes) {
      buffer = (buffer shl 8) or (byte.toInt() and 0xFF)
      bits += 8
      while (bits >= 6) {
        bits -= 6
        out.append(ALPHABET[(buffer shr bits) and 0x3F])
      }
    }
    if (bits > 0) out.append(ALPHABET[(buffer shl (6 - bits)) and 0x3F])
    return out.toString()
  }
}

/**
 * The sealed content is one flat JSON object of strings. This reads that and
 * nothing else, so no JSON library is needed on a desktop JVM and a value that
 * is not a string, or any nesting, is refused rather than guessed at.
 */
object FlatJson {
  fun parseStringObject(text: String): Map<String, String>? {
    var position = 0

    fun skipSpace() {
      while (position < text.length && text[position] in " \t\r\n") position += 1
    }

    fun readString(): String? {
      if (position >= text.length || text[position] != '"') return null
      position += 1
      val out = StringBuilder()
      while (position < text.length) {
        val character = text[position]
        position += 1
        when {
          character == '"' -> return out.toString()
          character == '\\' -> {
            if (position >= text.length) return null
            val escape = text[position]
            position += 1
            when (escape) {
              '"', '\\', '/' -> out.append(escape)
              'b' -> out.append('\b')
              'f' -> out.append('\u000C')
              'n' -> out.append('\n')
              'r' -> out.append('\r')
              't' -> out.append('\t')
              'u' -> {
                if (position + 4 > text.length) return null
                val code = text.substring(position, position + 4).toIntOrNull(16) ?: return null
                out.append(code.toChar())
                position += 4
              }
              else -> return null
            }
          }
          character.code < 0x20 -> return null
          else -> out.append(character)
        }
      }
      return null
    }

    skipSpace()
    if (position >= text.length || text[position] != '{') return null
    position += 1
    val result = LinkedHashMap<String, String>()
    skipSpace()
    if (position < text.length && text[position] == '}') {
      position += 1
    } else {
      while (true) {
        skipSpace()
        val name = readString() ?: return null
        skipSpace()
        if (position >= text.length || text[position] != ':') return null
        position += 1
        skipSpace()
        val value = readString() ?: return null
        if (result.put(name, value) != null) return null
        skipSpace()
        if (position >= text.length) return null
        val next = text[position]
        position += 1
        if (next == '}') break
        if (next != ',') return null
      }
    }
    skipSpace()
    return if (position == text.length) result else null
  }
}
