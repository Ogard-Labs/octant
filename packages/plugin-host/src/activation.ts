import type {
  ExtensionActivationState,
  ExtensionComponent,
  ExtensionEffectiveState,
  ExtensionPackageState,
} from "@octant/contracts/extensions";
import type { OctantMode } from "@octant/contracts/modes";

const rendererKinds = ["ui-surface", "appearance-pack", "preview-viewer"] as const;
const providerDriverKind = ["provider-driver"] as const;
// Chat never leases a desktop: a Chat Project has no root to send an artifact from.
const desktopProviderKind = ["desktop-provider"] as const;

const modeKinds: Readonly<Record<OctantMode, ReadonlySet<ExtensionComponent["kind"]>>> = {
  chat: new Set([
    "skill-instructions",
    "mcp-server",
    "mcp-tool",
    "mcp-prompt",
    "mcp-resource",
    ...rendererKinds,
    ...providerDriverKind,
  ]),
  work: new Set([
    "skill-instructions",
    "mcp-server",
    "mcp-tool",
    "mcp-prompt",
    "mcp-resource",
    "app",
    ...rendererKinds,
    ...providerDriverKind,
    ...desktopProviderKind,
  ]),
  code: new Set([
    "skill-instructions",
    "mcp-server",
    "mcp-tool",
    "mcp-prompt",
    "mcp-resource",
    "hook",
    "app",
    "agent",
    "apple-development-adapter",
    "board",
    "integration",
    // Code only: Work has no developer environment and Chat has no folder.
    "language-server",
    "debug-adapter",
    ...rendererKinds,
    ...providerDriverKind,
    ...desktopProviderKind,
  ]),
};

const modeProhibitedCapabilities: Readonly<
  Record<OctantMode, ReadonlySet<ExtensionComponent["declaredCapabilities"][number]>>
> = {
  chat: new Set([
    "filesystem",
    "shell",
    "credentials",
    "external-application",
    "hooks",
    "apps",
    "agents",
    "apple-development",
  ]),
  work: new Set(["shell", "hooks", "agents", "apple-development"]),
  code: new Set(),
};

export function isExtensionComponentModeSafe(
  mode: OctantMode,
  component: ExtensionComponent,
): boolean {
  return (
    modeKinds[mode].has(component.kind) &&
    component.declaredCapabilities.every(
      (capability) => !modeProhibitedCapabilities[mode].has(capability),
    )
  );
}

/**
 * Whether a host may ever run a stored component's process. A stored
 * provider-driver component is an outside driver, and only macOS confines one
 * (deny-default Seatbelt with no network, exec, or fork). Extension processes
 * have no Linux or Windows confinement, so there the component is
 * `host-prohibited` rather than started unconfined.
 */
export function isExtensionComponentHostConfined(
  platform: string,
  component: ExtensionComponent,
): boolean {
  return component.kind !== "provider-driver" || isOutsideDriverHostConfined(platform);
}

/** Whether this platform confines an outside provider driver's process. */
export function isOutsideDriverHostConfined(platform: string): boolean {
  return platform === "darwin";
}

export interface ExtensionActivationContext extends ExtensionActivationState {
  readonly hostAllowed: boolean;
  readonly modeAllowed: boolean;
  readonly projectAllowed: boolean;
  readonly threadAllowed: boolean;
  readonly catalogCurrent: boolean;
}

export function resolveExtensionActivation(
  state: ExtensionActivationContext,
): ExtensionEffectiveState {
  if (!state.hostAllowed) return { kind: "blocked", reason: "host-prohibited" };
  if (!state.modeAllowed) return { kind: "blocked", reason: "mode-prohibited" };
  if (!state.projectAllowed || !state.policyAllowed) {
    return { kind: "blocked", reason: "project-prohibited" };
  }
  if (!state.threadAllowed) return { kind: "blocked", reason: "thread-prohibited" };
  if (!state.catalogCurrent) return { kind: "blocked", reason: "stale-catalog-epoch" };
  if (!state.installed) return { kind: "blocked", reason: "not-installed" };
  if (state.quarantined) return { kind: "blocked", reason: "quarantined" };
  if (!state.trusted) return { kind: "blocked", reason: "untrusted" };
  if (!state.pluginDesired) return { kind: "blocked", reason: "plugin-disabled" };
  if (!state.componentDesired) return { kind: "blocked", reason: "component-disabled" };
  if (!state.compatible) return { kind: "blocked", reason: "incompatible" };
  if (state.draining) return { kind: "blocked", reason: "draining" };
  if (state.broken) return { kind: "blocked", reason: "broken" };
  if (state.unavailable) return { kind: "blocked", reason: "unavailable" };
  if (state.interrupted) return { kind: "blocked", reason: "interrupted" };
  if (state.waiting) return { kind: "blocked", reason: "waiting" };
  return { kind: "effective" };
}

