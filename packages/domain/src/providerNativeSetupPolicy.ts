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

export interface ProviderNativeSetupInput {
  readonly driverKind: ProviderDriverKind;
  readonly mode: "chat" | "work" | "code";
  readonly executionPolicy: ProviderExecutionPolicy;
  /** The account's own switch: `nativeSetup` on the provider instance. */
  readonly accountAllows: boolean;
  /** The Work or Code Project lists this provider in `nativeProviders`. Always false in Chat. */
  readonly projectTrusts: boolean;
}

/**
 * What a key provider's session may load of its own. At Guarded and Reviewed
 * nothing loads until the person turns it on for the account or trusts the
 * Project for that provider; at Full access it is on, as it is in the
 * provider's own app. Undefined means every feature stays off, which is the
 * answer for every provider that is not a key provider.
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
  const projectTrusts = input.mode !== "chat" && input.projectTrusts;
  const fullAccess = input.mode !== "chat" && input.executionPolicy === "full-access";
  if (!input.accountAllows && !projectTrusts && !fullAccess) return undefined;
  const plan = input.executionPolicy === "plan";
  const chat = input.mode === "chat";
  return {
    subagents: true,
    webTools: true,
    skills: true,
    toolServers: !plan,
    hooks: !plan && !chat,
    projectCode: projectTrusts && !plan,
  };
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
