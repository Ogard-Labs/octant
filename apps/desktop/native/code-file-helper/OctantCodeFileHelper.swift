import CryptoKit
import Darwin
import Foundation

private let protocolVersion = 1
private let maximumFrameBytes = 1_048_576
private let maximumChunkBytes = 700_000
private let maximumReadBytes = 20 * 1_024 * 1_024
private let maximumWriteBytes = 5 * 1_024 * 1_024
private let fallbackCorrelationID = "00000000-0000-0000-0000-000000000000"

private enum FailureCode: String {
    case malformed
    case oversized
    case escaped
    case rootMismatch
    case notFound
    case symlink
    case hardlink
    case deviceMismatch
    case identityMismatch
    case digestMismatch
    case invalidType
    case alreadyExists
    case raced
    case interrupted
    case failed
}

private struct HelperFailure: Error {
    let code: FailureCode
}

private struct FileIdentity: Equatable {
    let device: UInt64
    let inode: UInt64

    var json: [String: Any] {
        ["device": String(device), "inode": String(inode)]
    }
}

private struct RootKey: Hashable {
    let path: String
    let device: UInt64
    let inode: UInt64
}

private final class ReadSession {
    let descriptor: Int32
    let rootKey: RootKey
    let identity: FileIdentity
    let totalLength: Int
    let modifiedNanoseconds: String
    let expectedDigest: String
    var offset = 0
    var hasher = SHA256()

    init(
        descriptor: Int32,
        rootKey: RootKey,
        identity: FileIdentity,
        totalLength: Int,
        modifiedNanoseconds: String,
        expectedDigest: String
    ) {
        self.descriptor = descriptor
        self.rootKey = rootKey
        self.identity = identity
        self.totalLength = totalLength
        self.modifiedNanoseconds = modifiedNanoseconds
        self.expectedDigest = expectedDigest
    }
}

private final class WriteSession {
    let descriptor: Int32
    let parentDescriptor: Int32
    let temporaryName: String
    let destinationName: String
    let rootKey: RootKey
    let expectedIdentity: FileIdentity?
    let expectedDigest: String?
    var length = 0
    var hasher = SHA256()

    init(
        descriptor: Int32,
        parentDescriptor: Int32,
        temporaryName: String,
        destinationName: String,
        rootKey: RootKey,
        expectedIdentity: FileIdentity?,
        expectedDigest: String?
    ) {
        self.descriptor = descriptor
        self.parentDescriptor = parentDescriptor
        self.temporaryName = temporaryName
        self.destinationName = destinationName
        self.rootKey = rootKey
        self.expectedIdentity = expectedIdentity
        self.expectedDigest = expectedDigest
    }
}

private struct OpenedFile {
    let descriptor: Int32
    let identity: FileIdentity
    let byteLength: Int
    let modifiedNanoseconds: String
    let digest: String
}

private var retainedRoots: [RootKey: Int32] = [:]
private var readSessions: [String: ReadSession] = [:]
private var writeSessions: [String: WriteSession] = [:]

private func fail(_ code: FailureCode) throws -> Never {
    throw HelperFailure(code: code)
}

private func mapErrno(_ value: Int32 = errno) -> FailureCode {
    switch value {
    case ENOENT:
        return .notFound
    case EEXIST:
        return .alreadyExists
    case ELOOP:
        return .symlink
    case ENOTDIR:
        return .invalidType
    default:
        return .failed
    }
}

private func strictString(_ object: [String: Any], _ key: String) throws -> String {
    guard let value = object[key] as? String, !value.isEmpty else { try fail(.malformed) }
    return value
}

private func strictInt(_ object: [String: Any], _ key: String) throws -> Int {
    guard let number = object[key] as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.rounded() == number.doubleValue,
          number.doubleValue >= 0,
          number.doubleValue <= Double(Int.max)
    else { try fail(.malformed) }
    return number.intValue
}

