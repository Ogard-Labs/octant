import {
  MAX_WORK_ATTACHMENT_BYTES,
  MAX_WORK_TURN_ATTACHMENTS,
  WORK_ATTACHMENT_MEDIA_TYPES,
} from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clipboardHasImage,
  collectPastedImages,
  pastedImageName,
} from "../../chat/composerImagePaste";

/**
 * Whether the selected model reads images.
 *
 * `undefined` when this renderer cannot tell — an unlisted provider, a model
 * the picker never described. The host decides in that case; the composer
 * does not refuse an attachment on a guess.
 */
export function selectedModelReadsImages(
  groups: ReadonlyArray<PickerGroup>,
  selection: { readonly providerInstanceId?: unknown; readonly modelId?: unknown },
): boolean | undefined {
  if (selection.providerInstanceId === undefined || selection.modelId === undefined) {
    return undefined;
  }
  const model = groups
    .find((candidate) => String(candidate.instance.id) === String(selection.providerInstanceId))
    ?.sections.flatMap((section) => section.models)
    .find((candidate) => String(candidate.model.id) === String(selection.modelId));
  const modalities = model?.model.inputModalities;
  return modalities === undefined ? undefined : modalities.includes("image");
}

export interface StagedWorkImage {
  readonly id: string;
  readonly file: File;
  readonly displayName: string;
  readonly previewUrl: string;
}

export interface WorkComposerImages {
  readonly staged: ReadonlyArray<StagedWorkImage>;
  readonly message: string | undefined;
  readonly attach: (files: ReadonlyArray<File>) => void;
  readonly refuse: (message: string) => void;
  readonly remove: (id: string) => void;
  readonly takeForSend: () => ReadonlyArray<File>;
  readonly filesForSend: () => ReadonlyArray<File>;
  readonly clearAfterAccepted: () => void;
  readonly consumePaste: (clipboard: DataTransfer | null) => boolean;
}

const SUPPORTED = new Set<string>(WORK_ATTACHMENT_MEDIA_TYPES);

/**
 * Images the Work composer is holding until the thread exists.
 *
 * The host stores attachments against a thread id, so a new-thread composer
 * cannot upload until create succeeds. Files stay local; takeForSend hands
 * them to the create path, which stages them on the host before the first
 * turn names their ids. filesForSend leaves the chips in place until
 * clearAfterAccepted, so a failed create or turn can retry the same images.
 */
export function useWorkComposerImages(): WorkComposerImages {
  const [staged, setStaged] = useState<ReadonlyArray<StagedWorkImage>>([]);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const previews = useRef(new Set<string>());
  const current = useRef<ReadonlyArray<StagedWorkImage>>([]);

  const apply = useCallback(
    (next: (list: ReadonlyArray<StagedWorkImage>) => ReadonlyArray<StagedWorkImage>) => {
      current.current = next(current.current);
      setStaged(current.current);
    },
    [],
  );

  const forget = useCallback((previewUrl: string) => {
    if (!previews.current.delete(previewUrl)) return;
    URL.revokeObjectURL(previewUrl);
  }, []);

  useEffect(
    () => () => {
      for (const previewUrl of previews.current) URL.revokeObjectURL(previewUrl);
      previews.current.clear();
    },
    [],
  );

  const attach = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      const images = files.filter((file) => SUPPORTED.has(file.type));
      if (images.length === 0) {
        setMessage("Only PNG, JPEG, WebP, and GIF images can be attached.");
        return;
      }
      for (const file of images) {
        if (file.size === 0 || file.size > MAX_WORK_ATTACHMENT_BYTES) {
          setMessage(`${pastedImageName(file)} is too large to attach.`);
          continue;
        }
        if (current.current.length >= MAX_WORK_TURN_ATTACHMENTS) {
          setMessage(`A turn carries at most ${MAX_WORK_TURN_ATTACHMENTS} images.`);
          break;
        }
        const previewUrl = URL.createObjectURL(file);
        previews.current.add(previewUrl);
        apply((list) => [
          ...list,
          {
            id: globalThis.crypto.randomUUID(),
            file,
            displayName: pastedImageName(file),
            previewUrl,
          },
        ]);
        setMessage(undefined);
      }
    },
    [apply],
  );

  const remove = useCallback(
    (id: string) => {
      apply((list) => {
        const removed = list.find((entry) => entry.id === id);
        if (removed !== undefined) forget(removed.previewUrl);
        return list.filter((entry) => entry.id !== id);
      });
    },
    [apply, forget],
  );

  const filesForSend = useCallback((): ReadonlyArray<File> => {
    return current.current.map((entry) => entry.file);
  }, []);

  const clearAfterAccepted = useCallback(() => {
    apply((list) => {
      for (const attachment of list) forget(attachment.previewUrl);
      return [];
    });
    setMessage(undefined);
  }, [apply, forget]);

  const takeForSend = useCallback((): ReadonlyArray<File> => {
    const taken = filesForSend();
    clearAfterAccepted();
    return taken;
  }, [clearAfterAccepted, filesForSend]);

  const consumePaste = useCallback(
    (clipboard: DataTransfer | null): boolean => {
      if (!clipboardHasImage(clipboard)) return false;
      const selection = collectPastedImages(clipboard, {
        allowedMediaTypes: WORK_ATTACHMENT_MEDIA_TYPES,
        maxBytes: MAX_WORK_ATTACHMENT_BYTES,
      });
      if (selection.files.length === 0 && selection.rejected.length === 0) return false;
      for (const rejection of selection.rejected) {
        setMessage(`${rejection.displayName}: ${rejection.reason}`);
      }
      if (selection.files.length > 0) attach(selection.files);
      return true;
    },
    [attach],
  );

  return {
    staged,
    message,
    attach,
    refuse: setMessage,
    remove,
    takeForSend,
    filesForSend,
    clearAfterAccepted,
    consumePaste,
  };
}
