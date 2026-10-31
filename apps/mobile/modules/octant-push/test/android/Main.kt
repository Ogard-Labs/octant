// Runs one SealedNotificationOpener from the command line on a desktop JVM, so
// a test can open what the host's sealer produced with the same Kotlin the
// phone's receiver runs. Takes the version, host id, device id, the phone's raw
// private key, the encapsulated key, and the ciphertext as arguments (keys and
// ciphertext in unpadded base64url), then writes one JSON line: the opened
// notification, or `{"status":"placeholder"}`. It is built only by that test;
// the app's module includes only `android/`.

package sh.octant.push

import java.io.PrintStream
import kotlin.system.exitProcess

private fun quote(value: String): String {
  val out = StringBuilder("\"")
  for (character in value) {
    when {
      character == '"' -> out.append("\\\"")
      character == '\\' -> out.append("\\\\")
      character.code < 0x20 -> out.append(String.format("\\u%04x", character.code))
      else -> out.append(character)
    }
  }
  return out.append('"').toString()
}

fun main(args: Array<String>) {
  if (args.size != 6) {
    System.err.println("usage: version hostId deviceId privateKey encapsulatedKey ciphertext")
    exitProcess(2)
  }
  val privateKey = Base64Url.decode(args[3])
  if (privateKey == null) {
    System.err.println("unreadable private key")
    exitProcess(2)
  }
  val opened =
    SealedNotificationOpener.open(args[0], args[4], args[5], listOf(NotificationKey(args[1], args[2], privateKey)))
  val out = PrintStream(System.out, true, "UTF-8")
  if (opened == null) {
    out.println("{\"status\":\"placeholder\"}")
  } else {
    out.println(
      "{\"body\":${quote(opened.body)},\"deepLink\":${quote(opened.deepLink)},\"status\":\"opened\",\"title\":${quote(opened.title)}}"
    )
  }
}
