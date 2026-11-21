import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeEventActor } from "@octant/contracts";
import {
  decodeMemberInstallRequestedPayload,
  decodeMemberInstallStepRecordedPayload,
  decodeMemberRemovalRequestedPayload,
  decodeMemberRemovalStepRecordedPayload,
  decodeMemberUpdateRequestedPayload,
  decodeMemberUpdateStepRecordedPayload,
  SHIELD_SERVERS_AGGREGATE,
  SHIELD_SERVERS_EVENT_NAMES,
  MemberInstallResult,
} from "@octant/contracts/shield-servers";
import { Schema } from "effect";
import { decodeHeadlessBuildRelease } from "@octant/contracts/app-updates";
import { canonicalHeadlessReleaseBytes } from "@octant/domain";
import {
  encodeHeadlessArtifactManifest,
  encodeHeadlessArtifactSignature,
  signHeadlessArtifactManifest,
  type HeadlessArtifactManifest,
  type ReleaseRing,
} from "@octant/host-runtime";
import { AGENT_ACCESS_ORIGIN } from "../clientPrincipal";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { ServerConnection } from "../serverProjects/serverConnection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createHeadlessBuilds, type HeadlessBuildFeed } from "./headlessBuilds";
import {
  MemberInstallService,
  MemberServerWork,
  type MemberInstallHub,
  type MemberInstallRequester,
} from "./memberInstall";
import { createMemberInstallRouteHandler, MEMBER_INSTALL_PATH } from "./memberInstallRoutes";
import {
  MemberUpkeepService,
  type MemberHelloReading,
  type MemberListener,
  type MemberUpkeepHub,
} from "./memberUpkeep";
import { ShieldServerStore } from "./shieldServerStore";

const scratches: string[] = [];
afterEach(() => {
  for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true });
});

function scratchDirectory(): string {
  const scratch = mkdtempSync(join(tmpdir(), "octant-member-install-"));
  scratches.push(scratch);
  return scratch;
}

const JOIN_CODE = "octant-pair:1:join-code-that-must-never-be-journaled";
const COMPARISON_CODE = "482913";
const TICKET_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const PAIRED_DEVICE = "8d7f5e1c-2b3a-4c5d-8e6f-7a8b9c0d1e2f";
const decodeMemberInstallResult = Schema.decodeUnknownSync(MemberInstallResult);

/**
 * The stand-in Octant CLI the build carries. It records each call in
 * `$HOME/octant-calls.log` and does what the real one would to the login's
 * folders, and its `hub join` prints a comparison code and waits for this
 * computer's approval, which the stand-in hub writes as `$HOME/approved`.
 * Its `server upgrade` swaps the `current` link, and when `$HOME/unhealthy`
 * exists it fails its health check and puts the previous version back, as
 * the real one does.
 */
const STAND_IN_CLI = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/octant-calls.log"
version_of() { sed -n 's/.*"artifactVersion": *"\\([^"]*\\)".*/\\1/p' "$1/octant-artifact.json"; }
case "$1 $2" in
  "server install")
    artifact=$4; root=$6; v=$(version_of "$artifact")
    [ -f "$artifact/octant-artifact.sig" ] || { echo "Octant refuses an unsigned build." >&2; exit 1; }
    mkdir -p "$root/versions/$v" && cp -R "$artifact/." "$root/versions/$v/" && ln -sfn "$root/versions/$v" "$root/current"
    echo "Octant $v installed at $root." ;;
  "server upgrade")
    artifact=$4; root=$6; v=$(version_of "$artifact"); from=$(readlink "$root/current")
    [ -f "$artifact/octant-artifact.sig" ] || { echo "Octant refuses an unsigned build." >&2; exit 1; }
    [ -e "$root/versions/$v" ] && { echo "Octant version $v is already installed; refusing to overwrite it." >&2; exit 1; }
    mkdir -p "$root/versions/$v" && cp -R "$artifact/." "$root/versions/$v/" && ln -sfn "$root/versions/$v" "$root/current"
    if [ -f "$HOME/unhealthy" ]; then
      ln -sfn "$from" "$root/current"
      echo "Octant $v failed its health check and was rolled back to \${from##*/}." >&2
      exit 1
    fi
    echo "Octant upgraded from \${from##*/} to $v." ;;
  "server enable")
    mkdir -p "$HOME/.config/systemd/user" && echo "[Unit]" > "$HOME/.config/systemd/user/octant.service"
    echo "enabled" ;;
  "server start") echo "ready" ;;
  "server stop") echo "stopped" ;;
  "server disable")
    if [ "$3" = "--remove-service" ]; then rm -f "$HOME/.config/systemd/user/octant.service"; fi
    echo "disabled" ;;
  "server uninstall")
    root=$4; rm -rf "$root"; echo "Octant uninstalled from $root; user data preserved."
    if [ "$5" = "--remove-data" ]; then
      [ "$7" = "$HOME/.local/share/octant" ] || { echo "User-data removal requires confirming the exact canonical data directory path." >&2; exit 1; }
      rm -rf "$7"; echo "Octant user data removed from $7."
    fi ;;
  "hub leave") echo "Left the hub." ;;
  "listener enable") echo "listening on $4:$6" ;;
  "hub join")
    # The real CLI reads the code from standard input when given a dash.
    if [ "$3" = "-" ]; then IFS= read -r code; else code=$3; fi
    printf '%s\\n' "$code" > "$HOME/join-code-received"
    echo "Hub Test hub"
    echo "Comparison code ${COMPARISON_CODE}"
    echo "Approve on the hub only if the comparison code matches. Waiting for approval..."
    n=0
    while [ ! -f "$HOME/approved" ]; do
      n=$((n+1)); [ "$n" -gt 100 ] && { echo "The hub did not approve." >&2; exit 1; }
      sleep 0.05
    done
    echo "Joined Test hub." ;;
  *) echo "unknown command: $*" >&2; exit 2 ;;
