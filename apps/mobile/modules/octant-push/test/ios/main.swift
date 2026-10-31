// Runs one SealedNotificationOpener from the command line, so a test on a Mac
// can open what the host's sealer produced with the same Swift the phone's
// notification service extension runs. Reads one JSON object on stdin and
// writes one JSON line: the opened notification, or `{"status":"placeholder"}`.
// It is built only by that test; the app's pod includes only `ios/`.

import CryptoKit
import Foundation

struct Input: Decodable {
  let version: Int
  let hostId: String
  let deviceId: String
  /// The phone's raw X25519 private key, unpadded base64url.
  let privateKey: String
  let encapsulatedKey: String
  let ciphertext: String
}

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let input = try? JSONDecoder().decode(Input.self, from: data),
  let raw = SealedNotificationOpener.base64URLDecode(input.privateKey),
  let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
else {
  FileHandle.standardError.write(Data("unreadable input\n".utf8))
  exit(2)
}
let entry = NotificationKeyEntry(hostId: input.hostId, deviceId: input.deviceId, privateKey: key)
let opened = SealedNotificationOpener.open(
  version: input.version, encapsulatedKey: input.encapsulatedKey, ciphertext: input.ciphertext,
  entries: [entry])
let output: [String: String] =
  opened.map { ["status": "opened", "title": $0.title, "body": $0.body, "deepLink": $0.deepLink] }
  ?? ["status": "placeholder"]
var line = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
line.append(0x0A)
FileHandle.standardOutput.write(line)
