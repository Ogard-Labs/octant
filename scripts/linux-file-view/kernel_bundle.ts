/** Exception-only diagnostics in the owned guest; never a production build. */
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
)
  throw Error("Diagnostic compilation requires the owned ephemeral guest directory.");
const prefix = `
let octantFailures = 16;
const octantFailureTrace = (event: string, values: unknown) => {
  if (process.argv[2] === "--bubblewrap" && octantFailures-- > 0)
    console.error("OCTANT_GUEST_BROKER_FAILURE " + JSON.stringify({event, values}));
};
`;
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "kernel_policy.ts")],
  target: "bun",
  compile: { outfile: output },
  plugins: [
    {
      name: "owned-guest-exceptions",
      setup(build) {
        build.onLoad({ filter: /\/src\/process\/linuxMediationBroker\.ts$/ }, async (input) => {
          let source = await Bun.file(input.path).text();
          let point = 0;
          source = source.replaceAll(/refuse\("broker-protocol"\)/g, (_match, offset: number) => {
            const id = ++point;
            console.log(
              JSON.stringify({
                diagnosticProtocolPoint: id,
                sourceLine: source.slice(0, offset).split("\n").length,
              }),
            );
            return `(octantFailureTrace("protocol", {point:${id},working,status:statusWait!==undefined,parent:parentWait!==undefined,previous:previousRequest.toString()}), refuse("broker-protocol"))`;
          });
          const anchor = 'epoch = snapshot.status === "ready" ? snapshot.epoch : 0n;';
          if (point === 0 || source.split(anchor).length !== 2)
            throw Error("Exact diagnostic source differs.");
          source = source.replace(
            anchor,
            `if (!allow) octantFailureTrace("denied-snapshot", {request: request.readBigUInt64LE(0).toString(),operation,status:snapshot.status,reason:snapshot.status==="unavailable"?snapshot.reason:"protected"}); ${anchor}`,
          );
          return { contents: prefix + source, loader: "ts" };
        });
      },
    },
  ],
});
if (!result.success) throw Error(`The guest diagnostic build failed: ${result.logs.join("\n")}`);
