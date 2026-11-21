import { createHash } from "node:crypto";
import { ProviderCloudSessionService } from "../cloud/providerCloudSessionService";
import { ProviderCloudSessionStore } from "../cloud/providerCloudSessionStore";
import { createProviderCloudSessionRoutes } from "../cloud/providerCloudSessionRoutes";
import { makeProviderCloudPorts } from "../cloud/providerCloudHttp";
import { makeConfiguredProviderDriver, type ProvidersWiring } from "./providers";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import type { ServerStart } from "./serverShape";
import type { CodeProjectAccess } from "../codeProjectAccess";
import type { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import type { SpendCeilingService } from "../spendCeilingService";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  readDeviceApprovedByPerson,
  readDeviceRegistration,
  readRemoteSessionInvalidation,
} from "../persistence/remoteAccessProjection";
import { isDeviceRegistrationCurrent } from "../extensions/pairedDeviceApprovalAuthority";

export function wireProviderCloudSessions(
  input: Pick<ServerStart, "persistence"> & {
    readonly codeProjectAccess: CodeProjectAccess;
    readonly codeSessionAuthority: CodeSessionAuthorityStore;
    readonly windowAuthorityStore: WindowAuthorityStore;
    readonly spendCeilingService: SpendCeilingService;
    readonly credentialResolver: ProviderCredentialResolver | undefined;
    readonly configuredDriverOptions: ProvidersWiring["configuredDriverOptions"];
    readonly isPersonPairedDeviceCurrent?: (
      deviceId: string,
      credentialGeneration: number,
      sessionId?: string,
    ) => boolean;
    readonly allowedRendererHttpOrigin?: string | null;
  },
) {
  const { persistence } = input;
  const now = () => new Date().toISOString();
  const store = new ProviderCloudSessionStore({
    connection: persistence.connection,
    journal: persistence.journal,
    now,
  });
  const local = (windowId: Parameters<CodeProjectAccess["canAccessProject"]>[0]) =>
    input.windowAuthorityStore.listWindowIds().some((id) => String(id) === String(windowId));
  const deviceCurrent =
    input.isPersonPairedDeviceCurrent ??
    ((deviceId: string, credentialGeneration: number, sessionId?: string): boolean => {
      const registration = readDeviceRegistration(persistence.connection, deviceId);
      if (
        registration === undefined ||
        !isDeviceRegistrationCurrent(registration, Date.now()) ||
        registration.credentialGeneration !== credentialGeneration ||
        !readDeviceApprovedByPerson(persistence.connection, deviceId)
      ) {
        return false;
      }
      if (sessionId !== undefined) {
        const digest = createHash("sha256").update(sessionId).digest("hex");
        if (readRemoteSessionInvalidation(persistence.connection, digest) !== undefined) {
          return false;
        }
      }
      return true;
    });
  const cloudDriver = (instance: ReturnType<typeof persistence.readProviderInstances>[number]) => {
    if (
      instance.driverKind === "outside-harness-endpoint" &&
      input.configuredDriverOptions.runtimeRegistry?.observedState(instance.id)?.capabilities
        .cloudSessions !== "supported"
    )
      return undefined;
    try {
      const driver = makeConfiguredProviderDriver(
        instance,
        input.configuredDriverOptions,
      ).cloudSessions;
      return driver?.protocol === "openai-agents-v1" && driver.supports(instance)
        ? driver
        : undefined;
    } catch {
      return undefined;
    }
  };
  const service = new ProviderCloudSessionService({
    store,
    now,
    instances: () => persistence.readProviderInstances(),
    supports: (instance) => cloudDriver(instance) !== undefined,
    models: (instance) => {
      if (instance.driverKind === "openai-compatible") return instance.configuration.manualModelIds;
      if (instance.driverKind === "outside-harness-endpoint")
        return instance.configuration.modelIds;
      return [];
    },
    canManageProvider: (windowId, principal) => {
      if (principal === undefined || principal.kind === "local-window") return local(windowId);
      if (principal.kind === "person-paired-device") {
        return deviceCurrent(
          principal.deviceId,
          principal.credentialGeneration,
          principal.sessionId,
        );
      }
      return false;
    },
    adapter: (instance, intent, admission = () => true, onCreated, options) =>
      (cloudDriver(instance) ?? unavailableDriver).create({
        instanceId: instance.id,
        ports:
          input.credentialResolver === undefined
            ? {
                current: admission,
                request: async () => {
                  throw new Error("Provider cloud credentials unavailable.");
                },
              }
            : makeProviderCloudPorts({
                instanceId: instance.id,
                credentialResolver: input.credentialResolver,
                admission,
                intent,
                ...(options?.principalKind === undefined
                  ? {}
                  : { principalKind: options.principalKind }),
                ...(options?.onCredentialUnlockRequired === undefined
                  ? {}
                  : { onCredentialUnlockRequired: options.onCredentialUnlockRequired }),
                ...(onCreated === undefined ? {} : { onCreated }),
                ...(intent.kind === "create"
                  ? {
                      onCreateDispatch: () => {
                        const job = store.get(intent.jobId);
                        if (job === undefined) throw new Error("Cloud job was purged.");
                        store.recordCreateDispatch(job);
                      },
                    }
                  : {}),
              }),
      }),
    context: (windowId, threadId, signal, principal) => {
      const stored = persistence.readCodeThread(threadId);
      if (stored === undefined || stored.lifecycle !== "active") return undefined;
      if (principal?.kind === "remote-device") return undefined;
      const isDevice = principal?.kind === "person-paired-device";
      if (isDevice) {
        if (
          !deviceCurrent(principal.deviceId, principal.credentialGeneration, principal.sessionId)
        ) {
          return undefined;
        }
      } else if (!local(windowId)) {
        return undefined;
      }
      const projectId = stored.projectId;
      const threadUnchanged = () => {
        const next = persistence.readCodeThread(threadId);
        return (
          next !== undefined &&
          next.lifecycle === "active" &&
          String(next.projectId) === String(projectId) &&
          String(next.bindingRevisionId) === String(stored.bindingRevisionId) &&
          String(next.checkoutId) === String(stored.checkoutId)
        );
      };
      const current = isDevice
        ? () =>
            signal?.aborted !== true &&
            deviceCurrent(
              principal.deviceId,
              principal.credentialGeneration,
              principal.sessionId,
            ) &&
            input.codeProjectAccess.hasActiveCodeProject(projectId) &&
            threadUnchanged()
        : () =>
            input.codeProjectAccess.standingAuthority(projectId, () => {
              if (
                signal?.aborted === true ||
                !local(windowId) ||
                !input.codeProjectAccess.canAccessProject(windowId, projectId)
              )
                return false;
              return threadUnchanged();
            });
      if (!current()) return undefined;
      const principalKind = isDevice ? "person-paired-device" : "local-window";
      return {
        threadId,
        projectId,
        current,
        canSubmit: () => {
          const next = persistence.readCodeThread(threadId);
          return (
            next !== undefined &&
            input.codeSessionAuthority.effectiveThread(windowId, next).executionPolicy !== "plan"
          );
        },
        executionPolicy: input.codeSessionAuthority.effectiveThread(windowId, stored)
          .executionPolicy,
        requiresUnsupportedBound: () => {
          const budget = input.spendCeilingService.snapshot({
            principalKind,
            threadId,
            threadType: "code-thread",
            projectId,
          });
          return "kind" in budget || budget.thread !== undefined || budget.project !== undefined;
        },
      };
    },
  });
  return {
    service,
    routes: createProviderCloudSessionRoutes({
      service,
      windowAuthorityStore: input.windowAuthorityStore,
      isPersonPairedDeviceCurrent: deviceCurrent,
      ...(input.allowedRendererHttpOrigin === undefined
        ? {}
        : { allowedRendererHttpOrigin: input.allowedRendererHttpOrigin }),
    }),
  };
}

const unavailableDriver = {
  create: () => ({
    create: async () => ({ status: "unavailable" as const }),
    read: async () => ({ status: "unavailable" as const }),
    cancel: async () => ({ status: "unavailable" as const }),
  }),
};
