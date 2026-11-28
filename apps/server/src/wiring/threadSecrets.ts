import { randomUUID } from "node:crypto";
import {
  decodeBrowserThreadId,
  decodeCodeThreadId,
  decodeWindowId,
  decodeWorkThreadId,
  type CodeThread,
  type WindowId,
  type WorkThread,
} from "@octant/contracts";
import type { CredentialRequestReference } from "@octant/contracts/credential-request";
import type { CredentialRequestResolution } from "@octant/contracts/credential-request";
import { OCTANT_CREDENTIAL_TOOL } from "@octant/contracts/credential-request";
import type {
  SecretStoreBrowseResult,
  SecretStoreBrowseStep,
} from "@octant/contracts/secret-stores";
import { isToolAllowedByAllowlist } from "@octant/domain";
import type { ProviderExecutionPolicy } from "@octant/contracts";
import type { DeviceAccessLevel } from "@octant/contracts/remote-access";
import type { NativeHarnessComposition } from "../harness/nativeHarnessComposition";
import { readDeviceAccessLevel } from "../persistence/remoteAccessProjection";
import { turnHoldsSandboxPolicy } from "../process/sandboxRuntimePolicy";
import { holdSecretValue } from "../process/secretRedaction";
import { makeThreadSecretCredentialBrokerClient } from "../providers/credentialBrokerClient";
import {
  RememberedThreadSecrets,
  threadSecretMemoryJournal,
} from "../threadSecrets/rememberedThreadSecrets";
import { createThreadSecretFiles } from "../threadSecrets/threadSecretFiles";
import {
  createPairedThreadSecretRoutes,
  createThreadSecretRoutes,
} from "../threadSecrets/threadSecretRoutes";
import {
  ThreadSecretService,
  type ThreadSecretAuthority,
  type ThreadSecretServiceOptions,
} from "../threadSecrets/threadSecretService";
import { threadSecretsJournal } from "../threadSecrets/threadSecretsJournal";
import {
  threadSecretOperations,
  type ThreadSecretOperations,
} from "../threadSecrets/threadSecretTools";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { ServerStart } from "./serverShape";

export type ThreadSecretsDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<
    AuthorityWiring,
    | "isPairedDeviceScope"
    | "isPairedDeviceSessionCurrent"
    | "isRestrictedDeviceScope"
    | "machineChangeFeed"
    | "onThreadArchived"
    | "onWaitingAsk"
    | "onWindowRevoked"
    | "processAuthorityTime"
    | "windowAuthorityStore"
  > &
  Pick<FoundationsWiring, "browserAuthority" | "workThreadProjection"> & {
    readonly readReference?:
      | ((
          reference: CredentialRequestReference,
          signal: AbortSignal,
        ) => Promise<CredentialRequestResolution>)
      | undefined;
    readonly browse?:
      | ((step: SecretStoreBrowseStep, signal: AbortSignal) => Promise<SecretStoreBrowseResult>)
      | undefined;
  };

/** The secrets people give threads: one service for the host, and its private routes. */
export function wireThreadSecrets(deps: ThreadSecretsDependencies) {
  const { options, persistence } = deps;
  const reach = threadSecretReach({
    ...deps,
    deviceAccessLevel: (id) => readDeviceAccessLevel(persistence.connection, String(id)),
    isLocalWindow: (id) =>
      deps.windowAuthorityStore.listWindowIds().some((window) => String(window) === String(id)),
  });
  const now = () => new Date().toISOString();
  const journal = {
    journal: persistence.journal,
    connection: persistence.connection,
    uuid: randomUUID,
    now,
  };
  const remembered =
    options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
      ? undefined
      : new RememberedThreadSecrets({
          journal: threadSecretMemoryJournal(journal),
          store: makeThreadSecretCredentialBrokerClient({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          }),
          uuid: randomUUID,
        });
  const threadSecrets = new ThreadSecretService({
    uuid: randomUUID,
    now: deps.processAuthorityTime,
    journal: threadSecretsJournal(journal),
    ...(options.threadSecretsDirectory === undefined
      ? {}
      : { files: createThreadSecretFiles({ root: options.threadSecretsDirectory }) }),
    hold: holdSecretValue,
    ...(remembered === undefined ? {} : { remembered }),
    ...(deps.readReference === undefined ? {} : { readReference: deps.readReference }),
    ...(deps.browse === undefined ? {} : { browse: deps.browse }),
    threadTitle: (threadId) =>
      persistence.readCodeThread(decodeCodeThreadId(threadId))?.title ??
      deps.workThreadProjection.read(decodeWorkThreadId(threadId))?.title,
    mayAnswer: reach.mayAnswer,
    onAsked: deps.onWaitingAsk,
    onChanged: () => deps.machineChangeFeed.publish(["tool-approvals"]),
  });
  deps.onThreadArchived((threadId) => threadSecrets.withdrawThread(threadId));
  deps.onWindowRevoked((window) => threadSecrets.revokeWindow(String(window)));
  return {
    threadSecrets,
    threadSecretRoutes: createThreadSecretRoutes(threadSecrets, deps.windowAuthorityStore),
    pairedThreadSecretRoutes: createPairedThreadSecretRoutes(threadSecrets, {
      sessionCurrent: deps.isPairedDeviceSessionCurrent,
    }),
    threadSecretScopeCurrent: reach.scopeCurrent,
  };
}

