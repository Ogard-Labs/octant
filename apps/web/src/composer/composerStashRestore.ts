import { MAX_FILE_MENTIONS_PER_TURN, MAX_THREAD_MENTIONS_PER_TURN } from "@octant/contracts";
import { MAX_CHAT_TURN_CANVAS_SELECTIONS } from "@octant/contracts/canvasContext";
import { MAX_CHAT_TURN_PREVIEW_SELECTIONS } from "@octant/contracts/chat";
import { MAX_CODE_REVIEW_CORRECTION_FINDINGS } from "@octant/contracts/code-operations";
import { MAX_SIDE_CHAT_DRAFT_RETURNS } from "@octant/contracts/side-chat-return";
import { isImageAttachment } from "./attachmentMediaType";
import {
  composerStashContextValues,
  composerStashLocationKey,
  type ComposerStashContext,
  type ComposerStashDraft,
  type ComposerStashLocation,
  type ComposerStashRestorePlan,
  type ComposerStashTarget,
} from "./composerStashDraft";

const CONTEXT_LABELS: Record<ComposerStashContext["kind"], string> = {
  thread: "A thread mention",
  file: "A file mention",
  extension: "An extension selection",
  quote: "A quoted reply",
  preview: "A browser selection",
  canvas: "A Canvas selection",
  "side-chat": "A returned Side Chat reply",
  review: "A review finding",
  "create-from": "A source selection",
  todo: "A to-do link",
  continuation: "A continuation choice",
};

const CONTEXT_LIMITS: Partial<Record<ComposerStashContext["kind"], number>> = {
  thread: MAX_THREAD_MENTIONS_PER_TURN,
  file: MAX_FILE_MENTIONS_PER_TURN,
  extension: 32,
  preview: MAX_CHAT_TURN_PREVIEW_SELECTIONS,
  canvas: MAX_CHAT_TURN_CANVAS_SELECTIONS,
  "side-chat": MAX_SIDE_CHAT_DRAFT_RETURNS,
  review: MAX_CODE_REVIEW_CORRECTION_FINDINGS,
  "create-from": 1,
  todo: 1,
  continuation: 1,
};

export function planComposerStashRestore(
  origin: ComposerStashLocation,
  target: ComposerStashTarget,
  current: ComposerStashDraft,
  saved: ComposerStashDraft,
): ComposerStashRestorePlan {
  const destination = target.location;
  if (origin.host !== destination.host) {
    return { kind: "refused", reason: "Open a composer on the draft's original computer." };
  }

  const sameComposer = composerStashLocationKey(origin) === composerStashLocationKey(destination);
  const sameNewTaskScope =
    origin.threadId === null &&
    destination.threadId === null &&
    origin.mode === destination.mode &&
    origin.projectId === destination.projectId;
  const currentTodo = composerStashContextValues(current, "todo")[0];
  const savedTodo = composerStashContextValues(saved, "todo")[0];
  const sameTodo =
    currentTodo !== undefined &&
    savedTodo !== undefined &&
    currentTodo.todoId === savedTodo.todoId &&
    currentTodo.listHostId === savedTodo.listHostId;
  const context = [
    ...current.context,
    ...saved.context.filter((part) => part.kind !== "todo" || !sameTodo),
  ];
  const checked = new Set<ComposerStashContext["kind"]>();
  for (const part of saved.context) {
    if (checked.has(part.kind)) continue;
    checked.add(part.kind);
    const label = CONTEXT_LABELS[part.kind];
    const canMoveThreadMention =
      part.kind === "thread" && origin.projectId === destination.projectId;
    const canMoveNewTaskSelection =
      sameNewTaskScope &&
      (part.kind === "extension" || part.kind === "create-from" || part.kind === "todo");
    if (!sameComposer && !canMoveThreadMention && !canMoveNewTaskSelection) {
      return { kind: "refused", reason: `${label} needs its original composer.` };
    }
    if (!target.context.includes(part.kind)) {
      return { kind: "refused", reason: `${label} is unavailable in this composer.` };
    }
    if (part.kind === "extension" && origin.extensionScope !== destination.extensionScope) {
      return {
        kind: "refused",
        reason: "Choose the original provider and Project to restore the extension selection.",
      };
    }
    const limit = CONTEXT_LIMITS[part.kind];
    if (limit !== undefined && context.filter((value) => value.kind === part.kind).length > limit) {
      const name = label.toLowerCase();
      return {
        kind: "refused",
        reason: `Remove ${name} before restoring this draft. This composer can hold ${limit}.`,
      };
    }
  }

  if (saved.files.length > 0 && target.attachmentLimit === 0) {
    return {
      kind: "refused",
      reason: "Use a composer that accepts attachments to restore this draft.",
    };
  }
  if (current.files.length + saved.files.length > target.attachmentLimit) {
    const count = target.attachmentLimit;
    return {
      kind: "refused",
      reason: `This composer can hold ${count} attachment${count === 1 ? "" : "s"}. Remove an attachment before restoring.`,
    };
  }
  for (const file of saved.files) {
    if (file.size > target.attachmentByteLimit) {
      return { kind: "refused", reason: `${file.name} is too large for this composer.` };
    }
    if (!target.readsImages && isImageAttachment(file)) {
      return {
        kind: "refused",
        reason: `Choose a model that reads images to restore ${file.name}.`,
      };
    }
  }

  const starter = sameTodo && current.text === target.todoSeed ? "" : current.text;
  const separator = starter !== "" && saved.text !== "" ? "\n\n" : "";
  return {
    kind: "ready",
    draft: {
      text: starter + separator + saved.text,
      caret:
        saved.text === "" && starter !== ""
          ? current.caret
          : starter.length + separator.length + saved.caret,
      files: [...current.files, ...saved.files],
      context,
    },
  };
}
