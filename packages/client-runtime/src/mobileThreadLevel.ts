import type { CodeThread, PermissionMode, WorkThread } from "@octant/contracts";
import {
  permissionModeOf,
  permissionModeOfWorkAccess,
  threadAccessOf,
  workAccessOfPermissionMode,
} from "@octant/domain";
import type { MobileRemoteTransport } from "./mobileInboxClient";

/**
 * A Work or Code thread's level, set from a phone the host's own person
 * paired. Such a device sets a level as a local window does (maintainer
 * decision, 2026-11-12), so this sends the commands a window sends and asks
 * for no owner unlock. The host still decides: a session it holds to the
 * catalogue is refused, and the refusal is reported as it is.
 */
export type MobileThreadLevelSubject =
  | {
      readonly mode: "code";
      readonly thread: Pick<
        CodeThread,
        "id" | "version" | "executionPolicy" | "permissionPersistence" | "autoApprove"
      >;
    }
  | { readonly mode: "work"; readonly thread: Pick<WorkThread, "id" | "version" | "access"> };

export const MOBILE_THREAD_LEVEL_LABELS: Readonly<Record<PermissionMode, string>> = {
  auto: "Auto",
  "ask-first": "Ask first",
  "accept-edits": "Accept edits",
  plan: "Plan",
  "full-access": "Full access",
};

/** Said before the first Full access pick, in the words the desktop warning uses. */
export const MOBILE_FULL_ACCESS_WARNING =
  "Agents can change any file and run any command without asking, with no sandbox. Protected files, such as SSH and cloud keys, are guarded by Octant's own tools and redaction only, and a shell command can read them.";

const CODE_LEVELS: ReadonlyArray<PermissionMode> = [
  "auto",
  "ask-first",
  "accept-edits",
  "plan",
  "full-access",
];
// Work shares Code's levels and has no Plan overlay.
const WORK_LEVELS = CODE_LEVELS.filter((level) => level !== "plan");

export function mobileThreadLevelChoices(mode: "code" | "work"): ReadonlyArray<PermissionMode> {
  return mode === "work" ? WORK_LEVELS : CODE_LEVELS;
}

export function mobileThreadLevel(subject: MobileThreadLevelSubject): PermissionMode {
  return subject.mode === "work"
    ? permissionModeOfWorkAccess(subject.thread.access)
    : permissionModeOf({
        executionPolicy: subject.thread.executionPolicy,
        autoApprove: subject.thread.autoApprove,
      });
}

export type MobileThreadLevelChange =
  | { readonly status: "changed" }
  | { readonly status: "refused"; readonly message: string };

const REFUSED: MobileThreadLevelChange = {
  status: "refused",
  message: "The host did not change this thread's mode.",
};

/** Sends one change against the version the phone read; a refusal is never retried. */
export async function changeMobileThreadLevel(input: {
  readonly transport: MobileRemoteTransport;
  readonly subject: MobileThreadLevelSubject;
  readonly level: PermissionMode;
}): Promise<MobileThreadLevelChange> {
  const { subject } = input;
  let path: string;
  let command: Record<string, unknown>;
  if (subject.mode === "work") {
    const access = workAccessOfPermissionMode(input.level);
    if (access === undefined) return REFUSED;
    path = "/api/work/threads/commands";
    command = {
      kind: "change-work-thread-access",
      threadId: subject.thread.id,
      expectedVersion: subject.thread.version,
      access,
    };
  } else {
    const access = threadAccessOf(input.level);
    path = "/api/code/commands";
    command = {
      kind: "change-code-thread-access",
      threadId: subject.thread.id,
      expectedVersion: subject.thread.version,
      executionPolicy: access.executionPolicy,
      permissionPersistence: subject.thread.permissionPersistence,
      autoApprove: access.autoApprove,
    };
  }
  try {
    const response = await input.transport.authenticatedFetch({
      method: "POST",
      path,
      body: JSON.stringify(command),
    });
    if (!response.ok) return REFUSED;
    const answer: unknown = await response.json();
    return typeof answer === "object" &&
      answer !== null &&
      "kind" in answer &&
      answer.kind === "thread-updated"
      ? { status: "changed" }
      : REFUSED;
  } catch {
    return REFUSED;
  }
}
