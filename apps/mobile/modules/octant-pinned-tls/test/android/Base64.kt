// The one Android class the exchange uses, over the JVM's own Base64, so the
// phone's Android exchange source runs on a desktop JVM in a test. Only the
// flags the exchange passes are honoured. It is built only by that test; the
// app's module includes only `android/`.

package android.util

object Base64 {
  const val DEFAULT = 0
  const val NO_PADDING = 1
  const val NO_WRAP = 2
  const val URL_SAFE = 8

  @JvmStatic
  fun encodeToString(input: ByteArray, flags: Int): String {
    var encoder =
      if (flags and URL_SAFE != 0) java.util.Base64.getUrlEncoder()
      else java.util.Base64.getEncoder()
    if (flags and NO_PADDING != 0) encoder = encoder.withoutPadding()
    return encoder.encodeToString(input)
  }

  @JvmStatic
  fun decode(input: String, flags: Int): ByteArray =
    if (flags and URL_SAFE != 0) java.util.Base64.getUrlDecoder().decode(input)
    else java.util.Base64.getMimeDecoder().decode(input)
}
