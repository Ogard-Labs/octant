import type { ExtensionPackageState } from "@octant/contracts/extensions";
import type { GeneratedMcpSignInPolicy } from "./userAddedMcpServers";

/** Retains the exact installed owner while keeping registration separate from activation. */
export function bindGeneratedMcpSignInPolicy(input: {
  readonly policy: GeneratedMcpSignInPolicy;
  readonly packageState: ExtensionPackageState;
  readonly componentId: string;
  readonly readPackage: () => ExtensionPackageState | undefined;
}): GeneratedMcpSignInPolicy {
  const readCurrentOwner = (): ExtensionPackageState | undefined => {
    try {
      const actual = input.readPackage();
      return input.policy.current() &&
        actual?.activation.installed === true &&
        actual.packageId === input.packageState.packageId &&
        actual.stateVersion === input.packageState.stateVersion &&
        actual.digest === input.packageState.digest &&
        actual.version === input.packageState.version
        ? actual
        : undefined;
    } catch {
      return undefined;
    }
  };
  const component = input.packageState.components.find(
    (entry) => String(entry.component.id) === input.componentId,
  );
  const wasEffective =
    component?.component.kind === "mcp-server" && component.effectiveState.kind === "effective";
  return {
    ...input.policy,
    current: () => readCurrentOwner() !== undefined,
    sourceCurrent: () => {
      if (!wasEffective) return false;
      const actual = readCurrentOwner()?.components.find(
        (entry) => String(entry.component.id) === input.componentId,
      );
      return actual?.component.kind === "mcp-server" && actual.effectiveState.kind === "effective";
    },
  };
}
