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

function send(decision: "approve" | "cancel" | "next" | "previous"): void {
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
  const firstChallenge = challenge === undefined;
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
  if (firstChallenge) {
    // Focusing Cancel makes VoiceOver read the dialog and Enter the safe
    // cancellation action; Allow still requires an explicit Tab or click.
    const cancel = element("cancel");
    if (cancel instanceof HTMLButtonElement) cancel.focus();
  }
}

ipcRenderer.on(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.challenge, (_event, value: unknown) => {
  // The main process decodes this challenge before sending it. Keep the view
  // tolerant of a late or malformed message; only textContent is ever used.
  const next = decodeChallenge(value);
  if (next !== undefined) render(next);
});

ipcRenderer.on(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.queue, (_event, value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("count" in value) ||
    typeof value.count !== "number" ||
    !Number.isInteger(value.count) ||
    value.count < 1 ||
    value.count > 8
  )
    return;
  const queue = element("queue");
  const count = element("queue-count");
  if (queue !== undefined) queue.hidden = value.count < 2;
  if (count !== undefined) count.textContent = `${value.count} pending approvals`;
});

window.addEventListener("DOMContentLoaded", () => {
  element("previous")?.addEventListener("click", () => send("previous"));
  element("next")?.addEventListener("click", () => send("next"));
  element("approve")?.addEventListener("click", () => send("approve"));
  element("cancel")?.addEventListener("click", () => send("cancel"));
  // Escape cancels; there is no custom Enter handler, so the focused Cancel
  // button remains the only safe native action before someone chooses Allow.
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") send("cancel");
  });
});
