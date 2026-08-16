import Foundation

private final class ForeignClientProbe: NSObject, OOConfinementBrokerProtocol {
  func establish(
    _ authority: OOConfinementAuthority,
    withReply reply: @escaping (OOConfinementReply) -> Void
  ) {
    reply(OOConfinementReply(status: .denied, category: .unauthorized))
  }

  func foreignProbeEndpoint(
    withReply reply: @escaping (NSXPCListenerEndpoint?, OOConfinementReply) -> Void
  ) {
    reply(nil, OOConfinementReply(status: .denied, category: .unauthorized))
  }

  func attemptForeignProbe(
    _ endpoint: NSXPCListenerEndpoint,
    authority: OOConfinementAuthority,
    withReply reply: @escaping (OOConfinementReply) -> Void
  ) {
    let connection = NSXPCConnection(listenerEndpoint: endpoint)
    connection.remoteObjectInterface = octantWorkConfinementInterface()
    connection.resume()
    guard
      let broker = connection.remoteObjectProxyWithErrorHandler({ error in
        let cocoaError = error as NSError
        let evidence = cocoaError.domain == NSCocoaErrorDomain && cocoaError.code == 4097
          ? "NSXPCConnectionInterrupted4097"
          : "UnexpectedConnectionFailure"
        reply(
          OOConfinementReply(
            status: .denied,
            category: .unauthorized,
            opaqueFixtureToken: evidence
          )
        )
        connection.invalidate()
      }) as? OOConfinementBrokerProtocol
    else {
      reply(OOConfinementReply(status: .unavailable, category: .unavailable))
      connection.invalidate()
      return
    }
    broker.establish(authority) { response in
      reply(
        OOConfinementReply(
          status: response.status == .allowed ? .allowed : .denied,
          category: response.category,
          opaqueFixtureToken: "UnexpectedBrokerReply"
        )
      )
      connection.invalidate()
    }
  }

  func perform(
    _ request: OOConfinementRequest,
    withReply reply: @escaping (OOConfinementReply) -> Void
  ) {
    reply(OOConfinementReply(status: .denied, category: .unauthorized))
  }
}

private final class ForeignClientListenerDelegate: NSObject, NSXPCListenerDelegate {
  private let probe = ForeignClientProbe()

  func listener(
    _ listener: NSXPCListener,
    shouldAcceptNewConnection connection: NSXPCConnection
  ) -> Bool {
    connection.exportedInterface = octantWorkConfinementInterface()
    connection.exportedObject = probe
    connection.resume()
    return true
  }
}

@main
struct OctantWorkConfinementForeignClient {
  static func main() {
    let delegate = ForeignClientListenerDelegate()
    let listener = NSXPCListener.service()
    listener.delegate = delegate
    listener.resume()
    RunLoop.current.run()
  }
}
