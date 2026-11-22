// The Code delegation host's ports over this host's own Code machinery: the
// managed-thread command a routine uses, the turn start a restart continuation
// uses, and the conversation page a window reads. Everything runs in the
// host's own scope, which no window or device can claim.

import {
  decodeCodeCheckoutId,
  decodeCodeCommand,
  decodeCodeConversationWindowRequest,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeProviderSessionId,
  personalSignInRefusals,
  type Project,
  type ProjectId,
  type ProviderCatalogSnapshot,
  type ProviderDefaults,
  type ProviderInstance,
  type WindowId,
} from "@octant/contracts";
import {
  isProviderAllowedByProjectPolicy,
  orderProviderInstances,
  orderProviderModels,
  parseGithubRemote,
} from "@octant/domain";
import type { CodeRouteService } from "../codeRoutes";
import type { ChildReading } from "./peerDelegationService";
import type { CodeDelegationServices } from "./codeDelegationHost";

export function createCodeDelegationServices(input: {
  readonly scope: WindowId;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  readonly readProviderInstances: () => ReadonlyArray<ProviderInstance>;
  readonly readProviderDefaults: () => ProviderDefaults;
  readonly readProviderCatalogs: () => ReadonlyArray<ProviderCatalogSnapshot>;
  /** The fetch URL of a remote in a checkout, or undefined when it has none. */
  readonly remoteUrl: (canonicalRoot: string, remoteName: string) => Promise<string | undefined>;
  readonly code: Pick<
    CodeRouteService,
    "execute" | "read" | "stageEvidence" | "executeOperation" | "conversationWindow"
  >;
}): CodeDelegationServices {
  const { scope, code } = input;
  return {
    readProject: (projectId) => input.readProject(projectId),
    helperRunRefusal: (providerInstanceId) =>
      personalSignInRefusals(
        input
          .readProviderInstances()
          .find((instance) => String(instance.id) === providerInstanceId),
      )?.refusesHelperRuns,
    defaultProvider: (projectId) => {
      const project = input.readProject(projectId);
      if (project === undefined || project.type === "chat") return undefined;
      const catalogs = input.readProviderCatalogs();
      // The provider the person ranks first that is turned on, at the first
      // model in its catalog's order the Project's whole provider policy
      // allows (whitelist and EU/ZDR tags), as the composer preselects for a
      // new thread. Thread creation and driver startup refuse a disabled
      // provider or a disallowed model, so a later qualifying pair is used
      // rather than failing the delegation on the first one.
      for (const instance of orderProviderInstances(
        input.readProviderInstances(),
        input.readProviderDefaults().providerOrder ?? [],
      )) {
        if (!instance.enabled) continue;
        const catalog = catalogs.find((each) => String(each.instanceId) === String(instance.id));
        if (catalog === undefined) continue;
        const model = orderProviderModels(catalog.models, catalog.manualModelOrder).find(
          (candidate) => isProviderAllowedByProjectPolicy(project, instance, candidate),
        );
        if (model !== undefined) {
          return { providerInstanceId: String(instance.id), modelId: String(model.id) };
        }
      }
      return undefined;
    },
    deliveryRepository: async (projectId, remoteName) => {
      const project = input.readProject(projectId);
      if (project?.type !== "code") return undefined;
      const url = await input.remoteUrl(project.binding.canonicalRoot, remoteName);
      if (url === undefined) return undefined;
      const parsed = parseGithubRemote(url);
      return parsed.status === "resolved"
        ? `${parsed.identity.owner}/${parsed.identity.name}`
        : undefined;
    },
    createThread: async (command, mark) => {
      const result = await code.execute(scope, decodeCodeCommand(command), undefined, {
        inheritedMark: mark,
      });
      return result.kind === "managed-thread-created"
        ? {
            kind: result.kind,
            thread: { id: String(result.thread.id), checkoutId: String(result.thread.checkoutId) },
          }
        : { kind: result.kind };
    },
    startTurn: async (turn) => {
      if (code.stageEvidence === undefined || code.executeOperation === undefined) return "refused";
      const threadId = decodeCodeThreadId(turn.threadId);
      const prompt = await code.stageEvidence(scope, threadId, turn.prompt);
      // Staging awaits; the sender's grant or the Project's mark may have
      // ended meanwhile, and nothing later checks before the provider starts.
      if (!turn.admissionCurrent()) return "refused";
      const result = await code.executeOperation(
        scope,
        {
          kind: "start-provider-turn",
          operationId: decodeCodeOperationId(turn.operationId),
          threadId,
          checkoutId: decodeCodeCheckoutId(turn.checkoutId),
          sessionId: decodeProviderSessionId(turn.sessionId),
          prompt,
        },
        // The operation service checks again right before it journals the
        // start, after any checkpoint it awaits, so a pause then still holds.
        { admissionCurrent: turn.admissionCurrent },
      );
      return result.kind === "provider-turn-state" &&
        (result.state === "running" || result.state === "waiting" || result.state === "completed")
        ? "accepted"
        : "refused";
    },
    readTurn: async (threadId, operationId): Promise<ChildReading | undefined> => {
      if (code.conversationWindow === undefined) return undefined;
      try {
        const answer = await code.conversationWindow(scope, decodeCodeThreadId(threadId), {
          ...decodeCodeConversationWindowRequest({ limit: 1, through: operationId }),
        });
        if (answer.status !== "ok") return undefined;
        const turn = answer.window.turns.find(
          (candidate) => String(candidate.operationId) === operationId,
        );
        if (turn === undefined) return undefined;
        const state = childStateOf(turn.status);
        return {
          state,
          // A Code turn's answer stays in its thread on this computer; the
          // delegating member is told where the work is, not handed the text.
          ...(state === "completed"
            ? {
                summary:
                  "The delegated Code thread finished. Its changes are on its own branch here.",
              }
            : {}),
          artifacts: [],
        };
      } catch {
        return undefined;
      }
    },
    cancelTurn: async (threadId, operationId) => {
      if (code.executeOperation === undefined) return "unavailable";
      try {
        const view = await code.read(scope, decodeCodeThreadId(threadId));
        const result = await code.executeOperation(scope, {
          kind: "cancel-provider-turn",
          operationId: decodeCodeOperationId(crypto.randomUUID()),
          threadId: view.thread.id,
          checkoutId: view.thread.checkoutId,
          turnOperationId: decodeCodeOperationId(operationId),
        });
        return result.kind === "provider-turn-state" && result.state === "interrupted"
          ? "interrupted"
          : "already-finished";
      } catch {
        return "unavailable";
      }
    },
  };
}

function childStateOf(
  status: "waiting" | "completed" | "interrupted" | "failed" | "incomplete",
): ChildReading["state"] {
  switch (status) {
    case "incomplete":
      return "running";
    case "waiting":
      return "waiting-for-approval";
    case "completed":
      return "completed";
    case "interrupted":
      return "cancelled";
    case "failed":
      return "failed";
  }
}
