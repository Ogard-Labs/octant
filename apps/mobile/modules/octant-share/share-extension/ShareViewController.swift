// Octant iOS Share Extension.
//
// Stages text, links, images, and files shared from other apps into the
// dedicated share App Group (`Library/Caches/share/<uuid>/`) and tells the
// person to open Octant to pick a computer and send.
//
// Security boundary: this target holds ONLY the App Group entitlement. It has
// no Keychain group, no device keys, no sessions, no host list, and no network
// code. It never walks the responder chain to open the host app.

import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

private enum ShareLimits {
  static let defaultAppGroup = "group.app.octant.mobile.share"
  static let maxItems = 16
  static let maxItemBytes = 10 * 1024 * 1024
  static let maxTotalBytes = 40 * 1024 * 1024
  static let maxStagedShares = 5
  static let maxAgeSeconds: TimeInterval = 24 * 60 * 60
  static let copyChunkBytes = 64 * 1024
}

private struct ShareManifestV1: Encodable {
  let version: Int = 1
  let id: String
  let createdAt: String
  let items: [ShareManifestItem]
}

private struct ShareManifestItem: Encodable {
  let kind: String
  let name: String
  let declaredType: String
  let bytes: Int
  let text: String?
  let url: String?
  let fileName: String?
}

private enum ShareStageError: Error {
  case unavailable
  case queueFull
  case tooManyItems
  case itemTooLarge
  case totalTooLarge
  case emptyItem
  case heicConversionFailed
  case invalidLink
  case noSupportedItems

  var message: String {
    switch self {
    case .unavailable:
      return "Could not save shared items for Octant."
    case .queueFull:
      return "Octant already has 5 shares waiting. Open Octant to send or discard them first."
    case .tooManyItems:
      return "You can share at most 16 items to Octant at once."
    case .itemTooLarge:
      return "A shared item is larger than 10 MB."
    case .totalTooLarge:
      return "Shared items together are larger than 40 MB."
    case .emptyItem:
      return "A shared item is empty."
    case .heicConversionFailed:
      return "Could not convert this HEIC photo to JPEG."
    case .invalidLink:
      return "Only http and https links can be shared to Octant."
    case .noSupportedItems:
      return "Nothing could be saved from this share."
    }
  }
}

public final class ShareViewController: UIViewController {
  private let statusLabel = UILabel()
  private let doneButton = UIButton(type: .system)
  private var started = false

  public override func viewDidLoad() {
    super.viewDidLoad()
    configureView()
  }

