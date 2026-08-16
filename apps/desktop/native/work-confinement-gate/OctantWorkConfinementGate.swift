import AppKit
import Darwin
import Foundation
import Security

private func secureRandomCapability() -> Data? {
  var capability = Data(count: 32)
  let status = capability.withUnsafeMutableBytes { buffer in
    SecRandomCopyBytes(kSecRandomDefault, 32, buffer.baseAddress!)
  }
  return status == errSecSuccess ? capability : nil
}

private func brokerConnection() -> NSXPCConnection? {
  let brokerExecutable = Bundle.main.bundleURL.appendingPathComponent(
    "Contents/XPCServices/OctantWorkConfinementBroker.xpc/Contents/MacOS/OctantWorkConfinementBroker"
  )
  guard
    let requirement = try? exactCodeRequirement(
      executableURL: brokerExecutable,
      identifier: octantWorkConfinementBrokerBundleIdentifier
    )
  else { return nil }

  let connection = NSXPCConnection(serviceName: octantWorkConfinementBrokerBundleIdentifier)
  connection.remoteObjectInterface = octantWorkConfinementInterface()
  connection.setCodeSigningRequirement(requirement)
  connection.resume()
  return connection
}

private struct TrustedPeerSession {
  let connection: NSXPCConnection
  let broker: OOConfinementBrokerProtocol
  let generation: UUID
  let capability: Data
}

private enum AuthorityEstablishment {
  case allowed(TrustedPeerSession)
  case stale
  case denied(OOConfinementCategory, String?)
}

private func categoryName(_ category: OOConfinementCategory) -> String {
  switch category {
  case .none: "None"
  case .unauthorized: "Unauthorized"
  case .invalidRequest: "InvalidRequest"
  case .staleAuthority: "StaleAuthority"
  case .sandboxDenied: "SandboxDenied"
  case .filesystemDenied: "FilesystemDenied"
  case .unavailable: "Unavailable"
  }
}

private func sanitizedConnectionError(_ error: Error) -> String {
  let error = error as NSError
  if error.domain == NSCocoaErrorDomain {
    return "NSCocoaErrorDomain\(abs(error.code))"
  }
  return "ConnectionError\(abs(error.code))"
}

private func establishTrustedPeer(
  mode: OOConfinementAuthorityMode,
  generation: UUID,
  transientBookmark: Data? = nil
) -> AuthorityEstablishment {
  guard
    let capability = secureRandomCapability(),
    let hostExecutable = Bundle.main.executableURL,
    let hostRequirement = try? exactCodeRequirement(
      executableURL: hostExecutable,
      identifier: octantWorkConfinementGateBundleIdentifier
    ),
    let bootstrapConnection = brokerConnection()
  else { return .denied(.unavailable, "HostSetupUnavailable") }

  let bootstrapSemaphore = DispatchSemaphore(value: 0)
  var bootstrapped = false
  guard
    let bootstrapBroker = bootstrapConnection.remoteObjectProxyWithErrorHandler({ _ in
      bootstrapSemaphore.signal()
    }) as? OOConfinementBrokerProtocol
  else {
    bootstrapConnection.invalidate()
    return .denied(.unavailable, "BootstrapProxyUnavailable")
  }
  bootstrapBroker.perform(
    OOConfinementRequest(
      operation: .establishAuthority,
      generation: generation,
      capability: capability,
      payload: Data(hostRequirement.utf8),
      probeID: "bootstrap-host"
    )
  ) { response in
    bootstrapped = response.status == .allowed
    bootstrapSemaphore.signal()
  }
  guard
    bootstrapSemaphore.wait(timeout: .now() + 10) == .success,
    bootstrapped,
    let connection = brokerConnection()
  else {
    bootstrapConnection.invalidate()
    return .denied(.unavailable, "BootstrapRejected")
  }

  let semaphore = DispatchSemaphore(value: 0)
  var establishmentStatus = OOConfinementStatus.unavailable
  var establishmentCategory = OOConfinementCategory.unavailable
  var establishmentEvidence: String?
  guard
    let broker = connection.remoteObjectProxyWithErrorHandler({ error in
      establishmentEvidence = sanitizedConnectionError(error)
      semaphore.signal()
    })
      as? OOConfinementBrokerProtocol
  else {
    connection.invalidate()
    return .denied(.unavailable, "TrustedProxyUnavailable")
  }
  broker.establish(
    OOConfinementAuthority(
      mode: mode,
      generation: generation,
      capability: capability,
      transientBookmark: transientBookmark
    )
  ) { establishment in
    establishmentStatus = establishment.status
    establishmentCategory = establishment.category
    establishmentEvidence = establishment.opaqueFixtureToken
    semaphore.signal()
  }
  guard semaphore.wait(timeout: .now() + 10) == .success else {
    bootstrapConnection.invalidate()
    connection.invalidate()
    return .denied(.unavailable, "EstablishTimeout")
  }
  bootstrapConnection.invalidate()
  if establishmentStatus == .allowed {
    return .allowed(
      TrustedPeerSession(
        connection: connection,
        broker: broker,
        generation: generation,
        capability: capability
      )
    )
  }
  connection.invalidate()
  return establishmentStatus == .stale
    ? .stale : .denied(establishmentCategory, establishmentEvidence)
}

