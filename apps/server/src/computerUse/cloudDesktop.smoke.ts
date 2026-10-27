/**
 * The maintainer's live smoke for a bundled desktop provider that runs
 * outside this host's own capsules: a cloud API, or a provider's local daemon.
 *
 * It runs the real lease service, the real host port (HTTPS or the local
 * daemon's Unix socket), and the bundled driver against the provider itself,
 * on the maintainer's own account. It is never run by tests or CI: a cloud
 * provider spends money, and a daemon provider boots a real VM. A cloud API
 * key is read from standard input, never from an argument or the
 * environment, and is held only in this process's memory, where the
 * credential broker would otherwise answer for it; a daemon provider reads
 * none, because its daemon holds the person's sign-in. A Project recipe is
 * supplied here because no host offers these providers to the recipe store
 * yet.
 *
 *   read -rs KEY; printf %s "$KEY" | bun run desktop:cloud:smoke e2b run
 *   read -rs KEY; printf %s "$KEY" | bun run desktop:cloud:smoke e2b kill
 *   read -rs KEY; printf %s "$KEY" | bun run desktop:cloud:smoke e2b restart
 *
 *   bun run desktop:cloud:smoke cua run
 *   bun run desktop:cloud:smoke cua kill
 *   bun run desktop:cloud:smoke cua restart
 *
 *   bun run desktop:cloud:smoke cua-other-machine run
 *   bun run desktop:cloud:smoke cua-other-machine kill
 *   bun run desktop:cloud:smoke cua-other-machine restart
 *
 * Cua needs a Linux host with Cua's daemon running as this user
 * (`cua daemon start`), signed in, and QEMU installed. `cua-other-machine`
 * also needs exactly one other machine of the same Cua account online and
 * set up with `cua host setup --provide-spaces`, with QEMU installed there;
 * its recipe names that machine, as a person would in the recipe editor.
 *
 * `run` acquires a desktop as a person who confirmed its provider,
 * placement, and machine, as a billed or off-machine one asks, reads a frame,
 * sends a person's click and text, sends a small app as the agent, launches,
 * observes, clicks, and types into it as the agent, extends the lease, then
 * releases it and asks the provider whether anything of this host remains.
 * `kill` acquires a desktop and kills this process with SIGKILL while it
 * runs. `restart` is the next host start: it reconciles from the journal and
 * the provider's tagged listing, then asks the provider again. The journal
 * and host tag live in a state directory that `kill` and `restart` share.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeDesktopCredentialRef,
  decodeDesktopHostTag,
  decodeDesktopRecipe,
  decodeEventActor,
  type DesktopPlacementId,
  type DesktopProviderId,
} from "@octant/contracts";
import { decodeComputerControlCommand } from "@octant/contracts/computer-use-plugin";
import type {
  DesktopDaemonPort,
  DesktopHttpsPort,
  DesktopProvider,
} from "@octant/plugin-api/desktop-provider";
import { createDesktopDaemonPort } from "./desktopDaemonPort";
import { createDesktopHttpsPort } from "./desktopHttpsPort";
import { createDesktopLeaseService } from "./desktopLeaseService";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  createE2bDesktopProvider,
  E2B_DESKTOP_HOSTS,
  E2B_DESKTOP_PROVIDER_ID,
} from "../plugins/e2bDesktop/e2bDesktopProvider";
import {
  createCuaDesktopProvider,
  CUA_DESKTOP_DAEMON,
  CUA_DESKTOP_PROVIDER_ID,
  CUA_OTHER_MACHINE_PLACEMENT,
  CUA_THIS_MACHINE_PLACEMENT,
} from "../plugins/cuaDesktop/cuaDesktopProvider";

type CloudDriver =
  | {
      readonly reach: "https";
      readonly id: DesktopProviderId;
      readonly hosts: ReadonlyArray<string>;
      readonly create: (https: DesktopHttpsPort) => DesktopProvider;
    }
  | {
      readonly reach: "daemon";
      readonly id: DesktopProviderId;
      readonly placementId: DesktopPlacementId;
      readonly create: (daemon: DesktopDaemonPort) => DesktopProvider;
    };

const DRIVERS: Readonly<Record<string, CloudDriver>> = {
  e2b: {
    reach: "https",
    id: E2B_DESKTOP_PROVIDER_ID,
    hosts: E2B_DESKTOP_HOSTS,
    create: (https) => createE2bDesktopProvider(https),
  },
  cua: {
    reach: "daemon",
    id: CUA_DESKTOP_PROVIDER_ID,
    placementId: CUA_THIS_MACHINE_PLACEMENT,
    create: (daemon) => createCuaDesktopProvider(daemon),
  },
  "cua-other-machine": {
    reach: "daemon",
    id: CUA_DESKTOP_PROVIDER_ID,
    placementId: CUA_OTHER_MACHINE_PLACEMENT,
    create: (daemon) => createCuaDesktopProvider(daemon),
  },
};

const [providerName = "", phase = ""] = process.argv.slice(2);
const driverEntry = DRIVERS[providerName];
if (driverEntry === undefined || !["run", "kill", "restart"].includes(phase)) {
  console.error(
    `usage: desktop:cloud:smoke <${Object.keys(DRIVERS).join("|")}> <run|kill|restart>`,
  );
  process.exit(2);
}
const cloud: CloudDriver = driverEntry;

const key = cloud.reach === "https" ? (await Bun.stdin.text()).trim() : "";
if (cloud.reach === "https" && key.length === 0) {
  console.error("Pipe the provider's API key on standard input.");
  process.exit(2);
}

const state = join(tmpdir(), `octant-cloud-desktop-smoke-${providerName}`);
mkdirSync(state, { recursive: true, mode: 0o700 });
const remembered = (name: string): string => {
  const path = join(state, name);
  if (!existsSync(path)) writeFileSync(path, randomUUID(), { mode: 0o600 });
  return readFileSync(path, "utf8").trim();
};
const hostTag = decodeDesktopHostTag(remembered("host-tag"));
const credentialRef = decodeDesktopCredentialRef(remembered("credential-ref"));
const threadId = remembered("thread-id");
const checkout = join(state, "checkout");
mkdirSync(checkout, { recursive: true });
// The app the agent sends: a shell script that keeps running so it can be observed.
writeFileSync(join(checkout, "octant-smoke-app"), "#!/bin/sh\nexec sleep 600\n");
chmodSync(join(checkout, "octant-smoke-app"), 0o755);

const connection = openSqlite(join(state, "journal.sqlite3"));
applyMigrations(connection, MIGRATIONS, () => new Date().toISOString());
const runtime = createPhase1RuntimeRegistries();
const journal = new Journal({
  connection,
  registry: runtime.events,
  projections: runtime.projections,
  clock: () => new Date().toISOString(),
});
for (const projection of runtime.projections.all()) {
  catchUpProjection({ connection, journal, projection, clock: () => new Date().toISOString() });
}
const projection = runtime.desktopLeaseProjection;

const driver =
  cloud.reach === "https"
    ? cloud.create(
        createDesktopHttpsPort({
          hosts: () => cloud.hosts,
          credentialPermitted: (ref) =>
            projection
              .list()
              .some(
                (record) =>
                  String(record.lease.providerId) === String(cloud.id) &&
                  String(record.lease.credentialRef ?? "") === String(ref),
              ),
          credential: async (ref) => (String(ref) === String(credentialRef) ? key : undefined),
        }),
      )
    : cloud.create(createDesktopDaemonPort({ daemon: () => CUA_DESKTOP_DAEMON }));
// A daemon provider's account is the placement its daemon is signed in to,
// never a key; a cloud provider's is the key piped in above.
const account = cloud.reach === "https" ? credentialRef : undefined;
/**
 * The machine a placement that chooses one runs on: the one online machine
 * this smoke's setup asks for, as a person would pick it in the recipe
 * editor. A restart only reconciles, so it names none.
 */
