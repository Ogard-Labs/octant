// Reads and deletes items staged by ShareReceiverActivity in cacheDir/share/.
// Refuses symbolic links on every folder and file.

package sh.octant.share

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.nio.file.Files

class OctantShareModule : Module() {
  private companion object {
    const val MAX_READ_BYTES = 10 * 1024 * 1024
  }

  override fun definition() = ModuleDefinition {
    Name("OctantShare")

    Function("isSupported") { shareRoot() != null }

    AsyncFunction("listShareFolders") {
      val root = shareRoot() ?: return@AsyncFunction emptyList<Map<String, Any>>()
      val entries = root.listFiles() ?: return@AsyncFunction emptyList<Map<String, Any>>()
      entries.map { entry ->
        val isLink = isSymbolicLink(entry)
        mapOf(
          "name" to entry.name,
          "isDirectory" to (!isLink && entry.isDirectory),
          "isSymbolicLink" to isLink,
        )
      }
    }

    AsyncFunction("statFile") { folder: String, fileName: String ->
      val target = safeTarget(folder, fileName)
        ?: return@AsyncFunction mapOf(
          "exists" to false,
          "isRegularFile" to false,
          "isSymbolicLink" to false,
          "sizeBytes" to 0,
        )
      val isLink = isSymbolicLink(target)
      val exists = isLink || target.exists()
      mapOf(
        "exists" to exists,
        "isRegularFile" to (!isLink && target.isFile),
        "isSymbolicLink" to isLink,
        "sizeBytes" to if (!isLink && target.isFile) target.length().toInt() else 0,
      )
    }

    AsyncFunction("readTextFile") { folder: String, fileName: String ->
      val bytes = readRegularBytes(folder, fileName) ?: return@AsyncFunction null
      String(bytes, Charsets.UTF_8)
    }

    AsyncFunction("readBinaryFileBase64") { folder: String, fileName: String ->
      val bytes = readRegularBytes(folder, fileName) ?: return@AsyncFunction null
      Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    AsyncFunction("deleteShareFolder") { folder: String ->
      val root = shareRoot() ?: return@AsyncFunction false
      if (!isSafeSegment(folder)) return@AsyncFunction false
      val target = File(root, folder)
      if (isSymbolicLink(target)) target.delete() else target.deleteRecursively()
      true
    }

    AsyncFunction("deleteAllShares") {
      val root = shareRoot() ?: return@AsyncFunction true
      val entries = root.listFiles() ?: return@AsyncFunction true
      for (entry in entries) {
        if (isSymbolicLink(entry)) entry.delete() else entry.deleteRecursively()
      }
      true
    }
  }

  private fun shareRoot(): File? {
    val context = appContext.reactContext ?: return null
    return File(context.cacheDir, "share")
  }

  private fun isSafeSegment(segment: String): Boolean {
    return segment.isNotEmpty() &&
      segment != "." &&
      segment != ".." &&
      !segment.contains('/') &&
      !segment.contains('\\')
  }

  private fun safeTarget(folder: String, fileName: String): File? {
    val root = shareRoot() ?: return null
    if (!isSafeSegment(folder) || !isSafeSegment(fileName)) return null
    val dir = File(root, folder)
    if (isSymbolicLink(dir)) return null
    return File(dir, fileName)
  }

  private fun isSymbolicLink(file: File): Boolean {
    return try {
      Files.isSymbolicLink(file.toPath())
    } catch (_: Throwable) {
      false
    }
  }

  private fun readRegularBytes(folder: String, fileName: String): ByteArray? {
    val target = safeTarget(folder, fileName) ?: return null
    if (isSymbolicLink(target) || !target.isFile) return null
    val size = target.length()
    if (size < 0 || size > MAX_READ_BYTES) return null
    return try {
      target.readBytes()
    } catch (_: Throwable) {
      null
    }
  }
}