  public override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !started else { return }
    started = true
    Task { @MainActor in
      await stageIncomingShare()
    }
  }

  private func configureView() {
    view.backgroundColor = .systemBackground

    let card = UIStackView()
    card.axis = .vertical
    card.alignment = .center
    card.spacing = 16
    card.translatesAutoresizingMaskIntoConstraints = false

    let titleLabel = UILabel()
    titleLabel.text = "Octant"
    titleLabel.font = .preferredFont(forTextStyle: .headline)
    titleLabel.adjustsFontForContentSizeCategory = true

    statusLabel.text = "Saving…"
    statusLabel.font = .preferredFont(forTextStyle: .body)
    statusLabel.textColor = .secondaryLabel
    statusLabel.textAlignment = .center
    statusLabel.numberOfLines = 0
    statusLabel.adjustsFontForContentSizeCategory = true

    var config = UIButton.Configuration.filled()
    config.title = "Done"
    config.cornerStyle = .capsule
    doneButton.configuration = config
    doneButton.isEnabled = false
    doneButton.addTarget(self, action: #selector(finishShare), for: .touchUpInside)

    card.addArrangedSubview(titleLabel)
    card.addArrangedSubview(statusLabel)
    card.addArrangedSubview(doneButton)
    view.addSubview(card)

    NSLayoutConstraint.activate([
      card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      card.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor, constant: 16),
      card.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor, constant: -16),
    ])
  }

  @objc private func finishShare() {
    extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
  }

  @MainActor
  private func stageIncomingShare() async {
    let providers = collectProviders()
    do {
      try await stageProviders(providers)
      statusLabel.text = "Saved. Open Octant to send."
    } catch let error as ShareStageError {
      statusLabel.text = error.message
    } catch {
      statusLabel.text = ShareStageError.unavailable.message
    }
    doneButton.isEnabled = true
  }

  private func collectProviders() -> [NSItemProvider] {
    guard let extensionItems = extensionContext?.inputItems as? [NSExtensionItem] else {
      return []
    }
    return extensionItems.flatMap { $0.attachments ?? [] }
  }

  private func stagingRootURL() throws -> URL {
    let group =
      (Bundle.main.object(forInfoDictionaryKey: "OctantShareAppGroup") as? String)
      ?? ShareLimits.defaultAppGroup
    guard let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: group
    ) else {
      throw ShareStageError.unavailable
    }
    let root = container
      .appendingPathComponent("Library", isDirectory: true)
      .appendingPathComponent("Caches", isDirectory: true)
      .appendingPathComponent("share", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    excludeFromBackup(root)
    return root
  }

  private func sweepExpired(in root: URL) {
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.contentModificationDateKey, .isSymbolicLinkKey],
      options: []
    ) else { return }
    let cutoff = Date().addingTimeInterval(-ShareLimits.maxAgeSeconds)
    for entry in entries {
      let values = try? entry.resourceValues(forKeys: [.contentModificationDateKey, .isSymbolicLinkKey])
      if values?.isSymbolicLink == true {
        try? fm.removeItem(at: entry)
        continue
      }
      if let modified = values?.contentModificationDate, modified < cutoff {
        try? fm.removeItem(at: entry)
      }
    }
  }

  private func stageProviders(_ providers: [NSItemProvider]) async throws {
    guard !providers.isEmpty else { throw ShareStageError.noSupportedItems }
    guard providers.count <= ShareLimits.maxItems else { throw ShareStageError.tooManyItems }

    let root = try stagingRootURL()
    sweepExpired(in: root)

    let existing = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
    guard existing.count < ShareLimits.maxStagedShares else {
      throw ShareStageError.queueFull
    }

    let shareId = UUID().uuidString.lowercased()
    let folder = root.appendingPathComponent(shareId, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    protect(folder)

    do {
      var manifestItems: [ShareManifestItem] = []
      var totalBytes = 0

      for (index, provider) in providers.enumerated() {
        let item = try await stageOne(provider: provider, index: index, folder: folder)
        guard item.bytes > 0 else { throw ShareStageError.emptyItem }
        guard item.bytes <= ShareLimits.maxItemBytes else { throw ShareStageError.itemTooLarge }
        totalBytes += item.bytes
        guard totalBytes <= ShareLimits.maxTotalBytes else { throw ShareStageError.totalTooLarge }
        manifestItems.append(item)
      }

      guard !manifestItems.isEmpty else { throw ShareStageError.noSupportedItems }

      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      let manifest = ShareManifestV1(
        id: shareId,
        createdAt: formatter.string(from: Date()),
        items: manifestItems
      )
      let encoded = try JSONEncoder().encode(manifest)
      let tmpURL = folder.appendingPathComponent("manifest.json.tmp", isDirectory: false)
      let finalURL = folder.appendingPathComponent("manifest.json", isDirectory: false)
      try encoded.write(to: tmpURL, options: [.completeFileProtectionUntilFirstUserAuthentication])
      excludeFromBackup(tmpURL)
      try FileManager.default.moveItem(at: tmpURL, to: finalURL)
      protect(finalURL)
    } catch {
      try? FileManager.default.removeItem(at: folder)
      throw error
    }
  }

  private func stageOne(
    provider: NSItemProvider,
    index: Int,
    folder: URL
  ) async throws -> ShareManifestItem {
    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      return try await stageImage(provider: provider, index: index, folder: folder)
    }
    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier)
      && !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
    {
      if let link = try await loadWebURL(provider: provider) {
        let bytes = link.utf8.count
        let name = sanitizedName(provider.suggestedName, fallback: "link-\(index + 1)")
        return ShareManifestItem(
          kind: "link",
          name: name,
          declaredType: "text/uri-list",
          bytes: bytes,
          text: nil,
          url: link,
          fileName: nil
        )
      }
    }
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      return try await stageFile(
        provider: provider,
        typeIdentifier: UTType.fileURL.identifier,
        index: index,
        folder: folder
      )
    }
    if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      if let text = try await loadText(provider: provider) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let link = validHttpLink(trimmed) {
          return ShareManifestItem(
            kind: "link",
            name: sanitizedName(provider.suggestedName, fallback: "link-\(index + 1)"),
            declaredType: "text/uri-list",
            bytes: link.utf8.count,
            text: nil,
            url: link,
            fileName: nil
          )
        }
        return ShareManifestItem(
          kind: "text",
          name: sanitizedName(provider.suggestedName, fallback: "text-\(index + 1).txt"),
          declaredType: "text/plain",
          bytes: text.utf8.count,
          text: text,
          url: nil,
          fileName: nil
        )
      }
    }
    if let firstType = provider.registeredTypeIdentifiers.first {
      return try await stageFile(
        provider: provider,
        typeIdentifier: firstType,
        index: index,
        folder: folder
      )
    }
    throw ShareStageError.noSupportedItems
  }

  private func stageImage(
    provider: NSItemProvider,
    index: Int,
    folder: URL
  ) async throws -> ShareManifestItem {
    let typeIdentifier =
      provider.registeredTypeIdentifiers.first {
        UTType($0)?.conforms(to: .image) == true
      } ?? UTType.image.identifier
    let isHeic =
      typeIdentifier == UTType.heic.identifier
      || typeIdentifier == UTType.heif.identifier
      || provider.hasItemConformingToTypeIdentifier(UTType.heic.identifier)
      || provider.hasItemConformingToTypeIdentifier(UTType.heif.identifier)

    let data = try await loadBoundedData(provider: provider, typeIdentifier: typeIdentifier)
    let rawName = sanitizedName(provider.suggestedName, fallback: "image-\(index + 1)")

    if isHeic {
      guard let image = UIImage(data: data),
        let jpeg = image.jpegData(compressionQuality: 0.9)
      else {
        throw ShareStageError.heicConversionFailed
      }
      guard !jpeg.isEmpty else { throw ShareStageError.emptyItem }
      guard jpeg.count <= ShareLimits.maxItemBytes else { throw ShareStageError.itemTooLarge }
      let displayName = replacingExtension(rawName, with: "jpg")
      let fileName = "item-\(index + 1).jpg"
      try writeStagedFile(data: jpeg, to: folder.appendingPathComponent(fileName))
      return ShareManifestItem(
        kind: "file",
        name: displayName,
        declaredType: "image/jpeg",
        bytes: jpeg.count,
        text: nil,
        url: nil,
        fileName: fileName
      )
    }

    let utType = UTType(typeIdentifier)
    let mime = utType?.preferredMIMEType ?? "image/jpeg"
    let ext = utType?.preferredFilenameExtension ?? "bin"
    let fileName = "item-\(index + 1).\(ext)"
    let displayName = rawName.contains(".") ? rawName : "\(rawName).\(ext)"
    try writeStagedFile(data: data, to: folder.appendingPathComponent(fileName))
    return ShareManifestItem(
      kind: "file",
      name: displayName,
      declaredType: mime,
      bytes: data.count,
      text: nil,
      url: nil,
      fileName: fileName
    )
  }

  private func stageFile(
    provider: NSItemProvider,
    typeIdentifier: String,
    index: Int,
    folder: URL
  ) async throws -> ShareManifestItem {
    let suggestedName = provider.suggestedName
    return try await withCheckedThrowingContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _ in
        guard let sourceURL = url else {
          continuation.resume(throwing: ShareStageError.unavailable)
          return
        }
        do {
          let ext = sourceURL.pathExtension
          let utType =
            UTType(filenameExtension: ext) ?? UTType(typeIdentifier)
          let mime = utType?.preferredMIMEType ?? "application/octet-stream"
          let displayName = self.sanitizedName(
            suggestedName ?? sourceURL.lastPathComponent,
            fallback: ext.isEmpty ? "file-\(index + 1)" : "file-\(index + 1).\(ext)"
          )
          let fileName = ext.isEmpty ? "item-\(index + 1)" : "item-\(index + 1).\(ext)"
          let targetURL = folder.appendingPathComponent(fileName, isDirectory: false)
          let bytes = try self.copyBounded(from: sourceURL, to: targetURL)
          continuation.resume(
            returning: ShareManifestItem(
              kind: "file",
              name: displayName,
              declaredType: mime,
              bytes: bytes,
              text: nil,
              url: nil,
              fileName: fileName
            )
          )
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  private func loadBoundedData(
    provider: NSItemProvider,
    typeIdentifier: String
  ) async throws -> Data {
    if let fileData = try await loadBoundedFileData(
      provider: provider,
      typeIdentifier: typeIdentifier
    ) {
      return fileData
    }
    return try await withCheckedThrowingContinuation { continuation in
      provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
        guard let data else {
          continuation.resume(throwing: ShareStageError.unavailable)
          return
        }
        if data.isEmpty {
          continuation.resume(throwing: ShareStageError.emptyItem)
        } else if data.count > ShareLimits.maxItemBytes {
          continuation.resume(throwing: ShareStageError.itemTooLarge)
        } else {
          continuation.resume(returning: data)
        }
      }
    }
  }

  private func loadBoundedFileData(
    provider: NSItemProvider,
    typeIdentifier: String
  ) async throws -> Data? {
    try await withCheckedThrowingContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _ in
        guard let sourceURL = url else {
          continuation.resume(returning: nil)
          return
        }
        do {
          let values = try sourceURL.resourceValues(forKeys: [.fileSizeKey])
          if let size = values.fileSize {
            if size == 0 {
              continuation.resume(throwing: ShareStageError.emptyItem)
              return
            }
            if size > ShareLimits.maxItemBytes {
              continuation.resume(throwing: ShareStageError.itemTooLarge)
              return
            }
          }
          let handle = try FileHandle(forReadingFrom: sourceURL)
          defer { try? handle.close() }
          guard let data = try handle.read(upToCount: ShareLimits.maxItemBytes + 1) else {
            continuation.resume(throwing: ShareStageError.emptyItem)
            return
          }
          if data.count > ShareLimits.maxItemBytes {
            continuation.resume(throwing: ShareStageError.itemTooLarge)
            return
          }
          continuation.resume(returning: data)
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  private func loadWebURL(provider: NSItemProvider) async throws -> String? {
    try await withCheckedThrowingContinuation { continuation in
      provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
        if let url = item as? URL {
          if url.isFileURL {
            continuation.resume(returning: nil)
          } else if let valid = self.validHttpLink(url.absoluteString) {
            continuation.resume(returning: valid)
          } else {
            continuation.resume(throwing: ShareStageError.invalidLink)
          }
        } else if let text = item as? String, let valid = self.validHttpLink(text) {
          continuation.resume(returning: valid)
        } else {
          continuation.resume(returning: nil)
        }
      }
    }
  }

  private func loadText(provider: NSItemProvider) async throws -> String? {
    try await withCheckedThrowingContinuation { continuation in
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
        if let text = item as? String {
          continuation.resume(returning: text)
        } else if let data = item as? Data, let text = String(data: data, encoding: .utf8) {
          continuation.resume(returning: text)
        } else {
          continuation.resume(returning: nil)
        }
      }
    }
  }

  private func copyBounded(from sourceURL: URL, to targetURL: URL) throws -> Int {
    let values = try? sourceURL.resourceValues(forKeys: [.fileSizeKey])
    if let size = values?.fileSize, size > ShareLimits.maxItemBytes {
      throw ShareStageError.itemTooLarge
    }
    let reader = try FileHandle(forReadingFrom: sourceURL)
    defer { try? reader.close() }
    FileManager.default.createFile(
      atPath: targetURL.path,
      contents: nil,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    let writer = try FileHandle(forWritingTo: targetURL)
    defer { try? writer.close() }
    var written = 0
    while true {
      let chunk = try reader.read(upToCount: ShareLimits.copyChunkBytes) ?? Data()
      if chunk.isEmpty { break }
      written += chunk.count
      if written > ShareLimits.maxItemBytes {
        try? FileManager.default.removeItem(at: targetURL)
        throw ShareStageError.itemTooLarge
      }
      try writer.write(contentsOf: chunk)
    }
    if written == 0 {
      try? FileManager.default.removeItem(at: targetURL)
      throw ShareStageError.emptyItem
    }
    protect(targetURL)
    return written
  }

  private func writeStagedFile(data: Data, to url: URL) throws {
    try data.write(to: url, options: [.completeFileProtectionUntilFirstUserAuthentication])
    protect(url)
  }

  private func protect(_ url: URL) {
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: url.path
    )
    excludeFromBackup(url)
  }

  private func excludeFromBackup(_ url: URL) {
    var mutable = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? mutable.setResourceValues(values)
  }

  private func validHttpLink(_ candidate: String) -> String? {
    guard let url = URL(string: candidate),
      let scheme = url.scheme?.lowercased(),
      (scheme == "http" || scheme == "https"),
      let host = url.host,
      !host.isEmpty
    else { return nil }
    return candidate
  }

  private func sanitizedName(_ candidate: String?, fallback: String) -> String {
    guard let raw = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      return fallback
    }
    let cleaned = raw
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "\\", with: "_")
      .filter { !$0.isNewline }
    return cleaned.isEmpty ? fallback : String(cleaned.prefix(200))
  }

  private func replacingExtension(_ name: String, with ext: String) -> String {
    let base = (name as NSString).deletingPathExtension
    return base.isEmpty ? "image.\(ext)" : "\(base).\(ext)"
  }
}
