import { AggregateId, type EventActor } from "@octant/contracts";
import {
  MEMBER_INSTALL_STEPS,
  type MemberInstallAddressOption,
  type MemberInstallFailure,
  type MemberInstallPlan,
  type MemberInstallProgress,
  type MemberInstallRefusalReason,
  type MemberInstallResult,
  type MemberInstallStep,
  type MemberInstallStepState,
  type MemberInstallTarget,
  type ShieldServer,
} from "@octant/contracts/shield-servers";
import { classifyRemoteListenerAddress } from "@octant/domain";
import { Schema } from "effect";
import type {
  ServerAddress,
  ServerCall,
  ServerConnection,
} from "../serverProjects/serverConnection";
import type { HeadlessBuildCheck, HeadlessBuilds } from "./headlessBuilds";
import type { ShieldServerStore } from "./shieldServerStore";

/**
 * Makes a registered server an Octant computer over SSH. Canonical:
 * docs/design/hub-and-spokes.md § Adding a computer over SSH.
 *
 * Preparing reads the server over its own SSH connection (`uname -sm`, its
 * login's data folder, its private addresses) and checks this computer's
 * signed build, and changes nothing anywhere. Only the person's one
 * confirmation runs anything: the build is copied and its digest checked,
 * the copy is recognized as the build checked here, `octant server install`
 * checks the signature again and installs into the login's data folder, the
 * user service starts, the listener comes up on the private address the
 * person picked, and the server joins this computer's hub. That confirmation
 * also approves the hub join, for its one ticket and only when the comparison
 * code the hub derives matches the one the server printed, read over the same
 * SSH connection. Octant never runs sudo and copies no credential: the join
 * code goes to the server on standard input and is never journaled.
 */

/** Who confirms the sheet. Only the host's own person may: a local window or a device they paired. */
export type MemberInstallRequester =
  /**
   * A window on this computer or a device its person paired, with the actor
   * the route resolved from that principal: the local person, or the device.
   */
  | { readonly kind: "person"; readonly actor: EventActor }
  /** A device the hub's roster introduced, or one whose pairing the journal does not prove. */
  | { readonly kind: "restricted-device" }
  | { readonly kind: "agent-grant" }
  /** A routine or another turn the host started on its own. */
  | { readonly kind: "routine" };

/** What this computer can do for a join: hand out a code for its hub, and decide that code's claim. */
export interface MemberInstallHub {
  readonly readiness: () =>
    | { readonly status: "ready"; readonly hubName: string }
    | {
        readonly status: "refused";
        readonly reason: "no-hub" | "not-the-hub" | "hub-unavailable";
        readonly message: string;
      };
  readonly mintJoinCode: () =>
    | { readonly status: "minted"; readonly code: string; readonly ticketId: string }
    | { readonly status: "refused"; readonly message: string };
  /** The comparison code of the claim waiting on this ticket, as this hub derives it. */
  readonly pendingComparisonCode: (ticketId: string) => string | undefined;
  readonly approve: (ticketId: string, actor: EventActor) => boolean;
  readonly deny: (ticketId: string, actor: EventActor) => void;
}

export interface MemberInstallOptions {
  /** The account's registered servers, read now. */
  readonly servers: () => ReadonlyArray<ShieldServer>;
  readonly connection: Pick<ServerConnection, "run">;
  readonly builds: HeadlessBuilds;
  readonly hub: MemberInstallHub;
  readonly journal: Pick<ShieldServerStore, "recordMemberInstall">;
  readonly uuid: () => string;
  readonly now: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** How long the server's join may take to print its comparison code, and then to finish. */
  readonly joinClaimMs?: number;
  readonly joinFinishMs?: number;
}

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);

/** The private listener's port, as `octant server install --pair` uses. */
const LISTEN_PORT = 8443;
const PLAN_LIFETIME_MS = 15 * 60 * 1_000;
const PROBE_TIMEOUT_MS = 20_000;
const COPY_TIMEOUT_MS = 10 * 60 * 1_000;
const STEP_TIMEOUT_MS = 5 * 60 * 1_000;
const SHORT_STEP_TIMEOUT_MS = 2 * 60 * 1_000;
const JOIN_CLAIM_MS = 60_000;
/** The server's `octant hub join` waits five minutes for approval; this waits a little longer. */
const JOIN_FINISH_MS = 6 * 60 * 1_000;
const POLL_MS = 1_000;
/** The grant a new spoke starts with: roster, Introduce and Owners, as `octant hub join` defaults. */
const DEFAULT_GRANT_ITEMS = "roster,introduce,owners";

