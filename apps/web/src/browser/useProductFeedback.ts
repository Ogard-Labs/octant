import {
  createProductFeedbackClient,
  ProductFeedbackClientFailure,
  type ProductFeedbackClient,
} from "@octant/client-runtime/product-feedback-client";
import {
  decodeProductFeedbackCommand,
  type ProductFeedbackCommand,
  type ProductFeedbackNote,
  type ProductFeedbackPreview,
  type ProductFeedbackRefusalReason,
} from "@octant/contracts/product-feedback";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ProductFeedbackOptions {
  readonly threadId: string | undefined;
  readonly mode: "chat" | "work" | "code";
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly client?: ProductFeedbackClient;
}

export interface ProductFeedback {
  readonly pending: ReadonlyArray<ProductFeedbackNote>;
  readonly crops: Readonly<Record<string, string>>;
  readonly preview: ProductFeedbackPreview | undefined;
  readonly previewExpired: boolean;
  readonly available: boolean;
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly prepare: (input: {
    readonly contextId: string;
    readonly point: { readonly x: number; readonly y: number };
    readonly selectionId?: string;
    readonly expectedObservationRevision?: number;
  }) => Promise<boolean>;
  readonly commit: (comment: string) => Promise<boolean>;
  readonly cancel: () => Promise<void>;
  readonly update: (
    note: ProductFeedbackNote,
    change: { readonly comment?: string; readonly included?: boolean },
  ) => Promise<boolean>;
  readonly discard: (note: ProductFeedbackNote) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly pauseRefresh: (paused: boolean) => void;
  readonly cancelPrepare: () => void;
}

const EMPTY_NOTES: ReadonlyArray<ProductFeedbackNote> = Object.freeze([]);
const EMPTY_CROPS: Readonly<Record<string, string>> = Object.freeze({});
const refusalText: Record<ProductFeedbackRefusalReason, string> = {
  "thread-unavailable":
    "This task or its original local authority is no longer available. Reconnect and refresh notes.",
  "surface-unavailable":
    "The host cannot read this page right now. Finish sign-in or choose the element again.",
  "element-unavailable": "There is no supported element at that spot. Choose another element.",
  "capture-unavailable":
    "The host could not keep this capture. Your comment stays here; choose the element again.",
  "note-limit-reached": "Send or remove pending notes before leaving more.",
  "preview-limit-reached":
    "The host's preview limit is reached. Cancel an unused preview or wait for it to expire.",
  "preview-expired": "This preview expired. Your comment stays here; choose the element again.",
};

type Owner = {
  readonly client: ProductFeedbackClient | undefined;
  readonly threadId: string | undefined;
  readonly mode: ProductFeedbackOptions["mode"];
};
interface View {
  readonly owner: Owner;
  readonly notes: ReadonlyArray<ProductFeedbackNote>;
  readonly crops: Readonly<Record<string, string>>;
  readonly cropRefs: Readonly<Record<string, string>>;
  readonly preview: ProductFeedbackPreview | undefined;
  readonly previewExpired: boolean;
  readonly busy: boolean;
  readonly message: string | undefined;
}
const empty = (owner: Owner): View => ({
  owner,
  notes: EMPTY_NOTES,
  crops: EMPTY_CROPS,
  cropRefs: EMPTY_CROPS,
  preview: undefined,
  previewExpired: false,
  busy: false,
  message: undefined,
});

