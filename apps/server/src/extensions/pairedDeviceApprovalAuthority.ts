/**
 * Whether a device registration still pairs its device right now. The
 * projection's `state` moves to `expired` only when the expiry reconciliation
 * runs, so a registration past its deadline can still read `active`; the
 * deadline is compared here too, and one that cannot be read fails closed.
 */
export function isDeviceRegistrationCurrent(
  registration: { readonly state: string; readonly expiresAt: string } | undefined,
  nowMs: number,
): boolean {
  if (registration?.state !== "active") return false;
  const expiresAtMs = Date.parse(registration.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

/**
 * Whether a Chat thread still stands where a prompt recorded it: active, and
 * in the same Chat Project, or in none when the prompt recorded none. A thread
 * archived or moved since the call was made no longer carries its authority.
 */
export function chatThreadStandsInProject(
  thread: { readonly lifecycle: string; readonly projectId?: unknown } | undefined,
  projectId: string | undefined,
): boolean {
  if (thread === undefined || thread.lifecycle !== "active") return false;
  const current = thread.projectId === undefined ? undefined : String(thread.projectId);
  return current === projectId;
}

/**
 * Whether a local window may drive the thread of a prompt it did not raise (a
 * host-run turn's, or a paired device's), routed by the Project the prompt
 * recorded, never by trying each mode: Work and Code thread ids are separate
 * namespaces, so a raw id alone could match an unrelated thread. No window
 * binding holds a Chat thread, so every local window reaches one while it
 * still stands where the prompt recorded it; before this, a Chat thread's
 * host-run prompt reached no window at all and could only be refused. A Work
 * or Code thread is reached only through the window's own Project binding.
 */
export function windowReachesPromptThread(
  prompt: { readonly threadId: string; readonly projectId: string | undefined },
  facts: {
    readonly readChatThread: (
      threadId: string,
    ) => { readonly lifecycle: string; readonly projectId?: unknown } | undefined;
    readonly readProject: (
      projectId: string,
    ) => { readonly type: string; readonly lifecycle: string } | undefined;
    /** Whether the asking window's own Project binding admits it to this thread. */
    readonly windowDrivesProjectThread: (
      threadId: string,
      type: "work" | "code",
      projectId: string,
    ) => boolean;
  },
): boolean {
  const { threadId, projectId } = prompt;
  if (projectId === undefined) {
    return chatThreadStandsInProject(facts.readChatThread(threadId), undefined);
  }
  const project = facts.readProject(projectId);
  if (project === undefined) return false;
  if (project.type === "chat") {
    return (
      project.lifecycle === "active" &&
      chatThreadStandsInProject(facts.readChatThread(threadId), projectId)
    );
  }
  if (project.type !== "work" && project.type !== "code") return false;
  return facts.windowDrivesProjectThread(threadId, project.type, projectId);
}
