// Receives Android SEND and SEND_MULTIPLE intents, copies shared text, links,
// images, and content:// streams into cacheDir/share/<uuid>/, writes
// manifest.json last by rename, and opens the main app via `octant://share`.
//
// Security boundary: holds no device keys, no sessions, no host list, and no
// network code.

package sh.octant.share

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

class ShareReceiverActivity : Activity() {
  private sealed class StageOutcome {
    data object Staged : StageOutcome()
    data class Refused(
      val message: String,
      val openOctant: Boolean = false,
    ) : StageOutcome()
  }

  private sealed class ItemStageResult {
    data class Staged(val item: JSONObject) : ItemStageResult()
    data class Refused(val message: String) : ItemStageResult()
  }

  private sealed class CopyOutcome {
    data class Copied(val bytes: Int) : CopyOutcome()
    data object TooLarge : CopyOutcome()
    data object Empty : CopyOutcome()
    data object Unavailable : CopyOutcome()
  }

  private companion object {
    const val MAX_ITEMS = 16
    const val MAX_ITEM_BYTES = 10 * 1024 * 1024
    const val MAX_TOTAL_BYTES = 40 * 1024 * 1024
    const val MAX_STAGED_SHARES = 5
    const val MAX_AGE_MS = 24L * 60L * 60L * 1000L
    const val COPY_BUFFER_BYTES = 64 * 1024

    const val MSG_UNAVAILABLE = "Could not save shared items for Octant."
    const val MSG_QUEUE_FULL =
      "Octant already has 5 shares waiting. Open Octant to send or discard them first."
    const val MSG_TOO_MANY_ITEMS = "You can share at most 16 items to Octant at once."
    const val MSG_ITEM_TOO_LARGE = "A shared item is larger than 10 MB."
    const val MSG_TOTAL_TOO_LARGE = "Shared items together are larger than 40 MB."
    const val MSG_EMPTY_ITEM = "A shared item is empty."
    const val MSG_HEIC_CONVERSION_FAILED = "Could not convert this HEIC photo to JPEG."
    const val MSG_NO_SUPPORTED_ITEMS = "Nothing could be saved from this share."
    const val MSG_UNSUPPORTED_SOURCE = "Only content shared by an app can be saved to Octant."
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val outcome = try {
      stageIntent(intent)
    } catch (_: Throwable) {
      StageOutcome.Refused(MSG_UNAVAILABLE)
    }
    when (outcome) {
      is StageOutcome.Staged -> openOctantShare()
      is StageOutcome.Refused -> {
        Toast.makeText(applicationContext, outcome.message, Toast.LENGTH_LONG).show()
        if (outcome.openOctant) {
          openOctantShare()
        }
      }
    }
    finish()
  }

