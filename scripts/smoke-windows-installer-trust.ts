/**
 * The update hand-off's signature check, run for real on Windows.
 *
 * Without Octant's certificate this cannot show an installer being accepted,
 * so it shows the two refusals that matter: the unsigned CI installer is
 * refused as unsigned and never started, and a program Windows itself signed
 * validly is refused as another publisher's. Both go through the same
 * checker, file writes and hash check an installed copy will use.
 *
 *   bun scripts/smoke-windows-installer-trust.ts <unsigned installer>
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import {
  createAuthenticodeReader,
  createNodeWindowsInstallerFiles,
  judgeAuthenticode,
  OCTANT_WINDOWS_PUBLISHER,
  runVerifiedInstaller,
} from "../apps/desktop/src/windowsInstallerUpdate";

const [installerPath] = process.argv.slice(2);
if (process.platform !== "win32" || installerPath === undefined) {
  throw new Error("Usage on Windows: smoke-windows-installer-trust.ts <unsigned installer>");
}
const read = createAuthenticodeReader();
const bytes = new Uint8Array(await readFile(installerPath));
let started = false;
const result = await runVerifiedInstaller({
  bytes,
  expectedSha256: createHash("sha256").update(bytes).digest("hex"),
  publisher: OCTANT_WINDOWS_PUBLISHER,
  files: createNodeWindowsInstallerFiles(),
  readSignature: read,
  launch: async () => {
    started = true;
  },
});
if (started || result.kind !== "untrusted-publisher" || result.reason !== "unsigned") {
  throw new Error(`The unsigned installer was not refused as unsigned: ${JSON.stringify(result)}`);
}

const systemProgram = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
const report = await read(systemProgram);
const verdict = judgeAuthenticode(report, OCTANT_WINDOWS_PUBLISHER);
if (
  report.kind !== "read" ||
  report.status !== "Valid" ||
  verdict.kind !== "refused" ||
  verdict.reason !== "other-publisher"
) {
  throw new Error(
    `A program Windows signed was not read as another publisher's: ${JSON.stringify(report)}`,
  );
}
console.log(
  JSON.stringify({
    unsignedInstallerRefused: true,
    otherPublisherRefused: true,
    systemProgramPublisher: report.publisher,
  }),
);