/** The exact package an outside driver instance binds, as the activation ladder reads it. */
export interface OutsideDriverActivationTarget {
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly version: string;
  readonly digest: string;
}

/**
 * Whether the outside driver one provider instance binds is effective on this
 * host. It is the ladder every component climbs, at host scope: a provider
 * instance serves every mode and belongs to no Project or thread, so the
 * driver must be safe in all three modes. Beyond the ladder, the package must
 * still select the exact version and digest the instance was added with; any
 * other selection is `superseded`, so trust and Verify tools records never
 * carry over to code the person did not add the provider from.
 */
export function resolveOutsideDriverActivation(input: {
  readonly platform: string;
  readonly packageState: ExtensionPackageState | undefined;
  /** The host's own verdict on the package's app range and platforms. */
  readonly compatible: boolean;
  readonly driver: OutsideDriverActivationTarget;
}): ExtensionEffectiveState {
  if (!isOutsideDriverHostConfined(input.platform)) {
    return { kind: "blocked", reason: "host-prohibited" };
  }
  const packageState = input.packageState;
  const componentState = packageState?.components.find(
    (candidate) => String(candidate.component.id) === input.driver.componentId,
  );
  if (
    packageState === undefined ||
    String(packageState.extensionId) !== input.driver.extensionId ||
    String(packageState.packageId) !== input.driver.packageId ||
    componentState === undefined ||
    componentState.component.kind !== "provider-driver" ||
    !componentState.activation.installed
  ) {
    return { kind: "blocked", reason: "not-installed" };
  }
  if (
    String(packageState.version) !== input.driver.version ||
    String(packageState.digest) !== input.driver.digest
  ) {
    return { kind: "blocked", reason: "superseded" };
  }
  const component = componentState.component;
  return resolveExtensionActivation({
    ...componentState.activation,
    compatible: input.compatible && componentState.activation.compatible,
    hostAllowed: true,
    modeAllowed: (["chat", "work", "code"] as const).every((mode) =>
      isExtensionComponentModeSafe(mode, component),
    ),
    projectAllowed: true,
    threadAllowed: true,
    catalogCurrent: true,
  });
}

/**
 * The selection an outside driver instance moves to once its person has
 * trusted it: the package's current version and digest, when the source is
 * trusted at that selection and nothing holds it, the package and component
 * are the ones the instance was added from, and the instance binds another
 * digest. Anything else leaves the binding where it is.
 *
 * Trust is the only thing that can satisfy this: every install, update, and
 * rollback clears it and holds the package for admission, so an update never
 * moves an instance by itself. The switches are not consulted, since trusting
 * is the review step and the switches only decide whether the bound digest
 * runs; an instance moved while the plugin is off reports the block until it
 * is switched on.
 */
export function resolveOutsideDriverRebind(input: {
  readonly packageState: ExtensionPackageState | undefined;
  readonly driver: OutsideDriverActivationTarget;
}): OutsideDriverActivationTarget | undefined {
  const { packageState, driver } = input;
  if (
    packageState === undefined ||
    String(packageState.extensionId) !== driver.extensionId ||
    String(packageState.packageId) !== driver.packageId
  ) {
    return undefined;
  }
  const componentState = packageState.components.find(
    (candidate) => String(candidate.component.id) === driver.componentId,
  );
  if (
    componentState === undefined ||
    componentState.component.kind !== "provider-driver" ||
    !componentState.activation.installed ||
    !componentState.activation.trusted ||
    componentState.activation.quarantined
  ) {
    return undefined;
  }
  const version = String(packageState.version);
  const digest = String(packageState.digest);
  if (version === driver.version && digest === driver.digest) return undefined;
  return { ...driver, version, digest };
}
