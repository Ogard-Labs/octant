import Darwin
import Foundation

private func processPath(_ processIdentifier: pid_t) -> String? {
  let maximumProcessPathBytes = 4_096
  var buffer = [CChar](repeating: 0, count: maximumProcessPathBytes)
  let length = proc_pidpath(processIdentifier, &buffer, UInt32(maximumProcessPathBytes))
  return length > 0 ? String(cString: buffer) : nil
}

private func normalizedTemporaryPath(_ path: String) -> String {
  path.hasPrefix("/private/var/") ? String(path.dropFirst("/private".count)) : path
}

private func validExactHostRequirement(_ requirement: String) -> Bool {
  let pattern =
    #"^identifier "com\.octant\.desktop\.work-confinement-gate" and cdhash H"[0-9a-f]{40,128}"$"#
  return requirement.range(of: pattern, options: .regularExpression) != nil
}

private struct StoredBrokerAuthority: Codable {
  let bookmark: Data
  let generation: UUID
}

private func brokerApplicationSupportDirectory() -> URL? {
  FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
    .appendingPathComponent("Octant Work Confinement Broker", isDirectory: true)
}

private func brokerAuthorityStateURL() -> URL? {
  brokerApplicationSupportDirectory()?.appendingPathComponent("authority.plist")
}

private enum BrokerPersistenceResult {
  case success
  case failure(String)
}

private func persistBrokerAuthority(_ authority: StoredBrokerAuthority) -> BrokerPersistenceResult {
  guard
    let directory = brokerApplicationSupportDirectory(),
    let stateURL = brokerAuthorityStateURL()
  else { return .failure("BrokerStateDirectoryUnavailable") }
  do {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  } catch {
    return .failure("BrokerStateCreateFailed")
  }
  let data: Data
  do {
    data = try PropertyListEncoder().encode(authority)
  } catch {
    return .failure("BrokerStateEncodeFailed")
  }
  do {
    try data.write(to: stateURL, options: .atomic)
  } catch {
    return .failure("BrokerStateWriteFailed")
  }
  do {
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
  } catch {
    try? FileManager.default.removeItem(at: stateURL)
    return .failure("BrokerStatePermissionsFailed")
  }
  return .success
}

private func loadBrokerAuthority() -> StoredBrokerAuthority? {
  guard let stateURL = brokerAuthorityStateURL(), let data = try? Data(contentsOf: stateURL) else {
    return nil
  }
  return try? PropertyListDecoder().decode(StoredBrokerAuthority.self, from: data)
}

private func removeBrokerAuthority() {
  guard let stateURL = brokerAuthorityStateURL() else { return }
  try? FileManager.default.removeItem(at: stateURL)
}

private struct FileIdentity: Equatable {
  let device: dev_t
  let inode: ino_t
}

private struct OpenParent {
  let descriptor: Int32
  let identity: FileIdentity
  let leaf: String
}

private enum BoundedOperationResult {
  case allowed(Data? = nil)
  case denied(OOConfinementCategory)
}

private func validRelativeComponents(_ components: [String]) -> Bool {
  !components.isEmpty
    && components.count <= 64
    && components.allSatisfy { component in
      !component.isEmpty
        && component != "."
        && component != ".."
        && !component.contains("/")
        && !component.contains("\0")
        && component.utf8.count <= 255
        && Array(component.precomposedStringWithCanonicalMapping.utf8) == Array(component.utf8)
    }
}

private func descriptorIdentity(_ descriptor: Int32) -> FileIdentity? {
  var metadata = stat()
  guard fstat(descriptor, &metadata) == 0 else { return nil }
  return FileIdentity(device: metadata.st_dev, inode: metadata.st_ino)
}

