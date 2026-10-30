// What this host does for each kind of hub offer, through the same services the
// person's own window would use. Nothing here takes a secret, trusts a package,
// or switches a component on: a plugin is only installed, which leaves it
// untrusted and disabled under the ordinary activation ladder; a profile and an
// endpoint row are added without a key, the row switched off; an update channel
// changes one setting.

import {
  AgentProfileId,
  ProviderInstanceId,
  WindowId,
  decodeProviderRegistryCommand,
  type AgentProfileOffer,
  type AppReleaseRing,
  type ExtensionCommand,
  type ExtensionCommandResult,
  type ModelEndpointOffer,
  type PluginOffer,
} from "@octant/contracts";
import { Schema } from "effect";
import type { AgentProfileServiceApi } from "../agentProfileService";
import type { ProviderServiceApi } from "../providers/providerService";
import { createRoutineOfferAuthor, type RoutineOfferDependencies } from "./routineOfferBuilder";
import type { ApplyOutcome, ProvisionHostPorts } from "./spokeProvisionService";

const decodeWindowId = Schema.decodeUnknownSync(WindowId);
const decodeProfileId = Schema.decodeUnknownSync(AgentProfileId);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);

/** The window a host-originated provider command names: provider commands use it only to probe, and no window exists here. */
export const HOST_WINDOW_ID = decodeWindowId("00000000-0000-4000-8000-000000000003");

export interface ProvisionHostDependencies {
  readonly shell: {
    readonly currentRing: () => AppReleaseRing | undefined;
    readonly setReleaseRing: (ring: AppReleaseRing) => void;
  };
  readonly extensions: {
    readonly execute: (command: ExtensionCommand) => Promise<ExtensionCommandResult>;
  };
  readonly profiles: Pick<AgentProfileServiceApi, "execute">;
  readonly providers: Pick<ProviderServiceApi, "execute">;
  /** The user-wide scope a profile offered by the hub joins: the host's own person. */
  readonly userScopeRef: string;
  readonly uuid: () => string;
  readonly verifyUpdateSignature?: ProvisionHostPorts["verifyUpdateSignature"];
  readonly routine?: Omit<RoutineOfferDependencies, "uuid">;
}

const failed: ApplyOutcome = { status: "failed", kind: "apply-failed" };

export function createProvisionHostPorts(deps: ProvisionHostDependencies): ProvisionHostPorts {
  return {
    updateChannel: {
      current: () => deps.shell.currentRing(),
      set: async (channel) => {
        try {
          deps.shell.setReleaseRing(channel);
          return { status: "applied" };
        } catch {
          return failed;
        }
      },
    },
    plugin: {
      install: async (offer) => installUntrusted(deps, offer),
    },
    agentProfile: {
      add: async (offer) => addProfile(deps, offer),
    },
    modelEndpoint: {
      add: async (offer) => addEndpoint(deps, offer),
    },
    // A routine is built here against this host's own Project, profile, and
    // binding receipts, so a host without them refuses the kind.
    ...(deps.routine === undefined
      ? {}
      : { routine: { author: createRoutineOfferAuthor({ ...deps.routine, uuid: deps.uuid }) } }),
    ...(deps.verifyUpdateSignature === undefined
      ? {}
      : { verifyUpdateSignature: deps.verifyUpdateSignature }),
  };
}

/**
 * Inspects the catalog entry the way a person's Install does, then installs it
 * and does nothing more: no source trust, no plugin switched on. The expected
 * digest the offer names must be the one the catalog serves.
 */
async function installUntrusted(
  deps: ProvisionHostDependencies,
  offer: PluginOffer,
): Promise<ApplyOutcome> {
  try {
    const inspected = await deps.extensions.execute({
      kind: "inspect-package",
      source: { kind: "catalog", catalogId: offer.catalogId, entryId: offer.entryId },
      expectedDigest: offer.expectedDigest,
    });
    if (inspected.kind !== "package-inspected") return failed;
    const entry = inspected.preview.entry;
    if (entry.digest !== offer.expectedDigest) return failed;
    const installed = await deps.extensions.execute({
      kind: "install-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: entry.digest,
    });
    return installed.kind === "extension-state-updated" ? { status: "applied" } : failed;
  } catch {
    return failed;
  }
}

async function addProfile(
  deps: ProvisionHostDependencies,
  offer: AgentProfileOffer,
): Promise<ApplyOutcome> {
  try {
    const result = await deps.profiles.execute({
      kind: "create-agent-profile",
      profileId: decodeProfileId(deps.uuid()),
      scope: { scopeKind: "user", scopeRef: deps.userScopeRef },
      displayName: offer.displayName,
      ...(offer.description === undefined ? {} : { description: offer.description }),
      ...(offer.instructions === undefined ? {} : { instructions: offer.instructions }),
      approvedSkillIds: offer.approvedSkillIds,
      toolConstraints: offer.toolConstraints,
      modelConstraints: offer.modelConstraints,
      defaultExecutionPolicy: offer.defaultExecutionPolicy,
      defaultPermissionPersistence: offer.defaultPermissionPersistence,
      compatibleModes: offer.compatibleModes,
    });
    return result.kind === "profile-created" ? { status: "applied" } : failed;
  } catch {
    return failed;
  }
}

/**
 * The row is made switched off and without a key. The person adds the key from
 * the endpoint's own page, which is also where it is enabled.
 */
async function addEndpoint(
  deps: ProvisionHostDependencies,
  offer: ModelEndpointOffer,
): Promise<ApplyOutcome> {
  try {
    const common = {
      instanceId: decodeProviderInstanceId(deps.uuid()),
      expectedVersion: 0,
      enabled: false,
      displayName: offer.displayName,
    };
    const command =
      offer.family === "openai-compatible"
        ? {
            kind: "create-openai-compatible-provider",
            ...common,
            configuration: {
              kind: "openai-compatible-http",
              baseUrl: offer.baseUrl,
              protocol: offer.protocol,
              manualModelIds: offer.manualModelIds,
              authentication: offer.authentication === "key" ? "bearer" : "none",
            },
          }
        : {
            kind: "create-anthropic-compatible-provider",
            ...common,
            configuration: {
              kind: "anthropic-compatible-http",
              baseUrl: offer.baseUrl,
              protocol: offer.protocol,
              protocolVersion: "2023-06-01",
              manualModelIds: offer.manualModelIds,
              authentication: offer.authentication === "key" ? "api-key" : "none",
            },
          };
    await deps.providers.execute(HOST_WINDOW_ID, decodeProviderRegistryCommand(command));
    return { status: "applied" };
  } catch {
    return failed;
  }
}
