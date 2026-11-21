import { AggregateId, type EventActor, type HubMemberId } from "@octant/contracts";
import {
  MEMBER_REMOVAL_STEPS,
  MEMBER_UPDATE_STEPS,
  type MemberComputer,
  type MemberInstallRefusalReason,
  type MemberInstallResult,
  type MemberInstallTarget,
  type MemberRemovalFailure,
  type MemberRemovalPlan,
  type MemberRemovalProgress,
  type MemberRemovalStep,
  type MemberRemovalStepState,
  type MemberUpdateDrain,
  type MemberUpdateFailure,
  type MemberUpdatePlan,
  type MemberUpdateProgress,
  type MemberUpdateStep,
  type MemberUpdateStepState,
  type ShieldServer,
} from "@octant/contracts/shield-servers";
import { decodeHeadlessArtifactManifest } from "@octant/host-runtime";
import { Schema } from "effect";
import type { ServerAddress, ServerConnection } from "../serverProjects/serverConnection";
import {
  compareBuildVersions,
  type HeadlessBuildCheck,
  type HeadlessBuilds,
} from "./headlessBuilds";
import {
  actorOf,
  buildRefusal,
  callServer,
  COPY_SCRIPT,
  MemberServerWork,
  targetOf,
  VERIFY_SCRIPT,
  type MemberInstallRequester,
  type ServerStepCall,
} from "./memberInstall";
import type { ShieldServerStore } from "./shieldServerStore";

/**
 * Updates a server this computer made an Octant computer, or removes Octant
 * from it, over the server's own SSH connection after one confirmation.
 * Canonical: docs/design/hub-and-spokes.md § Adding a computer over SSH.
 *
 * Preparing reads the server's install and changes nothing. An update copies
 * and checks the newest signed build exactly as the install does, stops the
 * member gracefully (waiting for running turns is not built; the turns the
 * stop cuts off continue after it starts again), runs the installed
 * `octant server upgrade`, which stages, backs up a migrating store, swaps
 * and rolls back after failed health polls, and then reads the member's
 * signed hello. A hello that does not come, is not signed by the member's
 * key, names another build, or whose protocol range does not cover this
 * computer rolls the member back to the version it ran before. Removal leaves
 * the hub, stops and removes the user service, and deletes the install; the
 * data folder is deleted only when the person ticked it.
 */

/** Where a member listens, as its install recorded it; the hub finds the member by it. */
export interface MemberListener {
  readonly address: string;
  readonly port: number;
}

export type MemberHelloReading =
  | {
      readonly status: "read";
      readonly buildVersion: string;
      readonly protocolRange: { readonly min: number; readonly max: number };
    }
  /** Nothing answered over the hub's pinned connection to the member's listener. */
  | { readonly status: "unreachable" }
  /** A hello came that the identity key the hub holds for the member did not sign. */
  | { readonly status: "unproven" };

/** What the hub on this computer does for an update and a removal. */
export interface MemberUpkeepHub {
  /**
   * Whether the roster this hub keeps lists a member listening there, with
   * the hub role on or off. Removal reads it: an entry kept while the role is
   * off must still stop a removal that would leave it behind.
   */
  readonly listed: (listener: MemberListener) => boolean;
  /**
   * Whether the running hub lists a member listening there, so its signed
   * hello can be read and checked. An update needs it: with the role off no
   * hello is believed, and a swapped member could never be confirmed.
   */
  readonly hellosFrom: (listener: MemberListener) => boolean;
  /** The member's signed hello, checked against the identity key this hub holds for it. */
  readonly readHello: (listener: MemberListener) => Promise<MemberHelloReading>;
  /**
   * Whether the hub role is on. A hub that is off keeps its roster but changes
   * nothing in it, so a member it still lists cannot leave or be removed.
   */
  readonly roleOn: () => boolean;
  /** Whether this hub's roster still lists that member. */
  readonly listsMember: (memberId: HubMemberId) => boolean;
  /** Removes the member from this hub's roster when it could not leave by itself. */
  readonly removeMember: (
    memberId: HubMemberId,
    actor: EventActor,
  ) => Promise<"removed" | "not-listed" | "refused">;
}

export interface MemberUpkeepOptions {
  readonly servers: () => ReadonlyArray<ShieldServer>;
  readonly connection: Pick<ServerConnection, "run">;
  readonly builds: HeadlessBuilds;
  readonly hub: MemberUpkeepHub;
  readonly journal: Pick<
    ShieldServerStore,
    "recordMemberUpdate" | "recordMemberRemoval" | "memberComputer" | "memberComputers"
  >;
  /** Shared with the install, so only one install, update or removal runs on a server at a time. */
  readonly work: MemberServerWork;
  /** The remote protocol version this computer speaks, which an updated member's range must cover. */
  readonly protocolVersion: number;
  readonly uuid: () => string;
  readonly now: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** How long the updated member may take to answer its hello. */
  readonly helloWaitMs?: number;
}

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);

const PLAN_LIFETIME_MS = 15 * 60 * 1_000;
const PROBE_TIMEOUT_MS = 20_000;
const COPY_TIMEOUT_MS = 10 * 60 * 1_000;
const STEP_TIMEOUT_MS = 5 * 60 * 1_000;
const SHORT_STEP_TIMEOUT_MS = 2 * 60 * 1_000;
const HELLO_WAIT_MS = 2 * 60 * 1_000;
const POLL_MS = 1_000;
/** A version names a folder under `versions/`, so it holds no path separator. */
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/**
 * Read-only facts about the install: the system, the login's state and data
 * folders as the headless CLI resolves them, what the install's `current`
 * link names, and that version's manifest.
 */