/**
 * Read-only facts about the server: its system, its login's state folder
 * (where the headless CLI keeps its install), whether systemd keeps the
 * login's services running with no one logged in, and its addresses.
 */
const PROBE_SCRIPT = `exec 2>/dev/null
printf 'system=%s\\n' "$(uname -sm)"
case "$(uname -s)" in
  Darwin) printf 'state=%s\\n' "$HOME/Library/Application Support/Octant" ;;
  *) printf 'state=%s\\n' "\${XDG_STATE_HOME:-$HOME/.local/state}/octant" ;;
esac
if command -v loginctl >/dev/null; then printf 'linger=%s\\n' "$(loginctl show-user "$(id -un)" --property=Linger --value)"; fi
printf 'addresses\\n'
ip -o addr show || ifconfig
exit 0`;

/** `$1` work folder, the build on standard input; prints its SHA-256. */
const COPY_SCRIPT = `exec 2>/dev/null
umask 077
mkdir -p -- "$1" || exit 3
cat > "$1/build.tar.gz" || exit 3
s=$(sha256sum -- "$1/build.tar.gz" || shasum -a 256 -- "$1/build.tar.gz") || exit 3
printf '%s' "\${s%% *}"`;

/** `$1` work folder: unpacks the copy and prints its root and its manifest's and signature's digests. */
const VERIFY_SCRIPT = `umask 077
cd -- "$1" || exit 3
rm -rf -- unpacked && mkdir unpacked || exit 3
tar -xzf build.tar.gz -C unpacked --no-same-owner || exit 4
set -- unpacked/*
[ "$#" -eq 1 ] && [ -d "$1" ] || exit 5
r=$(cd -- "$1" && pwd -P) || exit 5
digest() { s=$(sha256sum -- "$1" 2>/dev/null || shasum -a 256 -- "$1") || exit 6; printf '%s' "\${s%% *}"; }
printf '%s\\n%s\\n%s' "$r" "$(digest "$r/octant-artifact.json")" "$(digest "$r/octant-artifact.sig")"`;

/**
 * `$1` the unpacked build, `$2` the install root, `$3` the work folder. The
 * build's own CLI installs it and checks its signature first; there is no
 * \`--self-built\` here, ever.
 */
const INSTALL_SCRIPT = `"$1/bin/octant" server install --artifact "$1" --install-root "$2" || exit $?
rm -rf -- "$3/unpacked" "$3/build.tar.gz"
exit 0`;

/** `$1` the installed CLI: writes and enables the login's user service, then starts it. */
const START_SCRIPT = `"$1" server enable >/dev/null && "$1" server start`;

/** `$1` the installed CLI, `$2` address, `$3` port: the listener serves the certificate it makes itself. */
const LISTEN_SCRIPT = `"$1" listener enable --hostname "$2" --port "$3"`;

/**
 * `$1` work folder, `$2` the installed CLI, `$3` grant items, the join code on
 * standard input so it is never part of the command this host's ssh is given,
 * nor of any process's arguments on the server: the shell's own `printf`
 * hands it to `octant hub join -` on standard input.
 * The join runs on in the background, writing what it prints to a private log,
 * because it waits for this computer to approve it.
 */
const JOIN_START_SCRIPT = `umask 077
IFS= read -r code || exit 3
log="$1/join.log"
rm -f -- "$log"
printf '%s\\n' "$code" | nohup sh -c '"$0" hub join - --items "$1"; printf "\\nexit=%s\\n" "$?"' "$2" "$3" >"$log" 2>&1 &
exit 0`;

const JOIN_READ_SCRIPT = `cat -- "$1/join.log" 2>/dev/null; exit 0`;

/** What the server reported, parsed. */
interface ServerFacts {
  readonly system: string;
  readonly target: MemberInstallTarget;
  readonly stateRoot: string;
  readonly startsAtBoot: boolean;
  readonly addresses: ReadonlyArray<MemberInstallAddressOption>;
}

