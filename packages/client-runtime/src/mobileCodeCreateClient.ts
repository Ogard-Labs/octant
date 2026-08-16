import {
  decodeCodeBootstrap,
  decodeCodeCommandResult,
  decodeCodeDeliveryTarget,
  decodeCodeEvidenceReference,
  decodeCodeOperationEventFrame,
  decodeCodeOperationResult,
  decodeCodeThreadView,
  MAX_CODE_OPERATION_TEXT_BYTES,
  decodeProjectBootstrap,
  type CodeDeliveryOutcomeKind,
  type CodeDeliveryTarget,
  type CodeCheckoutIdentity,
  type CodeOperationResult,
  type CodeThread,
  type ProjectSummary,
} from "@octant/contracts";
import { suggestCodeDeliveryOutcome } from "@octant/domain";
import {
  MobileInboxFailure,
  type MobileInboxRow,
  type MobileRemoteTransport,
} from "./mobileInboxClient";

export interface MobileCodeProjectOption {
  readonly projectId: string;
  readonly name: string;
  readonly root: string;
}

export interface MobileCodeDeliveryTargetProposal {
  readonly branchIntent: string;
  readonly remoteName: string;
  readonly proposedBaseRepository: string;
  readonly proposedBaseBranch: string;
  readonly suggestedOutcomeKind: CodeDeliveryOutcomeKind;
}

export interface MobileCodeCreationRetry {
  readonly threadId: string;
  readonly deliveryTarget: CodeDeliveryTarget;
  readonly operationId?: string;
  readonly sessionId?: string;
}

export class MobileCodeCreationFailure extends MobileInboxFailure {
  readonly retry: MobileCodeCreationRetry;

  constructor(
    category: MobileInboxFailure["category"],
    message: string,
    retry: MobileCodeCreationRetry,
  ) {
    super(category, message);
    this.name = "MobileCodeCreationFailure";
    this.retry = retry;
  }
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (line.length <= 72) return line;
  return `${line.slice(0, 71).trimEnd()}…`;
}

function codeRow(hostId: string, thread: CodeThread): MobileInboxRow {
  return {
    hostId,
    mode: "code",
    threadId: String(thread.id),
    title: thread.title,
    status: thread.lifecycle,
    freshness: thread.updatedAt,
  };
}

async function requireJson<T>(
  response: Response,
  decode: (value: unknown) => T,
  message: string,
): Promise<T> {
  if (!response.ok) {
    throw new MobileInboxFailure(response.status === 403 ? "rejected" : "unavailable", message);
  }
  try {
    return decode(await response.json());
  } catch {
    throw new MobileInboxFailure("unavailable", `${message} The host returned invalid data.`);
  }
}

export function listMobileCodeProjects(
  projects: ReadonlyArray<ProjectSummary>,
): ReadonlyArray<MobileCodeProjectOption> {
  return projects
    .filter(
      (project): project is Extract<ProjectSummary, { readonly type: "code" }> =>
        project.type === "code" && project.lifecycle === "active",
    )
    .map((project) => ({
      projectId: String(project.id),
      name: project.name,
      root: project.binding.canonicalRoot,
    }));
}

export async function fetchMobileCodeProjects(
  transport: MobileRemoteTransport,
): Promise<ReadonlyArray<MobileCodeProjectOption>> {
  const bootstrap = await requireJson(
    await transport.authenticatedFetch({ method: "GET", path: "/api/projects/bootstrap" }),
    decodeProjectBootstrap,
    "Could not load Code projects from the host.",
  );
  const unavailable = new Set(
    bootstrap.availability
      .filter((entry) => entry.status === "unavailable")
      .map((entry) => String(entry.projectId)),
  );
  return listMobileCodeProjects(bootstrap.active).filter(
    (project) => !unavailable.has(project.projectId),
  );
}

async function executeCodeCommand(
  transport: MobileRemoteTransport,
  command: Record<string, unknown>,
) {
  return requireJson(
    await transport.authenticatedFetch({
      method: "POST",
      path: "/api/code/commands",
      body: JSON.stringify(command),
    }),
    decodeCodeCommandResult,
    "Could not create the Code task on the host.",
  );
}

function requireBranchCheckout(checkout: CodeCheckoutIdentity): string {
  if (checkout.head.kind !== "branch") {
    throw new MobileInboxFailure(
      "unavailable",
      "Select a repository branch on the host before starting a Code task.",
    );
  }
  return checkout.head.name;
}