const PROBE_SCRIPT = `exec 2>/dev/null
printf 'system=%s\\n' "$(uname -sm)"
if [ -n "$OCTANT_DATA_DIR" ]; then d="$OCTANT_DATA_DIR"; s="$d/state"
else case "$(uname -s)" in
  Darwin) s="$HOME/Library/Application Support/Octant"; d="$s" ;;
  *) s="\${XDG_STATE_HOME:-$HOME/.local/state}/octant"; d="\${XDG_DATA_HOME:-$HOME/.local/share}/octant" ;;
esac; fi
c=$(cd -- "$d" && pwd -P) && d="$c"
printf 'state=%s\\ndata=%s\\n' "$s" "$d"
c=$(readlink -- "$s/install/current") && printf 'current=%s\\n' "$c"
"$s/install/current/bin/octant" --help | grep -q -- '--remove-service' && printf 'removes_service=yes\\n'
printf 'manifest\\n'
cat -- "$s/install/current/octant-artifact.json"
exit 0`;

/** `$1` the installed CLI: the owner's graceful stop, the same the control socket's stop runs. */
const DRAIN_SCRIPT = `"$1" server stop`;

/**
 * `$1` install root, `$2` the unpacked build, `$3` work folder. The installed
 * CLI runs the upgrade so the user service it rewrites keeps naming the
 * install's `current` link rather than this work folder. Prints the end of
 * what it said, its exit, and what `current` names afterwards.
 */
const SWAP_SCRIPT = `"$1/current/bin/octant" server upgrade --artifact "$2" --install-root "$1" >"$3/upgrade.log" 2>&1
code=$?
tail -n 20 -- "$3/upgrade.log"
rm -rf -- "$3"
printf '\\nexit=%s\\ncurrent=%s\\n' "$code" "$(readlink -- "$1/current")"
exit 0`;

/**
 * `$1` install root, `$2` the previous version's folder, `$3` the failed
 * version's folder. Points \`current\` back at the previous version, starts it,
 * and deletes the failed version so the update can be tried again.
 */
const ROLL_BACK_SCRIPT = `cur=$(readlink -- "$1/current")
if [ "$cur" != "$2" ]; then
  "$1/current/bin/octant" server stop >/dev/null 2>&1
  ln -sfn -- "$2" "$1/current" || exit 3
fi
"$1/current/bin/octant" server start >/dev/null || exit $?
[ "$3" = "$2" ] || rm -rf -- "$3"
readlink -- "$1/current"`;

/** `$1` the installed CLI. */
/**
 * `$1` the installed CLI. A member that already dropped its own link (an
 * earlier leave that could not reach the hub) answers `not-a-spoke`; the
 * script prints that verdict as its last line so the hub can tell an absent
 * link from an SSH or CLI failure. Any other refusal keeps its exit status.
 */
const LEAVE_SCRIPT = `refusal=$("$1" hub leave 2>&1 >/dev/null)
status=$?
case "$refusal" in
  *"(not-a-spoke)"*) echo not-a-spoke; exit 0 ;;
esac
[ -n "$refusal" ] && printf '%s\\n' "$refusal" >&2
exit $status`;
const STOP_SCRIPT = `"$1" server disable --remove-service`;

/**
 * `$1` the installed CLI, `$2` install root, `$3` state folder, `$4` keep or
 * delete, `$5` the data folder the sheet named. The CLI deletes the data
 * folder only when it is that exact folder.
 */
const DELETE_SCRIPT = `if [ "$4" = delete ]; then
  "$1" server uninstall --install-root "$2" --remove-data --confirm "$5" || exit $?
else
  "$1" server uninstall --install-root "$2" || exit $?
fi
rm -rf -- "$3/member-install" "$3/member-update"
exit 0`;

interface InstalledFacts {
  readonly target: MemberInstallTarget;
  readonly stateRoot: string;
  readonly dataFolder: string;
  readonly installRoot: string;
  readonly currentRoot: string;
  readonly version: string;
  readonly storeVersion: number;
  /**
   * Whether the installed CLI lists `server disable --remove-service`. Builds
   * from before it reject the flag, and removal runs the installed CLI, not
   * this computer's, so removal is refused up front rather than stranding a
   * member that has already left the hub.
   */
  readonly removesService: boolean;
}

interface PreparedUpdate {
  readonly plan: MemberUpdatePlan;
  readonly server: ServerAddress;
  readonly facts: InstalledFacts;
  readonly listener: MemberListener;
  readonly buildPath: string;
  readonly buildSha256: string;
  readonly preparedAt: number;
}

interface PreparedRemoval {
  readonly plan: MemberRemovalPlan;
  readonly server: ServerAddress;
  readonly facts: InstalledFacts;
  readonly listener: MemberListener;
  /** The hub member its join made it, when the join recorded one. */
  readonly memberId: HubMemberId | undefined;
  readonly preparedAt: number;
}

interface RunningUpdate {
  readonly updateId: AggregateId;
  readonly serverId: AggregateId;
  state: MemberUpdateProgress["state"];
  steps: ReadonlyArray<MemberUpdateStepState>;
  rollbackReason?: MemberUpdateFailure;
}