interface PreparedPlan {
  readonly plan: MemberInstallPlan;
  readonly server: ServerAddress;
  readonly stateRoot: string;
  readonly buildPath: string;
  readonly buildSha256: string;
  readonly preparedAt: number;
}

interface RunningInstall {
  readonly installId: AggregateId;
  readonly serverId: AggregateId;
  state: MemberInstallProgress["state"];
  /** Replaced whole as each step changes, so a read never sees half a change. */
  steps: ReadonlyArray<MemberInstallStepState>;
}

type StepOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: MemberInstallFailure; readonly message: string };

export class MemberInstallService {
  readonly #options: MemberInstallOptions;
  readonly #plans = new Map<string, PreparedPlan>();
  readonly #installs = new Map<string, RunningInstall>();
  /** The install running on each server now, so a second confirmation cannot race the first. */
  readonly #busy = new Map<string, string>();
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: MemberInstallOptions) {
    this.#options = options;
    this.#sleep =
      options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  }

  /** Reads the server and this computer's build and states the plan; changes nothing. */
  async prepare(serverId: string, requester: MemberInstallRequester): Promise<MemberInstallResult> {
    if (actorOf(requester) === undefined) return refusedRequester(requester);
    const server = this.#server(serverId);
    if (server === undefined) return refused("server-not-found");
    const hub = this.#options.hub.readiness();
    if (hub.status === "refused") return refused(hub.reason, hub.message);
    const address = { alias: server.alias, user: server.user };
    const probe = await this.#options.connection.run(address, {
      script: PROBE_SCRIPT,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
    if (probe.status !== "ran") {
      return refused(
        "server-unreachable",
        `${server.alias} could not be reached${probe.status === "unreachable" ? `: ${probe.message}` : "."}`,
      );
    }
    const facts = readServerFacts(probe.output.toString("utf8"));
    if (facts.kind === "unsupported") {
      return refused(
        "unsupported-system",
        facts.system === undefined
          ? `${server.alias} did not answer \`uname -sm\`, so Octant cannot tell which build it needs. Octant computers run macOS on Apple silicon or Linux on x64 or arm64; Windows is not supported.`
          : `${server.alias} runs ${facts.system}. Octant computers run macOS on Apple silicon or Linux on x64 or arm64.`,
      );
    }
    if (facts.facts.addresses.length === 0) {
      return refused(
        "no-private-address",
        `${server.alias} has no Tailscale or private network address, and Octant listens only on one. Connect ${server.alias} to Tailscale or your local network (see the private network guide), then try again.`,
      );
    }
    const buildPath = await this.#options.builds.find(facts.facts.target);
    if (buildPath === undefined) {
      return refused(
        "no-build",
        `No signed Octant build for ${facts.facts.target} is on this computer. Put octant-<version>-${facts.facts.target}.tar.gz from Octant's release in ${this.#options.builds.folder}, then try again.`,
      );
    }
    const build = await this.#options.builds.check(buildPath, facts.facts.target);
    if (build.status === "refused") return refused("build-unverified", buildRefusal(build));
    const service = facts.facts.target.startsWith("darwin") ? "launchd-agent" : "systemd-user";
    const plan: MemberInstallPlan = {
      planId: decodeAggregateId(this.#options.uuid()),
      serverId: server.serverId,
      alias: server.alias,
      user: server.user,
      system: facts.facts.system,
      target: facts.facts.target,
      artifactVersion: build.version,
      ring: build.ring,
      signature: "verified",
      installRoot: `${facts.facts.stateRoot}/install`,
      service,
      startsAtBoot: facts.facts.startsAtBoot,
      ...(service === "systemd-user" && !facts.facts.startsAtBoot
        ? { bootCommand: `sudo loginctl enable-linger ${server.user}` }
        : {}),
      addresses: facts.facts.addresses,
      listenPort: LISTEN_PORT,
      joins: { kind: "hub", hubName: hub.hubName.slice(0, 128) },
    };
    this.#forgetExpiredPlans();
    this.#plans.set(String(plan.planId), {
      plan,
      server: address,
      stateRoot: facts.facts.stateRoot,
      buildPath,
      buildSha256: build.sha256,
      preparedAt: this.#options.now(),
    });
    return { kind: "member-install-plan", plan };
  }

  /**
   * The person's one confirmation. Everything is checked again before the
   * request is journaled, and the request is journaled before anything runs
   * on the server; the steps then run in the background and are read back
   * with {@link progress}.
   */
  async confirm(
    input: { readonly planId: string; readonly listenAddress: string },
    requester: MemberInstallRequester,
  ): Promise<MemberInstallResult> {
    const actor = actorOf(requester);
    if (actor === undefined) return refusedRequester(requester);
    this.#forgetExpiredPlans();
    const prepared = this.#plans.get(input.planId);
    if (prepared === undefined) return refused("plan-expired");
    const { plan } = prepared;
    if (!plan.addresses.some((option) => option.address === input.listenAddress)) {
      return refused("address-not-offered");
    }
    const server = this.#server(String(plan.serverId));
    if (server === undefined || server.alias !== plan.alias || server.user !== plan.user) {
      return refused("server-not-found");
    }
    if (this.#busy.has(String(plan.serverId))) return refused("already-installing");
    const hub = this.#options.hub.readiness();
    if (hub.status === "refused") return refused(hub.reason, hub.message);
    // The build is checked again: the file the sheet named may have changed since.
    const build = await this.#options.builds.check(prepared.buildPath, plan.target);
    if (build.status === "refused") return refused("build-unverified", buildRefusal(build));
    if (build.sha256 !== prepared.buildSha256) {
      return refused(
        "build-unverified",
        "The build changed after the sheet was read. Open the sheet again.",
      );
    }
    if (this.#busy.has(String(plan.serverId))) return refused("already-installing");
    this.#plans.delete(input.planId);
    const installId = decodeAggregateId(this.#options.uuid());
    const requested = this.#options.journal.recordMemberInstall(
      {
        event: "requested",
        payload: {
          installId,
          serverId: plan.serverId,
          target: plan.target,
          artifactVersion: plan.artifactVersion,
          ring: plan.ring,
          listenAddress: input.listenAddress,
          listenPort: plan.listenPort,
          joins: "hub",
        },
      },
      actor,
    );
    if (!requested) return refused("unavailable");
    const install: RunningInstall = {
      installId,
      serverId: plan.serverId,
      state: "running",
      steps: MEMBER_INSTALL_STEPS.map(
        (step): MemberInstallStepState => ({ step, state: "waiting" }),
      ),
    };
    this.#installs.set(String(installId), install);
    this.#busy.set(String(plan.serverId), String(installId));
    const done = this.#run(install, prepared, build, input.listenAddress, actor).finally(() => {
      this.#busy.delete(String(plan.serverId));
    });
    void done.catch(() => undefined);
    return { kind: "member-install-progress", progress: progressOf(install) };
  }

  progress(installId: string, requester: MemberInstallRequester): MemberInstallResult {
    if (actorOf(requester) === undefined) return refusedRequester(requester);
    const install = this.#installs.get(installId);
    if (install === undefined) return refused("install-not-found");
    return { kind: "member-install-progress", progress: progressOf(install) };
  }

  async #run(
    install: RunningInstall,
    prepared: PreparedPlan,
    build: Extract<HeadlessBuildCheck, { readonly status: "verified" }>,
    listenAddress: string,
    actor: EventActor,
  ): Promise<void> {
    const { plan, server } = prepared;
    const work = `${prepared.stateRoot}/member-install/${install.installId}`;
    const cli = `${plan.installRoot}/current/bin/octant`;
    let unpacked = "";
    const steps: Readonly<Record<MemberInstallStep, () => Promise<StepOutcome>>> = {
      copy: async () => {
        const call = await this.#call(server, {
          script: COPY_SCRIPT,
          args: [work],
          stdin: build.bytes,
          timeoutMs: COPY_TIMEOUT_MS,
        });
        if (!call.ok) return call;
        return call.output === build.sha256
          ? { ok: true }
          : failed(
              "digest-mismatch",
              `The copy on ${plan.alias} does not match the build checked here. Check that the server has room, then try again.`,
            );
      },
      verify: async () => {
        const call = await this.#call(server, {
          script: VERIFY_SCRIPT,
          args: [work],
          timeoutMs: STEP_TIMEOUT_MS,
        });
        if (!call.ok) return call;
        const [root = "", manifest, signature] = call.output.split("\n");
        if (
          !root.startsWith("/") ||
          manifest !== build.manifestSha256 ||
          signature !== build.signatureSha256
        ) {
          return failed(
            "build-mismatch",
            `What arrived on ${plan.alias} is not the build checked here, so nothing was installed.`,
          );
        }
        unpacked = root;
        return { ok: true };
      },
      install: async () => {
        const call = await this.#call(server, {
          script: INSTALL_SCRIPT,
          args: [unpacked, plan.installRoot, work],
          timeoutMs: STEP_TIMEOUT_MS,
        });
        return call.ok ? { ok: true } : call;
      },
      start: async () => {
        const call = await this.#call(server, {
          script: START_SCRIPT,
          args: [cli],
          timeoutMs: SHORT_STEP_TIMEOUT_MS,
        });
        return call.ok ? { ok: true } : call;
      },
      listen: async () => {
        const call = await this.#call(server, {
          script: LISTEN_SCRIPT,
          args: [cli, listenAddress, String(plan.listenPort)],
          timeoutMs: SHORT_STEP_TIMEOUT_MS,
        });
        return call.ok ? { ok: true } : call;
      },
      join: () => this.#join(server, plan.alias, work, cli, actor),
    };
    const mark = (step: MemberInstallStep, change: Omit<MemberInstallStepState, "step">) => {
      install.steps = install.steps.map((entry) =>
        entry.step === step ? { step, ...change } : entry,
      );
    };
    for (const step of MEMBER_INSTALL_STEPS) {
      mark(step, { state: "running" });
      const outcome = await steps[step]().catch(
        (): StepOutcome => failed("command-failed", "The step stopped unexpectedly."),
      );
      const recorded = this.#options.journal.recordMemberInstall(
        {
          event: "step",
          payload: {
            installId: install.installId,
            serverId: install.serverId,
            step,
            outcome: outcome.ok ? "succeeded" : "failed",
            ...(outcome.ok ? {} : { failure: outcome.failure }),
          },
        },
        actor,
      );
      if (outcome.ok && recorded) {
        mark(step, { state: "succeeded" });
        continue;
      }
      // A step whose outcome the journal does not hold stops the run as a
      // failed one does: nothing runs that the record would not explain.
      mark(step, {
        state: "failed",
        message: outcome.ok
          ? "This step finished, but Octant could not record it, so nothing more ran."
          : outcome.message,
      });
      install.steps = install.steps.map((entry) =>
        entry.state === "waiting" ? { step: entry.step, state: "not-run" } : entry,
      );
      install.state = "failed";
      return;
    }
    install.state = "joined";
  }

  async #join(
    server: ServerAddress,
    alias: string,
    work: string,
    cli: string,
    actor: EventActor,
  ): Promise<StepOutcome> {
    const minted = this.#options.hub.mintJoinCode();
    if (minted.status === "refused") return failed("join-code-unavailable", minted.message);
    const started = await this.#call(server, {
      script: JOIN_START_SCRIPT,
      args: [work, cli, DEFAULT_GRANT_ITEMS],
      stdin: Buffer.from(`${minted.code}\n`, "utf8"),
      timeoutMs: SHORT_STEP_TIMEOUT_MS,
    });
    if (!started.ok) return started;
    const read = async () => {
      const call = await this.#call(server, {
        script: JOIN_READ_SCRIPT,
        args: [work],
        timeoutMs: SHORT_STEP_TIMEOUT_MS,
      });
      return call.ok ? call.output : undefined;
    };
    let comparison: string | undefined;
    const claimDeadline = this.#options.now() + (this.#options.joinClaimMs ?? JOIN_CLAIM_MS);
    while (comparison === undefined) {
      const log = await read();
      if (log !== undefined) {
        comparison = /^Comparison code (\d{6})$/m.exec(log)?.[1];
        const exit = exitOf(log);
        if (comparison === undefined && exit !== undefined) return joinFailed(log);
      }
      if (comparison !== undefined) break;
      if (this.#options.now() >= claimDeadline) {
        return failed(
          "timed-out",
          `${alias} did not reach this computer's hub. Check that it can reach this computer over Tailscale or your local network.`,
        );
      }
      await this.#sleep(POLL_MS);
    }
    // The approval is bound to what the server printed over this SSH
    // connection: a claim on the ticket whose code differs came from somewhere
    // else, and is refused rather than approved.
    if (this.#options.hub.pendingComparisonCode(minted.ticketId) !== comparison) {
      this.#options.hub.deny(minted.ticketId, actor);
      return failed(
        "comparison-mismatch",
        `The request waiting on this hub does not show the comparison code ${alias} printed (${comparison}), so it was refused. Try again.`,
      );
    }
    if (!this.#options.hub.approve(minted.ticketId, actor)) {
      return failed("join-code-unavailable", "The hub could not approve the join. Try again.");
    }
    const finishDeadline = this.#options.now() + (this.#options.joinFinishMs ?? JOIN_FINISH_MS);
    for (;;) {
      const log = await read();
      const exit = log === undefined ? undefined : exitOf(log);
      if (log !== undefined && exit !== undefined) {
        return exit === "0" ? { ok: true } : joinFailed(log);
      }
      if (this.#options.now() >= finishDeadline) {
        return failed("timed-out", `${alias} did not finish joining the hub.`);
      }
      await this.#sleep(POLL_MS);
    }
  }

  /** One call whose script must exit 0; its output, trimmed of a final newline. */
  async #call(
    server: ServerAddress,
    input: {
      readonly script: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: Buffer;
      readonly timeoutMs: number;
    },
  ): Promise<{ readonly ok: true; readonly output: string } | (StepOutcome & { ok: false })> {
    const call: ServerCall = await this.#options.connection.run(server, {
      ...input,
      maxOutputBytes: 64 * 1024,
    });
    if (call.status === "unreachable") {
      return failed(
        "server-unreachable",
        `${server.alias} could not be reached: ${call.message}. Nothing ran after this step.`,
      );
    }
    if (call.status !== "ran") {
      return failed("timed-out", `${server.alias} did not finish this step in time.`);
    }
    const output = call.output.toString("utf8").replace(/\n$/, "");
    if (call.exitCode !== 0) {
      return failed(
        "command-failed",
        lastLine(call.errorOutput) ?? lastLine(output) ?? `The step exited ${call.exitCode}.`,
      );
    }
    return { ok: true, output };
  }

  #server(serverId: string): ShieldServer | undefined {
    return this.#options.servers().find((server) => String(server.serverId) === serverId);
  }

  #forgetExpiredPlans(): void {
    const now = this.#options.now();
    for (const [planId, prepared] of this.#plans) {
      if (now - prepared.preparedAt > PLAN_LIFETIME_MS) this.#plans.delete(planId);
    }
  }
}