async function machineToName(): Promise<{ machineId: string; displayName: string } | undefined> {
  if (cloud.reach !== "daemon" || phase === "restart") return undefined;
  const choosing = driver.placements?.find(
    (placement) => String(placement.id) === String(cloud.placementId),
  );
  if (choosing?.choosesMachine !== true || driver.listMachines === undefined) return undefined;
  const listed = await driver.listMachines(cloud.placementId, new AbortController().signal);
  const online = listed.status === "listed" ? listed.machines.filter((each) => each.online) : [];
  const [only] = online;
  if (only === undefined || online.length !== 1) {
    console.error(`Expected exactly one other machine online: ${JSON.stringify(listed)}`);
    process.exit(2);
  }
  return { machineId: only.id, displayName: only.name || only.id };
}
const machine = await machineToName();
const recipe = decodeDesktopRecipe({
  providerId: String(cloud.id),
  ...(cloud.reach === "https"
    ? { credentialRef: String(credentialRef) }
    : { placementId: String(cloud.placementId) }),
  ...(machine === undefined ? {} : { machine }),
  screen: { width: 1024, height: 768 },
  network: "none",
  leaseMinutes: 10,
  maximumLeaseMinutes: 40,
  idleMinutes: 15,
});
const person = decodeEventActor({ kind: "local-user", actorId: randomUUID() });
const agent = decodeEventActor({
  kind: "agent",
  actorId: randomUUID(),
  providerInstanceId: randomUUID(),
  threadId,
});
const service = createDesktopLeaseService({
  journal,
  projection,
  hostTag,
  platform: process.platform,
  hasScreen: false,
  providers: () => [{ provider: driver, effective: true }],
  recipe: () => recipe,
  thread: () => ({ active: true, executionPolicy: "approval-gated" }),
  callerMayOpen: () => true,
  computerUseEnabled: () => true,
  confirm: async () => "declined",
  threadRoot: async () => checkout,
  confirmTransfer: async () => "approved",
  systemActor: decodeEventActor({ kind: "system", actorId: randomUUID() }),
  now: () => Date.now(),
  uuid: randomUUID,
  ...(process.getuid === undefined ? {} : { daemonUserId: process.getuid() }),
});
const owner = { mode: "code" as const, threadId };
const caller = { owner, actor: person, scopeId: "smoke-window" };