/** Where the person can be when a card waits: at a window here, or at a device they paired at Full. */
export function threadSecretReach(
  deps: Pick<AuthorityWiring, "isPairedDeviceScope" | "isRestrictedDeviceScope"> &
    Pick<FoundationsWiring, "browserAuthority"> & {
      readonly isLocalWindow: (windowId: WindowId) => boolean;
      readonly deviceAccessLevel: (scopeId: WindowId) => DeviceAccessLevel;
    },
): {
  readonly mayAnswer: NonNullable<ThreadSecretServiceOptions["mayAnswer"]>;
  readonly scopeCurrent: (scopeId: WindowId) => boolean;
} {
  const scopeCurrent = (scopeId: WindowId): boolean =>
    deps.isLocalWindow(scopeId) ||
    (deps.isPairedDeviceScope(scopeId) &&
      !deps.isRestrictedDeviceScope(scopeId) &&
      // A device the person holds below Full is theirs, and still not them.
      deps.deviceAccessLevel(scopeId) === "full");
  return {
    scopeCurrent,
    mayAnswer: (reader, raised) => {
      const scopeId = decodeWindowId(reader.scopeId);
      if (!scopeCurrent(scopeId)) return false;
      if (reader.paired) return !deps.isLocalWindow(scopeId);
      // A window answers a paired device's card, never another window's, and
      // only for a thread it could drive itself.
      return (
        deps.isLocalWindow(scopeId) &&
        deps.isPairedDeviceScope(decodeWindowId(raised.windowId)) &&
        deps.browserAuthority.canAccessWindow(
          scopeId,
          decodeBrowserThreadId(raised.threadId),
          raised.mode,
        )
      );
    },
  };
}

export interface ThreadSecretTurnFacts {
  readonly service: ThreadSecretService;
  readonly composition: NativeHarnessComposition | undefined;
  readonly resolveStrict: (threadId: string) => boolean;
  readonly keepsSandbox: (threadId: string) => boolean;
  readonly isHarnessProvider: (providerInstanceId: CodeThread["providerInstanceId"]) => boolean;
  readonly windowCurrent: (windowId: WindowId) => boolean;
  readonly platform?: NodeJS.Platform;
}

/**
 * Whether a thread's own commands run in a sandbox Octant holds, which cannot
 * read a secret's file. Outside Strict a provider's own sandbox, if it has one,
 * can; the Octant Harness's commands run in Octant's below Full access.
 */
function commandsConfined(
  facts: ThreadSecretTurnFacts,
  thread: Pick<CodeThread, "providerInstanceId"> & { readonly id: unknown },
  posture: ProviderExecutionPolicy,
): boolean {
  const threadId = String(thread.id);
  return (
    facts.resolveStrict(threadId) ||
    facts.keepsSandbox(threadId) ||
    turnHoldsSandboxPolicy(threadId) ||
    (facts.isHarnessProvider(thread.providerInstanceId) &&
      posture !== "full-access" &&
      (facts.platform ?? process.platform) !== "win32")
  );
}

/**
 * The operations for one Code turn, or undefined where nobody could answer its
 * card. Plan is refused at each call instead, so moving a thread into Plan and
 * back leaves the tool as the provider's session first saw it.
 */
