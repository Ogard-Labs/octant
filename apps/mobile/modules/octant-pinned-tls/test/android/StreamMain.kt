// Runs one PinnedTlsStream from the command line on a desktop JVM, so a test
// can carry the phone's Android stream through a real relay to a real
// listener. The first line on stdin is `{"pins":"<comma-separated>",
// "request":"<base64>"}`; each later line is `{"push":"<base64>"}` with
// ciphertext from the listener, or `{"end":true}`. Each event goes out as one
// JSON line, as the iOS stream harness writes them. It is built only by that
// test; the app's module includes only `android/`.

package sh.octant.pinnedtls

import kotlin.concurrent.thread
import kotlin.system.exitProcess

private fun field(line: String, name: String): String? =
  Regex("\"$name\"\\s*:\\s*\"([^\"]*)\"").find(line)?.groupValues?.get(1)

private fun emit(vararg fields: Pair<String, String>) {
  synchronized(System.out) {
    // Every value is a status word, a reason slug, a pin, or base64.
    println(fields.joinToString(",", "{", "}") { (key, value) -> "\"$key\":\"$value\"" })
    System.out.flush()
  }
}

fun main() {
  val first = readLine() ?: exitProcess(2)
  val pins = (field(first, "pins") ?: "").split(',').filter { it.isNotEmpty() }
  val request = java.util.Base64.getDecoder().decode(field(first, "request") ?: "")
  val stream = PinnedTlsStream(null, pins, request)
  stream.begin()
  thread(isDaemon = true) {
    while (true) {
      val line = readLine() ?: break
      field(line, "push")?.let { stream.receive(java.util.Base64.getDecoder().decode(it)) }
      if (line.contains("\"end\":true")) stream.receiveEnd()
    }
    stream.receiveEnd()
  }
  val encoder = java.util.Base64.getEncoder()
  while (true) {
    when (val event = stream.next()) {
      is PinnedTlsStreamEvent.Send -> emit("status" to "send", "chunk" to encoder.encodeToString(event.chunk))
      is PinnedTlsStreamEvent.Opened -> emit("status" to "opened", "servedPin" to event.servedPin)
      is PinnedTlsStreamEvent.Data -> emit("status" to "data", "chunk" to encoder.encodeToString(event.chunk))
      is PinnedTlsStreamEvent.Refused -> {
        val pin = event.servedPin
        if (pin == null) emit("status" to "refused") else emit("status" to "refused", "servedPin" to pin)
        exitProcess(0)
      }
      is PinnedTlsStreamEvent.Failed -> {
        emit("status" to "failed", "reason" to event.reason)
        exitProcess(0)
      }
      is PinnedTlsStreamEvent.End -> {
        emit("status" to "end")
        exitProcess(0)
      }
    }
  }
}
