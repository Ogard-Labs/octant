// Native smoke for a physical iPhone or iPad (docs/design/apple-devices.md,
// delivery slice 3). It drives the host's device service through the same
// confined launches the product uses: discovery, a person-confirmed lease, a
// development-signed build of the Simulator fixture run on the device, its
// console read, its stop, and the refusals of a foreign product and bundle.
//
// Run on a Mac with Xcode selected, a paired and unlocked device with
// Developer Mode on, and a development provisioning profile for
// `app.octant.simulatorfixture` installed by Xcode for your team:
//
//   OCTANT_APPLE_TEAM_ID=<team> [OCTANT_APPLE_DEVICE_NAME=<name>] bun run smoke:apple-device
//
// The thread scope is approval-gated and the smoke stands in for the person
// who answers the lease confirmation and each effect's approval, as the
// desktop dialog's receipt would; it prints every evidence record it got.
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_TOOL_HOST_ID,
  decodeAppleDeviceRequest,
  type AppleDeviceResponse,
  type ToolActionAuthority,
} from "../packages/contracts/src/index";
import { AppleDeviceLeases } from "../apps/server/src/apple/appleDeviceLeases";
import {
  AppleDeviceService,
  type AppleDeviceExecutionContext,
} from "../apps/server/src/apple/appleDeviceService";
import { AppleRuntimeStore } from "../apps/server/src/apple/appleRuntimeStore";
import { APPLE_TOOLCHAIN_HOST_READ_PATHS } from "../apps/server/src/apple/appleToolchainService";
import { RepositoryTestProcessPort } from "../apps/server/src/code/repositoryTestProcessPort";

const teamId = process.env.OCTANT_APPLE_TEAM_ID ?? "";
if (process.platform !== "darwin" || !/^[A-Z0-9]{10}$/.test(teamId)) {
  console.error("Run on a Mac with OCTANT_APPLE_TEAM_ID set to your 10-character team ID.");
  process.exit(2);
}
const deviceName = process.env.OCTANT_APPLE_DEVICE_NAME;
const bundleIdentifier = "app.octant.simulatorfixture";
const projectPath = "apps/server/src/apple/fixtures/SimulatorFixture/SimulatorFixture.xcodeproj";