  private fun openOctantShare() {
    val open = Intent(Intent.ACTION_VIEW, Uri.parse("octant://share")).apply {
      setPackage(packageName)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    startActivity(open)
  }

  private fun shareRoot(): File {
    val root = File(cacheDir, "share")
    if (!root.exists()) root.mkdirs()
    return root
  }

  private fun sweepExpired(root: File) {
    val cutoff = System.currentTimeMillis() - MAX_AGE_MS
    val entries = root.listFiles() ?: return
    for (entry in entries) {
      if (entry.lastModified() < cutoff) {
        entry.deleteRecursively()
      }
    }
  }

  private fun stageIntent(incoming: Intent?): StageOutcome {
    if (incoming == null) return StageOutcome.Refused(MSG_NO_SUPPORTED_ITEMS)
    val action = incoming.action ?: return StageOutcome.Refused(MSG_NO_SUPPORTED_ITEMS)
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) {
      return StageOutcome.Refused(MSG_NO_SUPPORTED_ITEMS)
    }

    val root = shareRoot()
    sweepExpired(root)
    val existingCount = root.listFiles()?.size ?: 0
    if (existingCount >= MAX_STAGED_SHARES) {
      return StageOutcome.Refused(MSG_QUEUE_FULL, openOctant = true)
    }

    val shareId = UUID.randomUUID().toString().lowercase(Locale.US)
    val folder = File(root, shareId)
    if (!folder.mkdirs()) return StageOutcome.Refused(MSG_UNAVAILABLE)

    return try {
      val items = JSONArray()
      var totalBytes = 0

      val uris = extractUris(incoming, action)
      val sharedText = incoming.getStringExtra(Intent.EXTRA_TEXT)
      val itemCount = uris.size + if (sharedText.isNullOrEmpty()) 0 else 1
      if (itemCount == 0) {
        folder.deleteRecursively()
        return StageOutcome.Refused(MSG_NO_SUPPORTED_ITEMS)
      }
      if (itemCount > MAX_ITEMS) {
        folder.deleteRecursively()
        return StageOutcome.Refused(MSG_TOO_MANY_ITEMS)
      }

      if (!sharedText.isNullOrEmpty()) {
        val textItem = buildTextOrLinkItem(sharedText)
        val itemBytes = textItem.getInt("bytes")
        if (itemBytes <= 0) {
          folder.deleteRecursively()
          return StageOutcome.Refused(MSG_EMPTY_ITEM)
        }
        if (itemBytes > MAX_ITEM_BYTES) {
          folder.deleteRecursively()
          return StageOutcome.Refused(MSG_ITEM_TOO_LARGE)
        }
        totalBytes += itemBytes
        items.put(textItem)
      }

      for ((index, uri) in uris.withIndex()) {
        val staged = when (val result = stageContentUri(uri, index, folder, incoming.type)) {
          is ItemStageResult.Staged -> result.item
          is ItemStageResult.Refused -> {
            folder.deleteRecursively()
            return StageOutcome.Refused(result.message)
          }
        }
        val bytes = staged.getInt("bytes")
        totalBytes += bytes
        if (totalBytes > MAX_TOTAL_BYTES) {
          folder.deleteRecursively()
          return StageOutcome.Refused(MSG_TOTAL_TOO_LARGE)
        }
        items.put(staged)
      }

      val manifest = JSONObject().apply {
        put("version", 1)
        put("id", shareId)
        put("createdAt", isoNow())
        put("items", items)
      }

      val tmp = File(folder, "manifest.json.tmp")
      val finalFile = File(folder, "manifest.json")
      tmp.writeText(manifest.toString(), Charsets.UTF_8)
      if (!tmp.renameTo(finalFile)) {
        folder.deleteRecursively()
        return StageOutcome.Refused(MSG_UNAVAILABLE)
      }
      StageOutcome.Staged
    } catch (_: Throwable) {
      folder.deleteRecursively()
      StageOutcome.Refused(MSG_UNAVAILABLE)
    }
  }

