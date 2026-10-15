// The phone's pinned listener transport, as the Expo module the client
// runtime's exchange port calls: open an exchange, then read its reply one
// chunk at a time. Bytes cross as base64 strings.

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
  }
}
