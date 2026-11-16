import {
  KEY_PROVIDER_DRIVER_KINDS,
  type KeyProviderDriverKind,
  type ProviderDriverKind,
  type ProviderExecutionPolicy,
  type ProviderNativeSetup,
} from "@octant/contracts/providers";

export function isKeyProviderDriverKind(kind: ProviderDriverKind): kind is KeyProviderDriverKind {
  return (KEY_PROVIDER_DRIVER_KINDS as ReadonlyArray<string>).includes(kind);
}

/**
 * Whether a key provider account runs as itself. On unless the person turned
 * it off: Octant adds to a provider and does not take its own features away
 * (maintainer decision, 2026-11-14).
 */
export function accountRunsAsItself(instance: {
  readonly nativeSetup?: boolean | undefined;
}): boolean {
  return instance.nativeSetup !== false;
}

/**
 * Whether a Claude Code or Codex account keeps the provider's own memory. On
 * unless the person turned it off: Octant does not take a provider's own
 * features away (maintainer decision, 2026-11-14).
 */
export function accountKeepsOwnMemory(instance: {
  readonly ownMemory?: boolean | undefined;
}): boolean {
  return instance.ownMemory !== false;
}

export interface ProviderNativeSetupInput {
  readonly driverKind: ProviderDriverKind;
  readonly mode: "chat" | "work" | "code";
  readonly executionPolicy: ProviderExecutionPolicy;
  /** The account's own switch, on unless the person turned it off (`accountRunsAsItself`). */
  readonly accountAllows: boolean;
  /** The Work or Code Project lists this provider in `nativeProviders`. Always false in Chat. */
  readonly projectTrusts: boolean;
  /**
   * The thread's own choice. `off` keeps every feature unloaded at every
   * level, Full access included; `on` counts as the account switch does and
   * never grants a Project's own code, which still needs the Project's trust.
   */
  readonly threadChoice?: "on" | "off";
}

/**
 * What a key provider's session may load of its own. The account's switch is
 * on unless the person turned it off, so at every level a session loads the
 * person's own subagents, web tools, skills, and tool servers, as it does in
 * the provider's own app; each call still meets the thread's level. With the
 * account turned off, Full access and a trusted Project still turn the rest
 * on, but never the runtime's own web search and fetch: an account that does
 * not run as itself keeps them off in every mode and at every level
 * (maintainer decision, 2026-11-15). Undefined means every feature stays off,
 * which is the answer for every provider that is not a key provider.
 *
 * A thread's own choice overrides the rest: off loads nothing, on loads as
 * the account switch does, except the web tools of an account turned off.
 *
 * Plan stays read-only and Chat keeps its filesystem and shell withheld at
 * every level, so neither loads hooks or a Project's own code: a hook is a
 * shell command the runtime runs by itself, and a Project's MCP servers and
 * plugins carry hooks of their own. Plan also leaves the account's tool
 * servers off, because a server's tools can write. Chat may keep them: they
 * are the person's own tool servers, which Chat's no-filesystem rule does not
 * cover, and the switch says so. A Project's code loads only where the person
 * trusted that Project for that provider, Full access included.
 */
export function resolveProviderNativeSetup(
  input: ProviderNativeSetupInput,
): ProviderNativeSetup | undefined {
  if (!isKeyProviderDriverKind(input.driverKind)) return undefined;
  if (input.threadChoice === "off") return undefined;
  const accountAllows = input.accountAllows || input.threadChoice === "on";
  const projectTrusts = input.mode !== "chat" && input.projectTrusts;
  const fullAccess = input.mode !== "chat" && input.executionPolicy === "full-access";
  const plan = input.executionPolicy === "plan";
  if (!accountAllows && !projectTrusts && !fullAccess) return undefined;
  const chat = input.mode === "chat";
  return {
    subagents: true,
    webTools: input.accountAllows,
    skills: true,
    toolServers: !plan,
    hooks: !plan && !chat,
    projectCode: projectTrusts && !plan,
  };
}

/**
 * The provider's own MCP servers a Plan session starts: exactly the ones the
 * person marked "Read-only — allowed in Plan" on this host, and only where the
 * session loads the person's setup at all. Plan leaves the account's tool
 * servers off because a server's tools can write; the person's mark is what
 * lets one back in, never the server's own `readOnlyHint`, which is the
 * server's claim. Outside Plan the setup's `toolServers` decides as before, so
 * the mark adds nothing there. Each marked server's tools still meet the
 * thread's ask rules.
 */
export function planReadOnlyToolServers(input: {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly setup: ProviderNativeSetup | undefined;
  readonly marked: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  if (input.executionPolicy !== "plan" || input.setup === undefined) return [];
  return [...new Set(input.marked)];
}

/**
 * Whether a setup loads anything of the person's own configuration: rules,
 * skills, tool servers, hooks, subagents, or a Project's code. The runtime's
 * web tools alone do not, so a session with only those on is not running as
 * itself and keeps Octant's own permissions and approvals.
 */
export function providerRunsAsItself(setup: ProviderNativeSetup | undefined): boolean {
  return (
    setup !== undefined &&
    (setup.subagents || setup.skills || setup.toolServers || setup.hooks || setup.projectCode)
  );
}

/**
 * How a provider's own memory reaches its memory folder. `session-tools`: the
 * memory is loaded when a session starts, and only the model's own file tools
 * write it (Claude Code's `CLAUDE.md` files and auto-memory). `background`:
 * the runtime writes memories by itself, outside any tool call a gate could
 * refuse (Codex writes `~/.codex/memories` after a turn).
 */
export type ProviderMemoryWrites = "session-tools" | "background";

/**
 * Whether a session launches with the provider's own memory on. The account's
 * own setting decides (on unless the person turned it off,
 * `accountKeepsOwnMemory`), and nothing else turns it on: not "Run as itself",
 * not a trusted Project, not Full access. Plan and Chat may write nothing a
 * later session would load, and the runtime's memory folder is exactly that,
 * so there the memory is loaded only when it is read-only: a provider whose
 * memory only its session tools write keeps it in Plan and Chat, where Plan
 * holds no write tool and its sandbox binds that folder read-only, and Chat's
 * gate refuses a write into it; a provider that writes memories in the
 * background keeps it off there (maintainer decision, 2026-11-16).
 */
export function providerOwnMemoryLaunches(input: {
  /** The account's own switch (`accountKeepsOwnMemory`). */
  readonly accountAllows: boolean;
  readonly mode: "chat" | "work" | "code" | undefined;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly memoryWrites: ProviderMemoryWrites;
}): boolean {
  if (!input.accountAllows || input.mode === undefined) return false;
  const readOnlyLaunch = input.mode === "chat" || input.executionPolicy === "plan";
  return !readOnlyLaunch || input.memoryWrites === "session-tools";
}

/** Whether any feature of a resolved setup is on. */
export function providerNativeSetupIsOn(setup: ProviderNativeSetup | undefined): boolean {
  return (
    setup !== undefined &&
    (setup.subagents ||
      setup.webTools ||
      setup.skills ||
      setup.toolServers ||
      setup.hooks ||
      setup.projectCode)
  );
}
