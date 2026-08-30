import {
  CODE_ATTACHMENT_MEDIA_TYPES,
  MAX_CODE_ATTACHMENT_BYTES,
  MAX_CODE_TURN_ATTACHMENTS,
  decodeCodeAttachmentId,
  type CodeAttachmentId,
  type CodeAttachmentMediaType,
  type CodeAttachmentReference,
  type CodeThreadId,
} from "@octant/contracts";
import type { CodeClient } from "@octant/client-runtime";
import { useCallback, useEffect, useRef, useState } from "react";

export interface StagedCodeAttachment {
  /** Exactly what the host answered with, so the turn sends what it accepted. */
  readonly reference: CodeAttachmentReference;
  /** A local object URL for the thumbnail; revoked when the chip goes away. */
  readonly previewUrl: string;
}

export interface CodeAttachments {
  readonly staged: ReadonlyArray<StagedCodeAttachment>;
  readonly message: string | undefined;
  /** Whether an upload is still in flight. Sending waits for it. */
  readonly busy: boolean;
  readonly attach: (files: ReadonlyArray<File>) => Promise<void>;
  /** Refuse an attachment the composer itself knows this turn cannot carry. */
  readonly refuse: (message: string) => void;
  readonly remove: (attachmentId: CodeAttachmentId) => void;
  /** Detach the current images for a message that is waiting to start. */
  readonly detachForSend: () => ReadonlyArray<StagedCodeAttachment>;
  /** Put detached images back after the host refuses their message. */
  readonly restoreDetached: (attachments: ReadonlyArray<StagedCodeAttachment>) => void;
  /** Keep detached images out of the composer after the host accepts them. */
  readonly commitDetached: (attachments: ReadonlyArray<StagedCodeAttachment>) => void;
  /** Discard detached host attachments when a refused message is superseded. */
  readonly discardDetached: (attachments: ReadonlyArray<StagedCodeAttachment>) => void;
  /** The references a send would carry right now, without clearing the chips. */
  readonly peekForSend: () => ReadonlyArray<CodeAttachmentReference>;
  /**
   * Whether this composer is still holding, or still uploading, images that
   * would be lost if the thread were left now.
   */
  readonly peekAbandoned: () => boolean;
  /** Hand this turn's images over and clear the chips. */
  readonly takeForSend: () => ReadonlyArray<CodeAttachmentReference>;
}

const SUPPORTED = new Set<string>(CODE_ATTACHMENT_MEDIA_TYPES);

function supportedMediaType(file: File): CodeAttachmentMediaType | undefined {
  const mediaType = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return SUPPORTED.has(mediaType) ? (mediaType as CodeAttachmentMediaType) : undefined;
}

/**
 * The images a Code composer is holding for its next turn.
 *
 * Each pasted or dropped picture is uploaded to the host immediately, so by
 * the time the user presses send the turn names ids the host already accepted
 * rather than bytes it still has to be talked into taking. A chip the user
 * removes is discarded on the host too — the composer never leaves an image
 * behind that the user believes they took back.
 */
