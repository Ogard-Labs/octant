import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventActor,
  decodeCodeEvidenceReference,
  decodeProductFeedbackCommandResult,
  decodeProductFeedbackNoteId,
  decodeWindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CodeEvidenceStore } from "../code/codeEvidenceStore";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { Journal } from "../persistence/journal";
import { MIGRATIONS, applyMigrations } from "../persistence/migrations";
import {
  readProductFeedbackNote,
  readProductFeedbackNotes,
} from "../persistence/productFeedbackProjection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { createProductFeedbackRouteHandler } from "../productFeedbackRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { ProductFeedbackService } from "./productFeedbackService";

const now = "2026-11-03T10:00:00.000Z";
const threadId = "20000000-0000-4000-8000-000000000001";
const windowId = decodeWindowId("20000000-0000-4000-8000-000000000002");
const noteId = decodeProductFeedbackNoteId("20000000-0000-4000-8000-000000000003");
const existingImage = "data:image/jpeg;base64,ZXhpc3Rpbmc=";
const newImage = "data:image/jpeg;base64,bmV3IGNyb3A=";

describe("pointed-at feedback's actual crop, taint and note transaction", () => {
  it.each(["after-crop", "after-ingestion", "ingestion-refused", "shared-digest"] as const)(
    "rolls back rejected %s without deleting shared evidence or exhausting capacity",
    async (failure) => {
      const directory = mkdtempSync(join(tmpdir(), "octant-feedback-transaction-"));
      const connection = openSqlite(join(directory, "events.sqlite3"));
      let service: ProductFeedbackService | undefined;
      try {
        applyMigrations(connection, MIGRATIONS, () => now);
        let nextId = 100;
        const uuid = () => `20000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
        const runtime = createPhase1RuntimeRegistries();
        const published: string[] = [];
        const windows = new WindowAuthorityStore((id) => service?.revokeWindow(id));
        let revokeOnPublishedCapture = false;
        const journal = new Journal({
          connection,
          registry: runtime.events,
          projections: runtime.projections,
          clock: () => now,
          onCommitted: (append) => {
            published.push(...append.events.map((event) => event.eventName));
            if (
              revokeOnPublishedCapture &&
              append.events.some((event) => event.eventName === "feedback.note-captured@1")
            )
              windows.revoke(windowId);
          },
        });
        const evidence = new CodeEvidenceStore({ connection, newContentId: uuid, maxEntries: 2 });
        const existing = evidence.put(existingImage);
        const ingestion = new ExternalContentIngestionStore({
          connection,
          journal,
          uuid,
          clock: () => now,
          actor: Schema.decodeUnknownSync(EventActor)({ kind: "system", actorId: uuid() }),
        });
        let capability = "A".repeat(43);
        windows.register({ windowId, capability, now: Date.parse(now) });
        let reject = true;
        service = new ProductFeedbackService({
          journal,
          readNote: (id) => readProductFeedbackNote(connection, id),
          readNotes: (id) => readProductFeedbackNotes(connection, id),
          canAccessThread: async () => true,
          resolveThread: async () => ({ mode: "code", current: () => true }),
          browser: {
            describePoint: async () => ({
              status: "described",
              element: {
                selector: "main > button",
                bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
              },
              cropDataUrl: reject && failure === "shared-digest" ? existingImage : newImage,
            }),
          },
          crops: {
            put: (data) => {
              const reference = evidence.put(data);
              if (reject && failure === "after-crop") windows.revoke(windowId);
              return reference;
            },
            read: (reference) => evidence.read(decodeCodeEvidenceReference(reference)),
          },
          transaction: (body) => {
            try {
              return journal.transaction(body);
            } catch (error) {
              evidence.reconcileCapacity();
              throw error;
            }
          },
          recordExternalContentIngestion: (input) => {
            if (reject && (failure === "ingestion-refused" || failure === "shared-digest"))
              return { kind: "refused", reason: "unauthorized" };
            const result = ingestion.record(input);
            if (reject && failure === "after-ingestion") windows.revoke(windowId);
            return result;
          },
          uuid,
          clock: () => now,
          actor: Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: uuid() }),
        });
        const handler = createProductFeedbackRouteHandler({
          feedback: service,
          windowAuthorityStore: windows,
          now: () => Date.parse(now),
        });
        const post = async (body: unknown) => {
          const response = await handler(
            new Request("http://127.0.0.1/api/feedback/commands", {
              method: "POST",
              headers: {
                "x-octant-window-capability": capability,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            }),
          );
          if (response === undefined) throw Error("Feedback route missing");
          return response;
        };
        const prepare = async () => {
          const response = await post({
            kind: "prepare-product-feedback",
            threadId,
            contextId: uuid(),
            expectedObservationRevision: 0,
            point: { x: 0.2, y: 0.15 },
          });
          expect(response.status).toBe(200);
          const result = decodeProductFeedbackCommandResult(await response.json());
          expect(result.kind).toBe("feedback-prepared");
          if (result.kind !== "feedback-prepared") throw Error("Preview unavailable");
          return String(result.preview.id);
        };
        const before = connection.prepare("SELECT COUNT(*) AS count FROM event_journal").get();
        const previewId = await prepare();
        const failed = await post({
          kind: "commit-product-feedback",
          threadId,
          noteId,
          previewId,
          comment: "Keep my comment",
        });
        expect(failed.status).toBe(
          failure === "after-crop" || failure === "after-ingestion" ? 401 : 400,
        );
        expect(connection.prepare("SELECT COUNT(*) AS count FROM event_journal").get()).toEqual(
          before,
        );
        expect(
          connection.prepare("SELECT COUNT(*) AS count FROM code_evidence_content_store").get(),
        ).toMatchObject({ count: 1 });
        expect(evidence.read(existing)).toBe(existingImage);
        expect(readProductFeedbackNote(connection, noteId)).toBeUndefined();
        expect(readThreadExternalContentTaint(connection, threadId).externalContentIngested).toBe(
          false,
        );
        expect(published).toEqual([]);

        reject = false;
        windows.revoke(windowId);
        capability = "B".repeat(42) + "A";
        windows.register({ windowId, capability, now: Date.parse(now) });
        const retryPreview = await prepare();
        revokeOnPublishedCapture = failure === "after-crop";
        const committed = await post({
          kind: "commit-product-feedback",
          threadId,
          noteId,
          previewId: retryPreview,
          comment: "Keep my comment",
        });
        expect(committed.status).toBe(revokeOnPublishedCapture ? 401 : 200);
        if (revokeOnPublishedCapture)
          expect(await committed.json()).toMatchObject({
            error: expect.stringContaining("refresh notes before retrying"),
          });
        else
          expect(await committed.json()).toMatchObject({
            kind: "feedback-captured",
            note: { comment: "Keep my comment", crop: { digest: expect.any(String) } },
          });
        expect(
          connection.prepare("SELECT COUNT(*) AS count FROM code_evidence_content_store").get(),
        ).toMatchObject({ count: 2 });
        const stored = readProductFeedbackNote(connection, noteId);
        expect(stored?.crop).toBeDefined();
        expect(
          stored?.crop === undefined
            ? undefined
            : evidence.read(decodeCodeEvidenceReference(stored.crop)),
        ).toBe(newImage);
        expect(evidence.read(existing)).toBe(existingImage);
        expect(readThreadExternalContentTaint(connection, threadId).externalContentIngested).toBe(
          true,
        );
        expect(published).toContain("feedback.note-captured@1");
      } finally {
        service?.close();
        connection.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
