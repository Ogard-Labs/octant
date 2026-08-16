import Foundation
import Security

let octantWorkConfinementProtocolVersion = 1
let octantWorkConfinementBrokerBundleIdentifier =
  "app.octant.desktop.work-confinement-gate.broker"
let octantWorkConfinementGateBundleIdentifier =
  "app.octant.desktop.work-confinement-gate"
let octantWorkConfinementForeignServiceIdentifier =
  "app.octant.desktop.work-confinement-gate.foreign-client"

enum OOConfinementSecurityError: Error {
  case code(OSStatus)
  case malformedSigningInformation
}

func exactCodeRequirement(executableURL: URL, identifier: String) throws -> String {
  var staticCode: SecStaticCode?
  let createStatus = SecStaticCodeCreateWithPath(executableURL as CFURL, [], &staticCode)
  guard createStatus == errSecSuccess, let staticCode else {
    throw OOConfinementSecurityError.code(createStatus)
  }
  var information: CFDictionary?
  let informationStatus = SecCodeCopySigningInformation(
    staticCode,
    SecCSFlags(rawValue: kSecCSSigningInformation),
    &information
  )
  guard
    informationStatus == errSecSuccess,
    let signingInformation = information as? [CFString: Any],
    signingInformation[kSecCodeInfoIdentifier] as? String == identifier,
    let cdhash = signingInformation[kSecCodeInfoUnique] as? Data,
    !cdhash.isEmpty
  else {
    if informationStatus != errSecSuccess {
      throw OOConfinementSecurityError.code(informationStatus)
    }
    throw OOConfinementSecurityError.malformedSigningInformation
  }
  let hexadecimalHash = cdhash.map { String(format: "%02x", $0) }.joined()
  return "identifier \"\(identifier)\" and cdhash H\"\(hexadecimalHash)\""
}

func constantTimeCapabilityMatch(_ candidate: Data, _ expected: Data) -> Bool {
  guard candidate.count == 32, expected.count == 32 else { return false }
  var difference: UInt8 = 0
  for index in 0..<32 { difference |= candidate[index] ^ expected[index] }
  return difference == 0
}

@objc(OOConfinementOperation)
enum OOConfinementOperation: Int {
  case establishAuthority = 0
  case readFile = 1
  case writeFile = 2
  case renameFile = 3
  case deleteFile = 4
  case revokeAuthority = 5
  case inspectArchive = 6
  case spawnProcess = 7
  case connectLoopback = 8
  case connectExternal = 9
}

@objc(OOConfinementStatus)
enum OOConfinementStatus: Int {
  case allowed = 0
  case denied = 1
  case stale = 2
  case unavailable = 3
  case clean = 4
}

@objc(OOConfinementCategory)
enum OOConfinementCategory: Int {
  case none = 0
  case unauthorized = 1
  case invalidRequest = 2
  case staleAuthority = 3
  case sandboxDenied = 4
  case filesystemDenied = 5
  case unavailable = 6
}

@objc(OOConfinementAuthorityMode)
enum OOConfinementAuthorityMode: Int {
  case authenticationOnly = 0
  case adoptSelectedRoot = 1
  case resumePersisted = 2
}

private func boundedComponents(_ components: [String]) -> Bool {
  components.count <= 64
    && components.allSatisfy { component in
      component.utf8.count <= 255
    }
}

private func decodedData(_ coder: NSCoder, key: String) -> Data? {
  coder.decodeObject(of: NSData.self, forKey: key) as Data?
}

@objc(OOConfinementAuthority)
final class OOConfinementAuthority: NSObject, NSSecureCoding {
  static var supportsSecureCoding: Bool { true }

  let protocolVersion: Int
  let mode: OOConfinementAuthorityMode
  let generation: UUID
  let capability: Data
  let transientBookmark: Data?

