import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

/**
 * Opaque identity for one observed local listener.
 *
 * Local servers is an ephemeral host observation, not a journaled aggregate,
 * so the id is a per-scan opaque token rather than a persisted key. It is
 * deliberately *not* a PID: the renderer and remote clients must never receive
 * a host process handle they could use as a process inventory, and the server
 * re-resolves the token to a process only after re-classifying it.
 */
export const LocalServerListenerId = Schema.String.pipe(
  Schema.pattern(/^lsn_[a-f0-9]{32}$/),
  Schema.brand("LocalServerListenerId"),
);
export type LocalServerListenerId = typeof LocalServerListenerId.Type;

/** Correlation id the renderer mints so a result can be matched to its command. */
export const LocalServerRequestId = brandedUuid("LocalServerRequestId");
export type LocalServerRequestId = typeof LocalServerRequestId.Type;

/** TCP port a classified user/dev server holds. */
export const LocalServerPort = Schema.Int.pipe(
  Schema.greaterThanOrEqualTo(1),
  Schema.lessThanOrEqualTo(65_535),
  Schema.brand("LocalServerPort"),
);
export type LocalServerPort = typeof LocalServerPort.Type;

/**
 * Loopback authorities a listener URL may name. `[::1]` is the IPv6 loopback
 * as a URL authority: a dev server bound only to `::1` is reachable there and
 * nowhere else, so excluding it would make a healthy server unopenable rather
 * than narrowing any authority.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Normalized local URL for one listener. Constrained to a loopback HTTP(S)
 * origin with an explicit port and no credentials, query, or fragment: Open
 * creates a Browser tab allowed to reach exactly this origin, so a widened or
 * non-loopback URL would widen that tab's authority.
 */
export const LocalServerUrl = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOOPBACK_HOSTNAMES.has(url.hostname) &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.href === value
    );
  }),
  Schema.brand("LocalServerUrl"),
);
export type LocalServerUrl = typeof LocalServerUrl.Type;

/**
 * Where the listener was started from, as classified by the host. `unknown` is
 * reachable only for a listener that is otherwise classified (known framework
 * or interpreter in a user project); an unclassified process is omitted from
 * the snapshot entirely rather than listed with an unknown source.
 */
export const LocalServerStartSource = Schema.Literal(
  "octant",
  "vscode",
  "claude",
  "codex",
  "other-editor",
  "unknown",
);
export type LocalServerStartSource = typeof LocalServerStartSource.Type;

/** Loopback-only versus reachable from the local network. */
export const LocalServerBindScope = Schema.Literal("loopback", "lan");
export type LocalServerBindScope = typeof LocalServerBindScope.Type;

/**
 * Probe outcome. `listening` answered the health probe; `unresponsive` holds
 * the port but did not answer — the wedged case the design requires to be
 * visually and textually distinct from a healthy listener.
 *
 * `unknown` is neither, and it is the only honest answer for a listener the
 * host never finished asking about: a probe that threw, one the listing's
 * bounded health phase cut short, or one abandoned before it reached its second
 * scheme or loopback family. It is produced by the host running out of time or
 * of a usable answer, never by anything the listener did.
 *
 * It is deliberately *not* a softer `unresponsive`. It does not mean the
 * listener is wedged, slow, or broken, and it never means it is healthy: the
 * host established nothing either way, so `openAvailable` stays false for it
 * exactly as it does for a listener proven silent. Surfaces must say the host
 * did not determine it rather than describe the listener's state.
 */
export const LocalServerHealth = Schema.Literal("listening", "unresponsive", "unknown");
export type LocalServerHealth = typeof LocalServerHealth.Type;

/** Whether the listener belongs to this Code thread's checkout or is a leftover. */
export const LocalServerAttribution = Schema.Literal("current-checkout", "other");
export type LocalServerAttribution = typeof LocalServerAttribution.Type;

/**
 * Server-decided Stop availability. The renderer never decides this: it renders
 * exactly what the host classified. `unavailable` carries a reason so the row
 * can explain itself in words rather than by a missing control alone.
 */
export const LocalServerStopAvailability = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("available"),
    /** Leftovers require an explicit confirmation naming process, cwd, and port. */
    confirmationRequired: Schema.Boolean,
  }).annotations(strict),
);
export type LocalServerStopAvailability = typeof LocalServerStopAvailability.Type;

/**
 * One classified user/dev listener as the renderer sees it.
 *
 * Raw command lines, environment, PIDs, and other-user process details are
 * absent by construction: the schema is strict, so a server bug that tried to
 * attach them fails to encode rather than leaking a host process inventory.
 */
