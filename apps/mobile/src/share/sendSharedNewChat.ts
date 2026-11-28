import {
  createMobileChatThread,
  loadMobileChatThread,
  MobileInboxFailure,
  sendMobileChatTurn,
  type MobileInboxRow,
  type MobileRemoteTransport,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { MOBILE_COPY } from "../copy";
import { uploadStagedThreadAttachments } from "../inbox/thread/uploadThreadAttachment";
import type { MobileHostHealth } from "../session/MobileHostSessionHub";
import { evaluateShareHost } from "./shareDestinations";
import type { ValidatedStagedAttachment } from "./shareValidation";

export type SendSharedNewChatResult =
  | { readonly status: "sent"; readonly row: MobileInboxRow }
  | { readonly status: "refused"; readonly message: string };

function titleForSharedChat(
  prompt: string,
  attachments: ReadonlyArray<ValidatedStagedAttachment>,
): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim();
  if (firstLine !== undefined && firstLine.length > 0) {
    return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 71).trimEnd()}…`;
  }
  const firstAttachment = attachments[0]?.displayName.trim();
  if (firstAttachment !== undefined && firstAttachment.length > 0) {
    return firstAttachment.length <= 72
      ? firstAttachment
      : `${firstAttachment.slice(0, 71).trimEnd()}…`;
  }
  return MOBILE_COPY.shareNewChat;
}

/**
 * Executes New chat from the "Send to…" sheet when the person taps Send.
 * The thread is created only on Send (so discarding never leaves an empty
 * thread), attachments upload through `uploadMobileChatAttachment`, and
 * unmodified shared text is never marked `typedByPerson`.
 *
 * Refuses stale, unreachable, or restricted computers without sending anything
 * or touching the offline outbox.
 */
export async function sendSharedNewChat(input: {
  readonly hostId: string;
  readonly hostLabel: string;
  readonly health: MobileHostHealth | undefined;
  readonly transport: MobileRemoteTransport | undefined;
  readonly standing: RemoteSessionStanding | undefined;
  readonly prompt: string;
  readonly typedByPerson?: true;
  readonly attachments: ReadonlyArray<ValidatedStagedAttachment>;
  readonly onCleanupStaged: () => Promise<void>;
}): Promise<SendSharedNewChatResult> {
  const eligibility = evaluateShareHost({
    host: { hostId: input.hostId, label: input.hostLabel },
    health: input.health,
    transport: input.transport,
    standing: input.standing,
  });
  if (!eligibility.enabled || input.transport === undefined) {
    return {
      status: "refused",
      message: eligibility.disabledReason ?? MOBILE_COPY.shareComputerUnreachable,
    };
  }
  const trimmedPrompt = input.prompt.trim();
  if (trimmedPrompt.length === 0) {
    return { status: "refused", message: "Add a message before sending." };
  }

  try {
    const thread = await createMobileChatThread({
      transport: input.transport,
      title: titleForSharedChat(trimmedPrompt, input.attachments),
    });
    const threadId = String(thread.id);
    const uploaded = await uploadStagedThreadAttachments({
      mode: "chat",
      transport: input.transport,
      threadId,
      items: input.attachments,
    });
    if (uploaded.status === "failed") {
      return {
        status: "refused",
        message: uploaded.rejected ? uploaded.message : MOBILE_COPY.attachFailed,
      };
    }
    await sendMobileChatTurn({
      transport: input.transport,
      threadId,
      expectedVersion: thread.version,
      prompt: trimmedPrompt,
      ...(input.typedByPerson === true ? { typedByPerson: true as const } : {}),
      ...(uploaded.uploaded.length > 0
        ? { attachmentIds: uploaded.uploaded.map((item) => item.id) }
        : {}),
    });
    await input.onCleanupStaged().catch(() => undefined);
    let row: MobileInboxRow = {
      hostId: input.transport.hostId,
      mode: "chat",
      threadId,
      title: thread.title,
      status: "active",
      freshness: thread.updatedAt,
      version: thread.version,
      providerInstanceId: String(thread.providerInstanceId),
    };
    try {
      const view = await loadMobileChatThread(input.transport, threadId);
      const updated = view.thread;
      row = {
        hostId: input.transport.hostId,
        mode: "chat",
        threadId: String(updated.id),
        title: updated.title,
        status: "active",
        freshness: updated.updatedAt,
        version: updated.version,
        providerInstanceId: String(updated.providerInstanceId),
      };
    } catch {
      // The host already accepted the turn; preserve send success with the
      // created thread identity so a reload failure cannot trigger a duplicate send.
    }
    return { status: "sent", row };
  } catch (cause) {
    return {
      status: "refused",
      message:
        cause instanceof MobileInboxFailure
          ? cause.message
          : "Could not send the shared items to this computer.",
    };
  }
}

/**
 * Prepares shared items for an existing thread by checking the computer and
 * uploading any staged attachments through that mode's attachment route.
 * Never sends a turn — the caller populates the thread's composer for the
 * person to review and tap Send.
 */
export async function prepareShareForThread(input: {
  readonly hostLabel: string;
  readonly health: MobileHostHealth | undefined;
  readonly transport: MobileRemoteTransport | undefined;
  readonly standing: RemoteSessionStanding | undefined;
  readonly row: MobileInboxRow;
  readonly attachments: ReadonlyArray<ValidatedStagedAttachment>;
}): Promise<
  | {
      readonly status: "ready";
      readonly uploaded: ReadonlyArray<{ readonly id: string; readonly displayName: string }>;
    }
  | { readonly status: "refused"; readonly message: string }
> {
  const eligibility = evaluateShareHost({
    host: { hostId: input.row.hostId, label: input.hostLabel },
    health: input.health,
    transport: input.transport,
    standing: input.standing,
  });
  if (!eligibility.enabled || input.transport === undefined) {
    return {
      status: "refused",
      message: eligibility.disabledReason ?? MOBILE_COPY.shareComputerUnreachable,
    };
  }
  if (input.attachments.length === 0) {
    return { status: "ready", uploaded: [] };
  }
  const result = await uploadStagedThreadAttachments({
    mode: input.row.mode,
    transport: input.transport,
    threadId: input.row.threadId,
    items: input.attachments,
  });
  if (result.status === "failed") {
    return { status: "refused", message: result.message };
  }
  return { status: "ready", uploaded: result.uploaded };
}