  init(
    mode: OOConfinementAuthorityMode,
    generation: UUID,
    capability: Data,
    transientBookmark: Data? = nil
  ) {
    precondition((mode == .adoptSelectedRoot) == (transientBookmark != nil))
    precondition(
      transientBookmark.map({ transientBookmark in
        transientBookmark.count <= 1_048_576
      }) ?? true
    )
    protocolVersion = octantWorkConfinementProtocolVersion
    self.mode = mode
    self.generation = generation
    self.capability = capability
    self.transientBookmark = transientBookmark
  }

  required init?(coder: NSCoder) {
    let version = coder.decodeInteger(forKey: "protocolVersion")
    guard
      version == octantWorkConfinementProtocolVersion,
      let mode = OOConfinementAuthorityMode(rawValue: coder.decodeInteger(forKey: "mode")),
      let generation = coder.decodeObject(of: NSUUID.self, forKey: "generation") as UUID?,
      let capability = decodedData(coder, key: "capability"),
      capability.count == 32
    else { return nil }
    let transientBookmark = decodedData(coder, key: "transientBookmark")
    guard
      transientBookmark.map({ transientBookmark in
        transientBookmark.count <= 1_048_576
      }) ?? true,
      (mode == .adoptSelectedRoot) == (transientBookmark != nil)
    else { return nil }
    protocolVersion = version
    self.mode = mode
    self.generation = generation
    self.capability = capability
    self.transientBookmark = transientBookmark
  }

  func encode(with coder: NSCoder) {
    coder.encode(protocolVersion, forKey: "protocolVersion")
    coder.encode(mode.rawValue, forKey: "mode")
    coder.encode(generation as NSUUID, forKey: "generation")
    coder.encode(capability, forKey: "capability")
    coder.encode(transientBookmark, forKey: "transientBookmark")
  }
}

@objc(OOConfinementRequest)
final class OOConfinementRequest: NSObject, NSSecureCoding {
  static var supportsSecureCoding: Bool { true }

  let protocolVersion: Int
  let operation: OOConfinementOperation
  let generation: UUID
  let capability: Data
  let relativePathComponents: [String]
  let destinationPathComponents: [String]?
  let payload: Data?
  let readOffset: UInt64
  let readLength: Int
  let probeID: String

  init(
    operation: OOConfinementOperation,
    generation: UUID,
    capability: Data,
    relativePathComponents: [String] = [],
    destinationPathComponents: [String]? = nil,
    payload: Data? = nil,
    readOffset: UInt64 = 0,
    readLength: Int = 0,
    probeID: String
  ) {
    protocolVersion = octantWorkConfinementProtocolVersion
    self.operation = operation
    self.generation = generation
    self.capability = capability
    self.relativePathComponents = relativePathComponents
    self.destinationPathComponents = destinationPathComponents
    self.payload = payload
    self.readOffset = readOffset
    self.readLength = readLength
    self.probeID = probeID
  }