export const LocalServerListener = Schema.Struct({
  listenerId: LocalServerListenerId,
  port: LocalServerPort,
  url: LocalServerUrl,
  /** Process or app name, e.g. `node`, `bun`, `python`. Never a command line. */
  processName: Schema.NonEmptyTrimmedString,
  /** Inferred framework when the host recognized one, e.g. `vite`, `next`. */
  framework: Schema.optional(Schema.NonEmptyTrimmedString),
  /**
   * Working directory of the listener when known. Present because leftover
   * Stop confirmation must name process, cwd, and port; a listener whose cwd
   * the host could not read is listed without it rather than with a guess.
   */
  workingDirectory: Schema.optional(Schema.NonEmptyTrimmedString),
  /** Project or worktree label when the host could attribute the cwd. */
  workspaceLabel: Schema.optional(Schema.NonEmptyTrimmedString),
  attribution: LocalServerAttribution,
  startSource: LocalServerStartSource,
  bindScope: LocalServerBindScope,
  health: LocalServerHealth,
  /** Open is offered for healthy HTTP(S) listeners, including API backends. */
  openAvailable: Schema.Boolean,
  stop: LocalServerStopAvailability,
}).annotations(strict);
export type LocalServerListener = typeof LocalServerListener.Type;

/**
 * One ephemeral observation for a bound Code thread. `currentCheckout` rows
 * render above `other` leftovers; the split is authoritative rather than a
 * renderer-side sort so remote clients see the same grouping.
 */
export const LocalServerSnapshot = Schema.Struct({
  threadId: CodeThreadId,
  projectId: ProjectId,
  currentCheckout: Schema.Array(LocalServerListener),
  other: Schema.Array(LocalServerListener),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type LocalServerSnapshot = typeof LocalServerSnapshot.Type;

/**
 * Explicit leftover-stop confirmation. The renderer echoes the exact facts it
 * showed the user; the server re-classifies and refuses when they no longer
 * match the observed listener, so a stale confirmation cannot signal a
 * different process that has since taken the port.
 */
export const LocalServerStopConfirmation = Schema.Struct({
  acknowledgedProcessName: Schema.NonEmptyTrimmedString,
  acknowledgedPort: LocalServerPort,
  acknowledgedWorkingDirectory: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type LocalServerStopConfirmation = typeof LocalServerStopConfirmation.Type;

const CommandFields = {
  requestId: LocalServerRequestId,
  threadId: CodeThreadId,
  projectId: ProjectId,
} as const;

export const LocalServerCommand = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("list-local-servers"), ...CommandFields }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("open-local-server"),
    ...CommandFields,
    listenerId: LocalServerListenerId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("stop-local-server"),
    ...CommandFields,
    listenerId: LocalServerListenerId,
    confirmation: Schema.optional(LocalServerStopConfirmation),
  }).annotations(strict),
);
export type LocalServerCommand = typeof LocalServerCommand.Type;

/**
 * Target for a host-owned Browser tab. Open always creates a new tab whose
 * context allows exactly `allowedOrigin`; a second leftover creates another tab
 * rather than widening `localhost` to every port.
 */
export const LocalServerOpenTarget = Schema.Struct({
  url: LocalServerUrl,
  allowedOrigin: Schema.NonEmptyTrimmedString,
  /** True when the isolated tab may accept this one localhost certificate. */
  acceptsLocalCertificate: Schema.Boolean,
}).annotations(strict);
export type LocalServerOpenTarget = typeof LocalServerOpenTarget.Type;

/**
 * Typed failure categories. `confirmation-required` and `local-host-required`
 * are distinct from `unauthorized` because they are actionable: the first asks
 * the local user to confirm, the second says the action must happen on the
 * host rather than from a paired remote device.
 */
export const LocalServerFailure = Schema.Struct({
  category: Schema.Literal(
    "invalid",
    "unauthorized",
    "unavailable",
    "not-found",
    "confirmation-required",
    "local-host-required",
  ),
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type LocalServerFailure = typeof LocalServerFailure.Type;

export const LocalServerCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("local-servers-listed"),
    requestId: LocalServerRequestId,
    snapshot: LocalServerSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("local-server-open-prepared"),
    requestId: LocalServerRequestId,
    listenerId: LocalServerListenerId,
    target: LocalServerOpenTarget,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("local-server-stopped"),
    requestId: LocalServerRequestId,
    listenerId: LocalServerListenerId,
    snapshot: LocalServerSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("local-server-rejected"),
    requestId: LocalServerRequestId,
    failure: LocalServerFailure,
  }).annotations(strict),
);
export type LocalServerCommandResult = typeof LocalServerCommandResult.Type;

export const decodeLocalServerListenerId = Schema.decodeUnknownSync(LocalServerListenerId);
export const decodeLocalServerRequestId = Schema.decodeUnknownSync(LocalServerRequestId);
export const decodeLocalServerPort = Schema.decodeUnknownSync(LocalServerPort);
export const decodeLocalServerUrl = Schema.decodeUnknownSync(LocalServerUrl);
export const decodeLocalServerListener = Schema.decodeUnknownSync(LocalServerListener);
export const decodeLocalServerSnapshot = Schema.decodeUnknownSync(LocalServerSnapshot);
export const decodeLocalServerCommand = Schema.decodeUnknownSync(LocalServerCommand);
export const decodeLocalServerCommandResult = Schema.decodeUnknownSync(LocalServerCommandResult);
export const decodeLocalServerFailure = Schema.decodeUnknownSync(LocalServerFailure);

/** Bound on one observation so a pathological host cannot flood the renderer. */
export const MAX_LOCAL_SERVER_LISTENERS = 200;
