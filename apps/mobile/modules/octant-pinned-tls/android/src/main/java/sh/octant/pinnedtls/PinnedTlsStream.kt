// One request to a paired listener over bytes the app carries itself: the
// hub's device relay, whose WebSocket the shared client runtime holds. The
// TLS is the same as the direct exchange's: TLS 1.3 only, and a handshake
// whose one trust decision is whether the served leaf's SubjectPublicKeyInfo
// hashes to a given pin. Only the transport differs: an SSLEngine wraps and
// unwraps here, and every ciphertext byte goes out to the app as a `Send`
// event and comes back through `receive`, so the hub carries only
// ciphertext. The request is wrapped only after the handshake passed the
// pin, and the reply's bytes go back unparsed, as on the direct path.

package sh.octant.pinnedtls

import java.nio.ByteBuffer
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLEngineResult
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager

sealed class PinnedTlsStreamEvent {
  /** Ciphertext for the app to carry to the listener. */
  class Send(val chunk: ByteArray) : PinnedTlsStreamEvent()

  /** The handshake passed the pin and the request was wrapped. */
  data class Opened(val servedPin: String) : PinnedTlsStreamEvent()

  /** The handshake refused the served key; no request byte was wrapped. */
  data class Refused(val servedPin: String?) : PinnedTlsStreamEvent()

  data class Failed(val reason: String) : PinnedTlsStreamEvent()

  /** Reply bytes from the listener. */
  class Data(val chunk: ByteArray) : PinnedTlsStreamEvent()

  /** The listener closed the connection. */
  object End : PinnedTlsStreamEvent()
}

class PinnedTlsStream(serverName: String?, pins: List<String>, private val request: ByteArray) {
  private val pins = pins.toSet()
  private val events = LinkedBlockingQueue<PinnedTlsStreamEvent>()
  private val lock = Any()
  private val engine: SSLEngine
  @Volatile private var servedPin: String? = null
  @Volatile private var accepted = false
  private var inbound: ByteBuffer
  private var opened = false
  private var settled = false
  private var finished = false

  init {
    val context = SSLContext.getInstance("TLSv1.3")
    context.init(null, arrayOf(PinTrustManager()), null)
    engine = context.createSSLEngine()
    engine.useClientMode = true
    // TLS 1.2 renegotiation could present a second certificate after the
    // judged one; TLS 1.3 has none, and the listener speaks it.
    engine.enabledProtocols = arrayOf("TLSv1.3")
    val parameters = engine.sslParameters
    parameters.serverNames = serverName?.let { listOf(SNIHostName(it)) } ?: emptyList()
    engine.sslParameters = parameters
    inbound = ByteBuffer.allocate(engine.session.packetBufferSize).also { it.flip() }
  }

  companion object {
    /** A listener has this long to finish the handshake through the relay, as on the desktop. */
    const val HANDSHAKE_TIMEOUT_MS = 10_000L

    /** How often a waiting pull looks whether its stream was cancelled or closed. */
    const val PULL_CHECK_MS = 1_000L
  }

  /** Starts the handshake: its first flight comes out as `Send` events. */
  fun begin() {
    synchronized(lock) {
      try {
        engine.beginHandshake()
        pump()
      } catch (error: Exception) {
        fail()
      }
    }
  }

  /** Ciphertext the listener sent, as the app received it. */
  fun receive(chunk: ByteArray) {
    synchronized(lock) {
      if (finished) return
      val joined = ByteBuffer.allocate(inbound.remaining() + chunk.size)
      joined.put(inbound).put(chunk).flip()
      inbound = joined
      try {
        pump()
      } catch (error: Exception) {
        fail()
      }
    }
  }

  /** The app's carrier closed: no more ciphertext will come. */
  fun receiveEnd() {
    synchronized(lock) {
      if (finished) return
      if (!settled) {
        settle(refusedOrFailed("connection-failed"))
        return
      }
      finish(PinnedTlsStreamEvent.End)
    }
  }

  /**
   * The next event. A carrier silent past the handshake limit fails a stream
   * still opening. An open stream may stay quiet for as long as it lives, but
   * no pull outlasts it: a finished stream queues nothing more, so a pull left
   * waiting after another took the last event answers `End` and frees its
   * thread.
   */
  fun next(): PinnedTlsStreamEvent {
    val started = System.nanoTime()
    while (true) {
      val event = events.poll(PULL_CHECK_MS, TimeUnit.MILLISECONDS)
      if (event != null) return event
      synchronized(lock) {
        if (finished) return events.poll() ?: PinnedTlsStreamEvent.End
        val waitedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        if (!settled && waitedMs >= HANDSHAKE_TIMEOUT_MS) {
          settle(PinnedTlsStreamEvent.Failed("handshake-failed"))
        }
      }
    }
  }

