// The phone's pinned listener transport, as the Expo module the client
// runtime's exchange port calls: open an exchange, then read its reply one
// chunk at a time. Bytes cross as base64 strings. A stream is the same
// pinned TLS over bytes the app carries through the hub's relay: the app
// pushes the listener's ciphertext in and pulls events, ciphertext to send
// among them, one at a time.

package sh.octant.pinnedtls

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

class OctantPinnedTlsModule : Module() {
  private val running = ConcurrentHashMap<String, PinnedTlsExchange>()
  private val streams = ConcurrentHashMap<String, PinnedTlsStream>()

  override fun definition() = ModuleDefinition {
    Name("OctantPinnedTls")

    AsyncFunction("resolve") { hostname: String, promise: Promise ->
      thread(name = "octant-pinned-tls-resolve") {
        val addresses =
          try {
            InetAddress.getAllByName(hostname).mapNotNull { it.hostAddress }.distinct()
          } catch (error: Exception) {
            emptyList()
          }
        promise.resolve(addresses)
      }
    }

    AsyncFunction("open") {
      id: String,
      address: String,
      port: Int,
      serverName: String?,
      pins: List<String>,
      request: String,
      promise: Promise ->
      val bytes =
        try {
          Base64.decode(request, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
          promise.resolve(mapOf("status" to "failed", "reason" to "connection-failed"))
          return@AsyncFunction
        }
      val exchange = PinnedTlsExchange(address, port, serverName, pins, bytes)
      running[id] = exchange
      thread(name = "octant-pinned-tls") {
        when (val opening = exchange.open()) {
          is PinnedTlsOpening.Opened ->
            promise.resolve(mapOf("status" to "opened", "servedPin" to opening.servedPin))
          is PinnedTlsOpening.Refused -> {
            running.remove(id)
            promise.resolve(
              if (opening.servedPin == null) mapOf("status" to "refused")
              else mapOf("status" to "refused", "servedPin" to opening.servedPin)
            )
          }
          is PinnedTlsOpening.Failed -> {
            running.remove(id)
            promise.resolve(mapOf("status" to "failed", "reason" to opening.reason))
          }
        }
      }
    }

    AsyncFunction("read") { id: String, promise: Promise ->
      val exchange = running[id]
      if (exchange == null) {
        promise.resolve(mapOf("status" to "end"))
        return@AsyncFunction
      }
      thread(name = "octant-pinned-tls-read") {
        when (val next = exchange.read()) {
          is PinnedTlsRead.Data ->
            promise.resolve(
              mapOf("status" to "data", "chunk" to Base64.encodeToString(next.chunk, Base64.NO_WRAP))
            )
          is PinnedTlsRead.End -> {
            running.remove(id)
            promise.resolve(mapOf("status" to "end"))
          }
          is PinnedTlsRead.Failed -> {
            running.remove(id)
            promise.resolve(mapOf("status" to "failed"))
          }
        }
      }
    }

    Function("cancel") { id: String -> running.remove(id)?.cancel() }

    Function("streamOpen") { id: String, serverName: String?, pins: List<String>, request: String ->
      val bytes =
        try {
          Base64.decode(request, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
          return@Function
        }
      val stream = PinnedTlsStream(serverName, pins, bytes)
      streams[id] = stream
      stream.begin()
    }

    Function("streamPush") { id: String, chunk: String ->
      val bytes =
        try {
          Base64.decode(chunk, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
          return@Function
        }
      streams[id]?.receive(bytes)
    }

    Function("streamPushEnd") { id: String -> streams[id]?.receiveEnd() }

    AsyncFunction("streamPull") { id: String, promise: Promise ->
      val stream = streams[id]
      if (stream == null) {
        promise.resolve(mapOf("status" to "end"))
        return@AsyncFunction
      }
      thread(name = "octant-pinned-tls-stream") {
        val answer =
          when (val event = stream.next()) {
            is PinnedTlsStreamEvent.Send ->
              mapOf("status" to "send", "chunk" to Base64.encodeToString(event.chunk, Base64.NO_WRAP))
            is PinnedTlsStreamEvent.Opened -> mapOf("status" to "opened", "servedPin" to event.servedPin)
            is PinnedTlsStreamEvent.Data ->
              mapOf("status" to "data", "chunk" to Base64.encodeToString(event.chunk, Base64.NO_WRAP))
            is PinnedTlsStreamEvent.Refused -> {
              streams.remove(id)
              val pin = event.servedPin
              if (pin == null) mapOf("status" to "refused")
              else mapOf("status" to "refused", "servedPin" to pin)
            }
            is PinnedTlsStreamEvent.Failed -> {
              streams.remove(id)
              mapOf("status" to "failed", "reason" to event.reason)
            }
            is PinnedTlsStreamEvent.End -> {
              streams.remove(id)
              mapOf("status" to "end")
            }
          }
        promise.resolve(answer)
      }
    }

    Function("streamCancel") { id: String -> streams.remove(id)?.cancel() }
  }
}
