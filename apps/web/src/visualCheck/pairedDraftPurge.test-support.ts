import assert from "node:assert/strict";
import {
  decodeThreadRetentionState,
  type ThreadRetentionState,
} from "@octant/contracts/thread-retention";
import type { Page } from "playwright-core";

export async function verifyPairedDraftPurge(page: Page): Promise<void> {
  const host = "paired-computer";
  const threadId = "00000000-0000-4000-8000-000000000102";
  const retention = decodeThreadRetentionState({
    windows: [],
    tombstones: [{ mode: "code", threadId, purgedAt: "2026-11-24T20:00:00.000Z" }],
  });
  const result = await page.evaluate(
    async ({ modulePath, host, threadId, retentionJson }) => {
      const { createComposerStashStore, reconcileComposerStashPurges } = (await import(
        modulePath
      )) as typeof import("../composer/composerStashStore");
      const store = createComposerStashStore(indexedDB);
      const purged = {
        host,
        mode: "code" as const,
        projectId: null,
        composerId: threadId,
        threadId,
      };
      const recovery = { ...purged, composerId: "restored-composer" };
      const archiveId = "00000000-0000-4000-8000-000000000103";
      const sources = [
        { source: purged, text: "Purged draft" },
        { source: recovery, text: "Purged recovery" },
        { source: { ...purged, threadId: archiveId, composerId: archiveId }, text: "Archived" },
        { source: { ...purged, mode: "work" as const }, text: "Work with the same ID" },
        { source: { ...purged, host: "another-computer" }, text: "Other computer" },
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
      const read = async (host: string) =>
        (
          await Promise.all(
            (await store.list(host)).map(async ({ draft }) => draft.files[0]?.text()),
          )
        ).sort();
      const recoveryBefore = (await store.readRecovery(recovery))?.draft.text;
      await reconcileComposerStashPurges(host, async () => {
        throw Error("The paired host is unavailable.");
      });
      const whileUnavailable = await read(host);
      await reconcileComposerStashPurges(
        host,
        async () => JSON.parse(retentionJson) as ThreadRetentionState,
      );
      return {
        whileUnavailable,
        paired: await read(host),
        other: await read("another-computer"),
        recoveryBefore,
        recoveryAfter: (await store.readRecovery(recovery))?.draft.text,
      };
    },
    {
      modulePath: "/src/composer/composerStashStore.ts",
      host,
      threadId,
      retentionJson: JSON.stringify(retention),
    },
  );
  assert.deepEqual(result, {
    whileUnavailable: ["Archived", "Purged draft", "Work with the same ID"],
    paired: ["Archived", "Work with the same ID"],
    other: ["Other computer"],
    recoveryBefore: "Purged recovery",
    recoveryAfter: undefined,
  });
}
