import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

public final class OctantVideoSaveModule: Module {
  private let folder = VideoSaveFolder()

  public func definition() -> ModuleDefinition {
    Name("OctantVideoSave")

    AsyncFunction("pick") { (promise: Promise) in
      self.folder.pick(from: self.appContext?.utilities?.currentViewController(), promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("copy") { (selection: String, clipUri: String, promise: Promise) in
      guard let destination = self.folder.take(selection) else {
        promise.reject("ERR_VIDEO_SAVE_FOLDER", "Choose a folder for the video.")
        return
      }
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          try copyCachedVideo(clipUri, to: destination)
          promise.resolve()
        } catch {
          promise.reject("ERR_VIDEO_SAVE_COPY", "Could not save the video in the chosen folder.")
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("discard") { (selection: String) in
      _ = self.folder.take(selection)
    }.runOnQueue(.main)
  }
}

private final class VideoSaveFolder: NSObject, UIDocumentPickerDelegate,
  UIAdaptivePresentationControllerDelegate
{
  private var picking: (controller: UIDocumentPickerViewController, promise: Promise)?
  private var selected: (token: String, url: URL)?

  func pick(from presenter: UIViewController?, promise: Promise) {
    guard let presenter, picking == nil, selected == nil else {
      promise.reject("ERR_VIDEO_SAVE_PICKER", "The folder picker is unavailable.")
      return
    }
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
    picker.delegate = self
    picker.modalPresentationStyle = .pageSheet
    picker.presentationController?.delegate = self
    picking = (picker, promise)
    presenter.present(picker, animated: true)
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    finish(controller, url: urls.first)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish(controller, url: nil)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    if let picker = presentationController.presentedViewController as? UIDocumentPickerViewController {
      finish(picker, url: nil)
    }
  }

  private func finish(_ controller: UIDocumentPickerViewController, url: URL?) {
    guard let picking, picking.controller === controller else { return }
    self.picking = nil
    guard let url else {
      picking.promise.resolve(nil)
      return
    }
    // Keep the URL in native code without taking access while the caller checks
    // whether the player is still allowed to use the clip.
    let token = UUID().uuidString
    selected = (token, url)
    picking.promise.resolve(token)
  }

  func take(_ token: String) -> URL? {
    guard let selected, selected.token == token else { return nil }
    self.selected = nil
    return selected.url
  }
}

private enum VideoSaveFailure: Error {
  case invalidClip
  case folderUnavailable
}

private func copyCachedVideo(_ clipUri: String, to folder: URL) throws {
  let files = FileManager.default
  guard let file = URL(string: clipUri), file.isFileURL,
    let cache = files.urls(for: .cachesDirectory, in: .userDomainMask).first
  else { throw VideoSaveFailure.invalidClip }
  let source = file.resolvingSymlinksInPath().standardizedFileURL
  let name = source.deletingPathExtension().lastPathComponent
  guard source.deletingLastPathComponent().path == cache.resolvingSymlinksInPath().path,
    source.pathExtension == "mp4", name.hasPrefix("octant-video-"),
    UUID(uuidString: String(name.dropFirst("octant-video-".count))) != nil
  else { throw VideoSaveFailure.invalidClip }

  guard folder.startAccessingSecurityScopedResource() else {
    throw VideoSaveFailure.folderUnavailable
  }
  defer { folder.stopAccessingSecurityScopedResource() }

  let destination = folder.appendingPathComponent(source.lastPathComponent)
  var coordinationError: NSError?
  var copyError: Error?
  NSFileCoordinator().coordinate(writingItemAt: destination, options: [], error: &coordinationError) {
    coordinatedDestination in
    do {
      try files.copyItem(at: source, to: coordinatedDestination)
    } catch {
      copyError = error
    }
  }
  if let error = coordinationError { throw error }
  if let error = copyError { throw error }
}
