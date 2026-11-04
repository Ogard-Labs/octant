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

export function wireProviderCloudSessions(
  input: Pick<ServerStart, "persistence"> & {
    readonly codeProjectAccess: CodeProjectAccess;
    readonly codeSessionAuthority: CodeSessionAuthorityStore;
    readonly windowAuthorityStore: WindowAuthorityStore;
    readonly spendCeilingService: SpendCeilingService;
    readonly credentialResolver: ProviderCredentialResolver | undefined;
    readonly configuredDriverOptions: ProvidersWiring["configuredDriverOptions"];
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
    canManageProvider: local,
    adapter: (instance, intent, admission = () => true, onCreated) =>
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
    context: (windowId, threadId, signal) => {
      const stored = persistence.readCodeThread(threadId);
      if (stored === undefined || stored.lifecycle !== "active" || !local(windowId))
        return undefined;
      const projectId = stored.projectId;
      const current = () =>
        input.codeProjectAccess.standingAuthority(() => {
          if (
            signal?.aborted === true ||
            !local(windowId) ||
            !input.codeProjectAccess.canAccessProject(windowId, projectId)
          )
            return false;
          const next = persistence.readCodeThread(threadId);
          return (
            next !== undefined &&
            next.lifecycle === "active" &&
            String(next.projectId) === String(projectId) &&
            String(next.bindingRevisionId) === String(stored.bindingRevisionId) &&
            String(next.checkoutId) === String(stored.checkoutId)
          );
        });
      if (!current()) return undefined;
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
            principalKind: "local-window",
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
