import { MAX_FILE_MENTIONS_PER_TURN, MAX_THREAD_MENTIONS_PER_TURN } from "@octant/contracts";
import {
  MAX_CHAT_TURN_CANVAS_SELECTIONS,
  type CanvasContextSelection,
} from "@octant/contracts/canvasContext";
import { MAX_CHAT_TURN_PREVIEW_SELECTIONS } from "@octant/contracts/chat";
import {
  MAX_CODE_REVIEW_CORRECTION_FINDINGS,
  type CodeReviewFindingReference,
} from "@octant/contracts/code-operations";
import type { PreviewContextSelection } from "@octant/contracts/previews";
import {
  MAX_SIDE_CHAT_DRAFT_RETURNS,
  type SideChatDraftReturnReference,
} from "@octant/contracts/side-chat-return";
import type { ThreadMentionChip } from "../chat/ThreadMentionPicker";
import type { TranscriptQuoteChip } from "../chat/quoteSelection";
import { isImageAttachment } from "./attachmentMediaType";
import type { ComposerExtensionSelection } from "./composerExtensionSelection";
import type { ComposerDraftMode, ComposerThreadDraft } from "./composerThreadDraftStore";
import type { NewTaskCreateFromSelection } from "./useNewTaskPrompt";

export interface ComposerStashLocation {
  readonly host: string;
  readonly mode: ComposerDraftMode;
  readonly projectId: string | null;
  readonly composerId: string;
  readonly threadId: string | null;
  readonly binding?: string | null;
}

export interface ComposerStashTodo {
  readonly todoId: string;
  readonly title: string;
  readonly listHostId: string;
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
  readonly todo: ComposerStashTodo;
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

export function composerStashLocationKey(location: ComposerStashLocation): string {
  return JSON.stringify([
    location.host,
    location.mode,
    location.projectId,
    location.composerId,
    location.threadId,
    location.binding ?? null,
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

export function recoveredComposerThreadDraft(draft: ComposerStashDraft): ComposerThreadDraft {
  const returns = composerStashContextValues(draft, "side-chat");
  const findings = composerStashContextValues(draft, "review");
  return {
    text: draft.text,
    caretIndex: draft.caret,
    stagedDropped: false,
    sideChatReturns: returns.filter((value) => value !== null),
    ...(returns.includes(null) ? { sideChatReturnsInvalid: true } : {}),
    reviewFindingReferences: findings.filter((value) => value !== null),
    ...(findings.includes(null) ? { reviewFindingReferencesInvalid: true } : {}),
  };
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
  const sameNewTaskScope =
    origin.threadId === null &&
    destination.threadId === null &&
    origin.mode === destination.mode &&
    origin.projectId === destination.projectId;
  const context = [...current.context, ...saved.context];
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

  const separator = current.text !== "" && saved.text !== "" ? "\n\n" : "";
  return {
    kind: "ready",
    draft: {
      text: current.text + separator + saved.text,
      caret:
        saved.text === "" ? current.caret : current.text.length + separator.length + saved.caret,
      files: [...current.files, ...saved.files],
      context,
    },
  };
}