private func trustedPeerProbe() -> TrustedPeerSession? {
  if
    case .allowed(let session) = establishTrustedPeer(
      mode: .authenticationOnly,
      generation: UUID()
    )
  {
    return session
  }
  return nil
}

private func foreignClientProbe(_ session: TrustedPeerSession) -> String? {
  let endpointSemaphore = DispatchSemaphore(value: 0)
  var foreignEndpoint: NSXPCListenerEndpoint?
  session.broker.foreignProbeEndpoint { endpoint, response in
    if response.status == .allowed { foreignEndpoint = endpoint }
    endpointSemaphore.signal()
  }
  guard
    endpointSemaphore.wait(timeout: .now() + 10) == .success,
    let foreignEndpoint
  else { return nil }

  let foreignExecutable = Bundle.main.bundleURL.appendingPathComponent(
    "Contents/XPCServices/OctantWorkConfinementForeignClient.xpc/Contents/MacOS/OctantWorkConfinementForeignClient"
  )
  guard
    let requirement = try? exactCodeRequirement(
      executableURL: foreignExecutable,
      identifier: octantWorkConfinementGateBundleIdentifier
    )
  else { return nil }
  let connection = NSXPCConnection(serviceName: octantWorkConfinementForeignServiceIdentifier)
  connection.remoteObjectInterface = octantWorkConfinementInterface()
  connection.setCodeSigningRequirement(requirement)
  connection.resume()
  defer { connection.invalidate() }

  let semaphore = DispatchSemaphore(value: 0)
  var result: String?
  guard
    let foreignClient = connection.remoteObjectProxyWithErrorHandler({ _ in semaphore.signal() })
      as? OOConfinementBrokerProtocol
  else { return nil }
  foreignClient.attemptForeignProbe(
    foreignEndpoint,
    authority:
    OOConfinementAuthority(
      mode: .authenticationOnly,
      generation: session.generation,
      capability: session.capability
    )
  ) { response in
    if response.status == .denied,
      let evidence = response.opaqueFixtureToken
    {
      result = "probe=foreign-client result=denied category=\(evidence)"
    }
    semaphore.signal()
  }
  guard semaphore.wait(timeout: .now() + 10) == .success else { return nil }
  return result
}

private func brokerRejectionEvidence(_ session: TrustedPeerSession) -> Bool {
  for _ in 0..<40 {
    let semaphore = DispatchSemaphore(value: 0)
    var proved = false
    session.broker.perform(
      OOConfinementRequest(
        operation: .revokeAuthority,
        generation: session.generation,
        capability: session.capability,
        probeID: "broker-rejection-evidence"
      )
    ) { response in
      proved = response.status == .allowed
        && response.opaqueFixtureToken == "ExactRequirementInstalled"
      semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 1) == .success else { return false }
    if proved { return true }
    Thread.sleep(forTimeInterval: 0.05)
  }
  return false
}

private struct StoredAuthority: Codable {
  let generation: UUID
}

private func applicationSupportDirectory() -> URL? {
  FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
    .appendingPathComponent("Octant Work Confinement Gate", isDirectory: true)
}

private func authorityStateURL() -> URL? {
  applicationSupportDirectory()?.appendingPathComponent("authority.plist")
}

private func persistAuthority(_ authority: StoredAuthority) -> Bool {
  guard let directory = applicationSupportDirectory(), let stateURL = authorityStateURL() else {
    return false
  }
  do {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let data = try PropertyListEncoder().encode(authority)
    try data.write(to: stateURL, options: .atomic)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: stateURL.path
    )
    return true
  } catch {
    return false
  }
}

private func loadAuthority() -> StoredAuthority? {
  guard let stateURL = authorityStateURL(), let data = try? Data(contentsOf: stateURL) else {
    return nil
  }
  return try? PropertyListDecoder().decode(StoredAuthority.self, from: data)
}