interface RunningRemoval {
  readonly removalId: AggregateId;
  readonly serverId: AggregateId;
  readonly deleteData: boolean;
  state: MemberRemovalProgress["state"];
  steps: ReadonlyArray<MemberRemovalStepState>;
}

type UpdateOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure: MemberUpdateFailure;
      readonly message: string;
      /** The member is to be put back on the version it ran before. */
      readonly rollBack: boolean;
    };

type RemovalOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: MemberRemovalFailure; readonly message: string };

type Verified = Extract<HeadlessBuildCheck, { readonly status: "verified" }>;

export class MemberUpkeepService {
  readonly #options: MemberUpkeepOptions;
  readonly #updatePlans = new Map<string, PreparedUpdate>();
  readonly #removalPlans = new Map<string, PreparedRemoval>();
  readonly #updates = new Map<string, RunningUpdate>();
  readonly #removals = new Map<string, RunningRemoval>();
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: MemberUpkeepOptions) {
    this.#options = options;
    this.#sleep =
      options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  }

  /** The servers that offer Update and Remove Octant. */
  members(requester: MemberInstallRequester): MemberInstallResult {
    if (actorOf(requester) === undefined) return refusedRequester(requester);
    return { kind: "member-computers", members: this.#options.journal.memberComputers() };
  }

  /** Reads the server's install and this computer's newer build and states the plan; changes nothing. */
  async prepareUpdate(
    serverId: string,
    requester: MemberInstallRequester,
  ): Promise<MemberInstallResult> {
    if (actorOf(requester) === undefined) return refusedRequester(requester);
    const found = this.#member(serverId);
    if (found.kind === "refused") return found.result;
    const { server, member } = found;
    const listener = listenerOf(member);
    if (!this.#options.hub.hellosFrom(listener)) {
      return refused(
        "not-a-member",
        `This hub does not list ${server.alias} as a member, so an update could not be confirmed by its signed hello. Turn on the hub in Settings › Remote access, then open the sheet again.`,
      );
    }
    const read = await this.#readInstall(server, member);
    if (read.kind === "refused") return read.result;
    const { facts } = read;
    const buildPath = await this.#options.builds.find(facts.target);
    if (buildPath === undefined) {
      return refused(
        "no-build",
        `No signed Octant build for ${facts.target} is on this computer. Put octant-<version>-${facts.target}.tar.gz from Octant's release in ${this.#options.builds.folder}, then try again.`,
      );
    }
    const build = await this.#options.builds.check(buildPath, facts.target);
    if (build.status === "refused") return refused("build-unverified", buildRefusal(build));
    if (!isNewer(build.version, facts.version)) {
      return refused(
        "no-newer-build",
        `${server.alias} already runs Octant ${facts.version}, and the newest signed build on this computer is ${build.version}. Put a newer release build in ${this.#options.builds.folder}, then try again.`,
      );
    }
    if (!SAFE_VERSION.test(build.version)) {
      return refused("build-unverified", "The build's version name is not one Octant installs.");
    }
    const plan: MemberUpdatePlan = {
      planId: decodeAggregateId(this.#options.uuid()),
      serverId: server.serverId,
      alias: server.alias,
      user: server.user,
      target: facts.target,
      fromVersion: facts.version,
      toVersion: build.version,
      ring: build.ring,
      signature: "verified",
      installRoot: facts.installRoot,
      storeMigration: build.storeVersion > facts.storeVersion,
      drains: ["stop-now"],
    };
    this.#forgetExpiredPlans();
    this.#updatePlans.set(String(plan.planId), {
      plan,
      server: { alias: server.alias, user: server.user },
      facts,
      listener,
      buildPath,
      buildSha256: build.sha256,
      preparedAt: this.#options.now(),
    });
    return { kind: "member-update-plan", plan };
  }

  /**
   * The person's one confirmation. Everything is checked again, then the
   * request is journaled before anything runs on the server; the steps run in
   * the background and are read back with {@link updateProgress}.
   */
  async confirmUpdate(
    input: { readonly planId: string; readonly drain: MemberUpdateDrain },
    requester: MemberInstallRequester,
  ): Promise<MemberInstallResult> {
    const actor = actorOf(requester);
    if (actor === undefined) return refusedRequester(requester);
    this.#forgetExpiredPlans();
    const prepared = this.#updatePlans.get(input.planId);
    if (prepared === undefined) return refused("plan-expired");
    const { plan } = prepared;
    const found = this.#member(String(plan.serverId));
    if (found.kind === "refused") return found.result;
    if (found.server.alias !== plan.alias || found.server.user !== plan.user) {
      return refused("server-not-found");
    }
    if (this.#options.work.busy(String(plan.serverId))) return refused("already-installing");
    // Checked again before anything runs: the hub role may have been turned
    // off since the sheet was read, and then no hello could confirm the swap.
    if (!this.#options.hub.hellosFrom(listenerOf(found.member))) {
      return refused(
        "not-a-member",
        `This hub does not list ${found.server.alias} as a member now, so an update could not be confirmed by its signed hello. Turn on the hub in Settings › Remote access, then open the sheet again.`,
      );
    }
    // The build is checked again: the file the sheet named may have changed since.
    const build = await this.#options.builds.check(prepared.buildPath, plan.target);
    if (build.status === "refused") return refused("build-unverified", buildRefusal(build));
    if (build.sha256 !== prepared.buildSha256) {
      return refused(
        "build-unverified",
        "The build changed after the sheet was read. Open the sheet again.",
      );
    }
    const updateId = decodeAggregateId(this.#options.uuid());
    if (!this.#options.work.claim(String(plan.serverId), String(updateId))) {
      return refused("already-installing");
    }
    this.#updatePlans.delete(input.planId);
    // Another sheet may have finished an update since this one was read: the
    // install is read again, and a plan whose starting version is no longer
    // current is refused before the member is stopped.
    const reread = await this.#readInstall(found.server, found.member);
    if (reread.kind === "refused" || reread.facts.currentRoot !== prepared.facts.currentRoot) {
      this.#options.work.release(String(plan.serverId), String(updateId));
      return reread.kind === "refused"
        ? reread.result
        : refused(
            "plan-expired",
            `${plan.alias} no longer runs Octant ${plan.fromVersion}. Open the sheet again.`,
          );
    }
    const requested = this.#options.journal.recordMemberUpdate(
      {
        event: "requested",
        payload: {
          updateId,
          serverId: plan.serverId,
          target: plan.target,
          fromVersion: plan.fromVersion,
          toVersion: plan.toVersion,
          ring: plan.ring,
          drain: input.drain,
        },
      },
      actor,
    );
    if (!requested) {
      this.#options.work.release(String(plan.serverId), String(updateId));
      return refused("unavailable");
    }
    const update: RunningUpdate = {
      updateId,
      serverId: plan.serverId,
      state: "running",
      steps: MEMBER_UPDATE_STEPS.map((step): MemberUpdateStepState => ({ step, state: "waiting" })),
    };
    this.#updates.set(String(updateId), update);
    const done = this.#runUpdate(update, prepared, build, actor).finally(() => {
      this.#options.work.release(String(plan.serverId), String(updateId));
    });
    void done.catch(() => undefined);
    return { kind: "member-update-progress", progress: updateProgressOf(update) };
  }

  updateProgress(updateId: string, requester: MemberInstallRequester): MemberInstallResult {
    if (actorOf(requester) === undefined) return refusedRequester(requester);
    const update = this.#updates.get(updateId);
    if (update === undefined) return refused("update-not-found");
    return { kind: "member-update-progress", progress: updateProgressOf(update) };
  }

  /** Reads where Octant is installed on the server and states what removal deletes; changes nothing. */
  async prepareRemoval(
    serverId: string,
    requester: MemberInstallRequester,
  ): Promise<MemberInstallResult> {
    if (actorOf(requester) === undefined) return refusedRequester(requester);
    const found = this.#member(serverId);
    if (found.kind === "refused") return found.result;
    const { server, member } = found;
    // Refused up front rather than after the leave step: turning the role
    // back on is the owner's choice, and the hub never edits its roster while off.
    const listed =
      member.memberId === undefined
        ? this.#options.hub.listed(listenerOf(member))
        : this.#options.hub.listsMember(member.memberId);
    if (listed && !this.#options.hub.roleOn()) {
      return refused(
        "unavailable",
        `This computer's hub role is off, and its roster cannot change until it is on, so ${server.alias} cannot leave it. Turn on the hub in Settings › Remote access, then remove Octant from ${server.alias}.`,
      );
    }
    const read = await this.#readInstall(server, member);
    if (read.kind === "refused") return read.result;
    if (!read.facts.removesService) {
      return refused(
        "unavailable",
        `Octant ${read.facts.version} on ${server.alias} cannot remove its own service, so removing it from here would leave the service behind. Update ${server.alias} first, then remove Octant.`,
      );
    }
    const plan: MemberRemovalPlan = {
      planId: decodeAggregateId(this.#options.uuid()),
      serverId: server.serverId,
      alias: server.alias,
      user: server.user,
      installRoot: read.facts.installRoot,
      dataFolder: read.facts.dataFolder,
      service: read.facts.target.startsWith("darwin") ? "launchd-agent" : "systemd-user",
    };
    this.#forgetExpiredPlans();
    this.#removalPlans.set(String(plan.planId), {
      plan,
      server: { alias: server.alias, user: server.user },
      facts: read.facts,
      listener: listenerOf(member),
      memberId: member.memberId,
      preparedAt: this.#options.now(),
    });
    return { kind: "member-removal-plan", plan };
  }

  confirmRemoval(
    input: { readonly planId: string; readonly deleteData: boolean },
    requester: MemberInstallRequester,
  ): MemberInstallResult {
    const actor = actorOf(requester);
    if (actor === undefined) return refusedRequester(requester);
    this.#forgetExpiredPlans();
    const prepared = this.#removalPlans.get(input.planId);
    if (prepared === undefined) return refused("plan-expired");
    const { plan } = prepared;
    const found = this.#member(String(plan.serverId));
    if (found.kind === "refused") return found.result;
    if (found.server.alias !== plan.alias || found.server.user !== plan.user) {
      return refused("server-not-found");
    }
    const removalId = decodeAggregateId(this.#options.uuid());
    if (!this.#options.work.claim(String(plan.serverId), String(removalId))) {
      return refused("already-installing");
    }
    this.#removalPlans.delete(input.planId);
    const requested = this.#options.journal.recordMemberRemoval(
      {
        event: "requested",
        payload: { removalId, serverId: plan.serverId, deleteData: input.deleteData },
      },
      actor,
    );
    if (!requested) {
      this.#options.work.release(String(plan.serverId), String(removalId));
      return refused("unavailable");
    }
    const removal: RunningRemoval = {
      removalId,
      serverId: plan.serverId,
      deleteData: input.deleteData,
      state: "running",
      steps: MEMBER_REMOVAL_STEPS.map(
        (step): MemberRemovalStepState => ({ step, state: "waiting" }),
      ),
    };
    this.#removals.set(String(removalId), removal);
    const done = this.#runRemoval(removal, prepared, actor).finally(() => {
      this.#options.work.release(String(plan.serverId), String(removalId));
    });
    void done.catch(() => undefined);
    return { kind: "member-removal-progress", progress: removalProgressOf(removal) };
  }

  removalProgress(removalId: string, requester: MemberInstallRequester): MemberInstallResult {
    if (actorOf(requester) === undefined) return refusedRequester(requester);
    const removal = this.#removals.get(removalId);
    if (removal === undefined) return refused("removal-not-found");
    return { kind: "member-removal-progress", progress: removalProgressOf(removal) };
  }

  async #runUpdate(
    update: RunningUpdate,
    prepared: PreparedUpdate,
    build: Verified,
    actor: EventActor,
  ): Promise<void> {
    const { plan, server, facts } = prepared;
    const work = `${facts.stateRoot}/member-update/${update.updateId}`;
    const cli = `${facts.installRoot}/current/bin/octant`;
    const newRoot = `${facts.installRoot}/versions/${plan.toVersion}`;
    let unpacked = "";
    let swapped = false;
    const steps: Readonly<
      Record<(typeof MEMBER_UPDATE_STEPS)[number], () => Promise<UpdateOutcome>>
    > = {
      copy: async () => {
        const call = await this.#call(server, {
          script: COPY_SCRIPT,
          args: [work],
          stdin: build.bytes,
          timeoutMs: COPY_TIMEOUT_MS,
        });
        if (!call.ok) return kept(call);
        return call.output === build.sha256
          ? { ok: true }
          : updateFailed(
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
        if (!call.ok) return kept(call);
        const [root = "", manifest, signature] = call.output.split("\n");
        if (
          !root.startsWith("/") ||
          manifest !== build.manifestSha256 ||
          signature !== build.signatureSha256
        ) {
          return updateFailed(
            "build-mismatch",
            `What arrived on ${plan.alias} is not the build checked here, so nothing changed.`,
          );
        }
        unpacked = root;
        return { ok: true };
      },
      drain: async () => {
        // `octant server upgrade` takes the pre-migration backup through the
        // running owner's control socket and then stops it gracefully itself,
        // so a migrating update leaves the owner up for that backup; stopping
        // it here refused every migrating update as backup-required.
        if (plan.storeMigration) return { ok: true };
        const call = await this.#call(server, {
          script: DRAIN_SCRIPT,
          args: [cli],
          timeoutMs: SHORT_STEP_TIMEOUT_MS,
        });
        // A stop that failed may have stopped the member anyway, so it is
        // started again on the version it runs.
        return call.ok ? { ok: true } : { ...call, rollBack: true };
      },
      swap: async () => {
        const call = await this.#call(server, {
          script: SWAP_SCRIPT,
          args: [facts.installRoot, unpacked, work],
          timeoutMs: STEP_TIMEOUT_MS,
        });
        // A swap whose end Octant never saw may still be migrating the store,
        // and the previous version is never started against that.
        if (!call.ok) return { ...call, rollBack: !plan.storeMigration };
        const swap = readSwap(call.output);
        if (swap.exit === "0" && swap.current === newRoot) {
          swapped = true;
          return { ok: true };
        }
        if (swap.current === newRoot && !plan.storeMigration) {
          // The new build was made current but did not start (its service
          // start failed before the upgrade's own health roll-back). The
          // store format did not change, so the previous version is put back.
          return {
            ok: false,
            failure: "command-failed",
            message: swap.lastLine ?? `Octant ${plan.toVersion} did not start on ${plan.alias}.`,
            rollBack: true,
          };
        }
        if (swap.current === newRoot) {
          // `octant server upgrade` stopped a build whose store it could not
          // restore, and asks a person to restore it; starting the previous
          // version against that store would corrupt it.
          return updateFailed(
            "recovery-required",
            swap.lastLine ?? `Octant on ${plan.alias} is stopped and needs its store restored.`,
          );
        }
        return {
          ok: false,
          failure: swap.healthRolledBack ? "health-check-failed" : "command-failed",
          message: swap.healthRolledBack
            ? `Octant ${plan.toVersion} did not pass its health check on ${plan.alias}, so ${plan.alias} went back to ${plan.fromVersion}.`
            : (swap.lastLine ?? "The upgrade did not apply."),
          rollBack: true,
        };
      },
      confirm: () => this.#confirmHello(prepared),
    };
    const mark = (step: MemberUpdateStep, change: Omit<MemberUpdateStepState, "step">) => {
      update.steps = update.steps.map((entry) =>
        entry.step === step ? { step, ...change } : entry,
      );
    };
    const record = (step: MemberUpdateStep, outcome: UpdateOutcome) =>
      this.#options.journal.recordMemberUpdate(
        {
          event: "step",
          payload: {
            updateId: update.updateId,
            serverId: update.serverId,
            step,
            outcome: outcome.ok ? "succeeded" : "failed",
            ...(outcome.ok ? {} : { failure: outcome.failure }),
          },
        },
        actor,
      );
    for (const step of MEMBER_UPDATE_STEPS) {
      mark(step, { state: "running" });
      const outcome = await steps[step]().catch(
        (): UpdateOutcome => updateFailed("command-failed", "The step stopped unexpectedly."),
      );
      const recorded = record(step, outcome);
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
      update.steps = update.steps.map((entry) =>
        entry.state === "waiting" ? { step: entry.step, state: "not-run" } : entry,
      );
      if (outcome.ok || !outcome.rollBack || !recorded) {
        update.state = "failed";
        return;
      }
      update.steps = [...update.steps, { step: "roll-back", state: "running" }];
      const rolledBack = await this.#rollBack(prepared, swapped).catch(
        (): UpdateOutcome => updateFailed("command-failed", "The roll-back stopped unexpectedly."),
      );
      const rollBackRecorded = record("roll-back", rolledBack);
      mark(
        "roll-back",
        rolledBack.ok ? { state: "succeeded" } : { state: "failed", message: rolledBack.message },
      );
      if (rolledBack.ok && rollBackRecorded) {
        update.state = "rolled-back";
        update.rollbackReason = outcome.failure;
      } else {
        update.state = "failed";
      }
      return;
    }
    update.state = "updated";
  }

  /**
   * Reads the updated member's signed hello over the hub's pinned connection
   * until it answers or the wait runs out. Only a hello signed by the
   * member's own key, naming the installed build and a protocol range that
   * covers this computer, confirms the update.
   */
  async #confirmHello(prepared: PreparedUpdate): Promise<UpdateOutcome> {
    const { plan, listener } = prepared;
    const deadline = this.#options.now() + (this.#options.helloWaitMs ?? HELLO_WAIT_MS);
    for (;;) {
      const hello = await this.#options.hub
        .readHello(listener)
        .catch((): MemberHelloReading => ({ status: "unreachable" }));
      if (hello.status === "unproven") {
        return rollBackFor(
          "hello-unproven",
          `${plan.alias} answered with a hello its own key did not sign, so the update was not confirmed.`,
        );
      }
      if (hello.status === "read") {
        if (hello.buildVersion !== plan.toVersion) {
          return rollBackFor(
            "version-mismatch",
            `${plan.alias} reports Octant ${hello.buildVersion.slice(0, 64)}, not ${plan.toVersion}, which was installed.`,
          );
        }
        const version = this.#options.protocolVersion;
        if (hello.protocolRange.min > version || hello.protocolRange.max < version) {
          return rollBackFor(
            "protocol-not-covered",
            `Octant ${plan.toVersion} on ${plan.alias} speaks protocol ${hello.protocolRange.min} to ${hello.protocolRange.max}, which does not cover this computer's ${version}.`,
          );
        }
        return { ok: true };
      }
      if (this.#options.now() >= deadline) {
        return rollBackFor(
          "health-check-failed",
          `${plan.alias} did not answer this hub after the update.`,
        );
      }
      await this.#sleep(POLL_MS);
    }
  }

  /**
   * Puts the member back on the version it ran before and starts it. A store
   * the new build migrated is never handed back to the previous build: that
   * is the person's to restore.
   */
  async #rollBack(prepared: PreparedUpdate, swapped: boolean): Promise<UpdateOutcome> {
    const { plan, server, facts } = prepared;
    if (swapped && plan.storeMigration) {
      return updateFailed(
        "rollback-unsafe",
        `Octant ${plan.toVersion} migrated the store on ${plan.alias}, so Octant does not start ${plan.fromVersion} against it. Restore the backup \`octant server upgrade\` took on ${plan.alias}, then run ${plan.fromVersion} there.`,
      );
    }
    const call = await this.#call(server, {
      script: ROLL_BACK_SCRIPT,
      args: [
        facts.installRoot,
        facts.currentRoot,
        `${facts.installRoot}/versions/${plan.toVersion}`,
      ],
      timeoutMs: STEP_TIMEOUT_MS,
    });
    if (!call.ok) return kept(call);
    return call.output.split("\n").at(-1) === facts.currentRoot
      ? { ok: true }
      : updateFailed(
          "command-failed",
          `${plan.alias}'s install does not name ${plan.fromVersion} after the roll-back.`,
        );
  }

  async #runRemoval(
    removal: RunningRemoval,
    prepared: PreparedRemoval,
    actor: EventActor,
  ): Promise<void> {
    const { plan, server, facts, listener, memberId } = prepared;
    const cli = `${facts.installRoot}/current/bin/octant`;
    const steps: Readonly<Record<MemberRemovalStep, () => Promise<RemovalOutcome>>> = {
      leave: async () => {
        const left = await this.#call(server, {
          script: LEAVE_SCRIPT,
          args: [cli],
          timeoutMs: SHORT_STEP_TIMEOUT_MS,
        });
        // A record from before joins kept the member's identity has only its
        // listener address, which another member may hold now. An empty
        // address confirms the leave; the hub removes no one by address alone.
        // A member that already left answers `not-a-spoke`, which also counts
        // once the old address is gone (the owner cleared it by hand).
        if (memberId === undefined) {
          if (left.ok && !this.#options.hub.listed(listener)) return { ok: true };
          const alreadyLeft = left.ok && left.output.split("\n").at(-1) === "not-a-spoke";
          return {
            ok: false,
            failure: left.ok ? "command-failed" : left.failure,
            message: `${
              alreadyLeft
                ? `${plan.alias} has already left the hub, but the hub still lists its old address`
                : `${plan.alias} could not confirm it left the hub${left.ok ? "" : ` (${left.message})`}`
            }, and Octant holds no verified hub identity for it, so the hub removed no member. Remove it from the hub's members in Settings › Remote access, then try again.`,
          };
        }
        // `octant hub leave` exits 0 even when it could not reach the hub (it
        // drops its own membership either way), so the roster decides.
        if (left.ok && !this.#options.hub.listsMember(memberId)) return { ok: true };
        // The member could not tell the hub (its service may be stopped), so
        // the hub, which is this computer, removes it from its roster instead.
        const removed = await this.#options.hub.removeMember(memberId, actor);
        return removed === "refused"
          ? {
              ok: false,
              failure: left.ok ? "command-failed" : left.failure,
              message: `${plan.alias} could not leave the hub${left.ok ? "" : ` (${left.message})`}, and the hub could not remove it.`,
            }
          : { ok: true };
      },
      stop: async () => {
        const call = await this.#call(server, {
          script: STOP_SCRIPT,
          args: [cli],
          timeoutMs: SHORT_STEP_TIMEOUT_MS,
        });
        return call.ok ? { ok: true } : call;
      },
      delete: async () => {
        const call = await this.#call(server, {
          script: DELETE_SCRIPT,
          args: [
            cli,
            facts.installRoot,
            facts.stateRoot,
            removal.deleteData ? "delete" : "keep",
            facts.dataFolder,
          ],
          timeoutMs: STEP_TIMEOUT_MS,
        });
        return call.ok ? { ok: true } : call;
      },
    };
    const mark = (step: MemberRemovalStep, change: Omit<MemberRemovalStepState, "step">) => {
      removal.steps = removal.steps.map((entry) =>
        entry.step === step ? { step, ...change } : entry,
      );
    };
    for (const step of MEMBER_REMOVAL_STEPS) {
      mark(step, { state: "running" });
      const outcome = await steps[step]().catch(
        (): RemovalOutcome => ({
          ok: false,
          failure: "command-failed",
          message: "The step stopped unexpectedly.",
        }),
      );
      const recorded = this.#options.journal.recordMemberRemoval(
        {
          event: "step",
          payload: {
            removalId: removal.removalId,
            serverId: removal.serverId,
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
      mark(step, {
        state: "failed",
        message: outcome.ok
          ? "This step finished, but Octant could not record it, so nothing more ran."
          : outcome.message.slice(0, 1_024),
      });
      removal.steps = removal.steps.map((entry) =>
        entry.state === "waiting" ? { step: entry.step, state: "not-run" } : entry,
      );
      removal.state = "failed";
      return;
    }
    removal.state = "removed";
  }

  /** The registered server and the member record the journal holds for it. */
  #member(
    serverId: string,
  ):
    | { readonly kind: "found"; readonly server: ShieldServer; readonly member: MemberComputer }
    | { readonly kind: "refused"; readonly result: MemberInstallResult } {
    const server = this.#options.servers().find((entry) => String(entry.serverId) === serverId);
    if (server === undefined) return { kind: "refused", result: refused("server-not-found") };
    const member = this.#options.journal.memberComputer(serverId);
    if (member === undefined) {
      return {
        kind: "refused",
        result: refused(
          "not-a-member",
          `Octant did not make ${server.alias} an Octant computer from this computer, so it cannot update it or remove Octant from it here.`,
        ),
      };
    }
    return { kind: "found", server, member };
  }

  /** Reads the install over SSH: the version its `current` link names, and where it and the data folder are. */
  async #readInstall(
    server: ShieldServer,
    member: MemberComputer,
  ): Promise<
    | { readonly kind: "read"; readonly facts: InstalledFacts }
    | { readonly kind: "refused"; readonly result: MemberInstallResult }
  > {
    const probe = await this.#options.connection.run(
      { alias: server.alias, user: server.user },
      { script: PROBE_SCRIPT, timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: 256 * 1024 },
    );
    if (probe.status !== "ran") {
      return {
        kind: "refused",
        result: refused(
          "server-unreachable",
          `${server.alias} could not be reached${probe.status === "unreachable" ? `: ${probe.message}` : "."}`,
        ),
      };
    }
    const facts = readInstalledFacts(probe.output.toString("utf8"));
    if (facts === undefined || facts.target !== member.target) {
      return {
        kind: "refused",
        result: refused(
          "not-a-member",
          `Octant could not find the install it made on ${server.alias}. If Octant was removed there by hand, make it an Octant computer again.`,
        ),
      };
    }
    return { kind: "read", facts };
  }

  #call(
    server: ServerAddress,
    input: {
      readonly script: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: Buffer;
      readonly timeoutMs: number;
    },
  ): Promise<ServerStepCall> {
    return callServer(this.#options.connection, server, input);
  }

  #forgetExpiredPlans(): void {
    const now = this.#options.now();
    for (const [planId, prepared] of this.#updatePlans) {
      if (now - prepared.preparedAt > PLAN_LIFETIME_MS) this.#updatePlans.delete(planId);
    }
    for (const [planId, prepared] of this.#removalPlans) {
      if (now - prepared.preparedAt > PLAN_LIFETIME_MS) this.#removalPlans.delete(planId);
    }
  }
}

