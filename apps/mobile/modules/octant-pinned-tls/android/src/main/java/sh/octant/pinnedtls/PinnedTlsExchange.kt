// One request to a paired listener held to its certificate pin. It dials
// the address it is given, never a name, checks the connected peer is that
// address, runs a TLS 1.3 handshake whose trust decision is only whether the
// served leaf's SubjectPublicKeyInfo hashes to one of the given pins, and
// writes the request only after that handshake passed. It parses nothing the
// listener sends: the reply's bytes go back to the shared client runtime as
// they arrive, one read at a time, and the runtime frames HTTP, so an event
// stream streams. Nothing here reads the platform's trust store,
// and nothing here turns off a check without the pin in its place.

package sh.octant.pinnedtls

import android.util.Base64
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

sealed class PinnedTlsOpening {
  /** The handshake passed the pin and the request was written. */
  data class Opened(val servedPin: String) : PinnedTlsOpening()

  /** The handshake refused the served key; nothing was written. */
  data class Refused(val servedPin: String?) : PinnedTlsOpening()

  data class Failed(val reason: String) : PinnedTlsOpening()
}

sealed class PinnedTlsRead {
  class Data(val chunk: ByteArray) : PinnedTlsRead()

  /** The listener closed the connection. */
  object End : PinnedTlsRead()

  object Failed : PinnedTlsRead()
}

class PinnedTlsExchange(
  private val address: String,
  private val port: Int,
  private val serverName: String?,
  pins: List<String>,
  private val request: ByteArray,
) {
  private val pins = pins.toSet()
  @Volatile private var servedPin: String? = null
  @Volatile private var accepted = false
  @Volatile private var socket: Socket? = null
  @Volatile private var cancelled = false

  companion object {
    /** A listener has this long to connect and finish the handshake, as on the desktop. */
    const val HANDSHAKE_TIMEOUT_MS = 10_000

    /** The most one read hands back. */
    const val MAX_READ_BYTES = 64 * 1024

    /** `sha256-` and the unpadded base64url SHA-256 of a DER SubjectPublicKeyInfo. */
    fun pinOf(subjectPublicKeyInfo: ByteArray): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(subjectPublicKeyInfo)
      val encoded =
        Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
      return "sha256-$encoded"
    }
  }

  @Volatile private var open: SSLSocket? = null

  /** Connects and writes the request, on the calling thread, which must not be the main thread. */
  fun open(): PinnedTlsOpening {
    // A literal parses without a lookup; a name here would be a caller bug.
    if (!isLiteral(address)) return PinnedTlsOpening.Failed("unreachable")
    val target =
      try {
        InetAddress.getByName(address)
      } catch (error: Exception) {
        return PinnedTlsOpening.Failed("unreachable")
      }
    val raw = Socket()
    socket = raw
    try {
      raw.connect(InetSocketAddress(target, port), HANDSHAKE_TIMEOUT_MS)
    } catch (error: Exception) {
      raw.close()
      return PinnedTlsOpening.Failed(if (cancelled) "connection-failed" else "unreachable")
    }
    if (raw.inetAddress != target) {
      raw.close()
      return PinnedTlsOpening.Failed("unreachable")
    }
    val tls: SSLSocket
    try {
      val context = SSLContext.getInstance("TLSv1.3")
      context.init(null, arrayOf(PinTrustManager()), null)
      tls = context.socketFactory.createSocket(raw, serverName ?: address, port, true) as SSLSocket
      socket = tls
      // TLS 1.2 renegotiation could present a second certificate after the
      // judged one; TLS 1.3 has none, and the listener speaks it.
      tls.enabledProtocols = arrayOf("TLSv1.3")
      val parameters = tls.sslParameters
      parameters.serverNames = serverName?.let { listOf(SNIHostName(it)) } ?: emptyList()
      tls.sslParameters = parameters
      tls.soTimeout = HANDSHAKE_TIMEOUT_MS
      tls.startHandshake()
    } catch (error: Exception) {
      raw.close()
      val pin = servedPin
      return if (pin != null && !accepted) PinnedTlsOpening.Refused(pin)
      else PinnedTlsOpening.Failed("handshake-failed")
    }
    // The trust manager is the only way through the handshake; this is the
    // same decision read again before the first byte.
    val pin = servedPin
    if (!accepted || pin == null) {
      tls.close()
      return PinnedTlsOpening.Refused(pin)
    }
    try {
      tls.soTimeout = 0
      tls.outputStream.write(request)
      tls.outputStream.flush()
    } catch (error: Exception) {
      tls.close()
      return PinnedTlsOpening.Failed("connection-failed")
    }
    open = tls
    return PinnedTlsOpening.Opened(pin)
  }

  /** The next bytes the listener sent, waiting for at least one, on a thread that may block. */
  fun read(): PinnedTlsRead {
    val tls = open ?: return if (cancelled) PinnedTlsRead.End else PinnedTlsRead.Failed
    return try {
      val buffer = ByteArray(MAX_READ_BYTES)
      val read = tls.inputStream.read(buffer)
      if (read < 0) {
        tls.close()
        PinnedTlsRead.End
      } else {
        PinnedTlsRead.Data(buffer.copyOf(read))
      }
    } catch (error: Exception) {
      tls.close()
      if (cancelled) PinnedTlsRead.End else PinnedTlsRead.Failed
    }
  }

  fun cancel() {
    cancelled = true
    try {
      socket?.close()
    } catch (_: Exception) {}
  }

  private fun isLiteral(text: String): Boolean =
    Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$").matches(text) ||
      (text.contains(':') && Regex("^[0-9A-Fa-f:]+$").matches(text))

  /**
   * The pin replaces platform chain, name, and date validation: the served
   * leaf passes only when its key hashes to a given pin, and nothing else is
   * consulted.
   */
  private inner class PinTrustManager : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      val leaf = chain?.firstOrNull() ?: throw CertificateException("No certificate served.")
      val pin = pinOf(leaf.publicKey.encoded)
      servedPin = pin
      if (pin !in pins) throw CertificateException("The served key is not the pinned key.")
      accepted = true
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      throw CertificateException("A listener connection authenticates no client certificate.")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
  }
}