/**
 * Steps that did not answer as a working desktop would. The run still
 * releases and checks the provider after one, so a failure never leaves a
 * billed desktop behind, but it cannot end `PASS`: the live run is the only
 * evidence for the parts a recording cannot prove.
 */
const failedSteps: Array<string> = [];

function step(name: string, outcome: unknown, ok = true): void {
  console.log(`${ok ? "" : "FAILED "}${name}: ${JSON.stringify(outcome)}`);
  if (!ok) failedSteps.push(name);
}

/** Whether an `octant_computer` answer is the desktop doing what was asked. */
const controlAnswered = (outcome: { readonly status: string; readonly result?: unknown }) =>
  outcome.status === "answered" &&
  typeof outcome.result === "object" &&
  outcome.result !== null &&
  "kind" in outcome.result &&
  outcome.result.kind !== "refused" &&
  outcome.result.kind !== "failed";

/** Asks the provider itself whether any desktop of this host remains. */
async function remaining(): Promise<number> {
  const listed = await driver.listOwned(hostTag, account);
  step("provider listing for this host", listed);
  if (listed.status !== "listed")
    throw new Error("The provider could not list this host's desktops.");
  return listed.resources.length;
}

const reconciled = await service.start();
step("restart reconciliation", reconciled);

if (phase === "restart") {
  const left = await remaining();
  console.log(left === 0 ? "PASS: nothing of this host remains." : "FAIL: desktops remain.");
  process.exit(left === 0 ? 0 : 1);
}

const acquired = await service.acquire({
  ...caller,
  confirmedProvider: cloud.id,
  ...(cloud.reach === "daemon" ? { confirmedPlacement: cloud.placementId } : {}),
  ...(recipe.machine === undefined ? {} : { confirmedMachine: recipe.machine.machineId }),
});
step("acquire", acquired);
if (acquired.status !== "acquired") process.exit(1);
const leaseId = acquired.lease.leaseId;

if (phase === "kill") {
  console.log(
    `Killing this host with lease ${String(leaseId)} running. Run the restart phase next.`,
  );
  process.kill(process.pid, "SIGKILL");
}

const view = await service.openView({ ...caller, leaseId });
step("open view", view, view.status === "viewing");
if (view.status === "viewing") {
  const frame = await service.frame({ ...caller, leaseId, viewId: view.viewId });
  step(
    "person's frame",
    frame.status === "frame" ? { ...frame.frame, bytes: frame.frame.bytes.length } : frame,
    frame.status === "frame",
  );
  for (const event of [
    { kind: "pointer", action: "down", button: "left", x: 100, y: 100 },
    { kind: "pointer", action: "up", button: "left", x: 100, y: 100 },
    { kind: "text", text: "hello from Octant" },
  ] as const) {
    const delivered = await service.input({ ...caller, leaseId, viewId: view.viewId, event });
    step(`person's ${event.kind}`, delivered, delivered.status === "delivered");
  }
}

const agentCaller = { owner, actor: agent, leaseId };
const sent = await service.transfer({
  ...agentCaller,
  path: "octant-smoke-app",
  confirm: async () => "approved",
});
step("agent's send-file", sent, sent.status === "delivered");
const control = async (command: unknown) =>
  service.control({ ...agentCaller, command: decodeComputerControlCommand(command) });
const launched = await control({ operation: "launch", appId: "octant-smoke-app" });
step("agent's launch", launched, controlAnswered(launched));
const observed = await control({ operation: "observe", appId: "octant-smoke-app", windowId: 1 });
const observation =
  observed.status === "answered" && observed.result.kind === "observation"
    ? observed.result
    : undefined;
step(
  "agent's observe",
  observation === undefined ? observed : { image: observation.image?.data.length },
  observation?.image !== undefined,
);
if (observation !== undefined) {
  const clicked = await control({
    operation: "click",
    observationId: observation.observationId,
    x: 50,
    y: 50,
  });
  step("agent's click", clicked, controlAnswered(clicked));
  const typed = await control({
    operation: "type",
    observationId: observation.observationId,
    text: "typed",
  });
  step("agent's type", typed, controlAnswered(typed));
}

const extended = await service.extend({ ...caller, leaseId, byMinutes: 10 });
step("person's extension", extended, extended.status === "extended");
const released = await service.release({ ...caller, leaseId });
step("release", released, released.status === "released");
const left = await remaining();
if (left === 0 && failedSteps.length === 0) {
  console.log("PASS: every step answered, and nothing of this host remains.");
  process.exit(0);
}
console.log(
  left === 0
    ? `FAIL: nothing of this host remains, but these steps failed: ${failedSteps.join(", ")}.`
    : "FAIL: desktops remain.",
);
process.exit(1);
