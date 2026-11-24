import { decodeThreadRetentionState } from "@octant/contracts/thread-retention";
import {
  createComposerStashStore,
  reconcileComposerStashPurges,
} from "../composer/composerStashStore";

async function observePairedDraftPurge() {
  const host = "paired-computer";
  const threadId = "00000000-0000-4000-8000-000000000102";
  const archiveId = "00000000-0000-4000-8000-000000000103";
  const otherHost = "another-computer";
  const retention = decodeThreadRetentionState({
    windows: [],
    tombstones: [{ mode: "code", threadId, purgedAt: "2026-11-24T20:00:00.000Z" }],
  });
  const store = createComposerStashStore(indexedDB);
  const purged = { host, mode: "code" as const, projectId: null, composerId: threadId, threadId };
  const recovery = { ...purged, composerId: "restored-composer" };
  const sources = [
    { source: purged, text: "Purged draft" },
    { source: recovery, text: "Purged recovery" },
    { source: { ...purged, threadId: archiveId, composerId: archiveId }, text: "Archived" },
    { source: { ...purged, mode: "work" as const }, text: "Work with the same ID" },
    { source: { ...purged, host: otherHost }, text: "Other computer" },
  ];
  for (const { source, text } of sources) {
    const move = {
      location: source,
      expectedRevision: undefined,
      beforeText: text,
      stillCurrent: () => true,
    };
    const draft = { text, caret: 0, files: [new File([text], "notes.md")], context: [] };
    const cleared = await store.stash(move, draft);
    if (source === recovery) {
      const entry = (await store.list(host)).find(({ draft }) => draft.text === text);
      if (entry === undefined || cleared === undefined) throw Error("Missing recovery seed.");
      await store.restore(entry.id, { ...move, expectedRevision: cleared.revision }, draft);
    }
  }
  const readFiles = async (host: string) =>
    (
      await Promise.all((await store.list(host)).map(async ({ draft }) => draft.files[0]?.text()))
    ).sort();
  const readRecoveredFile = async () =>
    (await store.readRecovery(recovery))?.draft.files[0]?.text();
  await reconcileComposerStashPurges(host, async () => {
    throw Error("The paired host is unavailable.");
  });
  const whileUnavailable = await readFiles(host);
  const recoveryWhileUnavailable = await readRecoveredFile();
  await reconcileComposerStashPurges(host, async () => retention);
  return {
    whileUnavailable,
    recoveryWhileUnavailable,
    paired: await readFiles(host),
    other: await readFiles(otherHost),
    recoveryAfter: await readRecoveredFile(),
  };
}

declare global {
  interface Window {
    octantPairedDraftPurge?: ReturnType<typeof observePairedDraftPurge>;
  }
}

window.octantPairedDraftPurge = observePairedDraftPurge();
