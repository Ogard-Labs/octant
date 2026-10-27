// Where the Android keystore puts a key made the way Octant's secure storage
// makes its own (an AES-256-GCM key in `AndroidKeyStore`, no user
// authentication), so the answer is where that storage's key lives too. The
// probe key is made, read, and deleted in one call and never used.

package sh.octant.deviceprotection

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKeyFactory

object KeyStorageProbe {
  private const val PROVIDER = "AndroidKeyStore"
  private const val ALIAS = "sh.octant.key-storage-probe"

  /** `secure-hardware`, `software`, or `unknown` when the keystore cannot say. */
  fun protection(): String {
    val keyStore =
      try {
        KeyStore.getInstance(PROVIDER).apply { load(null) }
      } catch (error: Exception) {
        return "unknown"
      }
    return try {
      val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
      generator.init(
        KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
          )
          .setKeySize(256)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .build()
      )
      val key = generator.generateKey()
      val info =
        SecretKeyFactory.getInstance(key.algorithm, PROVIDER).getKeySpec(key, KeyInfo::class.java)
          as KeyInfo
      levelOf(info)
    } catch (error: Exception) {
      "unknown"
    } finally {
      try {
        keyStore.deleteEntry(ALIAS)
      } catch (_: Exception) {}
    }
  }

  private fun levelOf(info: KeyInfo): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX,
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT,
        KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> "secure-hardware"
        KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
        else -> "unknown"
      }
    }
    @Suppress("DEPRECATION")
    return if (info.isInsideSecureHardware) "secure-hardware" else "software"
  }
}