esac
`;

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

/** A headless build for linux-x64 signed with `signingKey`, packed as the release names it. */
function signedBuild(
  folder: string,
  signingKey: string,
  version = "1.2.3",
  storeVersion = 1,
  ring: ReleaseRing = "preview",
): string {
  const work = scratchDirectory();
  const name = `octant-${version}-linux-x64`;
  const root = join(work, name);
  const files: ReadonlyArray<
    readonly [HeadlessArtifactManifest["components"][number]["role"], string, string, number]
  > = [
    ["cli", "bin/octant", STAND_IN_CLI, 0o755],
    ["server", "lib/server/main.mjs", "console.log('server');\n", 0o644],
    ["web-assets", "share/web/index.html", "<html></html>\n", 0o644],
    ["native-module", "lib/native/better_sqlite3.node", "native-bytes", 0o755],
    ["migrations", "share/migrations.json", '{"storeVersion":1}\n', 0o644],
    ["notices", "share/NOTICES.txt", "third-party notices\n", 0o644],
    ["service-template", "share/service/octant.service.template", "[Unit]\n", 0o644],
    ["runtime", "lib/runtime/bun", "runtime-bytes", 0o755],
  ];
  const components = files.map(([role, path, body, mode]) => {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, body);
    chmodSync(destination, mode);
    return {
      role,
      path,
      sha256: createHash("sha256").update(body).digest("hex"),
      byteLength: Buffer.byteLength(body),
      ...(role === "server" || role === "cli" || role === "web-assets" ? { version } : {}),
    };
  });
  const manifest: HeadlessArtifactManifest = {
    schemaVersion: 1,
    product: "octant",
    artifactVersion: version,
    target: { platform: "linux", arch: "x64" },
    wireVersion: "1",
    storeVersion,
    components,
  };
  writeFileSync(join(root, "octant-artifact.json"), encodeHeadlessArtifactManifest(manifest));
  writeFileSync(
    join(root, "octant-artifact.sig"),
    encodeHeadlessArtifactSignature(signHeadlessArtifactManifest(manifest, ring, signingKey)),
  );
  mkdirSync(folder, { recursive: true });
  const tarball = join(folder, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", tarball, "-C", work, name]);
  return tarball;
}

/**
 * A stand-in server: `ssh` runs the remote command in `sh` with `$HOME` set to
 * the server's home and stand-ins for `uname`, `ip` and `loginctl` first on
 * its PATH, so the probe reads a Linux x64 machine with the addresses given.
 */
function standInServer(addresses: ReadonlyArray<string>) {
  const scratch = scratchDirectory();
  const bin = join(scratch, "bin");
  const home = join(scratch, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("uname", 'if [ "$1" = "-s" ]; then echo Linux; else echo "Linux x86_64"; fi');
  script(
    "ip",
    [
      "echo '1: lo    inet 127.0.0.1/8 scope host lo'",
      ...addresses.map(
        (address, index) =>
          `echo '${String(index + 2)}: eth${String(index)}    inet ${address}/24 scope global eth${String(index)}'`,
      ),
    ].join("\n"),
  );
  script("loginctl", "echo no");
  const ssh = join(scratch, "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const env = { PATH: ${JSON.stringify(bin)} + ':' + process.env.PATH, HOME: ${JSON.stringify(home)} };
const child = spawn('sh', ['-c', process.argv[process.argv.length - 1]], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));`,
  );
  chmodSync(ssh, 0o700);
  const connection = new ServerConnection({
    sshPath: ssh,
    agentSocket: () => undefined,
    controlDirectory: () => scratch,
  });
  const calls = () =>
    existsSync(join(home, "octant-calls.log"))
      ? readFileSync(join(home, "octant-calls.log"), "utf8")
      : "";
  return { connection, home, calls, state: join(home, ".local", "state", "octant") };
}

function openJournal() {
  const connection = openSqlite(join(scratchDirectory(), "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => "2026-11-20T12:00:00.000Z");
  const runtime = createPhase1RuntimeRegistries();
  return new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date().toISOString(),
  });
}

/**
 * The hub on this computer as the install sees it: it mints one code for one
 * ticket, and holds a claim on that ticket whose comparison code is
 * `claimCode`, as the pairing service would derive it.
 */
function standInHub(home: string, claimCode: string | undefined = COMPARISON_CODE) {
  const decisions: Array<{ readonly ticketId: string; readonly decision: string }> = [];
  const hub: MemberInstallHub = {
    readiness: () => ({ status: "ready", hubName: "Studio" }),
    mintJoinCode: () => ({ status: "minted", code: JOIN_CODE, ticketId: TICKET_ID }),
    pendingComparisonCode: (ticketId) => (ticketId === TICKET_ID ? claimCode : undefined),
    approve: (ticketId) => {
      decisions.push({ ticketId, decision: "approved" });
      writeFileSync(join(home, "approved"), "");
      return true;
    },
    deny: (ticketId) => {
      decisions.push({ ticketId, decision: "denied" });
    },
  };
  return { hub, decisions };
}

/**
 * The hub as an update and a removal see it. The member's signed hello names
 * the version its `current` link points at, with the protocol range the test
 * sets, unless the test makes it unreachable or unproven.
 */
function standInUpkeepHub(state: string) {
  const hello: {
    answer: "signed" | "unreachable" | "unproven";
    protocolRange: { readonly min: number; readonly max: number };
  } = { answer: "signed", protocolRange: { min: 1, max: 1 } };
  const removed: MemberListener[] = [];
  const hub: MemberUpkeepHub = {
    listed: () => true,
    readHello: async (): Promise<MemberHelloReading> => {
      if (hello.answer !== "signed") return { status: hello.answer };
      return {
        status: "read",
        buildVersion: basename(readlinkSync(join(state, "install", "current"))),
        protocolRange: hello.protocolRange,
      };
    },
    removeMember: async (listener) => {
      removed.push(listener);
      return "removed";
    },
  };
  return { hub, hello, removed };
}

function setUp(
  options: {
    readonly addresses?: ReadonlyArray<string>;
    readonly claimCode?: string;
    readonly trusted?: boolean;
    /** The build the person placed on this computer, or none. */
    readonly placed?: "1.2.3" | "none";
    /** Where this computer downloads builds from; none by default. */
    readonly feed?: (keys: {
      readonly releaseKey: ReturnType<typeof keyPair>;
      readonly otherKey: ReturnType<typeof keyPair>;
    }) => HeadlessBuildFeed;
  } = {},
) {
  const server = standInServer(options.addresses ?? ["100.101.102.103", "192.168.1.20"]);
  const releaseKey = keyPair();
  const otherKey = keyPair();
  const builds = join(scratchDirectory(), "headless-builds");
  if (options.placed !== "none") {
    signedBuild(
      builds,
      options.trusted === false ? otherKey.privateKeyBase64 : releaseKey.privateKeyBase64,
    );
  }
  const journal = openJournal();
  const store = new ShieldServerStore({
    journal,
    personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => "2026-11-20T12:00:00.000Z",
  });
  store.load();
  store.register({
    server: { alias: "devbox", user: "build", profile: "operate", deployCommands: [] },
    principal: "local-window",
  });
  const serverId = String(store.servers()[0]?.serverId);
  const { hub, decisions } = standInHub(server.home, options.claimCode);
  const headlessBuilds = createHeadlessBuilds({
    folder: builds,
    trustedKeys: {
      stable: [],
      preview: [releaseKey.publicKeyBase64],
      candidate: [releaseKey.publicKeyBase64],
    },
    ...(options.feed === undefined ? {} : { feed: options.feed({ releaseKey, otherKey }) }),
  });
  const work = new MemberServerWork();
  const service = new MemberInstallService({
    servers: () => store.servers(),
    connection: server.connection,
    builds: headlessBuilds,
    work,
    hub,
    journal: store,
    uuid: randomUUID,
    now: Date.now,
    sleep: (milliseconds) => new Promise((done) => setTimeout(done, Math.min(milliseconds, 50))),
    joinClaimMs: 10_000,
    joinFinishMs: 10_000,
  });
  const upkeepHub = standInUpkeepHub(server.state);
  const upkeep = new MemberUpkeepService({
    servers: () => store.servers(),
    connection: server.connection,
    builds: headlessBuilds,
    hub: upkeepHub.hub,
    journal: store,
    work,
    protocolVersion: 1,
    uuid: randomUUID,
    now: Date.now,
    sleep: (milliseconds) => new Promise((done) => setTimeout(done, Math.min(milliseconds, 50))),
    helloWaitMs: 500,
  });
  const records = () =>
    journal
      .replayAggregateType({
        aggregateType: SHIELD_SERVERS_AGGREGATE,
        afterSequence: 0,
        limit: 100,
      })
      .filter((envelope) => String(envelope.aggregateId) === serverId);
  return {
    server,
    service,
    upkeep,
    upkeepHub,
    store,
    serverId,
    decisions,
    records,
    builds,
    otherKey,
    releaseKey,
    journal,
  };
}