  required init?(coder: NSCoder) {
    let version = coder.decodeInteger(forKey: "protocolVersion")
    guard
      version == octantWorkConfinementProtocolVersion,
      let operation = OOConfinementOperation(rawValue: coder.decodeInteger(forKey: "operation")),
      let generation = coder.decodeObject(of: NSUUID.self, forKey: "generation") as UUID?,
      let capability = decodedData(coder, key: "capability"),
      capability.count == 32,
      let components = coder.decodeObject(
        of: [NSArray.self, NSString.self],
        forKey: "relativePathComponents"
      ) as? [String],
      boundedComponents(components),
      let probeID = coder.decodeObject(of: NSString.self, forKey: "probeID") as String?,
      !probeID.isEmpty,
      probeID.utf8.count <= 64
    else { return nil }

    let destination = coder.decodeObject(
      of: [NSArray.self, NSString.self],
      forKey: "destinationPathComponents"
    ) as? [String]
    let payload = decodedData(coder, key: "payload")
    let readOffset = UInt64(bitPattern: coder.decodeInt64(forKey: "readOffset"))
    let readLength = coder.decodeInteger(forKey: "readLength")
    guard destination.map(boundedComponents) ?? true else { return nil }
    if let payload { guard payload.count <= 1_048_576 else { return nil } }
    switch operation {
    case .writeFile:
      guard
        payload != nil,
        destination == nil,
        !components.isEmpty,
        readOffset == 0,
        readLength == 0
      else { return nil }
    case .renameFile:
      guard
        payload == nil,
        destination?.isEmpty == false,
        !components.isEmpty,
        readOffset == 0,
        readLength == 0
      else { return nil }
    case .readFile:
      guard
        payload == nil,
        destination == nil,
        !components.isEmpty,
        readLength > 0,
        readLength <= 65_536
      else { return nil }
    case .deleteFile:
      guard
        payload == nil,
        destination == nil,
        !components.isEmpty,
        readOffset == 0,
        readLength == 0
      else { return nil }
    case .establishAuthority:
      guard
        payload != nil,
        destination == nil,
        components.isEmpty,
        readOffset == 0,
        readLength == 0
      else { return nil }
    case .revokeAuthority, .spawnProcess, .connectLoopback, .connectExternal:
      guard
        payload == nil,
        destination == nil,
        components.isEmpty,
        readOffset == 0,
        readLength == 0
      else { return nil }
    case .inspectArchive:
      guard
        payload != nil,
        destination == nil,
        components.isEmpty,
        readOffset == 0,
        readLength == 0
      else { return nil }
    }

    protocolVersion = version
    self.operation = operation
    self.generation = generation
    self.capability = capability
    relativePathComponents = components
    destinationPathComponents = destination
    self.payload = payload
    self.readOffset = readOffset
    self.readLength = readLength
    self.probeID = probeID
  }

  func encode(with coder: NSCoder) {
    coder.encode(protocolVersion, forKey: "protocolVersion")
    coder.encode(operation.rawValue, forKey: "operation")
    coder.encode(generation as NSUUID, forKey: "generation")
    coder.encode(capability, forKey: "capability")
    coder.encode(relativePathComponents, forKey: "relativePathComponents")
    coder.encode(destinationPathComponents, forKey: "destinationPathComponents")
    coder.encode(payload, forKey: "payload")
    coder.encode(Int64(bitPattern: readOffset), forKey: "readOffset")
    coder.encode(readLength, forKey: "readLength")
    coder.encode(probeID, forKey: "probeID")
  }
}

@objc(OOConfinementReply)
final class OOConfinementReply: NSObject, NSSecureCoding {
  static var supportsSecureCoding: Bool { true }

  let protocolVersion: Int
  let status: OOConfinementStatus
  let category: OOConfinementCategory
  let payload: Data?
  let opaqueFixtureToken: String?

  init(
    status: OOConfinementStatus,
    category: OOConfinementCategory,
    payload: Data? = nil,
    opaqueFixtureToken: String? = nil
  ) {
    protocolVersion = octantWorkConfinementProtocolVersion
    self.status = status
    self.category = category
    self.payload = payload
    self.opaqueFixtureToken = opaqueFixtureToken
  }

  required init?(coder: NSCoder) {
    let version = coder.decodeInteger(forKey: "protocolVersion")
    guard
      version == octantWorkConfinementProtocolVersion,
      let status = OOConfinementStatus(rawValue: coder.decodeInteger(forKey: "status")),
      let category = OOConfinementCategory(rawValue: coder.decodeInteger(forKey: "category"))
    else { return nil }
    let payload = decodedData(coder, key: "payload")
    guard payload.map({ payload in payload.count <= 65_536 }) ?? true else { return nil }
    let token = coder.decodeObject(of: NSString.self, forKey: "opaqueFixtureToken") as String?
    guard token.map({ token in token.utf8.count <= 64 }) ?? true else { return nil }
    protocolVersion = version
    self.status = status
    self.category = category
    self.payload = payload
    opaqueFixtureToken = token
  }