/** Host-resolved evidence only. Commands never contain caller-authored element data. */
export function useProductFeedback(options: ProductFeedbackOptions): ProductFeedback {
  const client = useMemo(() => {
    if (options.client !== undefined) return options.client;
    if (
      options.mode === "chat" ||
      options.serverUrl === undefined ||
      options.windowCapability === undefined
    )
      return undefined;
    try {
      return createProductFeedbackClient({
        baseUrl: options.serverUrl,
        windowCapability: options.windowCapability,
        fetch: globalThis.fetch,
      });
    } catch {
      return undefined;
    }
  }, [options.client, options.mode, options.serverUrl, options.windowCapability]);
  const owner = useMemo<Owner>(
    () => ({ client, threadId: options.threadId, mode: options.mode }),
    [client, options.threadId, options.mode],
  );
  const lifetime = useMemo(() => ({ current: new AbortController() }), [owner]);
  const latestOwner = useRef(owner);
  latestOwner.current = owner;
  const [state, setState] = useState(() => empty(owner));
  const stateRef = useRef(state);
  stateRef.current = state;
  const previewHolder = useMemo<{ current: ProductFeedbackPreview | undefined }>(
    () => ({ current: undefined }),
    [owner],
  );
  const operation = useRef<
    | { owner: Owner; abort: AbortController; foreground: boolean; kind: "prepare" | "command" }
    | undefined
  >(undefined);
  const refreshPaused = useMemo(() => ({ current: false }), [owner]);
  const current = useCallback(
    (signal?: AbortSignal) =>
      latestOwner.current === owner && !lifetime.current.signal.aborted && signal?.aborted !== true,
    [owner, lifetime],
  );
  const patch = useCallback(
    (change: Partial<Omit<View, "owner">>) => {
      if (!current()) return;
      setState((previous) => ({
        ...(previous.owner === owner ? previous : empty(owner)),
        ...change,
        owner,
      }));
    },
    [owner, current],
  );

  useEffect(() => {
    const active = new AbortController();
    lifetime.current = active;
    return () => {
      active.abort();
      if (operation.current?.owner === owner) {
        operation.current.abort.abort();
        operation.current = undefined;
      }
      const preview = previewHolder.current;
      if (preview !== undefined && owner.client !== undefined && owner.threadId !== undefined)
        void owner.client
          .execute(
            decodeProductFeedbackCommand({
              kind: "cancel-product-feedback-preview",
              previewId: preview.id,
              threadId: owner.threadId,
            }),
            AbortSignal.timeout(2_000),
          )
          .catch(() => undefined);
    };
  }, [owner, lifetime, previewHolder]);

  const perform = useCallback(
    async (
      work: (signal: AbortSignal) => Promise<boolean>,
      foreground = true,
      kind: "prepare" | "command" = "command",
    ): Promise<boolean> => {
      if (
        owner.client === undefined ||
        owner.threadId === undefined ||
        owner.mode === "chat" ||
        !current()
      )
        return false;
      if (!foreground && refreshPaused.current) return false;
      const previous = operation.current;
      if (previous?.owner === owner && previous.foreground) return false;
      if (previous?.owner === owner && !foreground) return false;
      previous?.abort.abort();
      const abort = new AbortController();
      operation.current = { owner, abort, foreground, kind };
      const signal = AbortSignal.any([abort.signal, lifetime.current.signal]);
      if (foreground) patch({ busy: true, message: undefined });
      try {
        return await work(signal);
      } catch (error) {
        if (current(signal)) {
          const unauthorized =
            error instanceof ProductFeedbackClientFailure &&
            (error.status === 401 || error.status === 403);
          if (unauthorized) {
            previewHolder.current = undefined;
            patch({
              notes: EMPTY_NOTES,
              crops: EMPTY_CROPS,
              preview: undefined,
              previewExpired: true,
            });
          }
          patch({
            message:
              error instanceof Error
                ? error.message
                : "Feedback is unavailable. Refresh notes before retrying.",
          });
        }
        return false;
      } finally {
        if (operation.current?.abort === abort) {
          operation.current = undefined;
          if (foreground) patch({ busy: false });
        }
      }
    },
    [owner, current, lifetime, patch, previewHolder, refreshPaused],
  );

  const load = useCallback(
    async (signal: AbortSignal): Promise<boolean> => {
      if (owner.client === undefined || owner.threadId === undefined) return false;
      const pending = (await owner.client.list(owner.threadId, signal)).filter(
        (note) => note.lifecycle === "pending",
      );
      if (!current(signal)) return false;
      if (pending.some((note) => note.threadId !== owner.threadId || note.mode !== owner.mode))
        throw new Error("The host returned notes for a different task. Refresh before continuing.");
      const previous = stateRef.current.owner === owner ? stateRef.current : empty(owner);
      const images = await Promise.all(
        pending.map(async (note) => {
          const reference =
            note.crop === undefined ? undefined : `${note.crop.contentId}:${note.crop.digest}`;
          if (reference === undefined) return undefined;
          const cached =
            previous.cropRefs[String(note.id)] === reference
              ? previous.crops[String(note.id)]
              : undefined;
          const data =
            cached ??
            (await owner.client?.readCrop(String(note.id), signal).catch(() => undefined));
          return data === undefined ? undefined : { id: String(note.id), reference, data };
        }),
      );
      if (!current(signal)) return false;
      const same =
        pending.length === previous.notes.length &&
        pending.every(
          (note, index) =>
            note.id === previous.notes[index]?.id &&
            note.version === previous.notes[index]?.version,
        );
      const crops: Record<string, string> = {},
        cropRefs: Record<string, string> = {};
      for (const image of images)
        if (image !== undefined) {
          crops[image.id] = image.data;
          cropRefs[image.id] = image.reference;
        }
      const sameImages =
        Object.keys(crops).length === Object.keys(previous.crops).length &&
        images.every(
          (image) =>
            image === undefined ||
            (previous.crops[image.id] === image.data &&
              previous.cropRefs[image.id] === image.reference),
        );
      patch({
        notes: pending.length === 0 ? EMPTY_NOTES : same ? previous.notes : pending,
        crops: sameImages ? previous.crops : crops,
        cropRefs: sameImages ? previous.cropRefs : cropRefs,
        ...(same ? {} : { message: undefined }),
      });
      return true;
    },
    [owner, current, patch],
  );
  const refresh = useCallback(async () => {
    await perform(load);
  }, [perform, load]);
  useEffect(() => {
    void perform(load, false);
    const timer = setInterval(() => void perform(load, false), 5_000);
    return () => clearInterval(timer);
  }, [owner, perform, load]);

  const pauseRefresh = useCallback(
    (paused: boolean) => {
      if (!current()) return;
      refreshPaused.current = paused;
      if (paused) {
        if (operation.current?.owner === owner && !operation.current.foreground)
          operation.current.abort.abort();
        patch({ message: undefined });
      }
    },
    [owner, current, refreshPaused, patch],
  );
  const cancelPrepare = useCallback(() => {
    const active = operation.current;
    if (active?.owner === owner && active.kind === "prepare") {
      active.abort.abort();
      operation.current = undefined;
      patch({ busy: false });
    }
  }, [owner, patch]);

  const accept = useCallback(
    (result: Awaited<ReturnType<ProductFeedbackClient["execute"]>>): boolean => {
      if (result.kind === "feedback-refused") {
        patch({
          message: refusalText[result.reason],
          ...(result.reason === "preview-expired" || result.reason === "thread-unavailable"
            ? { previewExpired: true }
            : {}),
        });
        return false;
      }
      if (
        result.kind !== "feedback-captured" &&
        result.kind !== "feedback-updated" &&
        result.kind !== "feedback-discarded"
      )
        throw new Error("The host returned an unexpected feedback result. Refresh notes.");
      if (result.note.threadId !== owner.threadId || result.note.mode !== owner.mode)
        throw new Error(
          "The host returned a note for a different task. Refresh before continuing.",
        );
      const previous = stateRef.current.owner === owner ? stateRef.current : empty(owner);
      const found = previous.notes.some((note) => note.id === result.note.id);
      const notes = (
        found
          ? previous.notes.map((note) => (note.id === result.note.id ? result.note : note))
          : [...previous.notes, result.note]
      ).filter((note) => note.lifecycle === "pending");
      patch({ notes: notes.length === 0 ? EMPTY_NOTES : notes, message: undefined });
      return true;
    },
    [owner, patch],
  );
  const mutate = useCallback(
    (command: ProductFeedbackCommand) =>
      perform(async (signal) => {
        const result = await owner.client?.execute(command, signal);
        if (!current(signal) || result === undefined) return false;
        if (
          result.kind !== "feedback-refused" &&
          (command.kind === "update-product-feedback"
            ? result.kind !== "feedback-updated"
            : result.kind !== "feedback-discarded")
        )
          throw new Error("The host did not confirm the note change. Refresh notes.");
        return accept(result);
      }),
    [owner, perform, current, accept],
  );

  const prepare = useCallback(
    (input: Parameters<ProductFeedback["prepare"]>[0]) =>
      perform(
        async (signal) => {
          const previous = previewHolder.current;
          if (previous !== undefined) {
            await owner.client?.execute(
              decodeProductFeedbackCommand({
                kind: "cancel-product-feedback-preview",
                previewId: previous.id,
                threadId: owner.threadId,
              }),
              signal,
            );
            if (!current(signal)) return false;
            patch({ previewExpired: true });
          }
          const result = await owner.client?.execute(
            decodeProductFeedbackCommand({
              kind: "prepare-product-feedback",
              threadId: owner.threadId,
              ...input,
            }),
            signal,
          );
          if (!current(signal) || result === undefined) return false;
          if (result.kind === "feedback-refused") {
            patch({ message: refusalText[result.reason] });
            return false;
          }
          if (result.kind !== "feedback-prepared")
            throw new Error("The host did not return an element preview.");
          if (result.preview.threadId !== owner.threadId || result.preview.mode !== owner.mode)
            throw new Error(
              "The host returned evidence for a different task. Refresh before continuing.",
            );
          previewHolder.current = result.preview;
          patch({ preview: result.preview, previewExpired: false, message: undefined });
          return true;
        },
        true,
        "prepare",
      ),
    [owner, previewHolder, perform, current, patch],
  );
  const commit = useCallback(
    (comment: string) =>
      perform(async (signal) => {
        const preview = previewHolder.current;
        if (preview === undefined) {
          patch({ message: "Choose an element and inspect its preview first." });
          return false;
        }
        const result = await owner.client?.execute(
          decodeProductFeedbackCommand({
            kind: "commit-product-feedback",
            previewId: preview.id,
            threadId: owner.threadId,
            comment,
          }),
          signal,
        );
        if (
          current(signal) &&
          result !== undefined &&
          result.kind !== "feedback-captured" &&
          result.kind !== "feedback-refused"
        )
          throw new Error(
            "The host did not confirm the captured note. Refresh notes before retrying.",
          );
        if (!current(signal) || result === undefined || !accept(result)) return false;
        previewHolder.current = undefined;
        patch({ preview: undefined, previewExpired: false });
        return true;
      }),
    [owner, previewHolder, perform, current, patch, accept],
  );
  const cancel = useCallback(async () => {
    if (!current()) return;
    const preview = previewHolder.current;
    previewHolder.current = undefined;
    patch({ preview: undefined, previewExpired: false, message: undefined });
    await perform(async (signal) => {
      if (preview !== undefined)
        await owner.client?.execute(
          decodeProductFeedbackCommand({
            kind: "cancel-product-feedback-preview",
            previewId: preview.id,
            threadId: owner.threadId,
          }),
          signal,
        );
      return current(signal);
    });
  }, [owner, previewHolder, perform, current, patch]);
  const update = useCallback(
    (note: ProductFeedbackNote, change: Parameters<ProductFeedback["update"]>[1]) => {
      if (note.threadId !== owner.threadId || note.mode !== owner.mode) {
        patch({ message: "This note belongs to a different task. Refresh notes." });
        return Promise.resolve(false);
      }
      return mutate(
        decodeProductFeedbackCommand({
          kind: "update-product-feedback",
          noteId: note.id,
          expectedVersion: note.version,
          ...change,
        }),
      );
    },
    [owner, mutate, patch],
  );
  const discard = useCallback(
    async (note: ProductFeedbackNote) => {
      if (note.threadId !== owner.threadId || note.mode !== owner.mode) {
        patch({ message: "This note belongs to a different task. Refresh notes." });
        return;
      }
      await mutate({
        kind: "discard-product-feedback",
        noteId: note.id,
        expectedVersion: note.version,
      });
    },
    [owner, mutate, patch],
  );

  const view = state.owner === owner ? state : empty(owner);
  return {
    pending: view.notes,
    crops: view.crops,
    preview: view.preview,
    previewExpired: view.previewExpired,
    available: client !== undefined && owner.threadId !== undefined && owner.mode !== "chat",
    busy: view.busy,
    message: view.message,
    prepare,
    commit,
    cancel,
    update,
    discard,
    refresh,
    pauseRefresh,
    cancelPrepare,
  };
}
