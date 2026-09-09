import { ipcRenderer } from "electron";
import { CODE_OPERATION_APPROVAL_VIEW_CHANNELS } from "./codeOperationApprovalViewProtocol";

interface ApprovalChallengeView {
  readonly challengeId: string;
  readonly effectDigest: string;
  readonly contextDigest: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly checkoutId: string;
  readonly repositoryId: string;
  readonly checkoutHead:
    | { readonly kind: "branch"; readonly name: string; readonly oid: string }
    | { readonly kind: "detached"; readonly oid: string };
  readonly pullRequestTarget?: {
    readonly baseRepository: string;
    readonly baseBranch: string;
    readonly head: string;
  };
  readonly message: string;
  readonly detail: string;
}

const token = process.argv
  .find((argument) => argument.startsWith("--octant-code-approval-token="))
  ?.slice("--octant-code-approval-token=".length);

function element(id: string): HTMLElement | undefined {
  const value = document.getElementById(id);
  return value instanceof HTMLElement ? value : undefined;
}

let challenge: ApprovalChallengeView | undefined;

function send(decision: "approve" | "cancel"): void {
  if (token === undefined || challenge === undefined) return;
  const approve = element("approve");
  const cancel = element("cancel");
  if (approve instanceof HTMLButtonElement) approve.disabled = true;
  if (cancel instanceof HTMLButtonElement) cancel.disabled = true;
  void ipcRenderer.invoke(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.decision, {
    token,
    challengeId: challenge.challengeId,
    decision,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeChallenge(value: unknown): ApprovalChallengeView | undefined {
  if (!isRecord(value)) return undefined;
  const challengeId = stringField(value, "challengeId");
  const effectDigest = stringField(value, "effectDigest");
  const contextDigest = stringField(value, "contextDigest");
  const projectId = stringField(value, "projectId");
  const threadId = stringField(value, "threadId");
  const checkoutId = stringField(value, "checkoutId");
  const repositoryId = stringField(value, "repositoryId");
  const message = stringField(value, "message");
  const detail = stringField(value, "detail");
  const checkoutHeadValue = value.checkoutHead;
  if (
    challengeId === undefined ||
    effectDigest === undefined ||
    contextDigest === undefined ||
    projectId === undefined ||
    threadId === undefined ||
    checkoutId === undefined ||
    repositoryId === undefined ||
    message === undefined ||
    detail === undefined ||
    !isRecord(checkoutHeadValue)
  ) {
    return undefined;
  }
  const oid = stringField(checkoutHeadValue, "oid");
  if (oid === undefined) return undefined;
  const checkoutHead =
    checkoutHeadValue.kind === "branch"
      ? (() => {
          const name = stringField(checkoutHeadValue, "name");
          return name === undefined ? undefined : { kind: "branch" as const, name, oid };
        })()
      : checkoutHeadValue.kind === "detached"
        ? { kind: "detached" as const, oid }
        : undefined;
  if (checkoutHead === undefined) return undefined;

  const pullRequestValue = value.pullRequestTarget;
  let pullRequestTarget: ApprovalChallengeView["pullRequestTarget"];
  if (pullRequestValue === undefined) {
    pullRequestTarget = undefined;
  } else {
    if (!isRecord(pullRequestValue)) return undefined;
    const baseRepository = stringField(pullRequestValue, "baseRepository");
    const baseBranch = stringField(pullRequestValue, "baseBranch");
    const head = stringField(pullRequestValue, "head");
    if (baseRepository === undefined || baseBranch === undefined || head === undefined) {
      return undefined;
    }
    pullRequestTarget = { baseRepository, baseBranch, head };
  }

  return {
    challengeId,
    effectDigest,
    contextDigest,
    projectId,
    threadId,
    checkoutId,
    repositoryId,
    checkoutHead,
    ...(pullRequestTarget === undefined ? {} : { pullRequestTarget }),
    message,
    detail,
  };
}

function render(next: ApprovalChallengeView): void {
  challenge = next;
  const message = element("message");
  const detail = element("detail");
  const identity = element("identity");
  const digests = element("digests");
  if (message !== undefined) message.textContent = next.message;
  if (detail !== undefined) detail.textContent = next.detail;
  if (identity !== undefined) {
    identity.textContent = [
      `Challenge: ${next.challengeId}`,
      `Project: ${next.projectId}`,
      `Thread: ${next.threadId}`,
      `Checkout: ${next.checkoutId}`,
      `Repository: ${next.repositoryId}`,
      `Checkout head: ${next.checkoutHead.kind === "branch" ? `${next.checkoutHead.name} @ ${next.checkoutHead.oid}` : next.checkoutHead.oid}`,
      ...(next.pullRequestTarget === undefined
        ? []
        : [
            `Pull request: ${next.pullRequestTarget.baseRepository} ${next.pullRequestTarget.baseBranch} ← ${next.pullRequestTarget.head}`,
          ]),
    ].join("\n");
  }
  if (digests !== undefined) {
    digests.textContent = `Effect digest: ${next.effectDigest}\nContext digest: ${next.contextDigest}`;
  }
}

ipcRenderer.on(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.challenge, (_event, value: unknown) => {
  // The main process decodes this challenge before sending it. Keep the view
  // tolerant of a late or malformed message; only textContent is ever used.
  const next = decodeChallenge(value);
  if (next !== undefined) render(next);
});

window.addEventListener("DOMContentLoaded", () => {
  element("approve")?.addEventListener("click", () => send("approve"));
  element("cancel")?.addEventListener("click", () => send("cancel"));
  // Escape cancels; Enter deliberately has no action so an accidental keypress
  // cannot grant Full access before the person explicitly clicks Approve.
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") send("cancel");
  });
});
