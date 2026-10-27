import type {
  ExtensionActivationState,
  ExtensionComponent,
  ExtensionEffectiveState,
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
