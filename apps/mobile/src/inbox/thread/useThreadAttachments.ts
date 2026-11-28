import { useCallback, useEffect, useReducer } from "react";
import type {
  MobileAttachmentMode,
  MobileAttachmentOffer,
  MobileAttachmentSource,
  MobileRemoteTransport,
} from "@octant/client-runtime";
import { MOBILE_COPY } from "../../copy";
import { readUriBytes } from "./imageBytes";
import { pendingAttachmentsReducer, type PendingAttachment } from "./pendingAttachments";
import { discardPickedCopy, pickAttachment, type PickedAttachment } from "./pickAttachment";
import { runMutation } from "./runMutation";
import type { ThreadHookInput } from "./threadTypes";
import {
  TURN_ATTACHMENT_LIMITS,
  uploadStagedThreadAttachment,
  uploadStagedThreadAttachments,
  type StagedBatchUploadResult,
  type StagedThreadAttachmentUpload,
} from "./uploadThreadAttachment";

export {
  uploadStagedThreadAttachment,
  uploadStagedThreadAttachments,
  type StagedBatchUploadResult,
  type StagedThreadAttachmentUpload,
};

/**
 * The attachments a phone has staged for a thread's next turn. Each one is
 * uploaded through the thread's own attachment route the moment it is picked,
 * so the host holds it under that thread's authority; the send carries only
 * the ids. They leave the composer when a send succeeds or the thread changes.
 */
export function useThreadAttachments(
  mode: MobileAttachmentMode,
  input: Pick<ThreadHookInput, "transport" | "target" | "guard" | "ui" | "gate">,
) {
  const { transport, target, guard, ui, gate } = input;
  const identity = target?.identity;
  const threadId = target?.threadId;
  const enabled = target?.mode === mode;
  const [pending, dispatch] = useReducer(pendingAttachmentsReducer, []);

  useEffect(() => {
    dispatch({ type: "thread-changed" });
  }, [identity]);

  const attach = async (source: MobileAttachmentSource, offer: MobileAttachmentOffer) => {
    if (!enabled || transport === undefined || identity === undefined || threadId === undefined) {
      return;
    }
    if (!offer.sources.includes(source)) return;
    if (!gate.allowProductMutations) {
      ui.setError(gate.message);
      return;
    }
    if (pending.length >= TURN_ATTACHMENT_LIMITS[mode]) {
      ui.setError(MOBILE_COPY.attachLimit(TURN_ATTACHMENT_LIMITS[mode]));
      return;
    }
    const picking = await guard.guarded(identity, () => pickAttachment(source, offer.mediaTypes));
    if (picking.status === "stale") return;
    if (picking.status === "failed") {
      ui.setError(MOBILE_COPY.attachFailed);
      return;
    }
    const picked = picking.value;
    if (picked.status === "denied") {
      ui.setError(
        picked.source === "camera"
          ? MOBILE_COPY.attachCameraDenied
          : MOBILE_COPY.attachLibraryDenied,
      );
      return;
    }
    if (picked.status === "unsupported") {
      ui.setError(MOBILE_COPY.attachUnsupported);
      return;
    }
    if (picked.status !== "picked") return;
    await runMutation({
      guard,
      identity,
      gate,
      ui,
      failure: MOBILE_COPY.attachFailed,
      run: () => uploadPicked(mode, transport, threadId, picked),
      onDone: (uploaded) => {
        if (uploaded === undefined) {
          ui.setError(MOBILE_COPY.attachFailed);
          return;
        }
        dispatch({ type: "uploaded", attachment: uploaded });
      },
    });
  };

  /** Receives attachments already uploaded for this thread (e.g. from the OS share sheet). */
  const receiveStaged = useCallback((attachments: ReadonlyArray<PendingAttachment>) => {
    dispatch({ type: "staged", attachments });
  }, []);

  /** Uploads validated staged items for this thread and places them in the composer. */
  const attachStaged = async (
    items: ReadonlyArray<StagedThreadAttachmentUpload>,
  ): Promise<boolean> => {
    if (!enabled || transport === undefined || identity === undefined || threadId === undefined) {
      return false;
    }
    if (!gate.allowProductMutations) {
      ui.setError(gate.message);
      return false;
    }
    const result = await uploadStagedThreadAttachments({
      mode,
      transport,
      threadId,
      items,
      existingCount: pending.length,
    });
    if (!guard.isSelected(identity)) return false;
    if (result.status === "failed") {
      ui.setError(result.message);
      return false;
    }
    dispatch({ type: "staged", attachments: result.uploaded });
    return true;
  };

  return {
    pending,
    attach,
    attachStaged,
    receiveStaged,
    sent: () => dispatch({ type: "sent" }),
  };
}

async function uploadPicked(
  mode: MobileAttachmentMode,
  transport: MobileRemoteTransport,
  threadId: string,
  picked: Extract<PickedAttachment, { readonly status: "picked" }>,
): Promise<PendingAttachment | undefined> {
  try {
    const read = await readUriBytes(picked.uri);
    if (read.status === "unreadable") return undefined;
    return await uploadStagedThreadAttachment(mode, transport, threadId, {
      displayName: picked.fileName ?? "",
      mediaType: picked.mediaType,
      bytes: read.bytes,
    });
  } finally {
    discardPickedCopy(picked.uri);
  }
}
