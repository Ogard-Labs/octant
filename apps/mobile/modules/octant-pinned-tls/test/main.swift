// Runs one PinnedTlsExchange from the command line, so a test on a Mac can
// drive the phone's iOS exchange against a real listener. Reads one JSON
// object on stdin, then writes one JSON line for the opening and one per
// read until the reply ends. It is built only by that test; the app's pod
// includes only `ios/`.

import Foundation

struct Input: Decodable {
  let address: String
  let port: UInt16
  let serverName: String?
  let pins: [String]
  let request: String
}

func emit(_ line: [String: String]) {
  var data = try! JSONSerialization.data(withJSONObject: line)
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
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

func readNext() {
  exchange.read { next in
    switch next {
    case .data(let chunk):
      emit(["status": "data", "chunk": chunk.base64EncodedString()])
      readNext()
    case .end:
      emit(["status": "end"])
      exit(0)
    case .failed:
      emit(["status": "failed"])
      exit(0)
    }
  }
}

exchange.start { opening in
  switch opening {
  case .opened(let servedPin):
    emit(["status": "opened", "servedPin": servedPin])
    readNext()
  case .refused(let servedPin):
    var line = ["status": "refused"]
    if let servedPin { line["servedPin"] = servedPin }
    emit(line)
    exit(0)
  case .failed(let reason):
    emit(["status": "failed", "reason": reason])
    exit(0)
  }
}
dispatchMain()