export function codeThreadSecrets(
  facts: ThreadSecretTurnFacts,
  input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
    readonly readThread: () => CodeThread | undefined;
    readonly folders: ReadonlyArray<string>;
    readonly operationId?: string | undefined;
    /** A routine's turn has nobody at a window to answer a card. */
    readonly routineRun: boolean;
    readonly hasHandleConsumer?: (() => boolean) | undefined;
  },
): ThreadSecretOperations | undefined {
  const { thread, windowId, folders } = input;
  const [cwd, ...extraRoots] = folders;
  const threadId = String(thread.id);
  const lifetime = new AbortController();
  const current = (): CodeThread | undefined => {
    const now = input.readThread();
    return now !== undefined &&
      !lifetime.signal.aborted &&
      facts.windowCurrent(windowId) &&
      now.lifecycle === "active" &&
      String(now.projectId) === String(thread.projectId) &&
      String(now.checkoutId) === String(thread.checkoutId) &&
      String(now.bindingRevisionId) === String(thread.bindingRevisionId) &&
      String(now.providerInstanceId) === String(thread.providerInstanceId) &&
      now.modelId === thread.modelId &&
      isToolAllowedByAllowlist(now.toolConstraints ?? [], OCTANT_CREDENTIAL_TOOL.name)
      ? now
      : undefined;
  };
  if (input.routineRun || current() === undefined) return undefined;
  const { composition } = facts;
  return withLifetime(
    lifetime,
    threadSecretOperations({
      service: facts.service,
      caller: {
        windowId: String(windowId),
        threadId,
        turnId: input.operationId ?? randomUUID(),
        authority: (): ThreadSecretAuthority | undefined => {
          const now = current();
          return now === undefined || now.executionPolicy === "plan"
            ? undefined
            : {
                mode: "code",
                strict: facts.resolveStrict(threadId),
                commandsConfined: commandsConfined(facts, now, now.executionPolicy),
              };
        },
        signal: lifetime.signal,
      },
      ...(composition === undefined || cwd === undefined
        ? {}
        : {
            commands: {
              prepare: ({ command, hostNote, signal }) =>
                composition.prepareCodeCommand({
                  thread: current() ?? thread,
                  checkoutRoot: cwd,
                  extraFolders: extraRoots,
                  windowId: String(windowId),
                  command,
                  hostNote,
                  signal,
                }),
              shell: composition.shellForCode({
                windowId: String(windowId),
                threadId,
                projectId: String(thread.projectId),
              }),
              cwd,
              extraRoots,
            },
          }),
      planning: () => input.readThread()?.executionPolicy === "plan",
      // A server Project's turn is never offered this host's tools.
      onServer: false,
      ...(input.hasHandleConsumer === undefined
        ? {}
        : { hasHandleConsumer: input.hasHandleConsumer }),
    }),
  );
}

/** The operations for one Work turn, on the same terms. */
export function workThreadSecrets(
  facts: ThreadSecretTurnFacts,
  input: {
    readonly windowId: WindowId;
    readonly thread: WorkThread;
    readonly readThread: () => WorkThread | undefined;
    readonly projectRoot: string;
    readonly extraFolders?: ReadonlyArray<string> | undefined;
    readonly turnId: string;
    readonly routineRun: boolean;
    /** The running turn's level. */
    readonly posture: () => ProviderExecutionPolicy;
    readonly hasHandleConsumer?: (() => boolean) | undefined;
  },
): ThreadSecretOperations | undefined {
  const { thread, windowId } = input;
  const threadId = String(thread.id);
  const lifetime = new AbortController();
  const current = (): WorkThread | undefined => {
    const now = input.readThread();
    return now !== undefined &&
      !lifetime.signal.aborted &&
      facts.windowCurrent(windowId) &&
      now.lifecycle === "active" &&
      String(now.projectId) === String(thread.projectId) &&
      String(now.bindingRevisionId) === String(thread.bindingRevisionId) &&
      String(now.providerInstanceId) === String(thread.providerInstanceId) &&
      now.modelId === thread.modelId
      ? now
      : undefined;
  };
  if (input.routineRun || current() === undefined) return undefined;
  const { composition } = facts;
  const cwd = input.projectRoot.length > 0 ? input.projectRoot : undefined;
  const extraRoots = input.extraFolders ?? [];
  return withLifetime(
    lifetime,
    threadSecretOperations({
      service: facts.service,
      caller: {
        windowId: String(windowId),
        threadId,
        turnId: input.turnId,
        authority: (): ThreadSecretAuthority | undefined => {
          const now = current();
          const posture = input.posture();
          return now === undefined || posture === "plan"
            ? undefined
            : {
                mode: "work",
                strict: facts.resolveStrict(threadId),
                commandsConfined: commandsConfined(facts, now, posture),
              };
        },
        signal: lifetime.signal,
      },
      ...(composition === undefined || cwd === undefined
        ? {}
        : {
            commands: {
              prepare: ({ command, hostNote, signal }) =>
                composition.prepareWorkCommand({
                  thread: current() ?? thread,
                  projectRoot: cwd,
                  extraFolders: extraRoots,
                  command,
                  hostNote,
                  signal,
                }),
              shell: composition.shellForWork({ threadId, projectId: String(thread.projectId) }),
              cwd,
              extraRoots,
            },
          }),
      planning: () => input.posture() === "plan",
      onServer: false,
      ...(input.hasHandleConsumer === undefined
        ? {}
        : { hasHandleConsumer: input.hasHandleConsumer }),
    }),
  );
}

/** The turn's tools closing is the turn ending: its waits stop and its secrets go. */
function withLifetime(
  lifetime: AbortController,
  operations: ThreadSecretOperations,
): ThreadSecretOperations {
  return {
    ...operations,
    close: () => {
      operations.close();
      lifetime.abort();
    },
  };
}
