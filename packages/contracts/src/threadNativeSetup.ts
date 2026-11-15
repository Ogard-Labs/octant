import { Schema } from "effect";
import { KeyProviderDriverKind, ProviderInstanceId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * One thread's own choice about a key provider's native setup. `on` lets the
 * thread load the provider's own setup as the account switch would, `off`
 * keeps all of it unloaded even at Full access, and `inherit` leaves the
 * decision to the account and the Project.
 */
export const ThreadNativeSetupChoice = Schema.Literal("on", "off", "inherit");
export type ThreadNativeSetupChoice = typeof ThreadNativeSetupChoice.Type;

/** A Chat, Work, or Code thread's id; the aggregate id of its choice. */
export const ThreadNativeSetupThreadId = Schema.UUID;

export const THREAD_NATIVE_SETUP_AGGREGATE = "thread-native-setup";
export const THREAD_NATIVE_SETUP_EVENT_NAMES = {
  changed: "thread.native-setup-changed@1",
} as const;

export const ThreadNativeSetupChanged = Schema.Struct({
  threadId: ThreadNativeSetupThreadId,
  choice: ThreadNativeSetupChoice,
}).annotations(strict);
export type ThreadNativeSetupChanged = typeof ThreadNativeSetupChanged.Type;
export const decodeThreadNativeSetupChanged = Schema.decodeUnknownSync(ThreadNativeSetupChanged);

export const ThreadNativeSetupRequest = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("get"),
    threadId: ThreadNativeSetupThreadId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set"),
    threadId: ThreadNativeSetupThreadId,
    /** The thread's provider account; the host refuses an account that is not a key provider's. */
    providerInstanceId: ProviderInstanceId,
    choice: ThreadNativeSetupChoice,
  }).annotations(strict),
  Schema.Struct({
    /**
     * Whether the thread's Project holds its key provider's own Project code
     * and whether the Project trusts that provider. A read: only
     * `change-project-native-providers` changes the trust.
     */
    kind: Schema.Literal("project-code"),
    threadId: ThreadNativeSetupThreadId,
    mode: Schema.Literal("work", "code"),
  }).annotations(strict),
);
export type ThreadNativeSetupRequest = typeof ThreadNativeSetupRequest.Type;
export const decodeThreadNativeSetupRequest = Schema.decodeUnknownSync(ThreadNativeSetupRequest);

export const ThreadNativeSetupResult = Schema.Struct({
  threadId: ThreadNativeSetupThreadId,
  choice: ThreadNativeSetupChoice,
}).annotations(strict);
export type ThreadNativeSetupResult = typeof ThreadNativeSetupResult.Type;
export const decodeThreadNativeSetupResult = Schema.decodeUnknownSync(ThreadNativeSetupResult);

/**
 * What a provider's own Project code would load: settings files (which may
 * carry hooks and MCP servers of their own), a Project MCP server list,
 * skills, hooks, plugins, tools, and agents.
 */
export const ProjectCodeKind = Schema.Literal(
  "settings",
  "mcp-servers",
  "skills",
  "hooks",
  "plugins",
  "tools",
  "agents",
);
export type ProjectCodeKind = typeof ProjectCodeKind.Type;

/**
 * `none` covers a provider that is not a key provider, one whose trust loads
 * no Project code, and a Project folder that holds none of it.
 */
export const ThreadProjectCode = Schema.Union(
  Schema.Struct({ status: Schema.Literal("none") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("trusted", "untrusted"),
    provider: KeyProviderDriverKind,
    found: Schema.NonEmptyArray(ProjectCodeKind),
  }).annotations(strict),
);
export type ThreadProjectCode = typeof ThreadProjectCode.Type;

export const ThreadProjectCodeResult = Schema.Struct({
  threadId: ThreadNativeSetupThreadId,
  projectCode: ThreadProjectCode,
}).annotations(strict);
export type ThreadProjectCodeResult = typeof ThreadProjectCodeResult.Type;
export const decodeThreadProjectCodeResult = Schema.decodeUnknownSync(ThreadProjectCodeResult);
