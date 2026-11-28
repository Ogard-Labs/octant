// Reads and deletes items staged by the Octant iOS Share Extension inside the
// dedicated share App Group (`Library/Caches/share/`). Every stat and read
// refuses symbolic links so an outside writer cannot trick the app into
// reading another file.

import Darwin
import ExpoModulesCore
import Foundation

public class OctantShareModule: Module {
  private static let maxReadBytes = 10 * 1024 * 1024

  public func definition() -> ModuleDefinition {
    Name("OctantShare")

    Function("isSupported") { () -> Bool in
      self.shareRootURL() != nil
    }

    AsyncFunction("listShareFolders") { () -> [[String: Any]] in
      guard let root = self.shareRootURL() else { return [] }
      let fm = FileManager.default
      guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { return [] }
      return names.map { name in
        let path = root.appendingPathComponent(name).path
        var info = stat()
        if lstat(path, &info) != 0 {
          return ["name": name, "isDirectory": false, "isSymbolicLink": false]
        }
        let mode = info.st_mode & S_IFMT
        return [
          "name": name,
          "isDirectory": mode == S_IFDIR,
          "isSymbolicLink": mode == S_IFLNK,
        ]
      }
    }

    AsyncFunction("statFile") { (folder: String, fileName: String) -> [String: Any] in
      guard let target = self.safeTargetURL(folder: folder, fileName: fileName) else {
        return ["exists": false, "isRegularFile": false, "isSymbolicLink": false, "sizeBytes": 0]
      }
      var info = stat()
      if lstat(target.path, &info) != 0 {
        return ["exists": false, "isRegularFile": false, "isSymbolicLink": false, "sizeBytes": 0]
      }
      let mode = info.st_mode & S_IFMT
      return [
        "exists": true,
        "isRegularFile": mode == S_IFREG,
        "isSymbolicLink": mode == S_IFLNK,
        "sizeBytes": Int(info.st_size),
      ]
    }

    AsyncFunction("readTextFile") { (folder: String, fileName: String) -> String? in
      guard let data = self.readRegularFile(folder: folder, fileName: fileName) else { return nil }
      return String(data: data, encoding: .utf8)
    }

    AsyncFunction("readBinaryFileBase64") { (folder: String, fileName: String) -> String? in
      guard let data = self.readRegularFile(folder: folder, fileName: fileName) else { return nil }
      return data.base64EncodedString()
    }

    AsyncFunction("deleteShareFolder") { (folder: String) -> Bool in
      guard let root = self.shareRootURL(), self.isSafeSegment(folder) else { return false }
      let target = root.appendingPathComponent(folder)
      try? FileManager.default.removeItem(at: target)
      return true
    }

    AsyncFunction("deleteAllShares") { () -> Bool in
      guard let root = self.shareRootURL() else { return true }
      let fm = FileManager.default
      guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { return true }
      for name in names {
        try? fm.removeItem(at: root.appendingPathComponent(name))
      }
      return true
    }
  }

  private func shareRootURL() -> URL? {
    guard
      let group = Bundle.main.object(forInfoDictionaryKey: "OctantShareAppGroup") as? String,
      !group.isEmpty,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { return nil }
    return container
      .appendingPathComponent("Library", isDirectory: true)
      .appendingPathComponent("Caches", isDirectory: true)
      .appendingPathComponent("share", isDirectory: true)
  }

  private func isSafeSegment(_ segment: String) -> Bool {
    !segment.isEmpty && segment != "." && segment != ".." && !segment.contains("/")
      && !segment.contains("\\")
  }

  private func safeTargetURL(folder: String, fileName: String) -> URL? {
    guard let root = shareRootURL(), isSafeSegment(folder), isSafeSegment(fileName) else {
      return nil
    }
    return root.appendingPathComponent(folder, isDirectory: true).appendingPathComponent(fileName)
  }

  private func readRegularFile(folder: String, fileName: String) -> Data? {
    guard let target = safeTargetURL(folder: folder, fileName: fileName) else { return nil }
    let fd = open(target.path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
    let size = Int(info.st_size)
    guard size >= 0, size <= Self.maxReadBytes else { return nil }
    var data = Data(count: size)
    let readCount = data.withUnsafeMutableBytes { buffer -> Int in
      guard let base = buffer.baseAddress else { return -1 }
      var offset = 0
      while offset < size {
        let chunk = Darwin.read(fd, base.advanced(by: offset), size - offset)
        if chunk <= 0 { break }
        offset += chunk
      }
      return offset
    }
    guard readCount == size else { return nil }
    return data
  }
}
