// The phone's pinned listener transport, as the Expo module the client
// runtime's exchange port calls. Bytes cross as base64 strings.

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

    AsyncFunction("exchange") {
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
        val outcome = exchange.run()
        running.remove(id)
        promise.resolve(
          when (outcome) {
            is PinnedTlsOutcome.Responded ->
              mapOf(
                "status" to "responded",
                "servedPin" to outcome.servedPin,
                "response" to Base64.encodeToString(outcome.response, Base64.NO_WRAP),
              )
            is PinnedTlsOutcome.Refused ->
              if (outcome.servedPin == null) mapOf("status" to "refused")
              else mapOf("status" to "refused", "servedPin" to outcome.servedPin)
            is PinnedTlsOutcome.Failed -> mapOf("status" to "failed", "reason" to outcome.reason)
          }
        )
      }
    }

    Function("cancel") { id: String -> running[id]?.cancel() }
  }
}