private func parseUInt64(_ value: Any?) throws -> UInt64 {
    guard let string = value as? String,
          !string.isEmpty,
          string.allSatisfy({ ("0"..."9").contains(String($0)) }),
          let parsed = UInt64(string)
    else { try fail(.malformed) }
    return parsed
}

private func parseIdentity(_ value: Any?) throws -> FileIdentity {
    guard let object = value as? [String: Any], Set(object.keys) == ["device", "inode"] else {
        try fail(.malformed)
    }
    return FileIdentity(
        device: try parseUInt64(object["device"]),
        inode: try parseUInt64(object["inode"])
    )
}

private func validIdentifier(_ value: String) -> Bool {
    value.count == 36 && UUID(uuidString: value) != nil
}

private func validCorrelationID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && !value.contains("\0")
}

private func validDigest(_ value: String) -> Bool {
    value.count == 64 && value.allSatisfy {
        ("0"..."9").contains(String($0)) || ("a"..."f").contains(String($0))
    }
}

private func parseComponents(_ value: Any?) throws -> [String] {
    guard let components = value as? [String], !components.isEmpty, components.count <= 256 else {
        try fail(.escaped)
    }
    for component in components {
        guard !component.isEmpty,
              component != ".",
              component != "..",
              !component.contains("/"),
              !component.contains("\\"),
              !component.contains("\0"),
              component.utf8.count <= 255,
              component.precomposedStringWithCanonicalMapping == component
        else { try fail(.escaped) }
    }
    return components
}

private func identity(_ metadata: stat) -> FileIdentity {
    FileIdentity(device: UInt64(metadata.st_dev), inode: UInt64(metadata.st_ino))
}

private func fileType(_ metadata: stat) -> mode_t {
    metadata.st_mode & S_IFMT
}

