import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeEvidenceReference,
  decodeEventActor,
  type ProductFeedbackNote,
  type WindowId,
} from "@octant/contracts";
import { CodeEvidenceStore } from "../code/codeEvidenceStore";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import { Journal } from "../persistence/journal";
import { MIGRATIONS, applyMigrations } from "../persistence/migrations";
import {
  readProductFeedbackNote,
  readProductFeedbackNotes,
} from "../persistence/productFeedbackProjection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ProductFeedbackService } from "./productFeedbackService";
import { createProductFeedbackTurnPort } from "./productFeedbackTurnPort";

/** Owned temporary SQLite journal/taint/crop storage; no browser/network/process. Caller closes it. */
export function productFeedbackPersistenceFixture(options: {
  readonly windowId: WindowId;
  readonly threadId: string;
  readonly mode: "work" | "code";
  readonly current: () => boolean;
  readonly longEvidence?: boolean;
  readonly cropDataUrl?: string;
  readonly now?: string;
  readonly beforeScopeRead?: () => Promise<void>;
  readonly beforePointRead?: () => Promise<void>;
}) {
  const now = options.now ?? "2026-11-03T10:00:00.000Z";
  const directory = mkdtempSync(join(tmpdir(), "octant-feedback-work-"));
  const connection = openSqlite(join(directory, "feedback.sqlite3"));
  try {
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const crops = new CodeEvidenceStore({ connection });
    const ingestion = new ExternalContentIngestionStore({
      connection,
      journal,
      uuid: randomUUID,
      clock: () => now,
      actor: decodeEventActor({ kind: "system", actorId: randomUUID() }),
    });
    const service = new ProductFeedbackService({
      journal,
      readNote: (id) => readProductFeedbackNote(connection, id),
      readNotes: (id) => readProductFeedbackNotes(connection, id),
      canAccessThread: async (windowId, threadId) =>
        windowId === options.windowId && threadId === options.threadId && options.current(),
      resolveThread: async (windowId, threadId) => {
        await options.beforeScopeRead?.();
        return windowId === options.windowId && threadId === options.threadId
          ? { mode: options.mode, current: options.current }
          : undefined;
      },
      browser: {
        describePoint: async () => {
          await options.beforePointRead?.();
          return {
            status: "described",
            element: {
              selector: "main > button",
              text: options.longEvidence ? "x".repeat(2_048) : "Save changes",
              bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
              context: {
                captureId: "f".repeat(64),
                viewport: { width: 1000, height: 800 },
                tag: "button",
                ancestors: ["main"],
                children: [],
                styles: [{ property: "margin", value: "8px" }],
                omissions: ["form-values-excluded"],
              },
            },
            url: "https://example.test/" + (options.longEvidence ? "p".repeat(3_000) : "settings"),
            cropDataUrl: options.cropDataUrl ?? "data:image/jpeg;base64,cGljdHVyZQ==",
          };
        },
      },
      crops: {
        put: (data) => crops.put(data),
        read: (ref) => crops.read(decodeCodeEvidenceReference(ref)),
      },
      transaction: (body) => {
        try {
          return journal.transaction(body);
        } catch (error) {
          crops.reconcileCapacity();
          throw error;
        }
      },
      recordExternalContentIngestion: (input) => ingestion.record(input),
      uuid: randomUUID,
      clock: () => now,
      actor: decodeEventActor({ kind: "local-user", actorId: randomUUID() }),
    });
    const create = async (comment = "Align this button"): Promise<ProductFeedbackNote> => {
      const execution = { admissionCurrent: options.current };
      const prepared = await service.execute(
        options.windowId,
        {
          kind: "prepare-product-feedback",
          threadId: options.threadId,
          contextId: randomUUID(),
          expectedObservationRevision: 0,
          point: { x: 0.2, y: 0.15 },
        },
        execution,
      );
      if (prepared.kind !== "feedback-prepared") throw Error("Fixture preview unavailable");
      const committed = await service.execute(
        options.windowId,
        {
          kind: "commit-product-feedback",
          previewId: prepared.preview.id,
          threadId: options.threadId,
          comment,
        },
        execution,
      );
      if (committed.kind !== "feedback-captured") throw Error("Fixture note unavailable");
      return committed.note;
    };
    return {
      service,
      journal,
      connection,
      create,
      port: createProductFeedbackTurnPort({ service }),
      close: () => {
        service.close();
        connection.close();
        rmSync(directory, { recursive: true, force: true });
        if (existsSync(directory)) throw Error("Owned feedback fixture cleanup incomplete");
      },
    };
  } catch (error) {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
