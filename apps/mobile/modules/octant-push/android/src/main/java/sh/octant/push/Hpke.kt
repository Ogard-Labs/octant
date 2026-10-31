// HPKE (RFC 9180) base mode, single-shot, receiving side only, for the one
// suite the host seals with: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
// AES-256-GCM. It follows the RFC's key schedule step by step so that its
// published test vector can be checked against it.

package sh.octant.push

import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object Hpke {
  private val kemSuite: ByteArray = "KEM".toByteArray() + byteArrayOf(0x00, 0x20)
  private val hpkeSuite: ByteArray =
    "HPKE".toByteArray() + byteArrayOf(0x00, 0x20, 0x00, 0x01, 0x00, 0x02)
  private val versionLabel: ByteArray = "HPKE-v1".toByteArray()
  private const val HASH_BYTES = 32
  private const val TAG_BITS = 128

  /**
   * Opens one sealed message, or returns null when the key, the info, the
   * associated data, or the bytes do not match. A low-order encapsulated key
   * is refused as the RFC requires.
   */
  fun open(
    privateKey: ByteArray,
    encapsulatedKey: ByteArray,
    info: ByteArray,
    associatedData: ByteArray,
    ciphertext: ByteArray,
  ): ByteArray? {
    if (privateKey.size != X25519.KEY_BYTES || encapsulatedKey.size != X25519.KEY_BYTES) return null
    val dh = X25519.scalarMultiply(privateKey, encapsulatedKey)
    if (dh.all { it.toInt() == 0 }) return null
    val recipientPublic = X25519.publicKey(privateKey)
    val sharedSecret =
      labeledExpand(
        kemSuite,
        labeledExtract(kemSuite, ByteArray(0), "eae_prk", dh),
        "shared_secret",
        encapsulatedKey + recipientPublic,
        HASH_BYTES,
      )
    val context =
      byteArrayOf(0x00) +
        labeledExtract(hpkeSuite, ByteArray(0), "psk_id_hash", ByteArray(0)) +
        labeledExtract(hpkeSuite, ByteArray(0), "info_hash", info)
    val secret = labeledExtract(hpkeSuite, sharedSecret, "secret", ByteArray(0))
    val key = labeledExpand(hpkeSuite, secret, "key", context, 32)
    val nonce = labeledExpand(hpkeSuite, secret, "base_nonce", context, 12)
    return try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
      cipher.updateAAD(associatedData)
      cipher.doFinal(ciphertext)
    } catch (error: GeneralSecurityException) {
      null
    }
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    // An empty salt is a string of zeros as long as the hash (RFC 5869), and
    // the platform refuses an empty HMAC key.
    val usable = if (key.isEmpty()) ByteArray(HASH_BYTES) else key
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(usable, "HmacSHA256"))
    return mac.doFinal(data)
  }

  private fun labeledExtract(suite: ByteArray, salt: ByteArray, label: String, ikm: ByteArray) =
    hmac(salt, versionLabel + suite + label.toByteArray() + ikm)

  private fun labeledExpand(
    suite: ByteArray,
    prk: ByteArray,
    label: String,
    info: ByteArray,
    length: Int,
  ): ByteArray {
    val labeledInfo =
      byteArrayOf((length shr 8).toByte(), length.toByte()) +
        versionLabel +
        suite +
        label.toByteArray() +
        info
    var previous = ByteArray(0)
    var output = ByteArray(0)
    var counter = 1
    while (output.size < length) {
      previous = hmac(prk, previous + labeledInfo + byteArrayOf(counter.toByte()))
      output += previous
      counter += 1
    }
    return output.copyOf(length)
  }
}