async function findCodeThreadForRetry(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<{ readonly thread: CodeThread; readonly checkout: CodeCheckoutIdentity } | undefined> {
  try {
    return await requireJson(
      await transport.authenticatedFetch({
        method: "GET",
        path: `/api/code/threads/${encodeURIComponent(threadId)}`,
      }),
      decodeCodeThreadView,
      "Could not reconcile the existing Code task.",
    );
  } catch (cause) {
    if (cause instanceof MobileInboxFailure && cause.category === "unavailable") return undefined;
    throw cause;
  }
}

async function findCodeOperationResultForRetry(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly operationId: string;
}): Promise<{ readonly result?: CodeOperationResult; readonly started: boolean }> {
  const response = await input.transport.authenticatedFetch({
    method: "GET",
    path: `/api/code/threads/${encodeURIComponent(input.threadId)}/operations/${encodeURIComponent(input.operationId)}/events?afterCursor=0`,
  });
  if (!response.ok) {
    if (response.status === 404) return { started: false };
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Could not reconcile the existing Code operation.",
    );
  }
  const body = await response.text();
  let started = false;
  let result: CodeOperationResult | undefined;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let frame;
    try {
      frame = decodeCodeOperationEventFrame(JSON.parse(trimmed));
    } catch {
      throw new MobileInboxFailure(
        "unavailable",
        "The host returned invalid Code operation evidence.",
      );
    }
    if (frame.threadId !== input.threadId || frame.operationId !== input.operationId) {
      throw new MobileInboxFailure(
        "unavailable",
        "The host returned mismatched Code operation evidence.",
      );
    }
    if (frame.event.kind === "conversation-turn-started") started = true;
    if (frame.event.kind === "operation-state" && frame.event.state !== "completed") {
      started = true;
    }
    if (frame.event.kind === "operation-result") result = frame.event.result;
  }
  return result === undefined ? { started } : { result, started };
}

function codeCreationFailure(
  cause: unknown,
  retry: MobileCodeCreationRetry,
): MobileCodeCreationFailure {
  if (cause instanceof MobileCodeCreationFailure) return cause;
  if (cause instanceof MobileInboxFailure) {
    return new MobileCodeCreationFailure(cause.category, cause.message, retry);
  }
  return new MobileCodeCreationFailure(
    "unavailable",
    "The Code task was created, but the next step could not complete.",
    retry,
  );
}

/**
 * Create a project-backed, approval-gated Code thread and launch its first
 * provider turn. Mobile never inherits remembered Full access implicitly.
 */
