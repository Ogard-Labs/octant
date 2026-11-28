/**
 * Access activity and change notices (maintainer decision, 2026-11-22).
 *
 * Access activity is the host's record of devices added, removed, and
 * re-levelled. A change notice tells the person, in the app only, that a
 * paired device or an agent grant raised a thread's access level or added or
 * replaced a provider key. Both are read from the journal; neither carries a
 * key, a prompt, or a path.
 */

import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { PermissionMode } from "./providers";
import { DeviceAccessLevel } from "./remoteAccess";

const label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const ACCESS_ACTIVITY_PATH = "/api/access-activity";
export const CHANGE_NOTICES_PATH = "/api/change-notices";
export const CHANGE_NOTICE_ACTION_PATHS = {
  dismiss: `${CHANGE_NOTICES_PATH}/dismiss`,
  undo: `${CHANGE_NOTICES_PATH}/undo`,
  revoke: `${CHANGE_NOTICES_PATH}/revoke`,
} as const;

/** The most access activity entries one read returns, newest first. */
export const ACCESS_ACTIVITY_LIMIT = 200;

/** Who made a change, as the person reads it. */
export const AccessChangeActor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local-person") }),
  Schema.Struct({ kind: Schema.Literal("host") }),
  Schema.Struct({
    kind: Schema.Literal("device"),
    deviceId: GuidString,
    label,
  }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    grantId: GuidString,
    name: label,
  }),
  Schema.Struct({ kind: Schema.Literal("owner-device") }),
]);
export type AccessChangeActor = typeof AccessChangeActor.Type;

export const AccessActivityEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("added"),
    entryId: GuidString,
    at: Schema.String,
    deviceId: GuidString,
    deviceLabel: label,
    accessLevel: DeviceAccessLevel,
    actor: AccessChangeActor,
  }),
  Schema.Struct({
    kind: Schema.Literal("removed"),
    entryId: GuidString,
    at: Schema.String,
    deviceId: GuidString,
    deviceLabel: label,
    /**
     * `revoked` by a person, `signed-out` with every other device,
     * `self-revoked` by the device itself, `expired`, `host-key-recovered`,
     * or `pairing-abandoned` — the host's sweep removed a pairing that never
     * finished, so no person removed it.
     */
    reason: Schema.Literals([
      "revoked",
      "signed-out",
      "self-revoked",
      "expired",
      "host-key-recovered",
      "pairing-abandoned",
    ]),
    actor: AccessChangeActor,
  }),
  Schema.Struct({
    kind: Schema.Literal("relevelled"),
    entryId: GuidString,
    at: Schema.String,
    deviceId: GuidString,
    deviceLabel: label,
    previousLevel: DeviceAccessLevel,
    accessLevel: DeviceAccessLevel,
    actor: AccessChangeActor,
  }),
]);
export type AccessActivityEntry = typeof AccessActivityEntry.Type;

export const AccessActivityList = Schema.Struct({
  entries: Schema.Array(AccessActivityEntry).check(Schema.isMaxLength(ACCESS_ACTIVITY_LIMIT)),
});
export type AccessActivityList = typeof AccessActivityList.Type;

/** Who a notice names: only a paired device or an agent grant raises one. */
export const ChangeNoticeActor = Schema.Union([
  AccessChangeActor.members[2],
  AccessChangeActor.members[3],
]);
export type ChangeNoticeActor = typeof ChangeNoticeActor.Type;

export const ChangeNotice = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread-level-raised"),
    noticeId: GuidString,
    at: Schema.String,
    actor: ChangeNoticeActor,
    surface: Schema.Literals(["code", "work"]),
    threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    threadTitle: Schema.optional(label),
    from: PermissionMode,
    to: PermissionMode,
  }),
  Schema.Struct({
    kind: Schema.Literals(["provider-key-added", "provider-key-replaced"]),
    noticeId: GuidString,
    at: Schema.String,
    actor: ChangeNoticeActor,
    providerInstanceId: GuidString,
    providerName: Schema.optional(label),
    /**
     * On a key added: the key's pool id, present only while Undo can still
     * remove exactly that key. A window removes it through the desktop's own
     * key path, so the read is what says the notice is still current.
     */
    keyId: Schema.optional(
      Schema.String.check(
        Schema.isPattern(
          /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
        ),
      ),
    ),
  }),
]);
export type ChangeNotice = typeof ChangeNotice.Type;

export const ChangeNoticeList = Schema.Struct({
  notices: Schema.Array(ChangeNotice).check(Schema.isMaxLength(50)),
});
export type ChangeNoticeList = typeof ChangeNoticeList.Type;

/** The body of a dismiss, Undo, or revoke: the notice it acts on. */
export const ChangeNoticeRequest = Schema.Struct({ noticeId: GuidString });
export const decodeChangeNoticeRequest = Schema.decodeUnknownSync(
  ChangeNoticeRequest,
  STRICT_DECODE_OPTIONS,
);

/**
 * A person dismissed a notice, or acted on it with Undo or revoke. Journaled
 * so the notice stays gone across a restart and on every client.
 */
export const CHANGE_NOTICE_DISMISSED = "access-notice.dismissed@1";
export const CHANGE_NOTICE_AGGREGATE_TYPE = "access-notice";
export const ChangeNoticeDismissed = Schema.Struct({
  noticeId: GuidString,
  dismissedAt: Schema.String,
  /** What the person did: dismissed it, undid the change, or revoked the actor. */
  outcome: Schema.Literals(["dismissed", "undone", "revoked"]),
});
export type ChangeNoticeDismissed = typeof ChangeNoticeDismissed.Type;
