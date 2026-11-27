import {
  rememberResultQuotePlaces,
  resultQuotePlaces,
  stashResultQuotePlaces,
  takeStashedResultQuotePlaces,
} from "./resultQuoteDraft";
import {
  composerTextWasTyped,
  noteTypedComposerText,
} from "@octant/client-runtime/typed-composer-text";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  composerStashLocationKey,
  composerStashRecoveryKey,
  emptyComposerStashDraft,
  hasComposerStashContent,
  type ComposerStashDraft,
  type ComposerStashLocation,
  type ComposerStashTarget,
} from "./composerStashDraft";
import { planComposerStashRecovery, planComposerStashRestore } from "./composerStashRestore";
import {
  createComposerStashStore,
  type ComposerDraftRecovery,
  type ComposerStashStore,
  type SavedComposerDraft,
} from "./composerStashStore";

export type PreparedComposerStash =
  | {
      readonly kind: "ready";
      readonly apply: () => void;
      readonly release?: () => void;
    }
  | { readonly kind: "refused"; readonly reason: string };

export interface ComposerStashBinding {
  /**
   * The draft scope the composer notes the person's typing under. A stash keeps
   * that note with the draft it moves, and a restore brings it back, so a draft
   * the person typed is still theirs after it was put aside and taken up again.
   */
  readonly typedScope?: string | undefined;
  readonly target: ComposerStashTarget;
  readonly draft: ComposerStashDraft;
  readonly readCaret?: () => number | undefined;
  readonly unavailable?: string | undefined;
  readonly submission?: RefObject<ComposerStashSubmission | undefined>;
  readonly prepare: (
    draft: ComposerStashDraft,
    current: ComposerStashDraft,
  ) => PreparedComposerStash | Promise<PreparedComposerStash>;
}

export type ComposerStashSubmission = () => (() => void) | undefined;

function canReadDraftStorage(): ComposerStashStore | undefined {
  try {
    return globalThis.indexedDB === undefined ? undefined : createComposerStashStore(indexedDB);
  } catch {
    return undefined;
  }
}

/** The draft with its note that the person typed it, as its composer holds that now. */
function withTypedNote(draft: ComposerStashDraft, scope: string | undefined): ComposerStashDraft {
  const { typed: _earlier, ...rest } = draft;
  return scope !== undefined && composerTextWasTyped(scope, draft.text)
    ? { ...rest, typed: true }
    : rest;
}

/** A draft about to be shown again is the person's own words again, if it was when it left. */
function restoreTypedNote(draft: ComposerStashDraft, scope: string | undefined): void {
  if (scope !== undefined && draft.typed === true) noteTypedComposerText(scope, draft.text);
}

function sameDraft(left: ComposerStashDraft, right: ComposerStashDraft): boolean {
  return (
    left.text === right.text &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => file === right.files[index]) &&
    JSON.stringify(left.context) === JSON.stringify(right.context)
  );
}

function sameScope(left: ComposerStashLocation, right: ComposerStashLocation): boolean {
  return (
    composerStashLocationKey(left) === composerStashLocationKey(right) &&
    left.extensionScope === right.extensionScope
  );
}

function canRecoverContext(record: ComposerDraftRecovery, target: ComposerStashTarget): boolean {
  return (
    sameScope(record.location, target.location) ||
    planComposerStashRestore(record.location, target, emptyComposerStashDraft(), {
      ...record.draft,
      files: [],
    }).kind === "ready"
  );
}

type ComposerStashNotice = {
  readonly text: string;
  readonly tone: "success" | "warning";
};