private func sha256(descriptor: Int32) throws -> String {
    guard lseek(descriptor, 0, SEEK_SET) >= 0 else { try fail(.failed) }
    var hasher = SHA256()
    var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
    while true {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count == 0 { break }
        guard count > 0 else {
            if errno == EINTR { continue }
            try fail(.failed)
        }
        hasher.update(data: Data(buffer[0..<count]))
    }
    guard lseek(descriptor, 0, SEEK_SET) >= 0 else { try fail(.failed) }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

private func verifiedRoot(_ request: [String: Any]) throws -> (RootKey, Int32) {
    let rootPath = try strictString(request, "rootPath")
    guard rootPath.hasPrefix("/"), !rootPath.contains("\0") else { try fail(.escaped) }
    let expected = try parseIdentity(request["rootIdentity"])
    let key = RootKey(path: rootPath, device: expected.device, inode: expected.inode)
    if let retained = retainedRoots[key] { return (key, retained) }

    let descriptor = open(rootPath, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else { try fail(mapErrno()) }
    var metadata = stat()
    guard fstat(descriptor, &metadata) == 0 else {
        close(descriptor)
        try fail(.failed)
    }
    guard fileType(metadata) == S_IFDIR, identity(metadata) == expected else {
        close(descriptor)
        try fail(.rootMismatch)
    }
    retainedRoots[key] = descriptor
    return (key, descriptor)
}

private func parentDescriptor(root: Int32, components: [String]) throws -> (Int32, String) {
    guard let name = components.last else { try fail(.escaped) }
    var rootMetadata = stat()
    guard fstat(root, &rootMetadata) == 0 else { try fail(.failed) }
    var current = dup(root)
    guard current >= 0 else { try fail(.failed) }
    do {
        for component in components.dropLast() {
            var before = stat()
            guard fstatat(current, component, &before, AT_SYMLINK_NOFOLLOW) == 0 else {
                try fail(mapErrno())
            }
            if fileType(before) == S_IFLNK { try fail(.symlink) }
            guard fileType(before) == S_IFDIR else { try fail(.invalidType) }
            guard before.st_dev == rootMetadata.st_dev else { try fail(.deviceMismatch) }
            let next = openat(current, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
            guard next >= 0 else { try fail(mapErrno()) }
            var after = stat()
            guard fstat(next, &after) == 0 else {
                close(next)
                try fail(.failed)
            }
            guard identity(before) == identity(after) else {
                close(next)
                try fail(.raced)
            }
            guard after.st_dev == rootMetadata.st_dev else {
                close(next)
                try fail(.deviceMismatch)
            }
            close(current)
            current = next
        }
        return (current, name)
    } catch {
        close(current)
        throw error
    }
}

private func openedRegularFile(
    root: Int32,
    rootIdentity: FileIdentity,
    components: [String],
    expectedIdentity: FileIdentity? = nil,
    expectedDigest: String? = nil
) throws -> OpenedFile {
    let (parent, name) = try parentDescriptor(root: root, components: components)
    defer { close(parent) }
    var before = stat()
    guard fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW) == 0 else { try fail(mapErrno()) }
    if fileType(before) == S_IFLNK { try fail(.symlink) }
    guard fileType(before) == S_IFREG else { try fail(.invalidType) }
    guard UInt64(before.st_dev) == rootIdentity.device else { try fail(.deviceMismatch) }
    guard before.st_nlink == 1 else { try fail(.hardlink) }

    let descriptor = openat(parent, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else { try fail(mapErrno()) }
    do {
        var after = stat()
        guard fstat(descriptor, &after) == 0 else { try fail(.failed) }
        guard identity(before) == identity(after) else { try fail(.raced) }
        guard fileType(after) == S_IFREG else { try fail(.invalidType) }
        guard UInt64(after.st_dev) == rootIdentity.device else { try fail(.deviceMismatch) }
        guard after.st_nlink == 1 else { try fail(.hardlink) }
        let actualIdentity = identity(after)
        if let expectedIdentity, actualIdentity != expectedIdentity { try fail(.identityMismatch) }
        let digest = try sha256(descriptor: descriptor)
        if let expectedDigest, digest != expectedDigest { try fail(.digestMismatch) }
        var stable = stat()
        guard fstat(descriptor, &stable) == 0 else { try fail(.failed) }
        guard identity(stable) == actualIdentity,
              stable.st_size == after.st_size,
              stable.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              stable.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              stable.st_nlink == 1
        else { try fail(.raced) }
        guard stable.st_size >= 0, UInt64(stable.st_size) <= UInt64(Int.max) else {
            try fail(.oversized)
        }
        let modified = Int64(stable.st_mtimespec.tv_sec) * 1_000_000_000
            + Int64(stable.st_mtimespec.tv_nsec)
        return OpenedFile(
            descriptor: descriptor,
            identity: actualIdentity,
            byteLength: Int(stable.st_size),
            modifiedNanoseconds: String(modified),
            digest: digest
        )
    } catch {
        close(descriptor)
        throw error
    }
}

private func metadataJSON(_ file: OpenedFile) -> [String: Any] {
    [
        "identity": file.identity.json,
        "byteLength": file.byteLength,
        "modifiedNanoseconds": file.modifiedNanoseconds,
        "digest": file.digest,
    ]
}

private func requireKeys(_ request: [String: Any], extras: Set<String>) throws {
    let common: Set<String> = [
        "protocolVersion", "correlationId", "operation", "rootPath", "rootIdentity", "pathComponents",
    ]
    guard Set(request.keys) == common.union(extras) else { try fail(.malformed) }
}

private func success(_ correlationID: String, _ values: [String: Any] = [:]) -> [String: Any] {
    ["protocolVersion": protocolVersion, "correlationId": correlationID, "ok": true, "result": values]
}

private func expectedMutation(_ request: [String: Any]) throws -> (FileIdentity, String) {
    let expectedIdentity = try parseIdentity(request["expectedIdentity"])
    let expectedDigest = try strictString(request, "expectedDigest")
    guard validDigest(expectedDigest) else { try fail(.malformed) }
    return (expectedIdentity, expectedDigest)
}

private func verifySameEntry(parent: Int32, name: String, opened: OpenedFile) throws {
    var current = stat()
    guard fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) == 0 else { try fail(mapErrno()) }
    if fileType(current) == S_IFLNK { try fail(.symlink) }
    guard identity(current) == opened.identity else { try fail(.raced) }
    guard fileType(current) == S_IFREG, current.st_nlink == 1 else { try fail(.raced) }
}

private func closeReadSession(_ identifier: String) {
    guard let session = readSessions.removeValue(forKey: identifier) else { return }
    close(session.descriptor)
}

private func cancelWriteSession(_ identifier: String) {
    guard let session = writeSessions.removeValue(forKey: identifier) else { return }
    close(session.descriptor)
    _ = unlinkat(session.parentDescriptor, session.temporaryName, 0)
    close(session.parentDescriptor)
}

private func process(_ request: [String: Any]) throws -> [String: Any] {
    guard let version = request["protocolVersion"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID(),
          version.doubleValue == Double(protocolVersion),
          let correlationID = request["correlationId"] as? String,
          validCorrelationID(correlationID),
          let operation = request["operation"] as? String
    else { try fail(.malformed) }

    let components = try parseComponents(request["pathComponents"])
    let (rootKey, root) = try verifiedRoot(request)
    let rootIdentity = FileIdentity(device: rootKey.device, inode: rootKey.inode)

    switch operation {
    case "inspect":
        try requireKeys(request, extras: [])
        let file = try openedRegularFile(root: root, rootIdentity: rootIdentity, components: components)
        defer { close(file.descriptor) }
        return success(correlationID, ["metadata": metadataJSON(file)])

    case "startRead":
        try requireKeys(request, extras: [])
        let file = try openedRegularFile(root: root, rootIdentity: rootIdentity, components: components)
        guard file.byteLength <= maximumReadBytes else {
            close(file.descriptor)
            try fail(.oversized)
        }
        let identifier = UUID().uuidString.lowercased()
        readSessions[identifier] = ReadSession(
            descriptor: file.descriptor,
            rootKey: rootKey,
            identity: file.identity,
            totalLength: file.byteLength,
            modifiedNanoseconds: file.modifiedNanoseconds,
            expectedDigest: file.digest
        )
        return success(correlationID, [
            "sessionId": identifier,
            "totalLength": file.byteLength,
            "metadata": metadataJSON(file),
        ])

    case "readChunk":
        try requireKeys(request, extras: ["sessionId", "maximumBytes"])
        let identifier = try strictString(request, "sessionId")
        let maximumBytes = try strictInt(request, "maximumBytes")
        guard validIdentifier(identifier), maximumBytes > 0, maximumBytes <= maximumChunkBytes else {
            try fail(.malformed)
        }
        guard let session = readSessions[identifier], session.rootKey == rootKey else {
            try fail(.interrupted)
        }
        var current = stat()
        guard fstat(session.descriptor, &current) == 0 else {
            closeReadSession(identifier)
            try fail(.interrupted)
        }
        let modified = Int64(current.st_mtimespec.tv_sec) * 1_000_000_000
            + Int64(current.st_mtimespec.tv_nsec)
        guard identity(current) == session.identity,
              current.st_size == session.totalLength,
              String(modified) == session.modifiedNanoseconds,
              current.st_nlink == 1
        else {
            closeReadSession(identifier)
            try fail(.raced)
        }
        let remaining = session.totalLength - session.offset
        let requested = min(maximumBytes, remaining)
        var buffer = [UInt8](repeating: 0, count: requested)
        var count = 0
        while count < requested {
            let received = buffer.withUnsafeMutableBytes { bytes in
                pread(
                    session.descriptor,
                    bytes.baseAddress!.advanced(by: count),
                    requested - count,
                    off_t(session.offset + count)
                )
            }
            if received == 0 { break }
            guard received > 0 else {
                if errno == EINTR { continue }
                closeReadSession(identifier)
                try fail(.interrupted)
            }
            count += received
        }
        session.offset += count
        let eof = session.offset == session.totalLength
        let chunk = Data(buffer.prefix(count))
        session.hasher.update(data: chunk)
        if eof {
            let digest = session.hasher.finalize().map { String(format: "%02x", $0) }.joined()
            closeReadSession(identifier)
            guard digest == session.expectedDigest else { try fail(.raced) }
        }
        let data = chunk.base64EncodedString()
        return success(correlationID, ["offset": session.offset - count, "dataBase64": data, "eof": eof])

    case "beginWrite":
        try requireKeys(request, extras: ["expectedIdentity", "expectedDigest"])
        let expectedIdentity: FileIdentity?
        let expectedDigest: String?
        if request["expectedIdentity"] is NSNull, request["expectedDigest"] is NSNull {
            expectedIdentity = nil
            expectedDigest = nil
        } else {
            expectedIdentity = try parseIdentity(request["expectedIdentity"])
            let digest = try strictString(request, "expectedDigest")
            guard validDigest(digest) else { try fail(.malformed) }
            expectedDigest = digest
        }
        let (parent, destinationName) = try parentDescriptor(root: root, components: components)
        if let expectedIdentity, let expectedDigest {
            do {
                let existing = try openedRegularFile(
                    root: root,
                    rootIdentity: rootIdentity,
                    components: components,
                    expectedIdentity: expectedIdentity,
                    expectedDigest: expectedDigest
                )
                close(existing.descriptor)
            } catch {
                close(parent)
                throw error
            }
        } else {
            var existing = stat()
            if fstatat(parent, destinationName, &existing, AT_SYMLINK_NOFOLLOW) == 0 {
                close(parent)
                try fail(fileType(existing) == S_IFLNK ? .symlink : .alreadyExists)
            }
            guard errno == ENOENT else {
                let code = mapErrno()
                close(parent)
                try fail(code)
            }
        }
        let temporaryName = ".octant-\(UUID().uuidString.lowercased()).tmp"
        let descriptor = openat(
            parent,
            temporaryName,
            O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else {
            close(parent)
            try fail(mapErrno())
        }
        let identifier = UUID().uuidString.lowercased()
        writeSessions[identifier] = WriteSession(
            descriptor: descriptor,
            parentDescriptor: parent,
            temporaryName: temporaryName,
            destinationName: destinationName,
            rootKey: rootKey,
            expectedIdentity: expectedIdentity,
            expectedDigest: expectedDigest
        )
        return success(correlationID, ["uploadId": identifier])

    case "writeChunk":
        try requireKeys(request, extras: ["uploadId", "chunkBase64"])
        let identifier = try strictString(request, "uploadId")
        let encoded = try strictString(request, "chunkBase64")
        guard validIdentifier(identifier),
              let data = Data(base64Encoded: encoded, options: []),
              !data.isEmpty,
              data.count <= maximumChunkBytes
        else { try fail(.malformed) }
        guard let session = writeSessions[identifier], session.rootKey == rootKey else {
            try fail(.interrupted)
        }
        guard session.length <= maximumWriteBytes - data.count else {
            cancelWriteSession(identifier)
            try fail(.oversized)
        }
        var written = 0
        let succeeded = data.withUnsafeBytes { bytes -> Bool in
            guard let base = bytes.baseAddress else { return false }
            while written < data.count {
                let result = Darwin.write(
                    session.descriptor,
                    base.advanced(by: written),
                    data.count - written
                )
                if result < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                written += result
            }
            return true
        }
        guard succeeded else {
            cancelWriteSession(identifier)
            try fail(.interrupted)
        }
        session.hasher.update(data: data)
        session.length += data.count
        return success(correlationID, ["acceptedLength": session.length])

    case "commitWrite":
        try requireKeys(request, extras: ["uploadId", "expectedLength", "expectedDigest"])
        let identifier = try strictString(request, "uploadId")
        let expectedLength = try strictInt(request, "expectedLength")
        let expectedDigest = try strictString(request, "expectedDigest")
        guard validIdentifier(identifier), validDigest(expectedDigest), expectedLength <= maximumWriteBytes,
              let session = writeSessions[identifier], session.rootKey == rootKey
        else { try fail(.interrupted) }
        var didCommit = false
        defer {
            if !didCommit { cancelWriteSession(identifier) }
        }
        let actualDigest = session.hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard expectedLength == session.length, expectedDigest == actualDigest else {
            cancelWriteSession(identifier)
            try fail(.digestMismatch)
        }
        let descriptorDigest = try sha256(descriptor: session.descriptor)
        guard descriptorDigest == actualDigest else {
            cancelWriteSession(identifier)
            try fail(.raced)
        }
        guard fsync(session.descriptor) == 0 else {
            cancelWriteSession(identifier)
            try fail(.interrupted)
        }
        var temporaryMetadata = stat()
        guard fstat(session.descriptor, &temporaryMetadata) == 0,
              fileType(temporaryMetadata) == S_IFREG,
              UInt64(temporaryMetadata.st_dev) == rootKey.device,
              temporaryMetadata.st_nlink == 1,
              temporaryMetadata.st_size == session.length
        else {
            cancelWriteSession(identifier)
            try fail(.raced)
        }
        if let expectedIdentity = session.expectedIdentity, let expectedDigest = session.expectedDigest {
            let destination = try openedRegularFile(
                root: root,
                rootIdentity: rootIdentity,
                components: components,
                expectedIdentity: expectedIdentity,
                expectedDigest: expectedDigest
            )
            close(destination.descriptor)
            var current = stat()
            guard fstatat(
                session.parentDescriptor,
                session.destinationName,
                &current,
                AT_SYMLINK_NOFOLLOW
            ) == 0,
                  identity(current) == expectedIdentity
            else {
                cancelWriteSession(identifier)
                try fail(.raced)
            }
        } else {
            var current = stat()
            if fstatat(
                session.parentDescriptor,
                session.destinationName,
                &current,
                AT_SYMLINK_NOFOLLOW
            ) == 0 {
                cancelWriteSession(identifier)
                try fail(fileType(current) == S_IFLNK ? .symlink : .alreadyExists)
            }
            guard errno == ENOENT else {
                cancelWriteSession(identifier)
                try fail(.raced)
            }
        }
        guard renameat(
            session.parentDescriptor,
            session.temporaryName,
            session.parentDescriptor,
            session.destinationName
        ) == 0 else {
            cancelWriteSession(identifier)
            try fail(mapErrno())
        }
        guard fsync(session.parentDescriptor) == 0 else {
            close(session.descriptor)
            close(session.parentDescriptor)
            writeSessions.removeValue(forKey: identifier)
            try fail(.interrupted)
        }
        close(session.descriptor)
        close(session.parentDescriptor)
        writeSessions.removeValue(forKey: identifier)
        didCommit = true
        return success(correlationID, ["byteLength": session.length, "digest": actualDigest])

    case "cancelSession":
        try requireKeys(request, extras: ["sessionId"])
        let identifier = try strictString(request, "sessionId")
        guard validIdentifier(identifier) else { try fail(.malformed) }
        if let session = readSessions[identifier], session.rootKey == rootKey {
            closeReadSession(identifier)
            return success(correlationID)
        }
        if let session = writeSessions[identifier], session.rootKey == rootKey {
            cancelWriteSession(identifier)
            return success(correlationID)
        }
        try fail(.interrupted)

    case "rename":
        try requireKeys(request, extras: [
            "destinationPathComponents", "expectedIdentity", "expectedDigest",
        ])
        let destinationComponents = try parseComponents(request["destinationPathComponents"])
        let expectedSource = try expectedMutation(request)
        let source = try openedRegularFile(
            root: root,
            rootIdentity: rootIdentity,
            components: components,
            expectedIdentity: expectedSource.0,
            expectedDigest: expectedSource.1
        )
        defer { close(source.descriptor) }
        let (sourceParent, sourceName) = try parentDescriptor(root: root, components: components)
        defer { close(sourceParent) }
        let (destinationParent, destinationName) = try parentDescriptor(
            root: root,
            components: destinationComponents
        )
        defer { close(destinationParent) }
        try verifySameEntry(parent: sourceParent, name: sourceName, opened: source)
        guard renameatx_np(
            sourceParent,
            sourceName,
            destinationParent,
            destinationName,
            UInt32(RENAME_EXCL)
        ) == 0 else {
            try fail(mapErrno())
        }
        guard fsync(destinationParent) == 0 else { try fail(.interrupted) }
        if identityOfDescriptor(sourceParent) != identityOfDescriptor(destinationParent) {
            guard fsync(sourceParent) == 0 else { try fail(.interrupted) }
        }
        return success(correlationID)

    case "delete":
        try requireKeys(request, extras: ["expectedIdentity", "expectedDigest"])
        let expected = try expectedMutation(request)
        let file = try openedRegularFile(
            root: root,
            rootIdentity: rootIdentity,
            components: components,
            expectedIdentity: expected.0,
            expectedDigest: expected.1
        )
        defer { close(file.descriptor) }
        let (parent, name) = try parentDescriptor(root: root, components: components)
        defer { close(parent) }
        try verifySameEntry(parent: parent, name: name, opened: file)
        guard unlinkat(parent, name, 0) == 0 else { try fail(mapErrno()) }
        guard fsync(parent) == 0 else { try fail(.interrupted) }
        return success(correlationID)

    default:
        try fail(.malformed)
    }
}

private func identityOfDescriptor(_ descriptor: Int32) -> FileIdentity? {
    var metadata = stat()
    return fstat(descriptor, &metadata) == 0 ? identity(metadata) : nil
}

private enum ReadResult {
    case complete(Data)
    case eof
    case partial
}

private func readExactly(_ count: Int) -> ReadResult {
    var data = Data()
    while data.count < count {
        let chunk = FileHandle.standardInput.readData(ofLength: count - data.count)
        if chunk.isEmpty { return data.isEmpty ? .eof : .partial }
        data.append(chunk)
    }
    return .complete(data)
}

private func emit(_ object: [String: Any]) {
    guard let payload = try? JSONSerialization.data(withJSONObject: object),
          payload.count <= maximumFrameBytes
    else { return }
    var length = UInt32(payload.count).bigEndian
    let header = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
    FileHandle.standardOutput.write(header)
    FileHandle.standardOutput.write(payload)
}

private func failure(_ correlationID: String, _ code: FailureCode) -> [String: Any] {
    [
        "protocolVersion": protocolVersion,
        "correlationId": correlationID,
        "ok": false,
        "failure": ["code": code.rawValue],
    ]
}

private func cleanup() {
    for identifier in Array(readSessions.keys) { closeReadSession(identifier) }
    for identifier in Array(writeSessions.keys) { cancelWriteSession(identifier) }
    for descriptor in retainedRoots.values { close(descriptor) }
    retainedRoots.removeAll()
}

while true {
    switch readExactly(4) {
    case .eof:
        cleanup()
        exit(EXIT_SUCCESS)
    case .partial:
        emit(failure(fallbackCorrelationID, .malformed))
        cleanup()
        exit(EXIT_FAILURE)
    case let .complete(header):
        let frameLength = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
        guard frameLength <= maximumFrameBytes else {
            emit(failure(fallbackCorrelationID, .oversized))
            cleanup()
            exit(EXIT_FAILURE)
        }
        switch readExactly(Int(frameLength)) {
        case .eof, .partial:
            emit(failure(fallbackCorrelationID, .malformed))
            cleanup()
            exit(EXIT_FAILURE)
        case let .complete(payload):
            var correlation = fallbackCorrelationID
            do {
                guard let object = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
                    try fail(.malformed)
                }
                if let candidate = object["correlationId"] as? String, validIdentifier(candidate) {
                    correlation = candidate
                }
                emit(try process(object))
            } catch let error as HelperFailure {
                emit(failure(correlation, error.code))
            } catch {
                emit(failure(correlation, .failed))
            }
        }
    }
}