const repositoryRoot = await realpath(process.cwd());
const stateRoot = await mkdtemp(join(tmpdir(), "octant-apple-device-smoke-"));
const store = new AppleRuntimeStore(stateRoot);
const appleProcess = new RepositoryTestProcessPort({
  receiptDirectory: join(stateRoot, "test-receipts"),
  literalReadPaths: APPLE_TOOLCHAIN_HOST_READ_PATHS,
  allowSimulatorControl: true,
});
const signingProcess = new RepositoryTestProcessPort({
  receiptDirectory: join(stateRoot, "signing-receipts"),
  literalReadPaths: APPLE_TOOLCHAIN_HOST_READ_PATHS,
  networkEgress: "none",
});
const journal: unknown[] = [];
const service = new AppleDeviceService({
  execute: (input, signal) => appleProcess.execute(input, signal),
  executeSigning: (input, signal) => signingProcess.execute(input, signal),
  outputDirectory: join(stateRoot, "devicectl"),
  artifactRoot: store.artifactRoot,
  signingDirectory: join(stateRoot, "signing"),
  provisioningProfileDirectories: [
    join(homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"),
    join(homedir(), "Library", "MobileDevice", "Provisioning Profiles"),
  ],
  isolatedRoots: [join(stateRoot, "captures")],
  identities: store,
  leases: new AppleDeviceLeases(),
  realpath,
  writeArtifact: (reference, bytes) => store.writeArtifact(reference, bytes),
  recordEvidence: (evidence) => journal.push(evidence),
  now: () => new Date().toISOString(),
  newId: randomUUID,
});

const authority: ToolActionAuthority = {
  hostId: LOCAL_TOOL_HOST_ID,
  mode: "code",
  projectId: "a2000000-0000-4000-8000-000000000001" as never,
  providerInstanceId: "a2000000-0000-4000-8000-000000000002" as never,
  extension: { kind: "core" },
};
const person = { kind: "local-user", actorId: "a2000000-0000-4000-8000-000000000005" } as const;
const threadId = "a2000000-0000-4000-8000-000000000003" as never;
const checkoutId = "a2000000-0000-4000-8000-000000000004" as never;
const scope: AppleDeviceExecutionContext = {
  authority,
  threadId,
  checkoutId,
  checkoutRoot: repositoryRoot,
  executionPolicy: "approval-gated",
  approvalValid: true,
  approvedBy: person as never,
};

let deviceId: string | undefined;
let launched = false;
const answers: Array<{ readonly step: string; readonly answer: AppleDeviceResponse }> = [];

async function ask(step: string, request: Record<string, unknown>): Promise<AppleDeviceResponse> {
  const answer = await service.request(
    decodeAppleDeviceRequest({
      actionId: randomUUID(),
      correlationId: randomUUID(),
      authority,
      threadId,
      checkoutId,
      requestedBy: person,
      timeoutMs: 15 * 60_000,
      approval: { kind: "approved", approvalId: randomUUID() },
      ...request,
    }),
    scope,
  );
  answers.push({ step, answer });
  return answer;
}

function requireEvidence(step: string, answer: AppleDeviceResponse) {
  if (answer.kind !== "apple-device-evidence" || answer.evidence.outcome !== "succeeded") {
    console.error(`APPLE_DEVICE_SMOKE_FAILURE=${JSON.stringify({ step, answer })}`);
    throw new Error(`Apple device ${step} did not succeed.`);
  }
  return answer.evidence;
}

function requireRefusal(step: string, answer: AppleDeviceResponse, reason: string): void {
  if (answer.kind !== "apple-device-refused" || answer.reason !== reason) {
    console.error(`APPLE_DEVICE_SMOKE_FAILURE=${JSON.stringify({ step, answer })}`);
    throw new Error(`Apple device ${step} was not refused as ${reason}.`);
  }
}

try {
  const discovery = await ask("discover", { kind: "discover" });
  if (discovery.kind !== "apple-device-discovery") throw new Error(JSON.stringify(discovery));
  console.info(`APPLE_DEVICE_SMOKE_DISCOVERY=${JSON.stringify(discovery.discovery)}`);
  const device = discovery.discovery.devices.find(
    (candidate) =>
      candidate.state === "connected" &&
      (deviceName === undefined || candidate.name === deviceName),
  );
  if (device === undefined) throw new Error("No connected device was discovered.");
  deviceId = device.deviceId;

  const lease = await ask("use-device", { kind: "use-device", deviceId });
  if (lease.kind !== "apple-device-leased") throw new Error(JSON.stringify(lease));

  const run = requireEvidence(
    "run",
    await ask("run", {
      kind: "run",
      deviceId,
      projectPath,
      scheme: "SimulatorFixture",
      configuration: "debug",
      teamId,
    }),
  );
  launched = true;
  await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  const logs = requireEvidence(
    "logs",
    await ask("logs", { kind: "logs", deviceId, bundleIdentifier }),
  );
  const consoleReference = logs.artifacts[0]?.reference;
  const printed =
    consoleReference === undefined ? undefined : await store.readArtifact(consoleReference);
  console.info(
    `APPLE_DEVICE_SMOKE_CONSOLE=${JSON.stringify(new TextDecoder().decode(printed ?? new Uint8Array()))}`,
  );
  requireEvidence(
    "terminate",
    await ask("terminate", { kind: "terminate", deviceId, bundleIdentifier }),
  );
  launched = false;

  requireRefusal(
    "install of a product no build held",
    await ask("install-foreign", {
      kind: "install",
      deviceId,
      artifact: "apple-device-product-not-built-here",
    }),
    "invalid-artifact",
  );
  requireRefusal(
    "launch of another app",
    await ask("launch-foreign", {
      kind: "launch",
      deviceId,
      bundleIdentifier: "com.apple.mobilesafari",
    }),
    "foreign-bundle",
  );
  // The installed fixture launches again from its own install, without a build.
  requireEvidence("launch", await ask("launch", { kind: "launch", deviceId, bundleIdentifier }));
  launched = true;

  console.info(
    `APPLE_DEVICE_SMOKE_EVIDENCE=${JSON.stringify({
      device: { model: device.model, osVersion: device.osVersion, connection: device.connection },
      signing: run.signing,
      journal,
    })}`,
  );
} finally {
  if (deviceId !== undefined && launched) {
    await ask("terminate", { kind: "terminate", deviceId, bundleIdentifier }).catch(
      () => undefined,
    );
  }
  if (deviceId !== undefined) {
    await ask("release-device", { kind: "release-device", deviceId }).catch(() => undefined);
  }
  await service.close();
  await rm(stateRoot, { recursive: true, force: true });
}
