import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ProjectId } from "./projects";
import {
  KeyProviderDriverKind,
  MAX_PROVIDER_MENTIONS,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderMention,
} from "./providers";

/**
 * One thread's own choice about a key provider's native setup. `on` lets the
 * thread load the provider's own setup as the account switch would, `off`
 * keeps all of it unloaded even at Full access, and `inherit` leaves the
 * decision to the account and the Project.
 */
export const ThreadNativeSetupChoice = Schema.Literals(["on", "off", "inherit"]);
export type ThreadNativeSetupChoice = typeof ThreadNativeSetupChoice.Type;

/** A Chat, Work, or Code thread's id; the aggregate id of its choice. */
export const ThreadNativeSetupThreadId = GuidString;

export const THREAD_NATIVE_SETUP_AGGREGATE = "thread-native-setup";
export const THREAD_NATIVE_SETUP_EVENT_NAMES = {
  changed: "thread.native-setup-changed@1",
} as const;

export const ThreadNativeSetupChanged = Schema.Struct({
  threadId: ThreadNativeSetupThreadId,
  choice: ThreadNativeSetupChoice,
});
export type ThreadNativeSetupChanged = typeof ThreadNativeSetupChanged.Type;
export const decodeThreadNativeSetupChanged = Schema.decodeUnknownSync(
  ThreadNativeSetupChanged,
  STRICT_DECODE_OPTIONS,
);

export const ThreadNativeSetupRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("get"),
    threadId: ThreadNativeSetupThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("set"),
    threadId: ThreadNativeSetupThreadId,
    /** The thread's provider account; the host refuses an account that is not a key provider's. */
    providerInstanceId: ProviderInstanceId,
    choice: ThreadNativeSetupChoice,
  }),
  Schema.Struct({
    /**
     * Whether the thread's Project holds its key provider's own Project code
     * and whether the Project trusts that provider. A read: only
     * `change-project-native-providers` changes the trust.
     */
    kind: Schema.Literal("project-code"),
    threadId: ThreadNativeSetupThreadId,
    mode: Schema.Literals(["work", "code"]),
  }),
  Schema.Struct({
    /**
     * The provider's own skills and plugins available for this Work or Code
     * thread's folder and effective native setup, for the composer's `@` menu.
     * Project skills are listed only when the thread's launch actually loads
     * them (`nativeSetup.skills === true`).
     */
    kind: Schema.Literal("mentions"),
    threadId: ThreadNativeSetupThreadId,
    mode: Schema.Literals(["work", "code"]),
  }),
  Schema.Struct({
    /**
     * Same as `mentions`, for a Work or Code draft before its thread exists,
     * using the Project's root folder and the selected provider.
     */
    kind: Schema.Literal("draft-mentions"),
    projectId: ProjectId,
    mode: Schema.Literals(["work", "code"]),
    providerInstanceId: ProviderInstanceId,
    executionPolicy: Schema.optional(ProviderExecutionPolicy),
  }),
]);
export type ThreadNativeSetupRequest = typeof ThreadNativeSetupRequest.Type;
export const decodeThreadNativeSetupRequest = Schema.decodeUnknownSync(
  ThreadNativeSetupRequest,
  STRICT_DECODE_OPTIONS,
);

export const ThreadNativeSetupResult = Schema.Struct({
  threadId: ThreadNativeSetupThreadId,
  choice: ThreadNativeSetupChoice,
});
export type ThreadNativeSetupResult = typeof ThreadNativeSetupResult.Type;
export const decodeThreadNativeSetupResult = Schema.decodeUnknownSync(
  ThreadNativeSetupResult,
  STRICT_DECODE_OPTIONS,
);

/**
 * What a provider's own Project code would load: settings files (which may
 * carry hooks and MCP servers of their own), a Project MCP server list,
 * skills, hooks, plugins, tools, and agents.
 */
export const ProjectCodeKind = Schema.Literals([
  "settings",
  "mcp-servers",
  "skills",
  "hooks",
  "plugins",
  "tools",
  "agents",
  "commands",
]);
export type ProjectCodeKind = typeof ProjectCodeKind.Type;

/**
 * `none` covers a provider that is not a key provider, one whose trust loads
 * no Project code, and a Project folder that holds none of it.
 */
export const ThreadProjectCode = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({
    status: Schema.Literals(["trusted", "untrusted"]),
    provider: KeyProviderDriverKind,
    found: Schema.NonEmptyArray(ProjectCodeKind),
  }),
]);
export type ThreadProjectCode = typeof ThreadProjectCode.Type;

export const ThreadProjectCodeResult = Schema.Struct({
  threadId: ThreadNativeSetupThreadId,
  projectCode: ThreadProjectCode,
});
export type ThreadProjectCodeResult = typeof ThreadProjectCodeResult.Type;
export const decodeThreadProjectCodeResult = Schema.decodeUnknownSync(
  ThreadProjectCodeResult,
  STRICT_DECODE_OPTIONS,
);

export const ThreadProviderMentionsResult = Schema.Struct({
  mentions: Schema.Array(ProviderMention).check(Schema.isMaxLength(MAX_PROVIDER_MENTIONS)),
});
export type ThreadProviderMentionsResult = typeof ThreadProviderMentionsResult.Type;
export const decodeThreadProviderMentionsResult = Schema.decodeUnknownSync(
  ThreadProviderMentionsResult,
  STRICT_DECODE_OPTIONS,
);