  fun cancel() {
    synchronized(lock) {
      if (!settled) settle(PinnedTlsStreamEvent.Failed("connection-failed"))
      else finish(PinnedTlsStreamEvent.End)
    }
  }

  /** Runs the engine until it needs bytes it does not have. Called with the lock held. */
  private fun pump() {
    while (!finished) {
      when (engine.handshakeStatus) {
        SSLEngineResult.HandshakeStatus.NEED_WRAP -> wrap(ByteBuffer.allocate(0))
        SSLEngineResult.HandshakeStatus.NEED_TASK -> {
          while (true) (engine.delegatedTask ?: break).run()
        }
        // Android's engine has no NEED_UNWRAP_AGAIN, which only a DTLS engine reports.
        SSLEngineResult.HandshakeStatus.NEED_UNWRAP -> if (!unwrap()) return
        else -> {
          if (!settled) handshakeDone()
          if (finished || !unwrap()) return
        }
      }
    }
  }

  private fun handshakeDone() {
    // The trust manager is the only way through the handshake; this is the
    // same decision read again before the first request byte.
    val pin = servedPin
    if (!accepted || pin == null) {
      settle(PinnedTlsStreamEvent.Refused(pin))
      return
    }
    if (request.isNotEmpty()) wrap(ByteBuffer.wrap(request))
    opened = true
    settle(PinnedTlsStreamEvent.Opened(pin))
  }

  private fun wrap(source: ByteBuffer) {
    do {
      val out = ByteBuffer.allocate(engine.session.packetBufferSize)
      val result = engine.wrap(source, out)
      if (result.status == SSLEngineResult.Status.CLOSED) return finish(PinnedTlsStreamEvent.End)
      out.flip()
      if (out.hasRemaining()) {
        val bytes = ByteArray(out.remaining())
        out.get(bytes)
        events.put(PinnedTlsStreamEvent.Send(bytes))
      }
    } while (source.hasRemaining())
  }

  /** One unwrap; false when it needs more ciphertext than has arrived. */
  private fun unwrap(): Boolean {
    if (!inbound.hasRemaining()) return false
    val out = ByteBuffer.allocate(engine.session.applicationBufferSize)
    val result =
      try {
        engine.unwrap(inbound, out)
      } catch (error: SSLException) {
        settle(refusedOrFailed("handshake-failed"))
        return false
      }
    out.flip()
    if (out.hasRemaining()) {
      val bytes = ByteArray(out.remaining())
      out.get(bytes)
      // Bytes before the handshake passed would be a broken engine; none is handed on.
      if (opened) events.put(PinnedTlsStreamEvent.Data(bytes))
    }
    return when (result.status) {
      SSLEngineResult.Status.BUFFER_UNDERFLOW -> false
      SSLEngineResult.Status.CLOSED -> {
        if (!settled) settle(refusedOrFailed("connection-failed")) else finish(PinnedTlsStreamEvent.End)
        false
      }
      else -> true
    }
  }

  private fun refusedOrFailed(reason: String): PinnedTlsStreamEvent {
    val pin = servedPin
    return if (pin != null && !accepted) PinnedTlsStreamEvent.Refused(pin)
    else PinnedTlsStreamEvent.Failed(reason)
  }

  private fun fail() {
    if (!settled) settle(refusedOrFailed("handshake-failed"))
    else finish(PinnedTlsStreamEvent.Failed("connection-failed"))
  }

  /** Reports how opening went, once; anything but opened also ends the stream. */
  private fun settle(event: PinnedTlsStreamEvent) {
    if (settled) return
    settled = true
    if (event is PinnedTlsStreamEvent.Opened) {
      events.put(event)
      return
    }
    finish(event)
  }

  private fun finish(event: PinnedTlsStreamEvent) {
    if (finished) return
    finished = true
    try {
      engine.closeOutbound()
    } catch (_: Exception) {}
    events.put(event)
  }

  /**
   * The pin replaces platform chain, name, and date validation, exactly as on
   * the direct path: the served leaf passes only when its key hashes to a
   * given pin.
   */
  private inner class PinTrustManager : X509TrustManager {
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      val leaf = chain?.firstOrNull() ?: throw CertificateException("No certificate served.")
      val pin = PinnedTlsExchange.pinOf(leaf.publicKey.encoded)
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
