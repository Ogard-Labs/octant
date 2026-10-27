import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  decodeCodeThreadId,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_RETENTION_EVENT_NAMES,
} from "@octant/contracts";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { Effect } from "effect";
import { GhAuthenticationPort } from "../github/ghAuthenticationPort";
import { GhRepositoryCataloguePort } from "../github/ghRepositoryCataloguePort";
import { GithubCapabilityService } from "../github/githubCapabilityService";
import { GithubCatalogueService } from "../github/githubCatalogueService";
import { GithubIssueContextService } from "../github/githubIssueContextService";
import { LinearIssueContextService } from "../plugins/linear/linearIssueContextService";
import { LINEAR_ISSUE_GET_OPERATION } from "@octant/contracts/linear-issues";
import { GithubReadToolService } from "../github/githubReadToolService";
import {
  isGithubIntegrationEffective,
  isLinearIntegrationEffective,
} from "../github/githubIntegrationEffective";
import { createGithubRouteHandler } from "../githubRoutes";
import {
  createBrokerSecretVault,
  createUnavailableSecretVault,
} from "../integration/integrationCredentialVault";
import { createFileConnectionStore } from "../integration/integrationConnectionStore";
import { createLinearIntegrationService } from "../integration/integrationService";
import { createIntegrationRouteHandler } from "../integrationRoutes";
import { makeCredentialBrokerClient } from "../providers/credentialBrokerClient";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { CacheStatsProjection } from "../cacheStatsProjection";
import { GistConnection } from "../canvas/gistExportTarget";
import type { RecordExternalContentIngestionInput } from "../context/externalContentIngestionStore";
import { AgentMessageProjection } from "../agentMessage/agentMessageProjection";
import { AgentMessageBodyStore } from "../agentMessage/agentMessageBodyStore";
import {
  type AgentMessageEndpointResolver,
  AgentMessageService,
} from "../agentMessage/agentMessageService";
import { SiblingThreadsService } from "../siblingThreads/siblingThreadTools";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import {
  materializeHarnessToolNetwork,
  resolveDefaultThreadEgressPolicy,
} from "../process/threadEgressPolicy";
import {
  toolEgressLaunchTaintReference,
  ToolEgressRules,
} from "../harness/nativeHarnessEgressRules";
import { isNativeHarnessDriverKind } from "@octant/domain";
import type { ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { FoundationsWiring } from "./foundations";

export type IntegrationsDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<AuthorityWiring, "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "externalContentIngestionStore"> &
  Pick<FoundationsWiring, "workThreadProjection">;

export function wireIntegrations(deps: IntegrationsDependencies) {
  const {
    externalContentIngestionStore,
    options,
    persistence,
    windowAuthorityStore,
    workThreadProjection,
  } = deps;
  return Effect.gen(function* () {
    const githubAuthenticationPort =
      options.githubAuthenticationPort ??
      new GhAuthenticationPort(
        options.ghExecutable === undefined ? {} : { ghExecutable: options.ghExecutable },
      );
    const githubCataloguePort = new GhRepositoryCataloguePort(
      options.ghExecutable === undefined ? {} : { ghExecutable: options.ghExecutable },
    );
    // The gist export destination's GitHub state. It is read on demand when an
    // export lists or prepares destinations, never at startup; see
    // `GistConnection`.
    const gistConnection = new GistConnection(
      (signal) => githubCapabilityService.snapshot(signal),
      process.platform,
    );
    // Areas that hold GitHub pull-request data register here, so a sign-in that
    // can no longer read pull requests reaches them without this area holding
    // them.
    const pullRequestsUnreadableListeners: Array<() => void> = [];
    const onGithubPullRequestsUnreadable = (listener: () => void): void => {
      pullRequestsUnreadableListeners.push(listener);
    };
    const githubCapabilityService = new GithubCapabilityService(githubAuthenticationPort, {
      probes: githubCataloguePort,
      onAuthenticationChanged: (snapshot) => {
        gistConnection.changed(snapshot);
        const readable = snapshot.capabilities.some(
          (capability) => capability.kind === "pull-requests-read" && capability.available,
        );
        if (!readable) for (const listener of pullRequestsUnreadableListeners) listener();
      },
    });
    // One reading for every cache this host keeps, so the usage dashboard can
    // report them together and a failing external cache paces itself.
    const cacheStats = new CacheStatsProjection();
    const githubCatalogueService = new GithubCatalogueService({
      port: githubCataloguePort,
      snapshot: (signal) => githubCapabilityService.snapshot(signal),
      cacheStats,
    });
    // Harness tool egress rules, proposals, and launch records. Recovery runs
    // here, before any route admits a turn: a launch the last run never
    // summarized is marked incomplete, and every launch whose bytes taint its
    // thread marks it now.
    const toolEgressRules = new ToolEgressRules({
      journal: persistence.journal,
      readCodeThread: (threadId) => {
        try {
          const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
          if (thread === undefined) return undefined;
          const instance = persistence.readProviderInstance(thread.providerInstanceId);
          return {
            projectId: String(thread.projectId),
            // Mirrors the harness composition: a harness thread's commands on
            // macOS and Linux run on the network its posture resolves now.
            commandsProxied:
              (process.platform === "darwin" || process.platform === "linux") &&
              instance !== undefined &&
              isNativeHarnessDriverKind(instance.driverKind) &&
              materializeHarnessToolNetwork(
                resolveDefaultThreadEgressPolicy({
                  mode: "code",
                  executionPolicy: thread.executionPolicy,
                }),
              ) === "proxied",
          };
        } catch {
          return undefined;
        }
      },
      readThreadTaint: (threadId) =>
        readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
      recordLaunchTaint: ({ threadId, launchId }) => {
        const marked = externalContentIngestionStore.record({
          threadId,
          provenance: { origin: "external-content", sourceLabel: "tool-egress" },
          contentReference: toolEgressLaunchTaintReference(launchId),
          correlationId: launchId,
          authorized: true,
        });
        return marked.kind === "recorded" || marked.kind === "already-recorded"
          ? "recorded"
          : "unavailable";
      },
      hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    toolEgressRules.recover();
    const unsubscribeToolEgressRules = persistence.journal.subscribeCommitted((append) => {
      for (const event of append.events) {
        if (event.aggregateType === THREAD_EXTERNAL_CONTENT_AGGREGATE) {
          // A thread tainted mid-launch stops its standing rules at once.
          toolEgressRules.recheck();
        } else if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
          const purged = event.payload as { readonly threadId?: unknown };
          if (typeof purged.threadId === "string") toolEgressRules.forgetThread(purged.threadId);
        }
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeToolEgressRules));
    // Where a mention or a Side Chat reads its source's mark and marks the
    // thread reading that source's transcript.
    const threadOutsideContentMarks = {
      record: (input: RecordExternalContentIngestionInput) =>
        externalContentIngestionStore.record(input),
      isMarked: (threadId: string) =>
        readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
    };
    // Agent-to-agent messaging (decision 0063): the host owns admission,
    // clamping, journaling, and delivery. The endpoint resolver is composed
    // lazily from the thread authorities declared later in this startup; a
    // send runs only inside a live turn, well after they exist.
    const agentMessageProjection = new AgentMessageProjection();
    const agentMessageBodyStore = new AgentMessageBodyStore(
      join(persistence.dataDirectory, "agent-messages"),
    );
    // Only a real thread is addressable. A child run has no turn that would
    // carry a message, so its id resolves to nothing and refuses like any
    // other unreachable one.
    const resolveAgentMessageEndpoint: AgentMessageEndpointResolver = (threadId) => {
      const chat = persistence.readChatThread(threadId as never);
      if (chat !== undefined) {
        return {
          mode: "chat",
          projectId: chat.projectId === undefined ? undefined : String(chat.projectId),
          terminal: chat.lifecycle !== "active",
        };
      }
      const code = persistence.readCodeThread(threadId as never);
      if (code !== undefined) {
        return {
          mode: "code",
          projectId: String(code.projectId),
          terminal: code.lifecycle !== "active",
        };
      }
      const work = workThreadProjection.list().find((thread) => String(thread.id) === threadId);
      if (work !== undefined) {
        return {
          mode: "work",
          projectId: String(work.projectId),
          terminal: work.lifecycle !== "active",
        };
      }
      return undefined;
    };
    const agentMessageService = new AgentMessageService({
      journal: persistence.journal,
      connection: persistence.connection,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
      projection: agentMessageProjection,
      bodyStore: agentMessageBodyStore,
      resolveEndpoint: resolveAgentMessageEndpoint,
      recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
      // The admitting principal on a local host is the host user, whose Open
      // scope covers every mode. A remote window's narrower Open scope is a
      // 0013 federation concern and stays out of this seam.
      openModes: ["chat", "work", "code"],
    });
    // The sibling-threads tool's host side. It appends only to the reader's
    // own records: its outside-content mark and its observation stream.
    const siblingThreadsService = new SiblingThreadsService({
      journal: persistence.journal,
      connection: persistence.connection,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
      recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
    });
    const githubReadToolService = new GithubReadToolService({
      catalogue: githubCatalogueService,
      snapshot: (signal) => githubCapabilityService.snapshot(signal),
      ingestion: externalContentIngestionStore,
    });
    const githubExtensionSnapshot = {
      read: (): Pick<ExtensionSnapshot, "packages"> => ({ packages: [] }),
    };
    const githubIntegrationIsEffective = () =>
      isGithubIntegrationEffective(githubExtensionSnapshot.read());
    const linearIntegrationIsEffective = () =>
      isLinearIntegrationEffective(githubExtensionSnapshot.read());
    const githubIssueContextService = new GithubIssueContextService({
      catalogue: githubCatalogueService,
      snapshot: (signal) => githubCapabilityService.snapshot(signal),
      ingestion: externalContentIngestionStore,
      uuid: randomUUID,
      isEffective: githubIntegrationIsEffective,
    });
    const githubRoutes = createGithubRouteHandler({
      windowAuthorityStore,
      service: githubCapabilityService,
      catalogue: githubCatalogueService,
      isEffective: githubIntegrationIsEffective,
    });
    const integrationVault =
      options.integrationSecretVault ??
      (options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? createUnavailableSecretVault()
        : createBrokerSecretVault(
            makeCredentialBrokerClient({
              url: options.credentialBrokerUrl,
              token: options.credentialBrokerToken,
            }),
          ));
    const linearRedirectUri =
      options.linearOAuthRedirectUri ?? "http://127.0.0.1:52693/oauth/linear/callback";
    const integrationService = createLinearIntegrationService({
      vault: integrationVault,
      connectionStore: createFileConnectionStore(
        join(persistence.dataDirectory, "integrations", "linear-connection.json"),
      ),
      config: {
        redirectUri: linearRedirectUri,
        ...(options.linearOAuthClientId === undefined
          ? {}
          : { clientId: options.linearOAuthClientId }),
      },
      isEffective: linearIntegrationIsEffective,
    });
    const linearIssueContextService = new LinearIssueContextService({
      reader: {
        snapshot: (signal) => integrationService.snapshot("linear", signal),
        executeGetIssue: async (id, signal) =>
          integrationService.executeOperation(
            "linear",
            { kind: "operation", operationId: LINEAR_ISSUE_GET_OPERATION, input: { id } },
            signal,
          ),
      },
      ingestion: externalContentIngestionStore,
      uuid: randomUUID,
      isEffective: linearIntegrationIsEffective,
    });
    const peekCreateFromIssueFramed = (threadId: string) =>
      githubIssueContextService.peekFramedForFirstTurn(threadId) ??
      linearIssueContextService.peekFramedForFirstTurn(threadId);
    const consumeCreateFromIssueFramed = (threadId: string) => {
      githubIssueContextService.consumeFramedForFirstTurn(threadId);
      linearIssueContextService.consumeFramedForFirstTurn(threadId);
    };
    const integrationRoutes = createIntegrationRouteHandler({
      windowAuthorityStore,
      service: integrationService,
      isEffective: (slug) => slug !== "linear" || linearIntegrationIsEffective(),
    });
    return {
      agentMessageProjection,
      agentMessageService,
      cacheStats,
      consumeCreateFromIssueFramed,
      gistConnection,
      githubAuthenticationPort,
      githubCapabilityService,
      githubCataloguePort,
      githubExtensionSnapshot,
      githubIntegrationIsEffective,
      githubIssueContextService,
      githubReadToolService,
      githubRoutes,
      integrationRoutes,
      linearIssueContextService,
      onGithubPullRequestsUnreadable,
      peekCreateFromIssueFramed,
      siblingThreadsService,
      threadOutsideContentMarks,
      toolEgressRules,
    };
  });
}

export type IntegrationsWiring = Effect.Effect.Success<ReturnType<typeof wireIntegrations>>;