function listenerOf(member: MemberComputer): MemberListener {
  return { address: member.listenAddress, port: member.listenPort };
}

/** Whether `candidate` is a later version than `installed`; a final release outranks its own candidate. */
function isNewer(candidate: string, installed: string): boolean {
  return compareBuildVersions(candidate, installed) > 0;
}

/**
 * The probe's answer, when it names an install Octant made: a supported
 * system, absolute folders, and a `current` link naming the version folder
 * of the manifest it holds.
 */
function readInstalledFacts(text: string): InstalledFacts | undefined {
  const at = text.indexOf("\nmanifest\n");
  if (at === -1) return undefined;
  const values = new Map<string, string>();
  for (const line of text.slice(0, at).split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) values.set(line.slice(0, equals), line.slice(equals + 1).trim());
  }
  const target = targetOf(values.get("system") ?? "");
  const stateRoot = values.get("state") ?? "";
  const dataFolder = values.get("data") ?? "";
  if (target === undefined || !isFolder(stateRoot) || !isFolder(dataFolder)) return undefined;
  const installRoot = `${stateRoot}/install`;
  let manifest;
  try {
    manifest = decodeHeadlessArtifactManifest(text.slice(at + "\nmanifest\n".length));
  } catch {
    return undefined;
  }
  const currentRoot = values.get("current") ?? "";
  if (
    !SAFE_VERSION.test(manifest.artifactVersion) ||
    currentRoot !== `${installRoot}/versions/${manifest.artifactVersion}`
  ) {
    return undefined;
  }
  return {
    target,
    stateRoot,
    dataFolder,
    installRoot,
    currentRoot,
    version: manifest.artifactVersion,
    storeVersion: manifest.storeVersion,
    removesService: values.get("removes_service") === "yes",
  };
}