private func removeAuthorityState() {
  guard let stateURL = authorityStateURL() else { return }
  try? FileManager.default.removeItem(at: stateURL)
}

private func revokeStoredAuthority() {
  defer { removeAuthorityState() }
  guard
    let authority = loadAuthority(),
    case .allowed(let session) = establishTrustedPeer(
      mode: .resumePersisted,
      generation: authority.generation
    )
  else { return }
  _ = performRequest(session, operation: .revokeAuthority, probeID: "revoke-state")
  session.connection.invalidate()
}

@MainActor
private func chooseConfinementRoot() -> URL? {
  let panel = NSOpenPanel()
  panel.canChooseFiles = false
  panel.canChooseDirectories = true
  panel.allowsMultipleSelection = false
  panel.canCreateDirectories = false
  panel.prompt = "Select"
  return panel.runModal() == .OK ? panel.url : nil
}

private func performReply(
  _ session: TrustedPeerSession,
  operation: OOConfinementOperation,
  probeID: String,
  relativePathComponents: [String] = [],
  destinationPathComponents: [String]? = nil,
  payload: Data? = nil,
  readOffset: UInt64 = 0,
  readLength: Int = 0
) -> OOConfinementReply? {
  let semaphore = DispatchSemaphore(value: 0)
  var receivedReply: OOConfinementReply?
  session.broker.perform(
    OOConfinementRequest(
      operation: operation,
      generation: session.generation,
      capability: session.capability,
      relativePathComponents: relativePathComponents,
      destinationPathComponents: destinationPathComponents,
      payload: payload,
      readOffset: readOffset,
      readLength: readLength,
      probeID: probeID
    )
  ) { response in
    receivedReply = response
    semaphore.signal()
  }
  guard semaphore.wait(timeout: .now() + 10) == .success else { return nil }
  return receivedReply
}

private func performRequest(
  _ session: TrustedPeerSession,
  operation: OOConfinementOperation,
  probeID: String,
  relativePathComponents: [String] = []
) -> OOConfinementStatus? {
  performReply(
    session,
    operation: operation,
    probeID: probeID,
    relativePathComponents: relativePathComponents,
    readLength: operation == .readFile ? 1 : 0
  )?.status
}

@MainActor
private func selectionLifecycleResults() -> [String] {
  guard let selectedRoot = chooseConfinementRoot() else {
    return ["probe=selection result=unavailable category=SelectionCancelled"]
  }
  let transientBookmark: Data
  do {
    transientBookmark = try selectedRoot.bookmarkData(
      options: .minimalBookmark,
      includingResourceValuesForKeys: nil,
      relativeTo: nil
    )
  } catch {
    return ["probe=selection result=unavailable category=TransientBookmarkCreationFailed"]
  }

  let initialGeneration = UUID()
  let initialEstablishment = establishTrustedPeer(
    mode: .adoptSelectedRoot,
    generation: initialGeneration,
    transientBookmark: transientBookmark
  )
  guard case .allowed(let initialSession) = initialEstablishment else {
    if case .denied(let category, let evidence) = initialEstablishment {
      return [
        "probe=selection result=unavailable category=\(evidence ?? categoryName(category))"
      ]
    }
    return ["probe=selection result=stale category=StaleAuthority"]
  }
  let revoked = performRequest(
    initialSession,
    operation: .revokeAuthority,
    probeID: "revoke-authority"
  ) == .allowed
    && performRequest(
      initialSession,
      operation: .readFile,
      probeID: "revoked",
      relativePathComponents: ["fixture"]
    ) == .denied
  let replayDenied = performRequest(
    initialSession,
    operation: .readFile,
    probeID: "old-generation-replay",
    relativePathComponents: ["fixture"]
  ) == .denied
  initialSession.connection.invalidate()

  let rotatedAuthority = StoredAuthority(generation: UUID())
  let rotatedAllowed: Bool
  if
    case .allowed(let rotatedSession) = establishTrustedPeer(
      mode: .adoptSelectedRoot,
      generation: rotatedAuthority.generation,
      transientBookmark: transientBookmark
    )
  {
    guard persistAuthority(rotatedAuthority) else {
      _ = performRequest(
        rotatedSession,
        operation: .revokeAuthority,
        probeID: "persistence-rollback"
      )
      rotatedSession.connection.invalidate()
      return ["probe=selection result=unavailable category=AuthorityPersistenceFailed"]
    }
    rotatedSession.connection.invalidate()
    rotatedAllowed = true
  } else {
    rotatedAllowed = false
  }

  return [
    "probe=selection result=\(rotatedAllowed ? "allowed" : "unavailable") category=\(rotatedAllowed ? "None" : "AuthorityRelaunchFailed")",
    "probe=revoked result=\(revoked ? "denied" : "unavailable") category=\(revoked ? "Unauthorized" : "Unavailable")",
    "probe=old-generation-replay result=\(replayDenied ? "denied" : "unavailable") category=\(replayDenied ? "Unauthorized" : "Unavailable")",
  ]
}

