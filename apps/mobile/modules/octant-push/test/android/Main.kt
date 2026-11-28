// Runs DirectNotificationParser from the command line on a desktop JVM so a
// test can verify the exact Kotlin the Android messaging service runs. Takes
// key=value pairs (with forgotten=id1,id2 optional) and writes one JSON line.

package sh.octant.push

import java.io.PrintStream

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
  val data = mutableMapOf<String, String>()
  var forgotten = emptySet<String>()
  for (arg in args) {
    val eq = arg.indexOf('=')
    if (eq <= 0) continue
    val key = arg.substring(0, eq)
    val value = arg.substring(eq + 1)
    if (key == "__forgotten") {
      forgotten = value.split(',').filter { it.isNotEmpty() }.toSet()
    } else {
      data[key] = value
    }
  }
  val parsed = DirectNotificationParser.parse(data, forgotten)
  val out = PrintStream(System.out, true, "UTF-8")
  if (parsed == null) {
    out.println("{\"status\":\"placeholder\"}")
  } else {
    out.println(
      "{\"body\":${quote(parsed.body)},\"deepLink\":${quote(parsed.deepLink)},\"hostId\":${quote(parsed.hostId)},\"kind\":${quote(parsed.kind)},\"status\":\"parsed\",\"title\":${quote(parsed.title)}}"
    )
  }
}
