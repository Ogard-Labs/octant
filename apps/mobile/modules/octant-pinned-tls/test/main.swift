// Runs one PinnedTlsExchange from the command line, so a test on a Mac can
// drive the phone's iOS exchange against a real listener. Reads one JSON
// object on stdin and writes the outcome as one JSON object on stdout. It
// is built only by that test; the app's pod includes only `ios/`.

import Foundation

struct Input: Decodable {
  let address: String
  let port: UInt16
  let serverName: String?
  let pins: [String]
  let request: String
}

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let input = try? JSONDecoder().decode(Input.self, from: data),
  let request = Data(base64Encoded: input.request)
else {
  FileHandle.standardError.write("unreadable input\n".data(using: .utf8)!)
  exit(2)
}
let exchange = PinnedTlsExchange(
  address: input.address, port: input.port, serverName: input.serverName, pins: input.pins,
  request: request)
let done = DispatchSemaphore(value: 0)
var output: [String: String] = [:]
exchange.start { outcome in
  switch outcome {
  case .responded(let servedPin, let response):
    output = [
      "status": "responded", "servedPin": servedPin, "response": response.base64EncodedString(),
    ]
  case .refused(let servedPin):
    output = ["status": "refused"]
    if let servedPin { output["servedPin"] = servedPin }
  case .failed(let reason):
    output = ["status": "failed", "reason": reason]
  }
  done.signal()
}
done.wait()
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: output))
