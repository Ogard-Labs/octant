import type { CanvasContextSelection } from "@octant/contracts/canvasContext";
import type { CodeReviewFindingReference } from "@octant/contracts/code-operations";
import type { PreviewContextSelection } from "@octant/contracts/previews";
import type { SideChatDraftReturnReference } from "@octant/contracts/side-chat-return";
import type { ThreadMentionChip } from "../chat/ThreadMentionPicker";
import type { TranscriptQuoteChip } from "../chat/quoteSelection";
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
  readonly windowId?: string | undefined;
  readonly extensionScope?: string | undefined;
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
  /**
   * The person's own input left this text in the composer it was taken from.
   * It travels with the draft, so a draft put aside and taken up again (or
   * moved to another composer) is still the person's own words.
   */
  readonly typed?: true;
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
  readonly todoSeed?: string | undefined;
}

export type ComposerStashRestorePlan =
  | { readonly kind: "ready"; readonly draft: ComposerStashDraft }
  | { readonly kind: "refused"; readonly reason: string };

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

export function composerStashRecoveryKey(location: ComposerStashLocation): string {
  if (location.threadId !== null) return composerStashLocationKey(location);
  // A new-task pane retains its prompt and files when its target Project changes.
  return JSON.stringify([
    location.host,
    location.mode,
    location.windowId ?? null,
    location.composerId,
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