function actorOf(requester: MemberInstallRequester): EventActor | undefined {
  return requester.kind === "person" ? requester.actor : undefined;
}

function refusedRequester(requester: MemberInstallRequester): MemberInstallResult {
  return refused(
    "not-the-person",
    requester.kind === "agent-grant"
      ? "An agent cannot make a server an Octant computer. Do it from a window on this computer or a device you paired."
      : requester.kind === "routine"
        ? "A routine cannot make a server an Octant computer. Do it from a window on this computer or a device you paired."
        : "Only a window on this computer or a device its person paired can make a server an Octant computer.",
  );
}

const MESSAGES: Readonly<Record<MemberInstallRefusalReason, string>> = {
  "not-the-person":
    "Only a window on this computer or a device its person paired can make a server an Octant computer.",
  "server-not-found": "That server is not registered.",
  "server-unreachable": "The server could not be reached.",
  "unsupported-system": "Octant cannot run on that server's system.",
  "no-private-address": "The server has no Tailscale or private network address.",
  "no-build": "No signed Octant build for that server is on this computer.",
  "build-unverified": "The Octant build on this computer did not pass its signature check.",
  "no-hub": "This computer is not a hub.",
  "not-the-hub": "This computer is not the hub.",
  "hub-unavailable": "This computer's hub cannot make a join code right now.",
  "plan-expired": "The sheet is out of date. Open it again.",
  "address-not-offered": "Choose one of the private addresses the server reported.",
  "install-not-found": "That install is not running on this computer.",
  "already-installing": "Octant is already being installed on that server.",
  unavailable: "Octant could not record the request, so nothing ran.",
};