const person: MemberInstallRequester = {
  kind: "person",
  actor: decodeEventActor({ kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID }),
};

const PERSON_PAIRED = { origin: "https://phone.example", admittedBy: "host-person" } as const;

/** One request to the route from a paired device, authenticated as the remote listener binds it. */
async function askAsDevice(
  setup: ReturnType<typeof setUp>,
  principal: { readonly origin: string; readonly admittedBy?: string },
  body: unknown,
): Promise<Response> {
  const route = createMemberInstallRouteHandler({
    windowAuthorityStore: new WindowAuthorityStore(),
    service: setup.service,
    upkeep: setup.upkeep,
  });
  const request = new Request(`http://127.0.0.1${MEMBER_INSTALL_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  bindPrincipalRouteContext(request, {
    principal: {
      kind: "remote-device",
      hostId: "11111111-1111-4111-8111-111111111111",
      deviceId: PAIRED_DEVICE,
      credentialGeneration: 1,
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId: "55000000-0000-4000-8000-0000000000aa",
      ...principal,
    } as never,
    scopeId: PAIRED_DEVICE as never,
  });
  const response = await route(request);
  if (response === undefined) throw new Error("The route did not answer.");
  return response;
}

function planOf(result: MemberInstallResult) {
  if (result.kind !== "member-install-plan") throw new Error(JSON.stringify(result));
  return result.plan;
}

async function installOver(
  setup: ReturnType<typeof setUp>,
  requester: MemberInstallRequester = person,
) {
  const plan = planOf(await setup.service.prepare(setup.serverId, requester));
  const confirmed = await setup.service.confirm(
    { planId: String(plan.planId), listenAddress: "100.101.102.103" },
    requester,
  );
  if (confirmed.kind !== "member-install-progress") throw new Error(JSON.stringify(confirmed));
  return { plan, progress: await settled(setup, String(confirmed.progress.installId)) };
}

/** Reads an install's steps, as the sheet does, until it stops running. */
async function settled(setup: ReturnType<typeof setUp>, installId: string) {
  for (;;) {
    const read = setup.service.progress(installId, person);
    if (read.kind !== "member-install-progress") throw new Error(JSON.stringify(read));
    if (read.progress.state !== "running") return read.progress;
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe("making a registered server an Octant computer over SSH", () => {
  it("installs, starts and joins a computer over SSH after one confirmation", async () => {
    const setup = setUp();
    const plan = planOf(await setup.service.prepare(setup.serverId, person));
    // Preparing reads the server and changes nothing on it.
    expect(setup.server.calls()).toBe("");
    expect(existsSync(setup.server.state)).toBe(false);
    expect(plan).toMatchObject({
      alias: "devbox",
      user: "build",
      system: "Linux x86_64",
      target: "linux-x64",
      artifactVersion: "1.2.3",
      ring: "preview",
      signature: "verified",
      installRoot: `${setup.server.state}/install`,
      service: "systemd-user",
      startsAtBoot: false,
      bootCommand: "sudo loginctl enable-linger build",
      addresses: [
        { address: "100.101.102.103", network: "tailscale" },
        { address: "192.168.1.20", network: "lan-private" },
      ],
      listenPort: 8443,
      joins: { kind: "hub", hubName: "Studio" },
    });

    const confirmed = await setup.service.confirm(
      { planId: String(plan.planId), listenAddress: "100.101.102.103" },
      person,
    );
    expect(confirmed.kind).toBe("member-install-progress");
    if (confirmed.kind !== "member-install-progress") return;
    const progress = await settled(setup, String(confirmed.progress.installId));
    expect(progress?.state).toBe("joined");
    expect(progress?.steps.map((step) => [step.step, step.state])).toEqual([
      ["copy", "succeeded"],
      ["verify", "succeeded"],
      ["install", "succeeded"],
      ["start", "succeeded"],
      ["listen", "succeeded"],
      ["join", "succeeded"],
    ]);
    const root = `${setup.server.state}/install`;
    expect(setup.server.calls().trim().split("\n")).toEqual([
      expect.stringMatching(new RegExp(`^server install --artifact /.+ --install-root ${root}$`)),
      "server enable",
      "server start",
      "listener enable --hostname 100.101.102.103 --port 8443",
      // The code reaches the CLI on standard input, never as an argument.
      "hub join - --items roster,introduce,owners",
    ]);
    expect(setup.server.calls()).not.toContain(JOIN_CODE);
    expect(existsSync(join(root, "current", "bin", "octant"))).toBe(true);
    expect(readFileSync(join(setup.server.home, "join-code-received"), "utf8").trim()).toBe(
      JOIN_CODE,
    );
    expect(setup.decisions).toEqual([{ ticketId: TICKET_ID, decision: "approved" }]);
    // The confirmation was spent: the same sheet cannot run twice.
    expect(
      await setup.service.confirm(
        { planId: String(plan.planId), listenAddress: "100.101.102.103" },
        person,
      ),
    ).toMatchObject({ reason: "plan-expired" });
  });

  it("refuses an artifact whose signature does not verify, and changes nothing on the server", async () => {
    const untrusted = setUp({ trusted: false });
    const refusal = await untrusted.service.prepare(untrusted.serverId, person);
    expect(refusal).toMatchObject({ kind: "member-install-refused", reason: "build-unverified" });
    expect(untrusted.server.calls()).toBe("");
    expect(existsSync(untrusted.server.state)).toBe(false);
    expect(untrusted.records()).toEqual([]);

    // A build swapped for one no trusted key signed after the sheet was read
    // is refused at the confirmation, before anything is copied or journaled.
    const swapped = setUp();
    const plan = planOf(await swapped.service.prepare(swapped.serverId, person));
    signedBuild(swapped.builds, swapped.otherKey.privateKeyBase64);
    expect(
      await swapped.service.confirm(
        { planId: String(plan.planId), listenAddress: "100.101.102.103" },
        person,
      ),
    ).toMatchObject({ kind: "member-install-refused", reason: "build-unverified" });
    expect(swapped.server.calls()).toBe("");
    expect(existsSync(swapped.server.state)).toBe(false);
    expect(swapped.records()).toEqual([]);
  });

  it("refuses a server with no private address, naming what to set up", async () => {
    const setup = setUp({ addresses: ["203.0.113.7"] });
    const refusal = await setup.service.prepare(setup.serverId, person);
    expect(refusal).toMatchObject({ kind: "member-install-refused", reason: "no-private-address" });
    expect(refusal.kind === "member-install-refused" && refusal.message).toContain(
      "Connect devbox to Tailscale or your local network",
    );
    expect(setup.server.calls()).toBe("");
  });

  it("a join approved from the sheet is bound to the comparison code read over SSH", async () => {
    const mismatched = setUp({ claimCode: "111111" });
    const { progress } = await installOver(mismatched);
    expect(progress?.state).toBe("failed");
    expect(progress?.steps.at(-1)).toMatchObject({ step: "join", state: "failed" });
    expect(progress?.steps.at(-1)?.message).toContain(COMPARISON_CODE);
    // The claim whose code differs is refused, never approved.
    expect(mismatched.decisions).toEqual([{ ticketId: TICKET_ID, decision: "denied" }]);
    expect(existsSync(join(mismatched.server.home, "approved"))).toBe(false);

    const matched = setUp();
    await installOver(matched);
    expect(matched.decisions).toEqual([{ ticketId: TICKET_ID, decision: "approved" }]);
  });

  it("the request and each step are journaled with the actor", async () => {
    const setup = setUp();
    // Prepared and confirmed from a device the person paired, through the route.
    const prepared = planOf(
      decodeMemberInstallResult(
        await (
          await askAsDevice(setup, PERSON_PAIRED, {
            kind: "prepare-member-install",
            serverId: setup.serverId,
          })
        ).json(),
      ),
    );
    const confirmed = decodeMemberInstallResult(
      await (
        await askAsDevice(setup, PERSON_PAIRED, {
          kind: "confirm-member-install",
          planId: prepared.planId,
          listenAddress: "100.101.102.103",
        })
      ).json(),
    );
    if (confirmed.kind !== "member-install-progress") throw new Error(JSON.stringify(confirmed));
    const progress = await settled(setup, String(confirmed.progress.installId));
    expect(progress.state).toBe("joined");
    const records = setup.records().filter((envelope) => envelope.eventName.includes("member"));
    const deviceActor = decodeEventActor({
      kind: "remote-device",
      actorId: PAIRED_DEVICE,
      deviceId: PAIRED_DEVICE,
    });
    expect(records.map((envelope) => envelope.actor)).toEqual(
      Array.from({ length: 7 }, () => deviceActor),
    );
    const [requested, ...steps] = records;
    expect(requested?.eventName).toBe(SHIELD_SERVERS_EVENT_NAMES.memberInstallRequested);
    expect(decodeMemberInstallRequestedPayload(requested?.payload)).toMatchObject({
      serverId: setup.serverId,
      target: "linux-x64",
      artifactVersion: "1.2.3",
      ring: "preview",
      listenAddress: "100.101.102.103",
      listenPort: 8443,
      joins: "hub",
    });
    expect(
      steps.map((envelope) => {
        expect(envelope.eventName).toBe(SHIELD_SERVERS_EVENT_NAMES.memberInstallStepRecorded);
        const payload = decodeMemberInstallStepRecordedPayload(envelope.payload);
        return [payload.step, payload.outcome];
      }),
    ).toEqual([
      ["copy", "succeeded"],
      ["verify", "succeeded"],
      ["install", "succeeded"],
      ["start", "succeeded"],
      ["listen", "succeeded"],
      ["join", "succeeded"],
    ]);
    // No join code, ticket or comparison code is ever journaled.
    const journaled = JSON.stringify(records);
    expect(journaled).not.toContain(JOIN_CODE);
    expect(journaled).not.toContain(TICKET_ID);
    expect(journaled).not.toContain(COMPARISON_CODE);
    // A failed step is journaled with its reason, and nothing after it runs.
    const failing = setUp({ claimCode: "111111" });
    await installOver(failing);
    const last = failing.records().at(-1);
    expect(decodeMemberInstallStepRecordedPayload(last?.payload)).toMatchObject({
      step: "join",
      outcome: "failed",
      failure: "comparison-mismatch",
    });
  });

  it("a paired device that is not the host's person, a routine, and an agent are refused", async () => {
    const setup = setUp();
    const plan = planOf(await setup.service.prepare(setup.serverId, person));
    for (const requester of [
      { kind: "restricted-device" },
      { kind: "routine" },
      { kind: "agent-grant" },
    ] satisfies ReadonlyArray<MemberInstallRequester>) {
      expect(await setup.service.prepare(setup.serverId, requester)).toMatchObject({
        kind: "member-install-refused",
        reason: "not-the-person",
      });
      expect(
        await setup.service.confirm(
          { planId: String(plan.planId), listenAddress: "100.101.102.103" },
          requester,
        ),
      ).toMatchObject({ kind: "member-install-refused", reason: "not-the-person" });
    }
    // The route reads who is asking from the authenticated principal: a
    // device the hub's roster introduced and an agent grant's session are not
    // the person, and a device the person paired is.
    const prepare = { kind: "prepare-member-install", serverId: setup.serverId };
    const ask = (principal: { readonly origin: string; readonly admittedBy?: string }) =>
      askAsDevice(setup, principal, prepare);
    expect((await ask({ origin: "https://phone.example", admittedBy: "hub-roster" })).status).toBe(
      403,
    );
    expect((await ask({ origin: AGENT_ACCESS_ORIGIN, admittedBy: "host-person" })).status).toBe(
      403,
    );
    expect(setup.server.calls()).toBe("");
    expect(setup.records()).toEqual([]);
    expect(setup.decisions).toEqual([]);
    const paired = await ask(PERSON_PAIRED);
    expect(paired.status).toBe(200);
    expect(await paired.json()).toMatchObject({ kind: "member-install-plan" });
  });
});

/** Makes the stand-in server a member at 1.2.3; the calls it has seen so far. */
async function memberAt123(setup: ReturnType<typeof setUp>): Promise<number> {
  const { progress } = await installOver(setup);
  if (progress.state !== "joined") throw new Error(JSON.stringify(progress));
  return setup.server.calls().length;
}

/** The CLI calls the server saw after `offset`, one per line. */
function callsSince(setup: ReturnType<typeof setUp>, offset: number): ReadonlyArray<string> {
  return setup.server
    .calls()
    .slice(offset)
    .split("\n")
    .filter((line) => line.length > 0);
}

function currentVersion(setup: ReturnType<typeof setUp>): string {
  return basename(readlinkSync(join(setup.server.state, "install", "current")));
}

function upkeepRecords(setup: ReturnType<typeof setUp>) {
  return setup
    .records()
    .filter(
      (envelope) =>
        envelope.eventName.includes("member-update") ||
        envelope.eventName.includes("member-removal"),
    );
}

function updatePlanOf(result: MemberInstallResult) {
  if (result.kind !== "member-update-plan") throw new Error(JSON.stringify(result));
  return result.plan;
}

function removalPlanOf(result: MemberInstallResult) {
  if (result.kind !== "member-removal-plan") throw new Error(JSON.stringify(result));
  return result.plan;
}

/** Reads an update's steps, as the sheet does, until it stops running. */
async function settledUpdate(setup: ReturnType<typeof setUp>, updateId: string) {
  for (;;) {
    const read = setup.upkeep.updateProgress(updateId, person);
    if (read.kind !== "member-update-progress") throw new Error(JSON.stringify(read));
    if (read.progress.state !== "running") return read.progress;
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function settledRemoval(setup: ReturnType<typeof setUp>, removalId: string) {
  for (;;) {
    const read = setup.upkeep.removalProgress(removalId, person);
    if (read.kind !== "member-removal-progress") throw new Error(JSON.stringify(read));
    if (read.progress.state !== "running") return read.progress;
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function updateOver(setup: ReturnType<typeof setUp>) {
  const plan = updatePlanOf(await setup.upkeep.prepareUpdate(setup.serverId, person));
  const confirmed = await setup.upkeep.confirmUpdate(
    { planId: String(plan.planId), drain: "stop-now" },
    person,
  );
  if (confirmed.kind !== "member-update-progress") throw new Error(JSON.stringify(confirmed));
  return { plan, progress: await settledUpdate(setup, String(confirmed.progress.updateId)) };
}

async function removeOver(setup: ReturnType<typeof setUp>, deleteData: boolean) {
  const plan = removalPlanOf(await setup.upkeep.prepareRemoval(setup.serverId, person));
  const confirmed = setup.upkeep.confirmRemoval(
    { planId: String(plan.planId), deleteData },
    person,
  );
  if (confirmed.kind !== "member-removal-progress") throw new Error(JSON.stringify(confirmed));
  return { plan, progress: await settledRemoval(setup, String(confirmed.progress.removalId)) };
}

describe("updating a member and removing Octant from it over SSH", () => {
  it("updates a member by draining, swapping and confirming its signed hello", async () => {
    const setup = setUp();
    const before = await memberAt123(setup);
    signedBuild(setup.builds, setup.releaseKey.privateKeyBase64, "1.2.4");
    const plan = updatePlanOf(await setup.upkeep.prepareUpdate(setup.serverId, person));
    // Preparing reads the install and changes nothing on the server.
    expect(callsSince(setup, before)).toEqual([]);
    expect(plan).toMatchObject({
      alias: "devbox",
      user: "build",
      target: "linux-x64",
      fromVersion: "1.2.3",
      toVersion: "1.2.4",
      ring: "preview",
      signature: "verified",
      installRoot: `${setup.server.state}/install`,
      storeMigration: false,
      drains: ["stop-now"],
    });
    const confirmed = await setup.upkeep.confirmUpdate(
      { planId: String(plan.planId), drain: "stop-now" },
      person,
    );
    if (confirmed.kind !== "member-update-progress") throw new Error(JSON.stringify(confirmed));
    const progress = await settledUpdate(setup, String(confirmed.progress.updateId));
    expect(progress.state).toBe("updated");
    expect(progress.steps.map((step) => [step.step, step.state])).toEqual([
      ["copy", "succeeded"],
      ["verify", "succeeded"],
      ["drain", "succeeded"],
      ["swap", "succeeded"],
      ["confirm", "succeeded"],
    ]);
    const root = `${setup.server.state}/install`;
    expect(callsSince(setup, before)).toEqual([
      // The member stops admitting turns before the swap.
      "server stop",
      expect.stringMatching(new RegExp(`^server upgrade --artifact /.+ --install-root ${root}$`)),
    ]);
    expect(currentVersion(setup)).toBe("1.2.4");
    expect(setup.store.memberComputer(setup.serverId)?.artifactVersion).toBe("1.2.4");
    expect(existsSync(join(setup.server.state, "member-update"))).toBe(true);
    expect(
      existsSync(join(setup.server.state, "member-update", String(confirmed.progress.updateId))),
    ).toBe(false);
    // The confirmation was spent, and there is nothing newer to update to.
    expect(
      await setup.upkeep.confirmUpdate({ planId: String(plan.planId), drain: "stop-now" }, person),
    ).toMatchObject({ reason: "plan-expired" });
    expect(await setup.upkeep.prepareUpdate(setup.serverId, person)).toMatchObject({
      kind: "member-install-refused",
      reason: "no-newer-build",
    });
  });

  it("rolls back to the previous version when the updated member's hello does not cover this computer", async () => {
    const setup = setUp();
    const before = await memberAt123(setup);
    signedBuild(setup.builds, setup.releaseKey.privateKeyBase64, "1.2.4");
    setup.upkeepHub.hello.protocolRange = { min: 2, max: 3 };
    const { progress } = await updateOver(setup);
    expect(progress.state).toBe("rolled-back");
    expect(progress.rollbackReason).toBe("protocol-not-covered");
    expect(progress.steps.map((step) => [step.step, step.state])).toEqual([
      ["copy", "succeeded"],
      ["verify", "succeeded"],
      ["drain", "succeeded"],
      ["swap", "succeeded"],
      ["confirm", "failed"],
      ["roll-back", "succeeded"],
    ]);
    expect(progress.steps.find((step) => step.step === "confirm")?.message).toContain(
      "does not cover this computer's 1",
    );
    // The previous version runs again, and the refused one is gone so the
    // update can be tried again.
    expect(currentVersion(setup)).toBe("1.2.3");
    expect(existsSync(join(setup.server.state, "install", "versions", "1.2.4"))).toBe(false);
    expect(callsSince(setup, before)).toEqual([
      "server stop",
      expect.stringMatching(/^server upgrade --artifact /),
      "server stop",
      "server start",
    ]);
    expect(setup.store.memberComputer(setup.serverId)?.artifactVersion).toBe("1.2.3");
    const steps = upkeepRecords(setup)
      .slice(1)
      .map((envelope) => decodeMemberUpdateStepRecordedPayload(envelope.payload));
    expect(steps.slice(-2)).toMatchObject([
      { step: "confirm", outcome: "failed", failure: "protocol-not-covered" },
      { step: "roll-back", outcome: "succeeded" },
    ]);
  });

  it("rolls back when the health check fails after the swap", async () => {
    // `octant server upgrade`'s own health polls fail: it puts the previous
    // version back, and the roll-back starts it and deletes the failed one.
    const unhealthy = setUp();
    const before = await memberAt123(unhealthy);
    signedBuild(unhealthy.builds, unhealthy.releaseKey.privateKeyBase64, "1.2.4");
    writeFileSync(join(unhealthy.server.home, "unhealthy"), "");
    const failed = await updateOver(unhealthy);
    expect(failed.progress.state).toBe("rolled-back");
    expect(failed.progress.rollbackReason).toBe("health-check-failed");
    expect(failed.progress.steps.map((step) => [step.step, step.state])).toEqual([
      ["copy", "succeeded"],
      ["verify", "succeeded"],
      ["drain", "succeeded"],
      ["swap", "failed"],
      ["confirm", "not-run"],
      ["roll-back", "succeeded"],
    ]);
    expect(currentVersion(unhealthy)).toBe("1.2.3");
    expect(existsSync(join(unhealthy.server.state, "install", "versions", "1.2.4"))).toBe(false);
    expect(callsSince(unhealthy, before).at(-1)).toBe("server start");

    // The swap succeeded but the member never answers its hello.
    const silent = setUp();
    await memberAt123(silent);
    signedBuild(silent.builds, silent.releaseKey.privateKeyBase64, "1.2.4");
    silent.upkeepHub.hello.answer = "unreachable";
    const unanswered = await updateOver(silent);
    expect(unanswered.progress.state).toBe("rolled-back");
    expect(unanswered.progress.rollbackReason).toBe("health-check-failed");
    expect(unanswered.progress.steps.at(-1)).toMatchObject({
      step: "roll-back",
      state: "succeeded",
    });
    expect(currentVersion(silent)).toBe("1.2.3");
    expect(silent.store.memberComputer(silent.serverId)?.artifactVersion).toBe("1.2.3");
  });

  it("refuses an update build whose signature does not verify, and changes nothing", async () => {
    const untrusted = setUp();
    const before = await memberAt123(untrusted);
    signedBuild(untrusted.builds, untrusted.otherKey.privateKeyBase64, "1.2.4");
    expect(await untrusted.upkeep.prepareUpdate(untrusted.serverId, person)).toMatchObject({
      kind: "member-install-refused",
      reason: "build-unverified",
    });
    expect(callsSince(untrusted, before)).toEqual([]);
    expect(existsSync(join(untrusted.server.state, "member-update"))).toBe(false);
    expect(currentVersion(untrusted)).toBe("1.2.3");
    expect(upkeepRecords(untrusted)).toEqual([]);

    // A build swapped for one no trusted key signed after the sheet was read
    // is refused at the confirmation, before anything is copied or journaled.
    const swapped = setUp();
    const swappedBefore = await memberAt123(swapped);
    signedBuild(swapped.builds, swapped.releaseKey.privateKeyBase64, "1.2.4");
    const plan = updatePlanOf(await swapped.upkeep.prepareUpdate(swapped.serverId, person));
    signedBuild(swapped.builds, swapped.otherKey.privateKeyBase64, "1.2.4");
    expect(
      await swapped.upkeep.confirmUpdate(
        { planId: String(plan.planId), drain: "stop-now" },
        person,
      ),
    ).toMatchObject({ kind: "member-install-refused", reason: "build-unverified" });
    expect(callsSince(swapped, swappedBefore)).toEqual([]);
    expect(currentVersion(swapped)).toBe("1.2.3");
    expect(upkeepRecords(swapped)).toEqual([]);
  });

  it("removes Octant, leaving the data folder unless asked to delete it", async () => {
    const keep = setUp();
    const before = await memberAt123(keep);
    const data = join(keep.server.home, ".local", "share", "octant");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "events.sqlite3"), "threads");
    const unit = join(keep.server.home, ".config", "systemd", "user", "octant.service");
    expect(existsSync(unit)).toBe(true);
    const root = `${keep.server.state}/install`;
    const plan = removalPlanOf(await keep.upkeep.prepareRemoval(keep.serverId, person));
    expect(callsSince(keep, before)).toEqual([]);
    expect(plan).toMatchObject({
      alias: "devbox",
      user: "build",
      installRoot: root,
      dataFolder: data,
      service: "systemd-user",
    });
    const confirmed = keep.upkeep.confirmRemoval(
      { planId: String(plan.planId), deleteData: false },
      person,
    );
    if (confirmed.kind !== "member-removal-progress") throw new Error(JSON.stringify(confirmed));
    const progress = await settledRemoval(keep, String(confirmed.progress.removalId));
    expect(progress.state).toBe("removed");
    expect(progress.steps.map((step) => [step.step, step.state])).toEqual([
      ["leave", "succeeded"],
      ["stop", "succeeded"],
      ["delete", "succeeded"],
    ]);
    expect(callsSince(keep, before)).toEqual([
      "hub leave",
      "server disable --remove-service",
      `server uninstall --install-root ${root}`,
    ]);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(unit)).toBe(false);
    expect(existsSync(join(keep.server.state, "member-install"))).toBe(false);
    expect(readFileSync(join(data, "events.sqlite3"), "utf8")).toBe("threads");
    // The member left by itself, so the hub removed nothing.
    expect(keep.upkeepHub.removed).toEqual([]);
    expect(keep.store.memberComputer(keep.serverId)).toBeUndefined();
    expect(keep.upkeep.members(person)).toEqual({ kind: "member-computers", members: [] });

    const wipe = setUp();
    const wipeBefore = await memberAt123(wipe);
    const wipeData = join(wipe.server.home, ".local", "share", "octant");
    mkdirSync(wipeData, { recursive: true });
    writeFileSync(join(wipeData, "events.sqlite3"), "threads");
    const wiped = await removeOver(wipe, true);
    expect(wiped.progress).toMatchObject({ state: "removed", deleteData: true });
    expect(callsSince(wipe, wipeBefore).at(-1)).toBe(
      `server uninstall --install-root ${wipe.server.state}/install --remove-data --confirm ${wipeData}`,
    );
    expect(existsSync(wipeData)).toBe(false);
  });

  it("the update and removal requests and each step are journaled with the actor, with no secrets", async () => {
    const setup = setUp();
    await memberAt123(setup);
    signedBuild(setup.builds, setup.releaseKey.privateKeyBase64, "1.2.4");
    // Updated and removed from a device the person paired, through the route.
    const askResult = async (body: unknown) =>
      decodeMemberInstallResult(await (await askAsDevice(setup, PERSON_PAIRED, body)).json());
    const listed = await askResult({ kind: "list-member-computers" });
    expect(listed).toMatchObject({
      kind: "member-computers",
      members: [{ serverId: setup.serverId, artifactVersion: "1.2.3" }],
    });
    const plan = updatePlanOf(
      await askResult({ kind: "prepare-member-update", serverId: setup.serverId }),
    );
    const updating = await askResult({
      kind: "confirm-member-update",
      planId: plan.planId,
      drain: "stop-now",
    });
    if (updating.kind !== "member-update-progress") throw new Error(JSON.stringify(updating));
    expect((await settledUpdate(setup, String(updating.progress.updateId))).state).toBe("updated");
    const removal = removalPlanOf(
      await askResult({ kind: "prepare-member-removal", serverId: setup.serverId }),
    );
    const removing = await askResult({
      kind: "confirm-member-removal",
      planId: removal.planId,
      deleteData: false,
    });
    if (removing.kind !== "member-removal-progress") throw new Error(JSON.stringify(removing));
    expect((await settledRemoval(setup, String(removing.progress.removalId))).state).toBe(
      "removed",
    );

    const records = upkeepRecords(setup);
    const deviceActor = decodeEventActor({
      kind: "remote-device",
      actorId: PAIRED_DEVICE,
      deviceId: PAIRED_DEVICE,
    });
    expect(records.map((envelope) => envelope.actor)).toEqual(
      Array.from({ length: 10 }, () => deviceActor),
    );
    expect(records.map((envelope) => envelope.eventName)).toEqual([
      SHIELD_SERVERS_EVENT_NAMES.memberUpdateRequested,
      ...Array.from({ length: 5 }, () => SHIELD_SERVERS_EVENT_NAMES.memberUpdateStepRecorded),
      SHIELD_SERVERS_EVENT_NAMES.memberRemovalRequested,
      ...Array.from({ length: 3 }, () => SHIELD_SERVERS_EVENT_NAMES.memberRemovalStepRecorded),
    ]);
    const [updateRequested, ...rest] = records;
    const updateSteps = rest.slice(0, 5);
    const [removalRequested, ...removalSteps] = rest.slice(5);
    const requestedPayload = decodeMemberUpdateRequestedPayload(updateRequested?.payload);
    expect(requestedPayload).toMatchObject({
      serverId: setup.serverId,
      target: "linux-x64",
      fromVersion: "1.2.3",
      toVersion: "1.2.4",
      ring: "preview",
      drain: "stop-now",
    });
    expect(
      updateSteps.map((envelope) => {
        const payload = decodeMemberUpdateStepRecordedPayload(envelope.payload);
        return [payload.step, payload.outcome];
      }),
    ).toEqual([
      ["copy", "succeeded"],
      ["verify", "succeeded"],
      ["drain", "succeeded"],
      ["swap", "succeeded"],
      ["confirm", "succeeded"],
    ]);
    expect(decodeMemberRemovalRequestedPayload(removalRequested?.payload)).toMatchObject({
      serverId: setup.serverId,
      deleteData: false,
    });
    expect(
      removalSteps.map((envelope) => {
        const payload = decodeMemberRemovalStepRecordedPayload(envelope.payload);
        return [payload.step, payload.outcome];
      }),
    ).toEqual([
      ["leave", "succeeded"],
      ["stop", "succeeded"],
      ["delete", "succeeded"],
    ]);
    // The shapes are strict: a field they do not name is refused.
    expect(() =>
      decodeMemberUpdateRequestedPayload({ ...requestedPayload, joinCode: JOIN_CODE }),
    ).toThrow();
    // No join code, ticket, comparison code, key or folder is ever journaled.
    const journaled = JSON.stringify(records);
    expect(journaled).not.toContain(JOIN_CODE);
    expect(journaled).not.toContain(TICKET_ID);
    expect(journaled).not.toContain(COMPARISON_CODE);
    expect(journaled).not.toContain(setup.releaseKey.privateKeyBase64);
    expect(journaled).not.toContain(setup.server.home);
  });

  it("a hub-introduced device, a routine and an agent are refused", async () => {
    const setup = setUp();
    const before = await memberAt123(setup);
    signedBuild(setup.builds, setup.releaseKey.privateKeyBase64, "1.2.4");
    const update = updatePlanOf(await setup.upkeep.prepareUpdate(setup.serverId, person));
    const removal = removalPlanOf(await setup.upkeep.prepareRemoval(setup.serverId, person));
    for (const requester of [
      { kind: "restricted-device" },
      { kind: "routine" },
      { kind: "agent-grant" },
    ] satisfies ReadonlyArray<MemberInstallRequester>) {
      const refusal = { kind: "member-install-refused", reason: "not-the-person" };
      expect(setup.upkeep.members(requester)).toMatchObject(refusal);
      expect(await setup.upkeep.prepareUpdate(setup.serverId, requester)).toMatchObject(refusal);
      expect(
        await setup.upkeep.confirmUpdate(
          { planId: String(update.planId), drain: "stop-now" },
          requester,
        ),
      ).toMatchObject(refusal);
      expect(await setup.upkeep.prepareRemoval(setup.serverId, requester)).toMatchObject(refusal);
      expect(
        setup.upkeep.confirmRemoval(
          { planId: String(removal.planId), deleteData: true },
          requester,
        ),
      ).toMatchObject(refusal);
    }
    // The route reads who is asking from the authenticated principal.
    for (const body of [
      { kind: "prepare-member-update", serverId: setup.serverId },
      { kind: "confirm-member-update", planId: update.planId, drain: "stop-now" },
      { kind: "prepare-member-removal", serverId: setup.serverId },
      { kind: "confirm-member-removal", planId: removal.planId, deleteData: true },
    ]) {
      for (const principal of [
        { origin: "https://phone.example", admittedBy: "hub-roster" },
        { origin: AGENT_ACCESS_ORIGIN, admittedBy: "host-person" },
      ]) {
        expect((await askAsDevice(setup, principal, body)).status).toBe(403);
      }
    }
    expect(callsSince(setup, before)).toEqual([]);
    expect(upkeepRecords(setup)).toEqual([]);
    expect(currentVersion(setup)).toBe("1.2.3");
    expect(existsSync(join(setup.server.state, "install"))).toBe(true);
    const paired = await askAsDevice(setup, PERSON_PAIRED, {
      kind: "prepare-member-update",
      serverId: setup.serverId,
    });
    expect(paired.status).toBe(200);
    expect(await paired.json()).toMatchObject({ kind: "member-update-plan" });
  });
});

const FEED_BASE = "https://octant.sh/updates";
const LISTING_URL = `${FEED_BASE}/candidate/linux-x64.octant-headless.json`;
/** Where octant.sh sends the listing, as it redirects every feed file to the ring's mailbox release. */
const MAILBOX_URL =
  "https://github.com/Ogard-Labs/octant/releases/download/feed-candidate/linux-x64.octant-headless.json";

function buildUrl(version: string): string {
  return `https://github.com/Ogard-Labs/octant/releases/download/v${version}/octant-${version}-linux-x64.tar.gz`;
}

/** A candidate build packed as the release attaches it, kept off this computer's builds folder. */
function releasedBuild(signingKey: string, version: string): Buffer {
  return readFileSync(signedBuild(scratchDirectory(), signingKey, version, 1, "candidate"));
}

/** The ring's signed listing of one build, as `scripts/sign-update-feed.ts --headless` writes it. */
function listingOf(input: {
  readonly version: string;
  readonly bytes: Uint8Array;
  readonly signingKey: string;
}): string {
  const release = decodeHeadlessBuildRelease({
    product: "octant",
    version: input.version,
    target: "linux-x64",
    ring: "candidate",
    url: buildUrl(input.version),
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    releasedAt: "2026-11-20T12:00:00.000Z",
  });
  const key = createPrivateKey({
    key: Buffer.from(input.signingKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, canonicalHeadlessReleaseBytes(release), key).toString("base64");
  return JSON.stringify({ schemaVersion: 1, release, signature });
}

/**
 * The release host as the feed reaches it, injected the way the desktop
 * updater's tests inject theirs: the listing behind octant.sh's redirect to
 * the mailbox release, and the build on its release. Offline, every request
 * fails as a dropped connection does. It records each URL asked for.
 */
function standInReleaseHost(files: {
  readonly listing?: string;
  readonly builds?: Readonly<Record<string, Uint8Array>>;
  readonly offline?: boolean;
}) {
  const requested: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requested.push(url);
    if (files.offline === true) throw new TypeError("fetch failed");
    if (url === LISTING_URL) {
      return new Response(null, { status: 302, headers: { location: MAILBOX_URL } });
    }
    if (url === MAILBOX_URL && files.listing !== undefined) {
      return new Response(files.listing, { status: 200 });
    }
    const build = files.builds?.[url];
    if (build !== undefined) return new Response(new Uint8Array(build), { status: 200 });
    return new Response("Not Found", { status: 404 });
  }) as typeof globalThis.fetch;
  const feed: HeadlessBuildFeed = { baseUrl: FEED_BASE, ring: () => "candidate", fetch };
  return { feed, requested };
}

/** Reads a download, as the sheet does, until it is ready or refused. */
async function settledDownload(setup: ReturnType<typeof setUp>, result: MemberInstallResult) {
  if (result.kind !== "member-build-download") throw new Error(JSON.stringify(result));
  for (;;) {
    const read = setup.service.downloadProgress(String(result.download.downloadId), person);
    if (read.kind !== "member-build-download") throw new Error(JSON.stringify(read));
    const { state } = read.download;
    if (state === "ready" || state === "refused") return read.download;
    await new Promise((done) => setTimeout(done, 10));
  }
}

function folderEntries(folder: string): ReadonlyArray<string> {
  return existsSync(folder) ? readdirSync(folder) : [];
}

describe("downloading the build from this computer's ring", () => {
  it("downloads the server's build from the ring when none is on this computer, and installs it", async () => {
    let host: ReturnType<typeof standInReleaseHost> | undefined;
    const setup = setUp({
      placed: "none",
      feed: ({ releaseKey }) => {
        const bytes = releasedBuild(releaseKey.privateKeyBase64, "1.2.3");
        host = standInReleaseHost({
          listing: listingOf({ version: "1.2.3", bytes, signingKey: releaseKey.privateKeyBase64 }),
          builds: { [buildUrl("1.2.3")]: bytes },
        });
        return host.feed;
      },
    });
    const started = await setup.service.prepare(setup.serverId, person);
    expect(started).toMatchObject({
      kind: "member-build-download",
      download: { target: "linux-x64", ring: "candidate", state: "downloading" },
    });
    const download = await settledDownload(setup, started);
    expect(download).toMatchObject({ state: "ready", version: "1.2.3" });
    // The listing behind the feed's redirect, then the build it names, and
    // nothing about this computer in either request.
    expect(host?.requested).toEqual([LISTING_URL, MAILBOX_URL, buildUrl("1.2.3")]);
    // Kept under the release's own name, with nothing staged left beside it.
    expect(folderEntries(setup.builds)).toEqual(["octant-1.2.3-linux-x64.tar.gz"]);
    // Downloading changed nothing on the server.
    expect(setup.server.calls()).toBe("");

    const { plan, progress } = await installOver(setup);
    expect(plan).toMatchObject({ artifactVersion: "1.2.3", ring: "candidate" });
    expect(progress.state).toBe("joined");
    expect(currentVersion(setup)).toBe("1.2.3");
  });

  it("refuses a downloaded build whose digest or signature does not match the feed, and keeps nothing", async () => {
    // The bytes served are not the ones the signed listing names.
    const substituted = setUp({
      placed: "none",
      feed: ({ releaseKey }) => {
        const listed = releasedBuild(releaseKey.privateKeyBase64, "1.2.3");
        const served = releasedBuild(releaseKey.privateKeyBase64, "1.2.3");
        return standInReleaseHost({
          listing: listingOf({
            version: "1.2.3",
            bytes: listed,
            signingKey: releaseKey.privateKeyBase64,
          }),
          builds: { [buildUrl("1.2.3")]: Buffer.concat([served, Buffer.from("tampered")]) },
        }).feed;
      },
    });
    expect(
      await settledDownload(
        substituted,
        await substituted.service.prepare(substituted.serverId, person),
      ),
    ).toMatchObject({ state: "refused", refusal: "digest-mismatch" });
    expect(folderEntries(substituted.builds)).toEqual([]);

    // A listing no key trusted for the ring signed: the build is never asked for.
    let untrustedHost: ReturnType<typeof standInReleaseHost> | undefined;
    const untrusted = setUp({
      placed: "none",
      feed: ({ releaseKey, otherKey }) => {
        const bytes = releasedBuild(releaseKey.privateKeyBase64, "1.2.3");
        untrustedHost = standInReleaseHost({
          listing: listingOf({ version: "1.2.3", bytes, signingKey: otherKey.privateKeyBase64 }),
          builds: { [buildUrl("1.2.3")]: bytes },
        });
        return untrustedHost.feed;
      },
    });
    expect(
      await settledDownload(untrusted, await untrusted.service.prepare(untrusted.serverId, person)),
    ).toMatchObject({ state: "refused", refusal: "untrusted-listing" });
    expect(untrustedHost?.requested).not.toContain(buildUrl("1.2.3"));
    expect(folderEntries(untrusted.builds)).toEqual([]);

    // A genuine listing of a build whose own release signature is not trusted.
    const unsigned = setUp({
      placed: "none",
      feed: ({ releaseKey, otherKey }) => {
        const bytes = releasedBuild(otherKey.privateKeyBase64, "1.2.3");
        return standInReleaseHost({
          listing: listingOf({ version: "1.2.3", bytes, signingKey: releaseKey.privateKeyBase64 }),
          builds: { [buildUrl("1.2.3")]: bytes },
        }).feed;
      },
    });
    expect(
      await settledDownload(unsigned, await unsigned.service.prepare(unsigned.serverId, person)),
    ).toMatchObject({ state: "refused", refusal: "build-unverified" });
    expect(folderEntries(unsigned.builds)).toEqual([]);

    for (const setup of [substituted, untrusted, unsigned]) {
      expect(setup.server.calls()).toBe("");
      expect(setup.records()).toEqual([]);
    }
  });

  it("keeps the hand-placed build when one is newer than the ring's", async () => {
    let host: ReturnType<typeof standInReleaseHost> | undefined;
    const setup = setUp({
      feed: ({ releaseKey }) => {
        const bytes = releasedBuild(releaseKey.privateKeyBase64, "1.2.9");
        host = standInReleaseHost({
          listing: listingOf({ version: "1.2.9", bytes, signingKey: releaseKey.privateKeyBase64 }),
          builds: { [buildUrl("1.2.9")]: bytes },
        });
        return host.feed;
      },
    });
    await memberAt123(setup);
    // The person placed 1.3.0, newer than both the member and the ring's 1.2.9.
    const placed = signedBuild(setup.builds, setup.releaseKey.privateKeyBase64, "1.3.0");
    const plan = updatePlanOf(await setup.upkeep.prepareUpdate(setup.serverId, person));
    expect(plan).toMatchObject({ fromVersion: "1.2.3", toVersion: "1.3.0" });
    expect(host?.requested).toEqual([]);

    // With no build newer than the member's on this computer, the ring's is downloaded.
    rmSync(placed);
    const download = await settledDownload(
      setup,
      await setup.upkeep.prepareUpdate(setup.serverId, person),
    );
    expect(download).toMatchObject({ state: "ready", version: "1.2.9" });
    expect(updatePlanOf(await setup.upkeep.prepareUpdate(setup.serverId, person))).toMatchObject({
      fromVersion: "1.2.3",
      toVersion: "1.2.9",
      ring: "candidate",
    });
  });

  it("says where to place a build when the ring cannot be reached", async () => {
    const setup = setUp({
      placed: "none",
      feed: () => standInReleaseHost({ offline: true }).feed,
    });
    const download = await settledDownload(
      setup,
      await setup.service.prepare(setup.serverId, person),
    );
    expect(download).toMatchObject({ state: "refused", refusal: "unreachable" });
    expect(download.message).toContain("No signed Octant build for linux-x64 is on this computer");
    expect(download.message).toContain(
      `Put octant-<version>-linux-x64.tar.gz from Octant's release in ${setup.builds}`,
    );
    expect(folderEntries(setup.builds)).toEqual([]);
    expect(setup.server.calls()).toBe("");
  });
});
