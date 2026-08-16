import type {
  ExtensionActivationState,
  ExtensionComponent,
  ExtensionEffectiveState,
} from "@octant/contracts/extensions";
import type { OctantMode } from "@octant/contracts/modes";

const modeKinds: Readonly<Record<OctantMode, ReadonlySet<ExtensionComponent["kind"]>>> = {
  chat: new Set(["skill-instructions", "mcp-server", "mcp-tool", "mcp-prompt", "mcp-resource"]),
  work: new Set([
    "skill-instructions",
    "mcp-server",
    "mcp-tool",
    "mcp-prompt",
    "mcp-resource",
    "app",
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