function refused(reason: MemberInstallRefusalReason, message?: string): MemberInstallResult {
  return { kind: "member-install-refused", reason, message: message ?? MESSAGES[reason] };
}

function failed(failure: MemberInstallFailure, message: string): StepOutcome & { ok: false } {
  return { ok: false, failure, message: message.slice(0, 1_024) };
}

function buildRefusal(build: Extract<HeadlessBuildCheck, { readonly status: "refused" }>): string {
  switch (build.reason) {
    case "unsigned":
      return "The Octant build on this computer carries no release signature, so it is not installed on another computer. Use the signed build from Octant's release.";
    case "unverified":
      return "The Octant build on this computer is not signed by a key Octant trusts for its release ring, so nothing was copied.";
    case "files-mismatch":
      return "A file in the Octant build on this computer does not match its manifest, so nothing was copied.";
    case "wrong-target":
      return "The Octant build on this computer is for another system.";
    case "unreadable":
      return "The Octant build on this computer could not be read.";
  }
}

function progressOf(install: RunningInstall): MemberInstallProgress {
  return {
    installId: install.installId,
    serverId: install.serverId,
    state: install.state,
    steps: install.steps,
  };
}

/** The server's `octant hub join` ended without joining: its own last words say why. */
function joinFailed(log: string): StepOutcome & { ok: false } {
  return failed(
    "command-failed",
    lastLine(log.slice(0, log.lastIndexOf("exit="))) ?? "The server's join ended without joining.",
  );
}