/** An absolute folder short enough to state in the sheet. */
function isFolder(path: string): boolean {
  return path.startsWith("/") && path.length <= 900 && !path.split("/").includes("..");
}

/** What `SWAP_SCRIPT` printed: the upgrade's exit, what `current` names after it, and why it ended. */
function readSwap(output: string): {
  readonly exit: string | undefined;
  readonly current: string | undefined;
  readonly healthRolledBack: boolean;
  readonly lastLine: string | undefined;
} {
  const exit = /(?:^|\n)exit=(\d+)\n/.exec(output)?.[1];
  const current = /(?:^|\n)current=([^\n]*)$/.exec(output)?.[1];
  const said = output.slice(0, output.lastIndexOf("\nexit="));
  const lines = said
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    exit,
    current,
    // `octant server upgrade` says so when its health polls failed and it
    // put the previous version back itself.
    healthRolledBack: /failed its health check and was rolled back/.test(said),
    lastLine: lines.at(-1)?.slice(0, 1_024),
  };
}

function updateFailed(failure: MemberUpdateFailure, message: string): UpdateOutcome {
  return { ok: false, failure, message: message.slice(0, 1_024), rollBack: false };
}

function rollBackFor(failure: MemberUpdateFailure, message: string): UpdateOutcome {
  return { ok: false, failure, message: message.slice(0, 1_024), rollBack: true };
}