export function useCodeAttachments(input: {
  readonly client: Pick<CodeClient, "putAttachment" | "discardAttachment">;
  readonly threadId: CodeThreadId | undefined;
}): CodeAttachments {
  const { client, threadId } = input;
  const [staged, setStaged] = useState<ReadonlyArray<StagedCodeAttachment>>([]);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const previews = useRef(new Set<string>());
  // Uploads land one after another, so the list has to be readable between
  // awaits — not only at the next render.
  const current = useRef<ReadonlyArray<StagedCodeAttachment>>([]);
  const inFlight = useRef(0);

  const apply = useCallback(
    (next: (list: ReadonlyArray<StagedCodeAttachment>) => ReadonlyArray<StagedCodeAttachment>) => {
      current.current = next(current.current);
      setStaged(current.current);
    },
    [],
  );

  const forget = useCallback((previewUrl: string) => {
    if (!previews.current.delete(previewUrl)) return;
    URL.revokeObjectURL(previewUrl);
  }, []);

  // Switching threads leaves the previous thread's chips behind: an image is
  // staged against the thread it was pasted into, not against the composer.
  useEffect(() => {
    apply((list) => {
      for (const attachment of list) forget(attachment.previewUrl);
      return [];
    });
    setMessage(undefined);
  }, [apply, forget, threadId]);

  useEffect(
    () => () => {
      for (const previewUrl of previews.current) URL.revokeObjectURL(previewUrl);
      previews.current.clear();
    },
    [],
  );

  const attach = useCallback(
    async (files: ReadonlyArray<File>) => {
      if (threadId === undefined || files.length === 0) return;
      const images = files.filter((file) => supportedMediaType(file) !== undefined);
      if (images.length === 0) {
        setMessage("Only PNG, JPEG, WebP, and GIF images can be attached.");
        return;
      }
      setBusy(true);
      inFlight.current += 1;
      try {
        for (const file of images) {
          const mediaType = supportedMediaType(file);
          if (mediaType === undefined) continue;
          if (file.size === 0 || file.size > MAX_CODE_ATTACHMENT_BYTES) {
            setMessage(`${file.name || "Image"} is too large to attach.`);
            continue;
          }
          if (current.current.length >= MAX_CODE_TURN_ATTACHMENTS) {
            setMessage(`A turn carries at most ${MAX_CODE_TURN_ATTACHMENTS} images.`);
            break;
          }
          const attachmentId = decodeCodeAttachmentId(globalThis.crypto.randomUUID());
          const displayName = file.name.trim() === "" ? "Pasted image" : file.name;
          const bytes = new Uint8Array(await file.arrayBuffer());
          const reference = await client.putAttachment({
            threadId,
            attachmentId,
            displayName,
            mediaType,
            bytes,
          });
          const previewUrl = URL.createObjectURL(file);
          previews.current.add(previewUrl);
          apply((list) => [...list, { reference, previewUrl }]);
          setMessage(undefined);
        }
      } catch {
        setMessage("The image could not be attached.");
      } finally {
        inFlight.current = Math.max(0, inFlight.current - 1);
        setBusy(false);
      }
    },
    [apply, client, threadId],
  );

  const remove = useCallback(
    (attachmentId: CodeAttachmentId) => {
      apply((list) => {
        const removed = list.find((entry) => entry.reference.attachmentId === attachmentId);
        if (removed !== undefined) forget(removed.previewUrl);
        return list.filter((entry) => entry.reference.attachmentId !== attachmentId);
      });
      if (threadId === undefined) return;
      void client.discardAttachment(threadId, attachmentId).catch(() => {
        // The chip is gone either way; a host that kept the bytes drops them
        // when the thread is next recovered.
      });
    },
    [apply, client, forget, threadId],
  );

  const detachForSend = useCallback((): ReadonlyArray<StagedCodeAttachment> => {
    const detached = current.current;
    current.current = [];
    setStaged([]);
    setMessage(undefined);
    return detached;
  }, []);

  const restoreDetached = useCallback(
    (attachments: ReadonlyArray<StagedCodeAttachment>): void => {
      if (attachments.length === 0) return;
      apply((list) => {
        const existing = new Set(list.map((entry) => String(entry.reference.attachmentId)));
        return [
          ...attachments.filter((entry) => !existing.has(String(entry.reference.attachmentId))),
          ...list,
        ];
      });
    },
    [apply],
  );

  const commitDetached = useCallback(
    (attachments: ReadonlyArray<StagedCodeAttachment>): void => {
      for (const attachment of attachments) forget(attachment.previewUrl);
    },
    [forget],
  );

  const discardDetached = useCallback(
    (attachments: ReadonlyArray<StagedCodeAttachment>): void => {
      for (const attachment of attachments) {
        forget(attachment.previewUrl);
        if (threadId === undefined) continue;
        void client.discardAttachment(threadId, attachment.reference.attachmentId).catch(() => {
          // A refused message that was superseded must not keep its bytes in the
          // composer; a later host recovery can clean up a failed discard.
        });
      }
    },
    [client, forget, threadId],
  );

  const peekForSend = useCallback(
    (): ReadonlyArray<CodeAttachmentReference> => current.current.map((entry) => entry.reference),
    [],
  );

  const peekAbandoned = useCallback(
    (): boolean => current.current.length > 0 || inFlight.current > 0,
    [],
  );

  const takeForSend = useCallback((): ReadonlyArray<CodeAttachmentReference> => {
    const taken = current.current.map((entry) => entry.reference);
    apply((list) => {
      for (const attachment of list) forget(attachment.previewUrl);
      return [];
    });
    setMessage(undefined);
    return taken;
  }, [apply, forget]);

  return {
    staged,
    message,
    busy,
    attach,
    refuse: setMessage,
    remove,
    detachForSend,
    restoreDetached,
    commitDetached,
    discardDetached,
    peekForSend,
    peekAbandoned,
    takeForSend,
  };
}
