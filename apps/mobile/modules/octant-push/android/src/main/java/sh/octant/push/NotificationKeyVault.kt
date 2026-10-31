// The phone's notification keys on Android, one X25519 key pair per paired
// computer. Each private key is encrypted under an AES key that lives in the
// Android Keystore and cannot be read out of it, and only that ciphertext is
// kept in the app's private storage, which the app's disabled backup never
// copies. The receiver runs in the app's own process, so it reads the same
// store the module writes.

package sh.octant.push

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class NotificationKeyVault(context: Context) {
  private val preferences =
    context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  /**
   * The public half of the key for one computer and this device id, made on
   * first use. A key made for another device id is replaced, since sealed
   * content binds the device id and the old key could never open it.
   */
  fun publicKey(hostId: String, deviceId: String): String? {
    val existing = key(hostId)
    if (existing != null && existing.deviceId == deviceId) {
      return Base64Url.encode(X25519.publicKey(existing.privateKey))
    }
    val privateKey = ByteArray(X25519.KEY_BYTES).also { SecureRandom().nextBytes(it) }
    val sealed = encrypt("$deviceId\n${Base64Url.encode(privateKey)}") ?: return null
    // Committed before returning, so a key the host is told about is never lost.
    if (!preferences.edit().putString(entry(hostId), sealed).commit()) return null
    return Base64Url.encode(X25519.publicKey(privateKey))
  }

  fun key(hostId: String): NotificationKey? = decode(hostId, preferences.getString(entry(hostId), null))

  /** Every held key, for the receiver, which does not know the host. */
  fun keys(): List<NotificationKey> =
    preferences.all.mapNotNull { (name, value) ->
      if (name.startsWith(ENTRY_PREFIX) && value is String) {
        decode(name.removePrefix(ENTRY_PREFIX), value)
      } else {
        null
      }
    }

  fun forget(hostId: String): Boolean = preferences.edit().remove(entry(hostId)).commit()

  private fun entry(hostId: String) = ENTRY_PREFIX + hostId

  private fun decode(hostId: String, stored: String?): NotificationKey? {
    if (stored == null) return null
    val text = decrypt(stored) ?: return null
    val parts = text.split('\n')
    if (parts.size != 2) return null
    val privateKey = Base64Url.decode(parts[1]) ?: return null
    if (privateKey.size != X25519.KEY_BYTES) return null
    return NotificationKey(hostId, parts[0], privateKey)
  }

  private fun wrappingKey(): SecretKey? =
    try {
      val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
      (store.getKey(KEY_ALIAS, null) as? SecretKey)
        ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
          .apply {
            init(
              KeyGenParameterSpec.Builder(
                  KEY_ALIAS,
                  KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
            )
          }
          .generateKey()
    } catch (error: Exception) {
      null
    }

  private fun encrypt(text: String): String? =
    try {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.ENCRYPT_MODE, wrappingKey() ?: return null)
      val sealed = cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8))
      Base64.encodeToString(sealed, Base64.NO_WRAP)
    } catch (error: Exception) {
      null
    }

  private fun decrypt(stored: String): String? =
    try {
      val bytes = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(
        Cipher.DECRYPT_MODE,
        wrappingKey() ?: return null,
        GCMParameterSpec(128, bytes.copyOfRange(0, IV_BYTES)),
      )
      String(cipher.doFinal(bytes.copyOfRange(IV_BYTES, bytes.size)), Charsets.UTF_8)
    } catch (error: Exception) {
      null
    }

  private companion object {
    const val PREFERENCES = "octant_push_keys"
    const val ENTRY_PREFIX = "host."
    const val ANDROID_KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "octant-push-key-wrap"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
