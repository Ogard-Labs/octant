/** Bounded diagnostic build for the owned networkless guest only. */
import { isAbsolute, resolve, sep } from "node:path";

const output = process.argv[2];
const owned = process.env.RUNNER_TEMP;
if (
  process.platform !== "linux" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  output === undefined ||
  owned === undefined ||
  !isAbsolute(output) ||
  !resolve(output).startsWith(`${resolve(owned, "octant-kernel-guest")}${sep}`)
) {
  throw Error("Guest diagnostic compilation requires the owned ephemeral CI directory.");
}
const prefix = `
import { openSync as octantTraceOpen, writeSync as octantTraceWrite, closeSync as octantTraceClose } from "node:fs";
const octantTraceFd = process.argv[2] === "--bubblewrap" ? octantTraceOpen("/tmp/octant-broker-frames.trace", "w", 0o600) : undefined;
const octantTraceRing: string[] = [];
const octantGuestTrace = (event: string, values: unknown) => {
  if (octantTraceFd === undefined) return;
  octantTraceRing.push(JSON.stringify({ event, at: Math.round(performance.now()), values }) + "\\n");
  if (octantTraceRing.length > 128) octantTraceRing.shift();
  if (event === "close") octantTraceWrite(octantTraceFd, octantTraceRing.join(""));
};
process.once("exit", () => { if (octantTraceFd !== undefined) octantTraceClose(octantTraceFd); });
`;
const changes: ReadonlyArray<readonly [string, string]> = [
  [
    "const complete = (code: number | null) => {",
    'const complete = (code: number | null) => { octantGuestTrace("close", {code, working, refusal});',
  ],
  [
    "const refuse = (reason: BrokerRefusal) => {",
    'const refuse = (reason: BrokerRefusal) => { octantGuestTrace("refuse", {reason, working, status: statusWait !== undefined, parent: parentWait !== undefined});',
  ],
  [
    "const requestId = frame.readBigUInt64LE(0);",
    'const requestId = frame.readBigUInt64LE(0); octantGuestTrace("R", {request: requestId.toString(), operation: frame.readUInt32LE(32), working});',
  ],
  [
    "const snapshot = await readLinuxMediationPolicy(input.policy, namespace);",
    'const snapshot = await readLinuxMediationPolicy(input.policy, namespace); octantGuestTrace("snapshot", {status: snapshot.status, reason: snapshot.status === "unavailable" ? snapshot.reason : "ready"});',
  ],
  [
    "response.writeUInt32LE(allow ? 1 : 0, 17);",
    'octantGuestTrace("answer", {request: request.readBigUInt64LE(0).toString(), operation, allow, epoch: epoch.toString()}); response.writeUInt32LE(allow ? 1 : 0, 17);',
  ],
  [
    "statusWait.accept({",
    'octantGuestTrace("S", {epoch: frame.readBigUInt64LE(0).toString(), active: frame.readUInt32LE(8)}); statusWait.accept({',
  ],
  [
    "if (working || commandExit !== undefined) {",
    'octantGuestTrace("X", {code: frame.readUInt32LE(0), working}); if (working || commandExit !== undefined) {',
  ],
];
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "kernel_policy.ts")],
  target: "bun",
  compile: { outfile: output },
  plugins: [
    {
      name: "owned-guest-broker-frames",
      setup(build) {
        build.onLoad({ filter: /\/src\/process\/linuxMediationBroker\.ts$/ }, async (input) => {
          let source = await Bun.file(input.path).text();
          for (const [anchor, replacement] of changes) {
            if (source.split(anchor).length !== 2)
              throw Error("The exact guest diagnostic anchor differs.");
            source = source.replace(anchor, replacement);
          }
          return { contents: prefix + source, loader: "ts" };
        });
      },
    },
  ],
});
if (!result.success)
  throw Error(`The owned guest policy compilation failed: ${result.logs.join("\n")}`);
