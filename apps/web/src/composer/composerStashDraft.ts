import type { CanvasContextSelection } from "@octant/contracts/canvasContext";
import type { CodeReviewFindingReference } from "@octant/contracts/code-operations";
import type { PreviewContextSelection } from "@octant/contracts/previews";
import type { SideChatDraftReturnReference } from "@octant/contracts/side-chat-return";
import type { ThreadMentionChip } from "../chat/ThreadMentionPicker";
import type { TranscriptQuoteChip } from "../chat/quoteSelection";
import { isImageAttachment } from "./attachmentMediaType";
import type { ComposerExtensionSelection } from "./composerExtensionSelection";
import type { ComposerDraftMode } from "./composerThreadDraftStore";
import type { NewTaskCreateFromSelection } from "./useNewTaskPrompt";

export interface ComposerStashLocation {
  readonly host: string;
  readonly mode: ComposerDraftMode;
  readonly projectId: string | null;
  readonly composerId: string;
  readonly threadId: string | null;
}

interface ComposerStashContextValue {
  readonly thread: ThreadMentionChip;
  readonly file: string;
  readonly extension: ComposerExtensionSelection;
  readonly quote: TranscriptQuoteChip;
  readonly preview: PreviewContextSelection;
  readonly canvas: CanvasContextSelection;
  readonly "side-chat": SideChatDraftReturnReference | null;
  readonly review: CodeReviewFindingReference | null;
  readonly "create-from": NewTaskCreateFromSelection;
  readonly continuation: "text-only";
}

export type ComposerStashContext = {
  [Kind in keyof ComposerStashContextValue]: {
    readonly kind: Kind;
    readonly value: ComposerStashContextValue[Kind];
  };
}[keyof ComposerStashContextValue];

export interface ComposerStashDraft {
  readonly text: string;
  readonly caret: number;
  readonly files: ReadonlyArray<File>;
  readonly context: ReadonlyArray<ComposerStashContext>;
}

export interface ComposerStashTarget {
  readonly location: ComposerStashLocation;
  readonly attachmentLimit: number;
  readonly attachmentByteLimit: number;
  readonly readsImages: boolean;
  readonly context: ReadonlyArray<ComposerStashContext["kind"]>;
}

export type ComposerStashRestorePlan =
  | { readonly kind: "ready"; readonly draft: ComposerStashDraft }
  | { readonly kind: "refused"; readonly reason: string };

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
  continuation: "A continuation choice",
};

export function composerStashLocationKey(location: ComposerStashLocation): string {
  return JSON.stringify([
    location.host,
    location.mode,
    location.projectId,
    location.composerId,
    location.threadId,
  ]);
}

export function emptyComposerStashDraft(): ComposerStashDraft {
  return { text: "", caret: 0, files: [], context: [] };
}

export function hasComposerStashContent(draft: ComposerStashDraft): boolean {
  return draft.text.trim().length > 0 || draft.files.length > 0 || draft.context.length > 0;
}

export function composerStashContextValues<Kind extends keyof ComposerStashContextValue>(
  draft: ComposerStashDraft,
  kind: Kind,
): ReadonlyArray<ComposerStashContextValue[Kind]> {
  return draft.context.flatMap((part) =>
    part.kind === kind ? [part.value as ComposerStashContextValue[Kind]] : [],
  );
}

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
  for (const part of saved.context) {
    const label = CONTEXT_LABELS[part.kind];
    const canMoveThreadMention =
      part.kind === "thread" && origin.projectId === destination.projectId;
    if (!sameComposer && !canMoveThreadMention) {
      return { kind: "refused", reason: `${label} needs its original composer.` };
    }
    if (!target.context.includes(part.kind)) {
      return { kind: "refused", reason: `${label} is unavailable in this composer.` };
    }
    if (
      (part.kind === "create-from" || part.kind === "continuation") &&
      current.context.some((value) => value.kind === part.kind)
    ) {
      return { kind: "refused", reason: `${label} is already present in this composer.` };
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

  const separator = current.text !== "" && saved.text !== "" ? "\n\n" : "";
  return {
    kind: "ready",
    draft: {
      text: current.text + separator + saved.text,
      caret:
        saved.text === "" ? current.caret : current.text.length + separator.length + saved.caret,
      files: [...current.files, ...saved.files],
      context: [...current.context, ...saved.context],
    },
  };
}