export function useComposerStash(
  binding: ComposerStashBinding,
  reconcilePurges?: () => Promise<void>,
) {
  const [store] = useState(canReadDraftStorage);
  const [notice, setNotice] = useState<ComposerStashNotice>();
  const [entries, setEntries] = useState<ReadonlyArray<SavedComposerDraft>>();
  const [busy, setBusy] = useState(store !== undefined);
  const latest = useRef(binding);
  latest.current = binding;
  const recovery = useRef<ComposerDraftRecovery | undefined>(undefined);
  const recoveryApplied = useRef(true);
  const mounted = useRef(true);
  const moving = useRef(false);
  const hydrated = useRef(false);
  const hydration = useRef<Promise<void> | undefined>(undefined);
  const write = useRef(Promise.resolve());
  const locationKey = composerStashRecoveryKey(binding.target.location);
  const scopeKey = composerStashLocationKey(binding.target.location);
  const extensionScope = binding.target.location.extensionScope;

  function report(text: string, tone: ComposerStashNotice["tone"] = "warning") {
    if (mounted.current) setNotice({ text, tone });
  }

  useEffect(() => {
    mounted.current = true;
    let observing = true;
    if (store === undefined) return;
    if (hydrated.current && recoveryApplied.current) {
      return () => {
        mounted.current = false;
      };
    }
    moving.current = true;
    setBusy(true);
    const initial = latest.current;
    const hydrate = async () => {
      const record = await store.readRecovery(initial.target.location);
      if (!observing) return;
      hydrated.current = true;
      if (record === undefined) return;
      recovery.current = record;
      recoveryApplied.current = false;
      const current = latest.current;
      if (
        !hasComposerStashContent(record.draft) &&
        (record.beforeText === "" || initial.draft.text !== record.beforeText)
      ) {
        recoveryApplied.current = true;
        return;
      }
      if (!sameDraft(current.draft, initial.draft)) {
        report("A restored draft is saved on this client. Reopen the composer to recover it.");
        return;
      }
      // An already populated pane owns its newer files. Reopening a surface such
      // as Settings can remount the controls without remounting that live draft.
      if (current.draft.files.length > 0) {
        recoveryApplied.current = true;
        return;
      }
      const plan = planComposerStashRecovery(record, current.target, current.draft);
      if (plan.kind === "refused") {
        report(plan.reason);
        return;
      }
      const { draft } = plan;
      if (sameDraft(draft, initial.draft)) {
        recoveryApplied.current = true;
        return;
      }
      const prepared = await current.prepare(draft, current.draft);
      if (prepared.kind === "refused") {
        if (observing) report(prepared.reason);
        return;
      }
      if (
        !observing ||
        !sameScope(latest.current.target.location, current.target.location) ||
        !sameDraft(latest.current.draft, current.draft)
      ) {
        prepared.release?.();
        if (observing)
          report("Your current edits are kept. Reopen the composer to recover the saved draft.");
        return;
      }
      restoreTypedNote(draft, current.typedScope);
      prepared.apply();
      recoveryApplied.current = true;
    };
    hydration.current = hydrate()
      .catch(() => {
        if (observing) report("Saved drafts could not be read on this client.");
      })
      .finally(() => {
        if (!observing) return;
        moving.current = false;
        setBusy(false);
      });
    return () => {
      observing = false;
      mounted.current = false;
    };
  }, [extensionScope, locationKey, scopeKey, store]);

  useEffect(() => {
    if (store === undefined || busy || !recoveryApplied.current || recovery.current === undefined) {
      return;
    }
    const followEdits = async () => {
      const previous = recovery.current;
      if (previous === undefined || moving.current) return;
      const { draft, target } = latest.current;
      const tracked = hasComposerStashContent(previous.draft);
      const compatible = canRecoverContext(previous, target);
      const location = compatible ? target.location : previous.location;
      const next = compatible ? draft : { ...draft, context: previous.draft.context };
      if (
        tracked
          ? sameDraft(previous.draft, next) && sameScope(previous.location, location)
          : previous.beforeText === ""
      )
        return;
      // Once the source has cleared, its marker only protects the move's revision.
      const updated = await store.revise(
        previous,
        tracked ? next : previous.draft,
        tracked ? previous.draft.text : "",
        location,
      );
      if (updated !== undefined) recovery.current = updated;
    };
    write.current = write.current.then(followEdits).catch(() => {
      report("Changes to the restored draft could not be saved on this client.");
    });
  }, [binding.draft, busy, store]);

  useEffect(() => {
    const submission = binding.submission;
    if (submission === undefined || store === undefined) return;
    submission.current = () => {
      if (!recoveryApplied.current || recovery.current === undefined || moving.current) return;
      if (!hasComposerStashContent(recovery.current.draft)) return;
      const sending = latest.current.draft;
      const expected = write.current.then(() => {
        const record = recovery.current;
        return record !== undefined && sameDraft(record.draft, sending) ? record : undefined;
      });
      return () => {
        write.current = write.current
          .then(async () => {
            const record = await expected;
            // An older acknowledgement cannot clear a draft edited during send.
            if (
              record !== undefined &&
              (await store.retire(record)) &&
              recovery.current?.revision === record.revision
            ) {
              recovery.current = undefined;
            }
          })
          .catch(() => report("The sent draft could not be removed from local recovery."));
      };
    };
    return () => {
      submission.current = undefined;
    };
  }, [binding.submission, store]);

  async function move(entry?: SavedComposerDraft): Promise<void> {
    await hydration.current;
    if (!mounted.current || moving.current) return;
    if (store === undefined) {
      report("Saved drafts are unavailable in this browser profile.");
      return;
    }
    const input = latest.current;
    if (!recoveryApplied.current) {
      report("Reopen this composer to recover its saved draft before moving another draft.");
      return;
    }
    if (recovery.current !== undefined && !canRecoverContext(recovery.current, input.target)) {
      report("Return to the original composer to move this recovered draft.");
      return;
    }
    if (input.unavailable !== undefined) {
      report(input.unavailable);
      return;
    }
    const before = {
      ...withTypedNote(input.draft, input.typedScope),
      caret: input.readCaret?.() ?? input.draft.caret,
    };
    if (entry === undefined && !hasComposerStashContent(before)) return;
    const plan =
      entry === undefined
        ? { kind: "ready" as const, draft: emptyComposerStashDraft() }
        : planComposerStashRestore(entry.source, input.target, before, entry.draft);
    if (plan.kind === "refused") {
      report(plan.reason);
      return;
    }

    const beforeResults = resultQuotePlaces(input.typedScope, before.text);
    moving.current = true;
    setBusy(true);
    setNotice(undefined);
    let release: (() => void) | undefined;
    let committed = false;
    const stillCurrent = () =>
      mounted.current &&
      latest.current.unavailable === undefined &&
      sameScope(latest.current.target.location, input.target.location) &&
      sameDraft(latest.current.draft, before);
    try {
      await write.current;
      const prepared = await input.prepare(plan.draft, before);
      if (prepared.kind === "refused") {
        report(prepared.reason);
        return;
      }
      release = prepared.release;
      const request = {
        location: input.target.location,
        expectedRevision: recovery.current?.revision,
        beforeText: before.text,
        stillCurrent,
      };
      const record = await (entry === undefined
        ? store.stash(request, before)
        : store.restore(entry.id, request, plan.draft));
      if (record === undefined) {
        report("The draft changed while it was moving. Reopen the composer and try again.");
        return;
      }
      if ("savedDraftId" in record && typeof record.savedDraftId === "string") {
        stashResultQuotePlaces(record.savedDraftId, beforeResults);
      }
      recovery.current = record;
      committed = true;
      if (!stillCurrent()) {
        recoveryApplied.current = false;
        report("The move was saved. Reopen the composer to recover the draft.");
        return;
      }
      if (entry !== undefined) {
        const offset = plan.draft.text.length - entry.draft.text.length;
        const sameThread =
          entry.source.mode === input.target.location.mode &&
          entry.source.threadId === input.target.location.threadId;
        const saved = takeStashedResultQuotePlaces(entry.id);
        const restored = sameThread
          ? saved.map((place) => ({
              ...place,
              start: place.start + offset,
              end: place.end + offset,
            }))
          : [];
        const kept = beforeResults.filter((place) => place.end <= offset);
        rememberResultQuotePlaces(input.typedScope, plan.draft.text, [...kept, ...restored]);
      }
      restoreTypedNote(plan.draft, input.typedScope);
      prepared.apply();
      release = undefined;
      setEntries(undefined);
      report(entry === undefined ? "Draft stashed" : "Draft restored", "success");
    } catch {
      if (committed) recoveryApplied.current = false;
      report(
        committed
          ? "The move was saved. Reopen the composer to recover the draft."
          : entry === undefined
            ? "The draft could not be saved. It is still in the composer."
            : "The draft could not be restored. It is still available in Saved drafts.",
      );
    } finally {
      release?.();
      moving.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function open(restoreSingle: boolean): Promise<void> {
    await hydration.current;
    if (!mounted.current || moving.current) return;
    if (store === undefined) {
      report("Saved drafts are unavailable in this browser profile.");
      return;
    }
    try {
      await reconcilePurges?.();
      if (!mounted.current || moving.current) return;
      const input = latest.current;
      const saved = await store.list(input.target.location.host);
      if (!mounted.current) return;
      const eligible = restoreSingle
        ? saved.filter(
            (entry) =>
              planComposerStashRestore(entry.source, input.target, input.draft, entry.draft)
                .kind === "ready",
          )
        : [];
      if (eligible.length === 1 && eligible[0] !== undefined) await move(eligible[0]);
      else {
        setNotice(undefined);
        setEntries(saved);
      }
    } catch {
      report("Saved drafts could not be read on this client.");
    }
  }

  async function remove(entry: SavedComposerDraft): Promise<void> {
    if (moving.current || store === undefined) return;
    try {
      await store.discard(entry.id, latest.current.target.location.host);
      if (mounted.current) setEntries((current) => current?.filter(({ id }) => id !== entry.id));
    } catch {
      report("The saved draft could not be removed. Try again.");
    }
  }

  return {
    notice,
    entries,
    busy,
    move,
    open,
    remove,
    close: () => setEntries(undefined),
  };
}