private func authorityLifecycleResult(probe: String) -> String {
  guard let authority = loadAuthority() else {
    return "probe=\(probe) result=denied category=Unauthorized"
  }
  switch establishTrustedPeer(mode: .resumePersisted, generation: authority.generation) {
  case .allowed(let session):
    session.connection.invalidate()
    return "probe=\(probe) result=allowed category=None"
  case .stale:
    return "probe=\(probe) result=stale category=StaleAuthority"
  case .denied:
    return "probe=\(probe) result=denied category=Unauthorized"
  }
}

private func fixedStoredZIPCorpus() -> Data {
  let entryNames = ["../outside", "/absolute", "safe/../../outside", "safe.txt"]
  var corpus = Data()
  for entryName in entryNames {
    let name = Data(entryName.utf8)
    corpus.append(contentsOf: [0x50, 0x4B, 0x01, 0x02])
    corpus.append(Data(repeating: 0, count: 24))
    corpus.append(UInt8(name.count & 0xFF))
    corpus.append(UInt8((name.count >> 8) & 0xFF))
    corpus.append(Data(repeating: 0, count: 16))
    corpus.append(name)
  }
  return corpus
}

private func operationProbeResult(
  _ session: TrustedPeerSession,
  probe: String,
  operation: OOConfinementOperation,
  relativePathComponents: [String] = [],
  destinationPathComponents: [String]? = nil,
  payload: Data? = nil,
  readLength: Int = 0
) -> String {
  guard let response = performReply(
    session,
    operation: operation,
    probeID: probe,
    relativePathComponents: relativePathComponents,
    destinationPathComponents: destinationPathComponents,
    payload: payload,
    readLength: readLength
  ) else {
    return "probe=\(probe) result=unavailable category=Unavailable"
  }
  let result: String
  switch response.status {
  case .allowed: result = "allowed"
  case .denied: result = "denied"
  case .stale: result = "stale"
  case .unavailable: result = "unavailable"
  case .clean: result = "clean"
  }
  return "probe=\(probe) result=\(result) category=\(categoryName(response.category))"
}

private func deniedReadAndWriteProbeResult(
  _ session: TrustedPeerSession,
  probe: String,
  relativePathComponents: [String]
) -> String {
  let readResponse = performReply(
    session,
    operation: .readFile,
    probeID: "\(probe)-read",
    relativePathComponents: relativePathComponents,
    readLength: 1
  )
  let writeResponse = performReply(
    session,
    operation: .writeFile,
    probeID: "\(probe)-write",
    relativePathComponents: relativePathComponents,
    payload: Data("blocked".utf8)
  )
  guard let readResponse, let writeResponse else {
    return "probe=\(probe) result=unavailable category=Unavailable"
  }
  let denied = readResponse.status == .denied && writeResponse.status == .denied
  return "probe=\(probe) result=\(denied ? "denied" : "allowed") category=\(denied ? categoryName(readResponse.category) : "None")"
}

