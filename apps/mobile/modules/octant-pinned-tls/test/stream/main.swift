// Runs one PinnedTlsStream from the command line, so a test on a Mac can
// carry the phone's iOS stream through a real relay to a real listener. The
// first line on stdin is a JSON object naming the pins and the request; each
// later line is `{"push":"<base64>"}` with ciphertext from the listener, or
// `{"end":true}`. Each event goes out as one JSON line, as the module hands
// it to the app. It is built only by that test; the app's pod includes only
// `ios/`.

import Foundation

struct Start: Decodable {
  let serverName: String?
  let pins: [String]
  let request: String
}

struct Line: Decodable {
  let push: String?
  let end: Bool?
}

let output = DispatchQueue(label: "output")
func emit(_ line: [String: String]) {
  output.sync {
    var data = try! JSONSerialization.data(withJSONObject: line)
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
  }
}

guard let first = readLine(), let start = try? JSONDecoder().decode(Start.self, from: Data(first.utf8)),
  let request = Data(base64Encoded: start.request)
else {
  FileHandle.standardError.write("unreadable input\n".data(using: .utf8)!)
  exit(2)
}

let stream = PinnedTlsStream(serverName: start.serverName, pins: start.pins, request: request) {
  event in
  switch event {
  case .send(let chunk): emit(["status": "send", "chunk": chunk.base64EncodedString()])
  case .opened(let servedPin): emit(["status": "opened", "servedPin": servedPin])
  case .refused(let servedPin):
    var line = ["status": "refused"]
    if let servedPin { line["servedPin"] = servedPin }
    emit(line)
    exit(0)
  case .failed(let reason):
    emit(["status": "failed", "reason": reason])
    exit(0)
  case .data(let chunk): emit(["status": "data", "chunk": chunk.base64EncodedString()])
  case .end:
    emit(["status": "end"])
    exit(0)
  }
}
stream.begin()

Thread {
  while let text = readLine() {
    guard let line = try? JSONDecoder().decode(Line.self, from: Data(text.utf8)) else { continue }
    if let push = line.push, let chunk = Data(base64Encoded: push) { stream.receive(chunk) }
    if line.end == true { stream.receiveEnd() }
  }
  stream.receiveEnd()
}.start()
dispatchMain()