  func encode(with coder: NSCoder) {
    coder.encode(protocolVersion, forKey: "protocolVersion")
    coder.encode(status.rawValue, forKey: "status")
    coder.encode(category.rawValue, forKey: "category")
    coder.encode(payload, forKey: "payload")
    coder.encode(opaqueFixtureToken, forKey: "opaqueFixtureToken")
  }
}

@objc(OOConfinementBrokerProtocol)
protocol OOConfinementBrokerProtocol {
  func establish(
    _ authority: OOConfinementAuthority,
    withReply reply: @escaping (OOConfinementReply) -> Void
  )
  func perform(
    _ request: OOConfinementRequest,
    withReply reply: @escaping (OOConfinementReply) -> Void
  )
  func foreignProbeEndpoint(
    withReply reply: @escaping (NSXPCListenerEndpoint?, OOConfinementReply) -> Void
  )
  func attemptForeignProbe(
    _ endpoint: NSXPCListenerEndpoint,
    authority: OOConfinementAuthority,
    withReply reply: @escaping (OOConfinementReply) -> Void
  )
}

func octantWorkConfinementInterface() -> NSXPCInterface {
  let interface = NSXPCInterface(with: OOConfinementBrokerProtocol.self)
  interface.setClasses(
    NSSet(array: [OOConfinementAuthority.self]) as! Set<AnyHashable>,
    for: #selector(OOConfinementBrokerProtocol.establish(_:withReply:)),
    argumentIndex: 0,
    ofReply: false
  )
  interface.setClasses(
    NSSet(array: [OOConfinementReply.self]) as! Set<AnyHashable>,
    for: #selector(OOConfinementBrokerProtocol.establish(_:withReply:)),
    argumentIndex: 0,
    ofReply: true
  )
  interface.setClasses(
    NSSet(array: [OOConfinementRequest.self]) as! Set<AnyHashable>,
    for: #selector(OOConfinementBrokerProtocol.perform(_:withReply:)),
    argumentIndex: 0,
    ofReply: false
  )
  interface.setClasses(
    NSSet(array: [OOConfinementReply.self]) as! Set<AnyHashable>,
    for: #selector(OOConfinementBrokerProtocol.perform(_:withReply:)),
    argumentIndex: 0,
    ofReply: true
  )
  interface.setClasses(
    NSSet(array: [NSXPCListenerEndpoint.self]) as! Set<AnyHashable>,
    for: #selector(OOConfinementBrokerProtocol.foreignProbeEndpoint(withReply:)),
    argumentIndex: 0,
    ofReply: true
  )
  interface.setClasses(
    NSSet(array: [OOConfinementReply.self]) as! Set<AnyHashable>,
    for: #selector(OOConfinementBrokerProtocol.foreignProbeEndpoint(withReply:)),
    argumentIndex: 1,
    ofReply: true
  )
  interface.setClasses(
    NSSet(array: [NSXPCListenerEndpoint.self]) as! Set<AnyHashable>,
    for: #selector(OOConfinementBrokerProtocol.attemptForeignProbe(_:authority:withReply:)),
    argumentIndex: 0,
    ofReply: false
  )
  interface.setClasses(
    NSSet(array: [OOConfinementAuthority.self]) as! Set<AnyHashable>,
    for: #selector(OOConfinementBrokerProtocol.attemptForeignProbe(_:authority:withReply:)),
    argumentIndex: 1,
    ofReply: false
  )
  interface.setClasses(
    NSSet(array: [OOConfinementReply.self]) as! Set<AnyHashable>,
    for: #selector(OOConfinementBrokerProtocol.attemptForeignProbe(_:authority:withReply:)),
    argumentIndex: 0,
    ofReply: true
  )
  return interface
}