function exitOf(log: string): string | undefined {
  return /(?:^|\n)exit=(\d+)\s*$/.exec(log)?.[1];
}

function lastLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1);
}

function readServerFacts(
  text: string,
):
  | { readonly kind: "supported"; readonly facts: ServerFacts }
  | { readonly kind: "unsupported"; readonly system?: string } {
  const at = text.indexOf("\naddresses\n");
  const head = at === -1 ? text : text.slice(0, at);
  const values = new Map<string, string>();
  for (const line of head.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) values.set(line.slice(0, equals), line.slice(equals + 1).trim());
  }
  const system = values.get("system");
  if (system === undefined || system === "") return { kind: "unsupported" };
  const target = targetOf(system);
  const stateRoot = values.get("state") ?? "";
  // A folder too long to state in the sheet is one Octant does not install into.
  if (target === undefined || !stateRoot.startsWith("/") || stateRoot.length > 900) {
    return { kind: "unsupported", system: system.slice(0, 128) };
  }
  return {
    kind: "supported",
    facts: {
      system: system.slice(0, 128),
      target,
      stateRoot,
      startsAtBoot: values.get("linger") === "yes",
      addresses: privateAddresses(at === -1 ? "" : text.slice(at)),
    },
  };
}

function targetOf(system: string): MemberInstallTarget | undefined {
  const [kernel, machine] = system.split(/\s+/);
  if (kernel === "Darwin" && machine === "arm64") return "darwin-arm64";
  if (kernel === "Linux" && (machine === "x86_64" || machine === "amd64")) return "linux-x64";
  if (kernel === "Linux" && (machine === "aarch64" || machine === "arm64")) return "linux-arm64";
  return undefined;
}

/** The Tailscale and private network addresses in `ip -o addr` or `ifconfig` output, Tailscale first. */
function privateAddresses(text: string): ReadonlyArray<MemberInstallAddressOption> {
  const found = new Map<string, MemberInstallAddressOption>();
  for (const match of text.matchAll(/\binet6?\s+(?:addr:)?([0-9A-Fa-f:.]+)/g)) {
    const address = match[1]?.toLowerCase() ?? "";
    if (address.startsWith("fe80:") || address.startsWith("169.254.")) continue;
    const network = classifyRemoteListenerAddress(address);
    if (network === "tailscale" || network === "lan-private") {
      found.set(address, { address, network });
    }
  }
  return [...found.values()]
    .sort(
      (left, right) => Number(right.network === "tailscale") - Number(left.network === "tailscale"),
    )
    .slice(0, 16);
}