/** A failed call before anything changed on the member: nothing to roll back. */
function kept(call: Extract<ServerStepCall, { readonly ok: false }>): UpdateOutcome {
  return { ...call, rollBack: false };
}

function refusedRequester(requester: MemberInstallRequester): MemberInstallResult {
  return refused(
    "not-the-person",
    requester.kind === "agent-grant"
      ? "An agent cannot update an Octant computer or remove Octant from it. Do it from a window on this computer or a device you paired."
      : requester.kind === "routine"
        ? "A routine cannot update an Octant computer or remove Octant from it. Do it from a window on this computer or a device you paired."
        : "Only a window on this computer or a device its person paired can update an Octant computer or remove Octant from it.",
  );
}

const MESSAGES: Partial<Readonly<Record<MemberInstallRefusalReason, string>>> = {
  "server-not-found": "That server is not registered.",
  "plan-expired": "The sheet is out of date. Open it again.",
  "already-installing": "Octant is already installing, updating or removing Octant on that server.",
  "update-not-found": "That update is not running on this computer.",
  "removal-not-found": "That removal is not running on this computer.",
  unavailable: "Octant could not record the request, so nothing ran.",
};

function refused(reason: MemberInstallRefusalReason, message?: string): MemberInstallResult {
  return {
    kind: "member-install-refused",
    reason,
    message: message ?? MESSAGES[reason] ?? "Octant refused this.",
  };
}

function updateProgressOf(update: RunningUpdate): MemberUpdateProgress {
  return {
    updateId: update.updateId,
    serverId: update.serverId,
    state: update.state,
    steps: update.steps,
    ...(update.rollbackReason === undefined ? {} : { rollbackReason: update.rollbackReason }),
  };
}

function removalProgressOf(removal: RunningRemoval): MemberRemovalProgress {
  return {
    removalId: removal.removalId,
    serverId: removal.serverId,
    state: removal.state,
    deleteData: removal.deleteData,
    steps: removal.steps,
  };
}
