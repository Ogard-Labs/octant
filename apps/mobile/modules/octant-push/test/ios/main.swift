// Runs DirectNotificationParser from the command line so a test on macOS can
// verify the exact Swift the keyless notification service extension runs. Reads
// one JSON object on stdin and writes one JSON line: parsed or placeholder.

import Foundation

let data = FileHandle.standardInput.readDataToEndOfFile()
guard
  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
  let octant = raw["octant"] as? [String: Any],
  let title = raw["title"] as? String,
  let body = raw["body"] as? String
else {
  FileHandle.standardError.write(Data("unreadable input\n".utf8))
  exit(2)
}
let forgotten = Set(raw["forgottenHosts"] as? [String] ?? [])
let parsed = DirectNotificationParser.parse(
  octant: octant, title: title, body: body, forgottenHosts: forgotten)
let output: [String: String] =
  parsed.map {
    [
      "status": "parsed",
      "hostId": $0.hostId,
      "kind": $0.kind,
      "title": $0.title,
      "body": $0.body,
      "deepLink": $0.deepLink,
    ]
  } ?? ["status": "placeholder"]
var line = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
line.append(0x0A)
FileHandle.standardOutput.write(line)