private func operationResults() -> [String] {
  guard
    let authority = loadAuthority(),
    case .allowed(let session) = establishTrustedPeer(
      mode: .resumePersisted,
      generation: authority.generation
    )
  else {
    return ["probe=allowed-create-read-write-rename-delete result=unavailable category=Unauthorized"]
  }
  defer { session.connection.invalidate() }
  let firstPayload = Data("first".utf8)
  let secondPayload = Data("second".utf8)
  let writeCreated = performReply(
    session,
    operation: .writeFile,
    probeID: "allowed-create",
    relativePathComponents: ["round-trip.txt"],
    payload: firstPayload
  )?.status == .allowed
  let firstRead = performReply(
    session,
    operation: .readFile,
    probeID: "allowed-read",
    relativePathComponents: ["round-trip.txt"],
    readLength: 64
  )
  let writeUpdated = performReply(
    session,
    operation: .writeFile,
    probeID: "allowed-write",
    relativePathComponents: ["round-trip.txt"],
    payload: secondPayload
  )?.status == .allowed
  let secondRead = performReply(
    session,
    operation: .readFile,
    probeID: "allowed-read-updated",
    relativePathComponents: ["round-trip.txt"],
    readLength: 64
  )
  let renamed = performReply(
    session,
    operation: .renameFile,
    probeID: "allowed-rename",
    relativePathComponents: ["round-trip.txt"],
    destinationPathComponents: ["round-trip-renamed.txt"]
  )?.status == .allowed
  let deleted = performReply(
    session,
    operation: .deleteFile,
    probeID: "allowed-delete",
    relativePathComponents: ["round-trip-renamed.txt"]
  )?.status == .allowed
  let roundTripAllowed = writeCreated
    && firstRead?.status == .allowed
    && firstRead?.payload == firstPayload
    && writeUpdated
    && secondRead?.status == .allowed
    && secondRead?.payload == secondPayload
    && renamed
    && deleted

  return [
    "probe=allowed-create-read-write-rename-delete result=\(roundTripAllowed ? "allowed" : "unavailable") category=\(roundTripAllowed ? "None" : "FilesystemDenied")",
    operationProbeResult(
      session,
      probe: "absolute",
      operation: .readFile,
      relativePathComponents: ["/absolute"],
      readLength: 1
    ),
    operationProbeResult(
      session,
      probe: "traversal",
      operation: .readFile,
      relativePathComponents: ["..", "outside-sentinel"],
      readLength: 1
    ),
    deniedReadAndWriteProbeResult(
      session,
      probe: "symlink",
      relativePathComponents: ["symlink"]
    ),
    deniedReadAndWriteProbeResult(
      session,
      probe: "hardlink",
      relativePathComponents: ["hardlink"]
    ),
    operationProbeResult(
      session,
      probe: "mount",
      operation: .readFile,
      relativePathComponents: ["mounted", "fixture"],
      readLength: 1
    ),
    operationProbeResult(
      session,
      probe: "unicode",
      operation: .readFile,
      relativePathComponents: ["e\u{301}.txt"],
      readLength: 1
    ),
    operationProbeResult(
      session,
      probe: "race",
      operation: .readFile,
      relativePathComponents: ["race-parent", "fixture"],
      readLength: 1
    ),
    operationProbeResult(
      session,
      probe: "archive",
      operation: .inspectArchive,
      payload: fixedStoredZIPCorpus()
    ),
    operationProbeResult(session, probe: "process", operation: .spawnProcess),
    operationProbeResult(session, probe: "loopback-network", operation: .connectLoopback),
    operationProbeResult(session, probe: "external-network", operation: .connectExternal),
  ]
}

private func writeProbeResults(_ results: [String]) {
  guard let directory = applicationSupportDirectory() else { return }
  do {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data("\(results.joined(separator: "\n"))\n".utf8).write(
      to: directory.appendingPathComponent("probe-results.txt"),
      options: .atomic
    )
  } catch {
    return
  }
}

private func finishProbeResults(_ results: [String]) -> Never {
  writeProbeResults(results)
  exit(EXIT_SUCCESS)
}

@main
struct OctantWorkConfinementGate {
  @MainActor
  static func main() {
    NSApplication.shared.setActivationPolicy(.accessory)
    guard let mode = CommandLine.arguments.dropFirst().first else {
      return
    }
    if mode == "hang" {
      signal(SIGTERM, SIG_IGN)
      RunLoop.current.run()
      exit(EXIT_FAILURE)
    }
    if mode == "select" {
      finishProbeResults(selectionLifecycleResults())
    }
    if mode == "authority-fresh" {
      finishProbeResults([authorityLifecycleResult(probe: "fresh-package-relaunch")])
    }
    if mode == "authority-stale" {
      finishProbeResults([authorityLifecycleResult(probe: "stale")])
    }
    if mode == "operations" {
      finishProbeResults(operationResults())
    }
    if mode == "revoke-state" {
      revokeStoredAuthority()
      finishProbeResults(["probe=state-cleanup result=clean category=None"])
    }
    guard mode == "authentication" else { return }
    var results: [String] = []
    let trustedSession = trustedPeerProbe()
    if trustedSession != nil {
      results.append("probe=trusted-peer result=allowed category=None")
    } else {
      results.append("probe=trusted-peer result=unavailable category=Unavailable")
    }
    if let trustedSession, let foreignResult = foreignClientProbe(trustedSession) {
      results.append(foreignResult)
    } else {
      results.append("probe=foreign-client result=unavailable category=Unavailable")
    }
    if let trustedSession, brokerRejectionEvidence(trustedSession) {
      results.append(
        "probe=broker-rejection-evidence result=allowed category=ExactRequirementInstalled"
      )
    } else {
      results.append("probe=broker-rejection-evidence result=unavailable category=Unavailable")
    }
    trustedSession?.connection.invalidate()
    finishProbeResults(results)
  }
}