private func openParentDescriptor(
  rootDescriptor: Int32,
  rootIdentity: FileIdentity,
  components: [String]
) -> OpenParent? {
  guard validRelativeComponents(components), let leaf = components.last else { return nil }
  var current = dup(rootDescriptor)
  guard current >= 0 else { return nil }
  for component in components.dropLast() {
    let next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    close(current)
    guard
      next >= 0,
      let identity = descriptorIdentity(next),
      identity.device == rootIdentity.device
    else {
      if next >= 0 { close(next) }
      return nil
    }
    current = next
  }
  guard let identity = descriptorIdentity(current), identity.device == rootIdentity.device else {
    close(current)
    return nil
  }
  return OpenParent(descriptor: current, identity: identity, leaf: leaf)
}

private func safeRegularMetadata(
  parentDescriptor: Int32,
  leaf: String,
  rootDevice: dev_t
) -> stat? {
  var metadata = stat()
  guard
    fstatat(parentDescriptor, leaf, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
    (metadata.st_mode & S_IFMT) == S_IFREG,
    metadata.st_dev == rootDevice,
    metadata.st_nlink == 1
  else { return nil }
  return metadata
}

private func parentStillBound(
  rootDescriptor: Int32,
  rootIdentity: FileIdentity,
  components: [String],
  expected: FileIdentity
) -> Bool {
  guard let reopened = openParentDescriptor(
    rootDescriptor: rootDescriptor,
    rootIdentity: rootIdentity,
    components: components
  ) else { return false }
  defer { close(reopened.descriptor) }
  return reopened.identity == expected
}

private func triggerParentReplacementRace(_ rootDescriptor: Int32) -> Bool {
  guard
    renameat(rootDescriptor, "race-parent", rootDescriptor, "race-original") == 0,
    renameat(rootDescriptor, "race-replacement", rootDescriptor, "race-parent") == 0
  else {
    _ = renameat(rootDescriptor, "race-original", rootDescriptor, "race-parent")
    return false
  }
  return true
}

private func restoreParentReplacementRace(_ rootDescriptor: Int32) {
  _ = renameat(rootDescriptor, "race-parent", rootDescriptor, "race-replacement")
  _ = renameat(rootDescriptor, "race-original", rootDescriptor, "race-parent")
}

private func safeRead(
  rootURL: URL,
  components: [String],
  offset: UInt64,
  length: Int,
  triggerRace: Bool
) -> BoundedOperationResult {
  guard
    length > 0,
    length <= 65_536,
    offset <= UInt64(Int64.max),
    offset <= UInt64(Int64.max) - UInt64(length)
  else { return .denied(.invalidRequest) }
  let rootDescriptor = open(rootURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  guard rootDescriptor >= 0, let rootIdentity = descriptorIdentity(rootDescriptor) else {
    if rootDescriptor >= 0 { close(rootDescriptor) }
    return .denied(.filesystemDenied)
  }
  defer { close(rootDescriptor) }
  guard let parent = openParentDescriptor(
    rootDescriptor: rootDescriptor,
    rootIdentity: rootIdentity,
    components: components
  ) else { return .denied(.filesystemDenied) }
  defer { close(parent.descriptor) }
  guard safeRegularMetadata(
    parentDescriptor: parent.descriptor,
    leaf: parent.leaf,
    rootDevice: rootIdentity.device
  ) != nil else { return .denied(.filesystemDenied) }
  let fileDescriptor = openat(parent.descriptor, parent.leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard fileDescriptor >= 0 else { return .denied(.filesystemDenied) }
  defer { close(fileDescriptor) }
  guard safeRegularMetadata(
    parentDescriptor: parent.descriptor,
    leaf: parent.leaf,
    rootDevice: rootIdentity.device
  ) != nil else { return .denied(.filesystemDenied) }
  var bytes = [UInt8](repeating: 0, count: length)
  let readCount = pread(fileDescriptor, &bytes, length, off_t(offset))
  guard readCount >= 0 else { return .denied(.filesystemDenied) }
  let raceTriggered = triggerRace && triggerParentReplacementRace(rootDescriptor)
  guard !triggerRace || raceTriggered else { return .denied(.filesystemDenied) }
  defer {
    if raceTriggered { restoreParentReplacementRace(rootDescriptor) }
  }
  guard parentStillBound(
    rootDescriptor: rootDescriptor,
    rootIdentity: rootIdentity,
    components: components,
    expected: parent.identity
  ) else { return .denied(.filesystemDenied) }
  return .allowed(Data(bytes.prefix(Int(readCount))))
}

private func safeWrite(
  rootURL: URL,
  components: [String],
  payload: Data
) -> BoundedOperationResult {
  guard payload.count <= 1_048_576 else { return .denied(.invalidRequest) }
  let rootDescriptor = open(rootURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  guard rootDescriptor >= 0, let rootIdentity = descriptorIdentity(rootDescriptor) else {
    if rootDescriptor >= 0 { close(rootDescriptor) }
    return .denied(.filesystemDenied)
  }
  defer { close(rootDescriptor) }
  guard let parent = openParentDescriptor(
    rootDescriptor: rootDescriptor,
    rootIdentity: rootIdentity,
    components: components
  ) else { return .denied(.filesystemDenied) }
  defer { close(parent.descriptor) }
  var existing = stat()
  if fstatat(parent.descriptor, parent.leaf, &existing, AT_SYMLINK_NOFOLLOW) == 0 {
    guard
      (existing.st_mode & S_IFMT) == S_IFREG,
      existing.st_dev == rootIdentity.device,
      existing.st_nlink == 1
    else { return .denied(.filesystemDenied) }
  } else if errno != ENOENT {
    return .denied(.filesystemDenied)
  }
  let temporary = ".octant-\(UUID().uuidString)"
  let temporaryDescriptor = openat(
    parent.descriptor,
    temporary,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    S_IRUSR | S_IWUSR
  )
  guard temporaryDescriptor >= 0 else { return .denied(.filesystemDenied) }
  var renamed = false
  defer {
    close(temporaryDescriptor)
    if !renamed { _ = unlinkat(parent.descriptor, temporary, 0) }
  }
  let writeSucceeded = payload.withUnsafeBytes { buffer -> Bool in
    guard let baseAddress = buffer.baseAddress else { return payload.isEmpty }
    var written = 0
    while written < payload.count {
      let count = Darwin.write(
        temporaryDescriptor,
        baseAddress.advanced(by: written),
        payload.count - written
      )
      guard count > 0 else { return false }
      written += count
    }
    return true
  }
  guard
    writeSucceeded,
    fsync(temporaryDescriptor) == 0,
    parentStillBound(
      rootDescriptor: rootDescriptor,
      rootIdentity: rootIdentity,
      components: components,
      expected: parent.identity
    ),
    renameat(parent.descriptor, temporary, parent.descriptor, parent.leaf) == 0,
    fsync(parent.descriptor) == 0
  else { return .denied(.filesystemDenied) }
  renamed = true
  return .allowed()
}

private func safeRename(
  rootURL: URL,
  source: [String],
  destination: [String]
) -> BoundedOperationResult {
  let rootDescriptor = open(rootURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  guard rootDescriptor >= 0, let rootIdentity = descriptorIdentity(rootDescriptor) else {
    if rootDescriptor >= 0 { close(rootDescriptor) }
    return .denied(.filesystemDenied)
  }
  defer { close(rootDescriptor) }
  guard
    let sourceParent = openParentDescriptor(
      rootDescriptor: rootDescriptor,
      rootIdentity: rootIdentity,
      components: source
    ),
    let destinationParent = openParentDescriptor(
      rootDescriptor: rootDescriptor,
      rootIdentity: rootIdentity,
      components: destination
    )
  else { return .denied(.filesystemDenied) }
  defer {
    close(sourceParent.descriptor)
    close(destinationParent.descriptor)
  }
  var destinationMetadata = stat()
  guard
    fstatat(
      destinationParent.descriptor,
      destinationParent.leaf,
      &destinationMetadata,
      AT_SYMLINK_NOFOLLOW
    ) == -1,
    errno == ENOENT
  else { return .denied(.filesystemDenied) }
  guard
    safeRegularMetadata(
      parentDescriptor: sourceParent.descriptor,
      leaf: sourceParent.leaf,
      rootDevice: rootIdentity.device
    ) != nil,
    parentStillBound(
      rootDescriptor: rootDescriptor,
      rootIdentity: rootIdentity,
      components: source,
      expected: sourceParent.identity
    ),
    parentStillBound(
      rootDescriptor: rootDescriptor,
      rootIdentity: rootIdentity,
      components: destination,
      expected: destinationParent.identity
    ),
    renameat(
      sourceParent.descriptor,
      sourceParent.leaf,
      destinationParent.descriptor,
      destinationParent.leaf
    ) == 0,
    fsync(sourceParent.descriptor) == 0,
    fsync(destinationParent.descriptor) == 0
  else { return .denied(.filesystemDenied) }
  return .allowed()
}

private func safeDelete(rootURL: URL, components: [String]) -> BoundedOperationResult {
  let rootDescriptor = open(rootURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  guard rootDescriptor >= 0, let rootIdentity = descriptorIdentity(rootDescriptor) else {
    if rootDescriptor >= 0 { close(rootDescriptor) }
    return .denied(.filesystemDenied)
  }
  defer { close(rootDescriptor) }
  guard let parent = openParentDescriptor(
    rootDescriptor: rootDescriptor,
    rootIdentity: rootIdentity,
    components: components
  ) else { return .denied(.filesystemDenied) }
  defer { close(parent.descriptor) }
  guard
    safeRegularMetadata(
      parentDescriptor: parent.descriptor,
      leaf: parent.leaf,
      rootDevice: rootIdentity.device
    ) != nil,
    parentStillBound(
      rootDescriptor: rootDescriptor,
      rootIdentity: rootIdentity,
      components: components,
      expected: parent.identity
    ),
    unlinkat(parent.descriptor, parent.leaf, 0) == 0,
    fsync(parent.descriptor) == 0
  else { return .denied(.filesystemDenied) }
  return .allowed()
}

private func archiveContainsUnsafeEntry(_ data: Data) -> Bool {
  let bytes = [UInt8](data)
  var index = 0
  var sawEntry = false
  while index + 46 <= bytes.count {
    let signature = UInt32(bytes[index])
      | UInt32(bytes[index + 1]) << 8
      | UInt32(bytes[index + 2]) << 16
      | UInt32(bytes[index + 3]) << 24
    guard signature == 0x0201_4B50 else {
      index += 1
      continue
    }
    sawEntry = true
    let nameLength = Int(bytes[index + 28]) | Int(bytes[index + 29]) << 8
    let extraLength = Int(bytes[index + 30]) | Int(bytes[index + 31]) << 8
    let commentLength = Int(bytes[index + 32]) | Int(bytes[index + 33]) << 8
    guard index + 46 + nameLength + extraLength + commentLength <= bytes.count else { return true }
    let nameBytes = bytes[(index + 46)..<(index + 46 + nameLength)]
    guard let name = String(bytes: nameBytes, encoding: .utf8) else { return true }
    let components = name.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    if name.hasPrefix("/") || !validRelativeComponents(components) { return true }
    index += 46 + nameLength + extraLength + commentLength
  }
  return !sawEntry
}

private func sandboxDeniedConnection(address: in_addr_t) -> Bool {
  let descriptor = socket(AF_INET, SOCK_STREAM, 0)
  guard descriptor >= 0 else { return errno == EPERM || errno == EACCES }
  defer { close(descriptor) }
  guard fcntl(descriptor, F_SETFL, O_NONBLOCK) == 0 else { return false }
  var socketAddress = sockaddr_in()
  socketAddress.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  socketAddress.sin_family = sa_family_t(AF_INET)
  socketAddress.sin_port = in_port_t(9).bigEndian
  socketAddress.sin_addr = in_addr(s_addr: address)
  let result = withUnsafePointer(to: &socketAddress) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { addressPointer in
      Darwin.connect(descriptor, addressPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
    }
  }
  return result == -1 && (errno == EPERM || errno == EACCES)
}

private final class WorkConfinementBroker: NSObject, OOConfinementBrokerProtocol {
  private var capability = Data()
  private var generation: UUID?
  private let bootstrapHandler: ((String) -> Bool)?
  private let denialEvidenceProvider: () -> Bool
  private let endpointProvider: () -> NSXPCListenerEndpoint?
  private var scopedURL: URL?
  private var scopeActive = false

  init(
    bootstrapHandler: ((String) -> Bool)? = nil,
    denialEvidenceProvider: @escaping () -> Bool,
    endpointProvider: @escaping () -> NSXPCListenerEndpoint?
  ) {
    self.bootstrapHandler = bootstrapHandler
    self.denialEvidenceProvider = denialEvidenceProvider
    self.endpointProvider = endpointProvider
  }

  func establish(
    _ authority: OOConfinementAuthority,
    withReply reply: @escaping (OOConfinementReply) -> Void
  ) {
    let storedAuthority: StoredBrokerAuthority?
    switch authority.mode {
    case .authenticationOnly:
      guard authority.transientBookmark == nil else {
        reply(OOConfinementReply(status: .denied, category: .invalidRequest))
        return
      }
      storedAuthority = nil
    case .adoptSelectedRoot:
      guard let transientBookmark = authority.transientBookmark else {
        reply(OOConfinementReply(status: .denied, category: .invalidRequest))
        return
      }
      var transientStale = false
      let selectedRootURL: URL
      do {
        selectedRootURL = try URL(
          resolvingBookmarkData: transientBookmark,
          options: .withoutUI,
          relativeTo: nil,
          bookmarkDataIsStale: &transientStale
        )
      } catch {
        reply(OOConfinementReply(status: .denied, category: .invalidRequest))
        return
      }
      guard !transientStale else {
        reply(OOConfinementReply(status: .stale, category: .staleAuthority))
        return
      }
      let bookmark: Data
      do {
        bookmark = try selectedRootURL.bookmarkData(
          options: .withSecurityScope,
          includingResourceValuesForKeys: nil,
          relativeTo: nil
        )
      } catch {
        reply(OOConfinementReply(status: .denied, category: .invalidRequest))
        return
      }
      let adopted = StoredBrokerAuthority(bookmark: bookmark, generation: authority.generation)
      let persistence = persistBrokerAuthority(adopted)
      guard case .success = persistence else {
        let evidence: String
        if case .failure(let failure) = persistence {
          evidence = failure
        } else {
          evidence = "BrokerStateWriteFailed"
        }
        reply(
          OOConfinementReply(
            status: .unavailable,
            category: .unavailable,
            opaqueFixtureToken: evidence
          )
        )
        return
      }
      storedAuthority = adopted
    case .resumePersisted:
      guard
        authority.transientBookmark == nil,
        let persisted = loadBrokerAuthority(),
        persisted.generation == authority.generation
      else {
        reply(OOConfinementReply(status: .denied, category: .unauthorized))
        return
      }
      storedAuthority = persisted
    }

    if let storedAuthority {
      var stale = false
      let resolvedURL: URL
      do {
        resolvedURL = try URL(
          resolvingBookmarkData: storedAuthority.bookmark,
          options: [.withSecurityScope, .withoutUI],
          relativeTo: nil,
          bookmarkDataIsStale: &stale
        )
      } catch {
        if authority.mode == .adoptSelectedRoot { removeBrokerAuthority() }
        reply(OOConfinementReply(status: .denied, category: .invalidRequest))
        return
      }
      guard !stale else {
        reply(OOConfinementReply(status: .stale, category: .staleAuthority))
        return
      }
      guard resolvedURL.startAccessingSecurityScopedResource() else {
        if authority.mode == .adoptSelectedRoot { removeBrokerAuthority() }
        reply(OOConfinementReply(status: .denied, category: .unauthorized))
        return
      }
      stopScope()
      scopedURL = resolvedURL
      scopeActive = true
    }
    capability = authority.capability
    generation = authority.generation
    reply(OOConfinementReply(status: .allowed, category: .none))
  }

  func perform(
    _ request: OOConfinementRequest,
    withReply reply: @escaping (OOConfinementReply) -> Void
  ) {
    if
      request.operation == .establishAuthority,
      let bootstrapHandler,
      let payload = request.payload,
      let requirement = String(data: payload, encoding: .utf8),
      validExactHostRequirement(requirement),
      bootstrapHandler(requirement)
    {
      reply(OOConfinementReply(status: .allowed, category: .none))
      return
    }
    guard
      let generation,
      request.generation == generation,
      constantTimeCapabilityMatch(request.capability, capability)
    else {
      reply(OOConfinementReply(status: .denied, category: .unauthorized))
      return
    }
    if request.probeID == "broker-rejection-evidence" {
      reply(
        OOConfinementReply(
          status: denialEvidenceProvider() ? .allowed : .unavailable,
          category: denialEvidenceProvider() ? .none : .unavailable,
          opaqueFixtureToken: denialEvidenceProvider() ? "ExactRequirementInstalled" : nil
        )
      )
      return
    }
    if request.operation == .revokeAuthority {
      stopScope()
      removeBrokerAuthority()
      capability.resetBytes(in: 0..<capability.count)
      capability.removeAll(keepingCapacity: false)
      self.generation = nil
      reply(OOConfinementReply(status: .allowed, category: .none))
      return
    }
    let result: BoundedOperationResult
    switch request.operation {
    case .readFile:
      guard let scopedURL else {
        reply(OOConfinementReply(status: .denied, category: .unauthorized))
        return
      }
      result = safeRead(
        rootURL: scopedURL,
        components: request.relativePathComponents,
        offset: request.readOffset,
        length: request.readLength,
        triggerRace: request.probeID == "race"
      )
    case .writeFile:
      guard let scopedURL, let payload = request.payload else {
        reply(OOConfinementReply(status: .denied, category: .unauthorized))
        return
      }
      result = safeWrite(
        rootURL: scopedURL,
        components: request.relativePathComponents,
        payload: payload
      )
    case .renameFile:
      guard let scopedURL, let destination = request.destinationPathComponents else {
        reply(OOConfinementReply(status: .denied, category: .unauthorized))
        return
      }
      result = safeRename(
        rootURL: scopedURL,
        source: request.relativePathComponents,
        destination: destination
      )
    case .deleteFile:
      guard let scopedURL else {
        reply(OOConfinementReply(status: .denied, category: .unauthorized))
        return
      }
      result = safeDelete(rootURL: scopedURL, components: request.relativePathComponents)
    case .inspectArchive:
      guard let payload = request.payload else {
        reply(OOConfinementReply(status: .denied, category: .invalidRequest))
        return
      }
      result = archiveContainsUnsafeEntry(payload) ? .denied(.filesystemDenied) : .allowed()
    case .spawnProcess:
      result = .denied(.unauthorized)
    case .connectLoopback:
      result = sandboxDeniedConnection(address: inet_addr("127.0.0.1"))
        ? .denied(.sandboxDenied) : .allowed()
    case .connectExternal:
      result = sandboxDeniedConnection(address: inet_addr("1.1.1.1"))
        ? .denied(.sandboxDenied) : .allowed()
    case .establishAuthority, .revokeAuthority:
      result = .denied(.invalidRequest)
    }
    switch result {
    case .allowed(let payload):
      reply(OOConfinementReply(status: .allowed, category: .none, payload: payload))
    case .denied(let category):
      reply(OOConfinementReply(status: .denied, category: category))
    }
  }

  private func stopScope() {
    if scopeActive { scopedURL?.stopAccessingSecurityScopedResource() }
    scopeActive = false
    scopedURL = nil
  }

  func invalidate() {
    stopScope()
    capability.resetBytes(in: 0..<capability.count)
    capability.removeAll(keepingCapacity: false)
    generation = nil
  }

  func foreignProbeEndpoint(
    withReply reply: @escaping (NSXPCListenerEndpoint?, OOConfinementReply) -> Void
  ) {
    guard generation != nil, let endpoint = endpointProvider() else {
      reply(nil, OOConfinementReply(status: .denied, category: .unauthorized))
      return
    }
    reply(endpoint, OOConfinementReply(status: .allowed, category: .none))
  }

  func attemptForeignProbe(
    _ endpoint: NSXPCListenerEndpoint,
    authority: OOConfinementAuthority,
    withReply reply: @escaping (OOConfinementReply) -> Void
  ) {
    reply(OOConfinementReply(status: .denied, category: .unauthorized))
  }
}

private final class ForeignProbeListenerDelegate: NSObject, NSXPCListenerDelegate {
  func listener(
    _ listener: NSXPCListener,
    shouldAcceptNewConnection connection: NSXPCConnection
  ) -> Bool { false }
}

private final class WorkConfinementListenerDelegate: NSObject, NSXPCListenerDelegate {
  private var trustedHostRequirement: String?
  private var foreignProbeRequirementInstalled = false
  private var foreignProbeListeners: [NSXPCListener] = []
  private var foreignProbeDelegates: [ForeignProbeListenerDelegate] = []

  private func makeForeignProbeEndpoint() -> NSXPCListenerEndpoint? {
    guard let trustedHostRequirement else { return nil }
    let delegate = ForeignProbeListenerDelegate()
    let listener = NSXPCListener.anonymous()
    listener.setConnectionCodeSigningRequirement(trustedHostRequirement)
    listener.delegate = delegate
    let endpoint = listener.endpoint
    listener.resume()
    foreignProbeDelegates.append(delegate)
    foreignProbeListeners.append(listener)
    foreignProbeRequirementInstalled = true
    return endpoint
  }

  func listener(
    _ listener: NSXPCListener,
    shouldAcceptNewConnection connection: NSXPCConnection
  ) -> Bool {
    let broker: WorkConfinementBroker
    if let trustedHostRequirement {
      connection.setCodeSigningRequirement(trustedHostRequirement)
      broker = WorkConfinementBroker(
        bootstrapHandler: { requirement in requirement == trustedHostRequirement },
        denialEvidenceProvider: { [weak self] in
          self?.foreignProbeRequirementInstalled == true
        },
        endpointProvider: { [weak self] in self?.makeForeignProbeEndpoint() }
      )
    } else {
      let appBundle = Bundle.main.bundleURL
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
      let expectedHostPath = appBundle.appendingPathComponent(
        "Contents/MacOS/OctantWorkConfinementGate"
      ).standardizedFileURL.path
      guard
        let observedHostPath = processPath(connection.processIdentifier),
        normalizedTemporaryPath(observedHostPath) == normalizedTemporaryPath(expectedHostPath)
      else { return false }
      connection.setCodeSigningRequirement(
        "identifier \"app.octant.desktop.work-confinement-gate\""
      )
      broker = WorkConfinementBroker(
        bootstrapHandler: { [weak self] requirement in
          guard self?.trustedHostRequirement == nil else { return false }
          self?.trustedHostRequirement = requirement
          return true
        },
        denialEvidenceProvider: { false },
        endpointProvider: { nil }
      )
    }
    connection.exportedInterface = octantWorkConfinementInterface()
    connection.exportedObject = broker
    connection.invalidationHandler = { broker.invalidate() }
    connection.resume()
    return true
  }
}

@main
struct OctantWorkConfinementBroker {
  static func main() {
    let delegate = WorkConfinementListenerDelegate()
    let listener = NSXPCListener.service()
    listener.delegate = delegate
    listener.resume()
    RunLoop.current.run()
  }
}
