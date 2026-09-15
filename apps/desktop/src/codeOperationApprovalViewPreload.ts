import { decodeChallenge, type ApprovalChallengeView } from "./codeOperationApprovalChallengeView";
import { ipcRenderer } from "electron";
import { CODE_OPERATION_APPROVAL_VIEW_CHANNELS } from "./codeOperationApprovalViewProtocol";

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

function render(next: ApprovalChallengeView): void {
  challenge = next;
  const approve = element("approve");
  if (approve instanceof HTMLButtonElement) approve.disabled = false;
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
      `Checkout head: ${next.checkoutHead.kind === "branch" ? `${next.checkoutHead.name} @ ${next.checkoutHead.oid}` : next.checkoutHead.kind === "detached" ? next.checkoutHead.oid : "No revision"}`,
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
