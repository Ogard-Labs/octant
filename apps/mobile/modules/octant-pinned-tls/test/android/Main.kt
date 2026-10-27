// Runs one PinnedTlsExchange from the command line on a desktop JVM, so a
// test can drive the phone's Android exchange against a real listener. Takes
// the address, port, server name (empty for none), comma-separated pins, and
// the base64 request as arguments, then writes one JSON line for the opening
// and one per read until the reply ends, as the iOS harness does. It is built
// only by that test; the app's module includes only `android/`.

package sh.octant.pinnedtls

import kotlin.system.exitProcess

private fun emit(vararg fields: Pair<String, String>) {
  // Every value is a status word, a reason slug, a pin, or base64, so none
  // needs escaping.
  println(fields.joinToString(",", "{", "}") { (key, value) -> "\"$key\":\"$value\"" })
  System.out.flush()
}

fun main(args: Array<String>) {
  if (args.size != 5) {
    System.err.println("usage: address port serverName pins request")
    exitProcess(2)
  }
  val exchange =
    PinnedTlsExchange(
      args[0],
      args[1].toInt(),
      args[2].ifEmpty { null },
      args[3].split(',').filter { it.isNotEmpty() },
      java.util.Base64.getDecoder().decode(args[4]),
    )
  when (val opening = exchange.open()) {
    is PinnedTlsOpening.Opened -> emit("status" to "opened", "servedPin" to opening.servedPin)
    is PinnedTlsOpening.Refused -> {
      val pin = opening.servedPin
      if (pin == null) emit("status" to "refused") else emit("status" to "refused", "servedPin" to pin)
      exitProcess(0)
    }
    is PinnedTlsOpening.Failed -> {
      emit("status" to "failed", "reason" to opening.reason)
      exitProcess(0)
    }
  }
  while (true) {
    when (val next = exchange.read()) {
      is PinnedTlsRead.Data ->
        emit("status" to "data", "chunk" to java.util.Base64.getEncoder().encodeToString(next.chunk))
      is PinnedTlsRead.End -> {
        emit("status" to "end")
        exitProcess(0)
      }
      is PinnedTlsRead.Failed -> {
        emit("status" to "failed")
        exitProcess(0)
      }
    }
  }
}
