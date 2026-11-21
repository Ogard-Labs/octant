import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeEventActor } from "@octant/contracts";
import {
  decodeMemberInstallRequestedPayload,
  decodeMemberInstallStepRecordedPayload,
  SHIELD_SERVERS_AGGREGATE,
  SHIELD_SERVERS_EVENT_NAMES,
  MemberInstallResult,
} from "@octant/contracts/shield-servers";
import { Schema } from "effect";
import {
  encodeHeadlessArtifactManifest,
  encodeHeadlessArtifactSignature,
  signHeadlessArtifactManifest,
  type HeadlessArtifactManifest,
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
import { createHeadlessBuilds } from "./headlessBuilds";
import {
  MemberInstallService,
  type MemberInstallHub,
  type MemberInstallRequester,
} from "./memberInstall";
import { createMemberInstallRouteHandler, MEMBER_INSTALL_PATH } from "./memberInstallRoutes";
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
 * Like the real one it refuses to install a version twice. \`$HOME/listen-fails\`
 * makes its listener fail, and \`$HOME/old-cli\` makes it a build whose usage
 * predates \`hub join -\`. Reading its usage is not recorded.
 */
const STAND_IN_CLI = `#!/bin/sh
if [ "$1" = --help ]; then
  echo "Usage:"
  [ -f "$HOME/old-cli" ] || echo "  octant hub join <code|-> [--items <list>]"
  exit 0
fi
printf '%s\\n' "$*" >> "$HOME/octant-calls.log"
case "$1 $2" in
  "server install")
    artifact=$4; root=$6
    [ -f "$artifact/octant-artifact.sig" ] || { echo "Octant refuses an unsigned build." >&2; exit 1; }
    [ -e "$root/versions/1.2.3" ] && { echo "Octant version 1.2.3 is already installed; refusing to overwrite it." >&2; exit 1; }
    mkdir -p "$root/versions/1.2.3" && cp -R "$artifact/." "$root/versions/1.2.3/" && ln -sfn "$root/versions/1.2.3" "$root/current"
    echo "Octant 1.2.3 installed at $root." ;;
  "server enable") echo "enabled" ;;
  "server start") echo "ready" ;;
  "listener enable")
    [ -f "$HOME/listen-fails" ] && { echo "Port $6 is in use." >&2; exit 1; }
    echo "listening on $4:$6" ;;
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
function signedBuild(folder: string, signingKey: string): string {
  const work = scratchDirectory();
  const name = "octant-1.2.3-linux-x64";
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
      ...(role === "server" || role === "cli" || role === "web-assets" ? { version: "1.2.3" } : {}),
    };
  });
  const manifest: HeadlessArtifactManifest = {
    schemaVersion: 1,
    product: "octant",
    artifactVersion: "1.2.3",
    target: { platform: "linux", arch: "x64" },
    wireVersion: "1",
    storeVersion: 1,
    components,
  };
  writeFileSync(join(root, "octant-artifact.json"), encodeHeadlessArtifactManifest(manifest));
  writeFileSync(
    join(root, "octant-artifact.sig"),
    encodeHeadlessArtifactSignature(signHeadlessArtifactManifest(manifest, "preview", signingKey)),
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

function setUp(
  options: {
    readonly addresses?: ReadonlyArray<string>;
    readonly claimCode?: string;
    readonly trusted?: boolean;
  } = {},
) {
  const server = standInServer(options.addresses ?? ["100.101.102.103", "192.168.1.20"]);
  const releaseKey = keyPair();
  const otherKey = keyPair();
  const builds = join(scratchDirectory(), "headless-builds");
  signedBuild(
    builds,
    options.trusted === false ? otherKey.privateKeyBase64 : releaseKey.privateKeyBase64,
  );
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
  const serviceOptions: ConstructorParameters<typeof MemberInstallService>[0] = {
    servers: () => store.servers(),
    connection: server.connection,
    builds: createHeadlessBuilds({
      folder: builds,
      trustedKeys: {
        stable: [],
        preview: [releaseKey.publicKeyBase64],
        candidate: [releaseKey.publicKeyBase64],
      },
    }),
    hub,
    journal: store,
    uuid: randomUUID,
    now: Date.now,
    sleep: (milliseconds) => new Promise((done) => setTimeout(done, Math.min(milliseconds, 50))),
    joinClaimMs: 10_000,
    joinFinishMs: 10_000,
  };
  const service = new MemberInstallService(serviceOptions);
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
    serviceOptions,
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

  it("finishes on a retry after a later step failed, without installing the build twice", async () => {
    const setup = setUp();
    writeFileSync(join(setup.server.home, "listen-fails"), "");
    const first = await installOver(setup);
    expect(first.progress.state).toBe("failed");
    rmSync(join(setup.server.home, "listen-fails"));
    const retry = await installOver(setup);
    expect(retry.progress.state).toBe("joined");
    expect(
      setup.server
        .calls()
        .split("\n")
        .filter((line) => line.startsWith("server install")),
    ).toHaveLength(1);
  });

  it("leaves a server that already runs this build untouched on a first attempt", async () => {
    const setup = setUp();
    expect((await installOver(setup)).progress.state).toBe("joined");
    // A second hub window, or this one after a restart, has no failed attempt
    // of its own here, so the CLI's refusal to install twice stands.
    const fresh = new MemberInstallService(setup.serviceOptions);
    const before = setup.server.calls().length;
    const plan = planOf(await fresh.prepare(setup.serverId, person));
    const confirmed = await fresh.confirm(
      { planId: String(plan.planId), listenAddress: "192.168.1.20" },
      person,
    );
    if (confirmed.kind !== "member-install-progress") throw new Error(JSON.stringify(confirmed));
    let progress = confirmed.progress;
    while (progress.state === "running") {
      await new Promise((done) => setTimeout(done, 10));
      const read = fresh.progress(String(progress.installId), person);
      if (read.kind !== "member-install-progress") throw new Error(JSON.stringify(read));
      progress = read.progress;
    }
    expect(progress.steps.find((step) => step.step === "install")?.state).toBe("failed");
    const calls = setup.server.calls().slice(before);
    expect(calls).not.toContain("listener enable");
    expect(calls).not.toContain("server start");
    // The refused attempt leaves no copy of the build behind.
    const attempt = join(setup.server.state, "member-install", String(progress.installId));
    expect(existsSync(join(attempt, "unpacked"))).toBe(false);
    expect(existsSync(join(attempt, "build.tar.gz"))).toBe(false);
  });

  it("refuses an archive that unpacks past its limit, or is not one, without failing the host", async () => {
    const setup = setUp();
    const [name] = readdirSync(setup.builds);
    const path = join(setup.builds, String(name));
    const keys = {
      stable: [],
      preview: [setup.releaseKey.publicKeyBase64],
      candidate: [setup.releaseKey.publicKeyBase64],
    };
    const small = createHeadlessBuilds({
      folder: setup.builds,
      trustedKeys: keys,
      maxUnpackedBytes: 1_024,
    });
    expect(await small.check(path, "linux-x64")).toMatchObject({ status: "refused" });
    const corrupt = join(setup.builds, "octant-9.9.9-linux-x64.tar.gz");
    writeFileSync(corrupt, "not a gzip archive");
    expect(
      await createHeadlessBuilds({ folder: setup.builds, trustedKeys: keys }).check(
        corrupt,
        "linux-x64",
      ),
    ).toMatchObject({ status: "refused" });
  });

  it("offers a final release over the candidate build that led to it", async () => {
    const folder = scratchDirectory();
    for (const version of ["1.2.3-candidate.20261120.1", "1.2.3", "1.2.2"]) {
      writeFileSync(join(folder, `octant-${version}-linux-x64.tar.gz`), "");
    }
    expect(await createHeadlessBuilds({ folder }).find("linux-x64")).toBe(
      join(folder, "octant-1.2.3-linux-x64.tar.gz"),
    );
  });

  it("refuses to join with a build whose CLI cannot read the join code on standard input", async () => {
    const setup = setUp();
    // The stand-in reads the old-build marker when asked for its usage.
    mkdirSync(setup.server.home, { recursive: true });
    writeFileSync(join(setup.server.home, "old-cli"), "");
    const { progress } = await installOver(setup);
    expect(progress.state).toBe("failed");
    expect(progress.steps.find((step) => step.step === "join")?.message).toContain(
      "cannot take a join code on standard input",
    );
    expect(setup.server.calls()).not.toContain("hub join");
    expect(setup.decisions).toEqual([]);
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
