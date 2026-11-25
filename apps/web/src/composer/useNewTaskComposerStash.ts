import { useContext, type RefObject } from "react";
import type { ComposerInputElement } from "./ComposerInput";
import type { ComposerExtensionSelection } from "./composerExtensionSelection";
import {
  composerStashContextValues,
  type ComposerStashContext,
  type ComposerStashTarget,
  type ComposerStashTodo,
} from "./composerStashDraft";
import { applyComposerCaret, type ComposerDraftMode } from "./composerThreadDraftStore";
import {
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
  type NewTaskCreateFromSelection,
} from "./useNewTaskPrompt";
import type { ComposerStashBinding } from "./useComposerStash";
import type { ThreadMentionChip } from "../chat/ThreadMentionPicker";

export interface ComposerStashSource {
  readonly current: NewTaskCreateFromSelection | undefined;
  readonly change: (source: NewTaskCreateFromSelection | undefined) => void;
}

export interface ComposerStashTodoSource {
  readonly current: ComposerStashTodo | undefined;
  readonly canRestore: (todo: ComposerStashTodo) => boolean;
  readonly change: (todo: ComposerStashTodo | undefined) => void;
  readonly seed?: string | undefined;
}

interface ComposerStashSelection<Value> {
  readonly current: ReadonlyArray<Value>;
  readonly change: (values: ReadonlyArray<Value>) => void;
}

export function useNewTaskComposerStash(options: {
  readonly mode: ComposerDraftMode;
  readonly host: string | undefined;
  readonly projectId: string | undefined;
  readonly prompt: string;
  readonly textarea: RefObject<ComposerInputElement | HTMLInputElement | null>;
  readonly setPrompt: (prompt: string) => void;
  readonly busy: boolean;
  readonly files?:
    | (ComposerStashSelection<File> &
        Pick<ComposerStashTarget, "attachmentLimit" | "attachmentByteLimit" | "readsImages">)
    | undefined;
  readonly threads?: ComposerStashSelection<ThreadMentionChip> | undefined;
  readonly extensions?:
    | (ComposerStashSelection<ComposerExtensionSelection> & {
        readonly scopeKey: string;
      })
    | undefined;
  readonly source?: ComposerStashSource | undefined;
  readonly todo?: ComposerStashTodoSource | undefined;
}): ComposerStashBinding {
  const draftScope = useContext(NewTaskDraftScopeContext);
  const windowId = useContext(NewTaskDraftsContext)?.windowId;
  const parts: ComposerStashContext[] = [
    ...(options.source?.current === undefined
      ? []
      : [{ kind: "create-from" as const, value: options.source.current }]),
    ...(options.todo?.current === undefined
      ? []
      : [{ kind: "todo" as const, value: options.todo.current }]),
    ...(options.threads?.current.map((value) => ({ kind: "thread" as const, value })) ?? []),
    ...(options.extensions?.current.map((value) => ({ kind: "extension" as const, value })) ?? []),
  ];
  return {
    target: {
      location: {
        host: options.host ?? "local",
        mode: options.mode,
        projectId: options.projectId ?? null,
        composerId: draftScope ?? options.mode,
        threadId: null,
        windowId,
        extensionScope: options.extensions?.scopeKey,
      },
      todoSeed: options.todo?.seed,
      attachmentLimit: options.files?.attachmentLimit ?? 0,
      attachmentByteLimit: options.files?.attachmentByteLimit ?? 0,
      readsImages: options.files?.readsImages ?? false,
      context: [
        ...(options.source === undefined ? [] : ["create-from" as const]),
        ...(options.todo === undefined ? [] : ["todo" as const]),
        ...(options.threads === undefined ? [] : ["thread" as const]),
        ...(options.extensions === undefined ? [] : ["extension" as const]),
      ],
    },
    draft: {
      text: options.prompt,
      caret: options.textarea.current?.selectionStart ?? options.prompt.length,
      files: options.files?.current ?? [],
      context: parts,
    },
    readCaret: () => options.textarea.current?.selectionStart ?? undefined,
    unavailable: options.busy
      ? "Wait for the current composer action before moving the draft."
      : undefined,
    prepare: (draft) => {
      const todo = composerStashContextValues(draft, "todo")[0];
      if (todo !== undefined && options.todo?.canRestore(todo) !== true) {
        return {
          kind: "refused",
          reason: "Open the original to-do list and make sure the to-do is still open.",
        };
      }
      return {
        kind: "ready",
        apply: () => {
          options.files?.change(draft.files);
          options.threads?.change(composerStashContextValues(draft, "thread"));
          options.extensions?.change(composerStashContextValues(draft, "extension"));
          options.source?.change(composerStashContextValues(draft, "create-from")[0]);
          if (todo !== options.todo?.current) options.todo?.change(todo);
          options.setPrompt(draft.text);
          window.requestAnimationFrame(() =>
            applyComposerCaret(options.textarea.current, draft.caret, draft.text.length),
          );
        },
      };
    },
  };
}
