import {
  ChatCommandResult,
  CodeCommandResult,
  WorkThreadCommandResult,
  decodeHostAnswer,
} from "@octant/contracts";
import {
  MobileInboxFailure,
  type MobileInboxRow,
  type MobileRemoteTransport,
} from "./mobileInboxClient";

/**
 * What the phone may do to a thread's place in the list, through the same
 * commands a desktop row menu sends: snooze it until a time, wake it, put it
 * away or reopen it, and pin or unpin a Code thread (pinning is Code-only, as
 * on the desktop). The host checks authority and the thread's version.
 */
export type MobileThreadRestAction =
  | { readonly kind: "snooze"; readonly until: string }
  | { readonly kind: "wake" }
  | { readonly kind: "put-away" }
  | { readonly kind: "reopen" }
  | { readonly kind: "pin"; readonly pinned: boolean };

export type MobileThreadRestResult =
  | { readonly status: "done" }
  | { readonly status: "refused"; readonly message: string };

const PATHS: Readonly<Record<MobileInboxRow["mode"], string>> = {
  chat: "/api/chat/commands",
  work: "/api/work/threads/commands",
  code: "/api/code/commands",
};

function commandKind(
  action: MobileThreadRestAction,
  mode: MobileInboxRow["mode"],
): string | undefined {
  if (action.kind === "pin") return mode === "code" ? "pin-code-thread" : undefined;
  const verb =
    action.kind === "put-away"
      ? "complete"
      : action.kind === "snooze"
        ? "snooze"
        : action.kind === "wake"
          ? "wake"
          : "reopen";
  return `${verb}-${mode}-thread`;
}

export async function setMobileThreadRest(input: {
  readonly transport: MobileRemoteTransport;
  readonly row: Pick<MobileInboxRow, "mode" | "threadId" | "version">;
  readonly action: MobileThreadRestAction;
}): Promise<MobileThreadRestResult> {
  const kind = commandKind(input.action, input.row.mode);
  if (kind === undefined) {
    return { status: "refused", message: "Only a Code thread can be pinned." };
  }
  return postThreadCommand(input.transport, input.row, {
    kind,
    ...(input.action.kind === "snooze" ? { until: input.action.until } : {}),
    ...(input.action.kind === "pin" ? { pinned: input.action.pinned } : {}),
  });
}

/**
 * Opt a usage-limited Work or Code turn into resuming when the provider's
 * limit resets, or withdraw that opt-in, as the desktop's usage-limit notice
 * does. The host binds the opt-in to the stopped turn and fires it at the
 * reset; Chat resumes through its own retry instead.
 */
export function setMobileUsageResume(input: {
  readonly transport: MobileRemoteTransport;
  readonly row: Pick<MobileInboxRow, "mode" | "threadId" | "version"> & {
    readonly mode: "work" | "code";
  };
  readonly action:
    | { readonly kind: "schedule"; readonly turnId: string }
    | { readonly kind: "cancel" };
}): Promise<MobileThreadRestResult> {
  const mode = input.row.mode;
  if (input.action.kind === "cancel") {
    return postThreadCommand(input.transport, input.row, { kind: `cancel-${mode}-usage-resume` });
  }
  return postThreadCommand(input.transport, input.row, {
    kind: `schedule-${mode}-usage-resume`,
    ...(mode === "work" ? { turnId: input.action.turnId } : { operationId: input.action.turnId }),
  });
}

async function postThreadCommand(
  transport: MobileRemoteTransport,
  row: Pick<MobileInboxRow, "mode" | "threadId" | "version">,
  fields: Record<string, unknown>,
): Promise<MobileThreadRestResult> {
  if (row.version === undefined) {
    return { status: "refused", message: "Refresh the list and try again." };
  }
  const response = await transport.authenticatedFetch({
    method: "POST",
    path: PATHS[row.mode],
    contentType: "application/json",
    body: JSON.stringify({ ...fields, threadId: row.threadId, expectedVersion: row.version }),
  });
  if (response.status === 409) {
    return { status: "refused", message: "The thread changed on the host. Refresh and try again." };
  }
  if (response.status === 403) {
    return { status: "refused", message: "This host does not let this device change that." };
  }
  if (!response.ok) {
    return { status: "refused", message: await refusalMessage(response) };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MobileInboxFailure("unavailable", "The host returned an invalid response.");
  }
  if (row.mode === "work") {
    const result = decodeHostAnswer(WorkThreadCommandResult)(body);
    if ("message" in result && !("thread" in result)) {
      return { status: "refused", message: result.message };
    }
    return { status: "done" };
  }
  if (row.mode === "chat") decodeHostAnswer(ChatCommandResult)(body);
  else decodeHostAnswer(CodeCommandResult)(body);
  return { status: "done" };
}

async function refusalMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readonly message?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
  } catch {
    // An unreadable refusal falls back to the generic sentence below.
  }
  return "The host refused the change. Nothing changed.";
}