  private fun extractUris(incoming: Intent, action: String): List<Uri> {
    if (action == Intent.ACTION_SEND) {
      val single = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        incoming.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        @Suppress("DEPRECATION")
        incoming.getParcelableExtra(Intent.EXTRA_STREAM)
      }
      return if (single != null) listOf(single) else emptyList()
    }
    val list = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      incoming.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      @Suppress("DEPRECATION")
      incoming.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
    }
    return list?.filterNotNull() ?: emptyList()
  }

  private fun buildTextOrLinkItem(raw: String): JSONObject {
    val trimmed = raw.trim()
    val scheme = Uri.parse(trimmed).scheme?.lowercase(Locale.US)
    val host = Uri.parse(trimmed).host
    if ((scheme == "http" || scheme == "https") && !host.isNullOrEmpty() && !trimmed.contains("\n")) {
      return JSONObject().apply {
        put("kind", "link")
        put("name", "link.txt")
        put("declaredType", "text/uri-list")
        put("bytes", trimmed.toByteArray(Charsets.UTF_8).size)
        put("url", trimmed)
      }
    }
    return JSONObject().apply {
      put("kind", "text")
      put("name", "shared-text.txt")
      put("declaredType", "text/plain")
      put("bytes", raw.toByteArray(Charsets.UTF_8).size)
      put("text", raw)
    }
  }

  private fun stageContentUri(
    uri: Uri,
    index: Int,
    folder: File,
    fallbackType: String?,
  ): ItemStageResult {
    val scheme = uri.scheme?.lowercase(Locale.US)
    if (scheme != "content") return ItemStageResult.Refused(MSG_UNSUPPORTED_SOURCE)

    val mime = (contentResolver.getType(uri) ?: fallbackType ?: "application/octet-stream")
      .substringBefore(';')
      .trim()
      .lowercase(Locale.US)
    val displayName = queryDisplayName(uri) ?: "shared-${index + 1}"
    val isHeic = mime == "image/heic" || mime == "image/heif"

    if (isHeic) {
      val fileName = "item-${index + 1}.jpg"
      val outFile = File(folder, fileName)
      val bytes = convertHeicToJpeg(uri, outFile)
        ?: return ItemStageResult.Refused(MSG_HEIC_CONVERSION_FAILED)
      if (bytes <= 0) {
        outFile.delete()
        return ItemStageResult.Refused(MSG_EMPTY_ITEM)
      }
      if (bytes > MAX_ITEM_BYTES) {
        outFile.delete()
        return ItemStageResult.Refused(MSG_ITEM_TOO_LARGE)
      }
      val jpegName = replaceExtension(displayName, "jpg")
      return ItemStageResult.Staged(
        JSONObject().apply {
          put("kind", "file")
          put("name", jpegName)
          put("declaredType", "image/jpeg")
          put("bytes", bytes)
          put("fileName", fileName)
        },
      )
    }

    val ext = displayName.substringAfterLast('.', "").take(12).filter { it.isLetterOrDigit() }
    val fileName = if (ext.isEmpty()) "item-${index + 1}" else "item-${index + 1}.$ext"
    val outFile = File(folder, fileName)
    val copied = when (val copyResult = copyStreamBounded(uri, outFile)) {
      is CopyOutcome.Copied -> copyResult.bytes
      CopyOutcome.TooLarge -> return ItemStageResult.Refused(MSG_ITEM_TOO_LARGE)
      CopyOutcome.Empty -> return ItemStageResult.Refused(MSG_EMPTY_ITEM)
      CopyOutcome.Unavailable -> return ItemStageResult.Refused(MSG_UNAVAILABLE)
    }
    return ItemStageResult.Staged(
      JSONObject().apply {
        put("kind", "file")
        put("name", displayName)
        put("declaredType", mime)
        put("bytes", copied)
        put("fileName", fileName)
      },
    )
  }

  private fun copyStreamBounded(uri: Uri, target: File): CopyOutcome {
    val input = contentResolver.openInputStream(uri) ?: return CopyOutcome.Unavailable
    input.use { stream ->
      FileOutputStream(target).use { out ->
        val buffer = ByteArray(COPY_BUFFER_BYTES)
        var total = 0
        while (true) {
          val read = stream.read(buffer)
          if (read <= 0) break
          total += read
          if (total > MAX_ITEM_BYTES) {
            target.delete()
            return CopyOutcome.TooLarge
          }
          out.write(buffer, 0, read)
        }
        if (total == 0) {
          target.delete()
          return CopyOutcome.Empty
        }
        return CopyOutcome.Copied(total)
      }
    }
  }

  private fun convertHeicToJpeg(uri: Uri, target: File): Int? {
    val bitmap: Bitmap = try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val source = ImageDecoder.createSource(contentResolver, uri)
        ImageDecoder.decodeBitmap(source)
      } else {
        contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: return null
      }
    } catch (_: Throwable) {
      return null
    }
    return try {
      FileOutputStream(target).use { out ->
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)) return null
      }
      target.length().toInt()
    } finally {
      bitmap.recycle()
    }
  }

  private fun queryDisplayName(uri: Uri): String? {
    val cursor = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
    cursor?.use {
      if (it.moveToFirst()) {
        val raw = it.getString(0)?.trim()
        if (!raw.isNullOrEmpty()) {
          return raw.replace('/', '_').replace('\\', '_').take(200)
        }
      }
    }
    return null
  }

  private fun replaceExtension(name: String, ext: String): String {
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    return "$stem.$ext"
  }

  private fun isoNow(): String {
    val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    format.timeZone = TimeZone.getTimeZone("UTC")
    return format.format(Date())
  }
}