export async function createMobileCodeFromPrompt(input: {
  readonly transport: MobileRemoteTransport;
  readonly prompt: string;
  readonly project: MobileCodeProjectOption;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly threadId?: string;
  readonly retry?: MobileCodeCreationRetry;
  readonly confirmDeliveryTarget: (
    proposal: MobileCodeDeliveryTargetProposal,
  ) => Promise<CodeDeliveryTarget | undefined>;
  readonly uuid?: () => string;
}): Promise<MobileInboxRow> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new MobileInboxFailure("unavailable", "Describe the Code task before starting it.");
  }
  if (new TextEncoder().encode(prompt).byteLength > MAX_CODE_OPERATION_TEXT_BYTES) {
    throw new MobileInboxFailure("rejected", "Code prompts must be at most 64 KiB.");
  }
  const uuid = input.uuid ?? (() => globalThis.crypto.randomUUID());
  const threadId = input.retry?.threadId ?? input.threadId ?? uuid();
  const operationId = input.retry?.operationId ?? uuid();
  const sessionId = input.retry?.sessionId ?? uuid();
  await requireJson(
    await input.transport.authenticatedFetch({ method: "GET", path: "/api/code/bootstrap" }),
    decodeCodeBootstrap,
    "Could not load Code settings from the host.",
  );
  let thread: CodeThread | undefined;
  let checkout: CodeCheckoutIdentity | undefined;
  let deliveryTarget: CodeDeliveryTarget | undefined;
  const existing =
    input.retry === undefined
      ? undefined
      : await findCodeThreadForRetry(input.transport, input.retry.threadId);
  if (existing !== undefined) {
    if (
      String(existing.thread.projectId) !== input.project.projectId ||
      String(existing.thread.providerInstanceId) !== input.providerInstanceId ||
      String(existing.thread.modelId) !== input.modelId
    ) {
      throw new MobileInboxFailure("rejected", "The existing Code task does not match this draft.");
    }
    thread = existing.thread;
    checkout = existing.checkout;
    deliveryTarget = existing.thread.deliveryTarget;
  } else {
    const prepared = await executeCodeCommand(input.transport, {
      kind: "prepare-code-project-checkout",
      projectId: input.project.projectId,
    });
    if (prepared.kind !== "checkout-prepared") {
      throw new MobileInboxFailure("unavailable", "The repository checkout could not be prepared.");
    }
    const checkoutBranch = requireBranchCheckout(prepared.checkout);
    if (input.retry !== undefined) {
      deliveryTarget = decodeCodeDeliveryTarget(input.retry.deliveryTarget);
    } else {
      const remoteFacts = await executeCodeCommand(input.transport, {
        kind: "get-worktree-remote-facts",
        projectId: input.project.projectId,
      });
      if (remoteFacts.kind !== "worktree-remote-facts-retrieved") {
        throw new MobileInboxFailure("unavailable", "The host did not provide repository remotes.");
      }
      const remoteName =
        remoteFacts.facts.defaultRemote ??
        remoteFacts.facts.upstreamRemote ??
        remoteFacts.facts.remotes[0];
      if (remoteName === undefined) {
        throw new MobileInboxFailure(
          "unavailable",
          "The host did not provide a repository remote.",
        );
      }
      const proposal: MobileCodeDeliveryTargetProposal = {
        branchIntent: `octant/mobile-${threadId.slice(0, 8)}`,
        remoteName,
        proposedBaseRepository: "",
        proposedBaseBranch: checkoutBranch,
        suggestedOutcomeKind: suggestCodeDeliveryOutcome(prompt),
      };
      const confirmed = await input.confirmDeliveryTarget(proposal);
      if (confirmed === undefined) {
        throw new MobileInboxFailure(
          "rejected",
          "Confirm the Code delivery target before starting this task.",
        );
      }
      try {
        deliveryTarget = decodeCodeDeliveryTarget(confirmed);
      } catch {
        throw new MobileInboxFailure(
          "rejected",
          "The Code delivery target confirmation is invalid.",
        );
      }
    }
    if (deliveryTarget === undefined) {
      throw new MobileInboxFailure(
        "unavailable",
        "The Code delivery target could not be resolved.",
      );
    }
    const sourceBranch = deliveryTarget.proposedBaseBranch;

    const retry = { threadId, deliveryTarget, operationId, sessionId };
    let created;
    try {
      created = await executeCodeCommand(input.transport, {
        kind: "create-managed-code-thread",
        threadId,
        projectId: input.project.projectId,
        bindingRevisionId: prepared.bindingRevisionId,
        title: titleFromPrompt(prompt),
        providerInstanceId: input.providerInstanceId,
        modelId: input.modelId,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget,
        sourceBranch,
        startFromOrigin: false,
        remoteName: deliveryTarget.remoteName,
      });
    } catch (cause) {
      throw codeCreationFailure(cause, retry);
    }
    if (created.kind !== "managed-thread-created") {
      throw codeCreationFailure(
        new MobileInboxFailure("unavailable", "The host did not confirm Code task creation."),
        retry,
      );
    }
    thread = created.thread;
    checkout = created.checkout;
    deliveryTarget = created.thread.deliveryTarget;
  }

  if (thread === undefined || checkout === undefined || deliveryTarget === undefined) {
    throw new MobileInboxFailure("unavailable", "The Code task could not be reconciled.");
  }
  const retry = { threadId: String(thread.id), deliveryTarget, operationId, sessionId };
  if (input.retry !== undefined) {
    const reconciled = await findCodeOperationResultForRetry({
      transport: input.transport,
      threadId: String(thread.id),
      operationId,
    });
    if (reconciled.result !== undefined) {
      if (
        reconciled.result.kind === "provider-turn-state" &&
        (reconciled.result.state === "failed" || reconciled.result.state === "interrupted")
      ) {
        throw new MobileCodeCreationFailure(
          "unavailable",
          "The existing Code provider turn did not complete successfully.",
          retry,
        );
      }
      return codeRow(input.transport.hostId, thread);
    }
    if (reconciled.started) {
      throw new MobileCodeCreationFailure(
        "unavailable",
        "The existing Code provider turn is still being reconciled on the host.",
        retry,
      );
    }
  }
  try {
    const evidence = await requireJson(
      await input.transport.authenticatedFetch({
        method: "PUT",
        path: "/api/code/evidence",
        body: prompt,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-octant-code-thread-id": String(thread.id),
        },
        contentType: "text/plain; charset=utf-8",
      }),
      decodeCodeEvidenceReference,
      "The Code task was created, but its prompt could not be staged.",
    );
    const started = await requireJson(
      await input.transport.authenticatedFetch({
        method: "POST",
        path: "/api/code/commands",
        body: JSON.stringify({
          kind: "start-provider-turn",
          operationId,
          threadId: thread.id,
          checkoutId: checkout.id,
          sessionId,
          prompt: evidence,
        }),
      }),
      decodeCodeOperationResult,
      "The Code task was created, but its first turn could not start.",
    );
    if (started.kind !== "provider-turn-state" || started.state !== "running") {
      throw new MobileInboxFailure(
        "unavailable",
        "The Code task was created, but the provider did not start working.",
      );
    }
  } catch (cause) {
    throw codeCreationFailure(cause, retry);
  }
  return codeRow(input.transport.hostId, thread);
}
