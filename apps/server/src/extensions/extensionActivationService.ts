import { createHash } from "node:crypto";
import type {
  ExtensionActivationPolicyFacts,
  ExtensionComponent,
  ExtensionPackageState,
} from "@octant/contracts/extensions";
import type {
  ExtensionEffectiveSnapshot,
  ExtensionEffectiveStateQuery,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import { decodeExtensionEffectiveSnapshot } from "@octant/contracts/extension-rpc";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  isExtensionComponentModeSafe,
  resolveExtensionActivation,
} from "@octant/plugin-host/activation";

export interface ExtensionActivationPolicyPort {
  resolve(input: {
    readonly scope: ExtensionEffectiveStateQuery["scope"];
    readonly packageState: ExtensionPackageState;
    readonly component: ExtensionComponent;
  }): ExtensionActivationPolicyFacts;
}

export interface ExtensionScopeAuthorityPort {
  project(scope: ExtensionEffectiveStateQuery["scope"]): {
    readonly allowed: boolean;
    readonly revision: number;
  };
  thread(scope: ExtensionEffectiveStateQuery["scope"]): {
    readonly allowed: boolean;
    readonly revision: number;
  };
}

export function createLocalExtensionActivationPolicy(
  authority: ExtensionScopeAuthorityPort,
): ExtensionActivationPolicyPort {
  return {
    resolve: ({ scope, packageState, component }) => {
      const project = authority.project(scope);
      const thread = authority.thread(scope);
      return {
        revision: 0,
        projectRevision: project.revision,
        threadRevision: thread.revision,
        hostAllowed: scope.hostId === LOCAL_HOST_ID,
        modeAllowed:
          packageState.compatibility.modes.includes(scope.mode) &&
          isExtensionComponentModeSafe(scope.mode, component),
        projectAllowed: project.allowed,
        threadAllowed: thread.allowed,
        policyAllowed: project.allowed && thread.allowed,
      };
    },
  };
}

export const LOCAL_EXTENSION_ACTIVATION_POLICY = createLocalExtensionActivationPolicy({
  project: (scope) => ({ allowed: scope.projectId === null, revision: 0 }),
  thread: (scope) => ({ allowed: scope.threadId === null, revision: 0 }),
});

export class ExtensionActivationService {
  readonly #policy: ExtensionActivationPolicyPort;
  readonly #catalogStatus: () => "available" | "offline";
  readonly #compatibility: (packageState: ExtensionPackageState) => boolean;

  constructor(options: {
    readonly policy: ExtensionActivationPolicyPort;
    readonly catalogStatus: () => "available" | "offline";
    readonly compatibility?: (packageState: ExtensionPackageState) => boolean;
  }) {
    this.#policy = options.policy;
    this.#catalogStatus = options.catalogStatus;
    this.#compatibility =
      options.compatibility ?? ((packageState) => packageState.activation.compatible);
  }

  resolve(
    snapshot: ExtensionSnapshot,
    query: ExtensionEffectiveStateQuery,
  ): ExtensionEffectiveSnapshot {
    const catalogStatus = this.#catalogStatus();
    const evaluated = snapshot.packages.map((packageState) => {
      const environmentCompatible = this.#compatibility(packageState);
      return {
        packageState,
        environmentCompatible,
        components: packageState.components.map((componentState) => ({
          componentState,
          policy: this.#policy.resolve({
            scope: query.scope,
            packageState,
            component: componentState.component,
          }),
        })),
      };
    });
    const catalogEpoch = deriveCatalogEpoch({
      snapshot,
      scope: query.scope,
      evaluated,
    });
    const stale =
      query.expectedCatalogEpoch !== undefined && query.expectedCatalogEpoch !== catalogEpoch;
    const packages = evaluated.map(({ packageState, environmentCompatible, components }) => ({
      ...packageState,
      components: components.map(({ componentState, policy }) => {
        const activation = {
          ...componentState.activation,
          compatible:
            componentState.activation.compatible &&
            environmentCompatible &&
            packageState.compatibility.modes.includes(query.scope.mode) &&
            (packageState.compatibility.providerFamilies.length === 0 ||
              packageState.compatibility.providerFamilies.includes(query.scope.providerFamily)),
          policyAllowed: policy.policyAllowed,
        };
        const effectiveState = resolveExtensionActivation({
          ...activation,
          hostAllowed: policy.hostAllowed,
          modeAllowed: policy.modeAllowed,
          projectAllowed: policy.projectAllowed,
          threadAllowed: policy.threadAllowed,
          catalogCurrent: !stale,
        });
        return {
          component: componentState.component,
          activation,
          policy,
          effectiveState,
          contextContribution: {
            kind: "zero" as const,
            reason:
              effectiveState.kind === "effective"
                ? ("not-selected" as const)
                : effectiveState.reason,
          },
        };
      }),
    }));
    return decodeExtensionEffectiveSnapshot({
      sequence: snapshot.sequence,
      snapshotAt: snapshot.snapshotAt,
      scope: query.scope,
      catalogEpoch,
      catalogStatus,
      stale,
      packages,
      collisions: snapshot.collisions,
    });
  }
}

function deriveCatalogEpoch(input: {
  readonly snapshot: ExtensionSnapshot;
  readonly scope: ExtensionEffectiveStateQuery["scope"];
  readonly evaluated: ReadonlyArray<{
    readonly packageState: ExtensionPackageState;
    readonly environmentCompatible: boolean;
    readonly components: ReadonlyArray<{
      readonly componentState: ExtensionPackageState["components"][number];
      readonly policy: ExtensionActivationPolicyFacts;
    }>;
  }>;
}): string {
  const facts = {
    scope: input.scope,
    collisions: input.snapshot.collisions,
    packages: input.evaluated.map(({ packageState, environmentCompatible, components }) => ({
      extensionId: packageState.extensionId,
      stateVersion: packageState.stateVersion,
      version: packageState.version,
      digest: packageState.digest,
      activation: packageState.activation,
      environmentCompatible,
      components: components.map(({ componentState, policy }) => ({
        componentId: componentState.component.id,
        activation: componentState.activation,
        policy,
      })),
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(facts)).digest("hex")}`;
}
