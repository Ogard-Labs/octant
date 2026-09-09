import type {
  PermissionPersistence,
  ProviderInstanceId,
  ProviderInstance,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type { AcpProcessPort } from "./acpProcess";
import { acpProviderProfiles } from "./acpProfiles";
import { makeAcpDriver } from "./acpDriver";
import type { OpenCodeProcessPort } from "./openCodeProcess";
import { makeOpenCode2CatalogProbe } from "./openCode2Catalog";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

export interface OpenCode2DriverOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  /** Beta HTTP server used only for provider/catalog discovery. */
  readonly catalogProcess: OpenCodeProcessPort;
  /** ACP stdio process used for Code and Work turns and their approvals. */
  readonly acpProcess: AcpProcessPort;
  readonly acpHome: string;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  readonly permissionPersistence: () => PermissionPersistence;
}

/**
 * OpenCode 2 exposes two complementary local transports. Its HTTP server
 * remains the stable read-only provider catalog, while `opencode2 acp`
 * carries model turns and `session/request_permission`. Keep those transports
 * behind one provider driver so the model picker can discover models without
 * using a turn transport that would bypass Octant's approval bridge.
 */
export function makeOpenCode2Driver(options: OpenCode2DriverOptions): ProviderDriver {
  const acp = makeAcpDriver({
    profile: acpProviderProfiles.opencode,
    instanceId: options.instanceId,
    binaryPath: options.binaryPath,
    managedHome: options.acpHome,
    process: options.acpProcess,
    runtimeRegistry: options.runtimeRegistry,
  });
  return {
    ...acp,
    // Provider/model discovery uses the beta HTTP catalog. Turns stay on ACP,
    // where permission requests are correlated to the active session.
    probe: makeOpenCode2CatalogProbe({
      instanceId: options.instanceId,
      binaryPath: options.binaryPath,
      process: options.catalogProcess,
      runtimeRegistry: options.runtimeRegistry,
    }),
  };
}

export function isOpenCode2Instance(
  instance: Extract<ProviderInstance, { readonly driverKind: "opencode" }>,
): boolean {
  const name = instance.configuration.binaryPath.toLowerCase().split(/[\\/]/u).at(-1);
  return name === "opencode2" || name === "opencode2.exe";
}
