import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodeOperationEventFrame,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeEventActor,
} from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, runtimeSqliteKind } from "../persistence/sqlitePort";
import { CODE_OPERATION_EVENT_RECORDED, CodeOperationEventStore } from "./codeOperationEventStore";

const now = "2026-11-06T00:00:00.000Z";
const threadId = decodeCodeThreadId("89000000-0000-4000-8000-000000000001");
const operationId = decodeCodeOperationId("89000000-0000-4000-8000-000000000010");
const actor = decodeEventActor({ kind: "system", actorId: "89000000-0000-4000-8000-000000000020" });

function summarize(samples: ReadonlyArray<number>) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: Math.max(...samples) };
}

// Opt-in evidence: timings are diagnostic, never a machine-dependent pass threshold.
describe.skipIf(process.env.OCTANT_RUN_CODE_HISTORY_BENCHMARK !== "1")(
  "Code history read costs",
  () => {
    it("measures advancing and unchanged reads while preserving retained snapshots", () => {
      const directory = mkdtempSync(join(tmpdir(), "octant-history-benchmark-"));
      const measurements = [];
      try {
        for (const initialFrames of [1_000, 10_000, 90_000]) {
          const connection = openSqlite(join(directory, `${initialFrames}.sqlite3`));
          try {
            applyMigrations(connection, MIGRATIONS, () => now);
            const journal = new Journal({
              connection,
              registry: new EventRegistry().register(
                CODE_OPERATION_EVENT_RECORDED,
                1,
                CodeOperationEventFrame,
              ),
              projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
              clock: () => now,
            });
            const options = { journal, actor, clock: () => now, uuid: () => crypto.randomUUID() };
            const writer = new CodeOperationEventStore(options);
            const secondReader = new CodeOperationEventStore(options);
            let cursor = 0;
            const append = () =>
              writer.append({
                threadId,
                operationId,
                expectedCursor: cursor++,
                event: { kind: "operation-state", state: "running" },
              });
            connection.transaction(() => {
              for (let i = 0; i < initialFrames; i += 1) append();
            })();
            const retained = writer.historyForThread(threadId);
            if (retained.status !== "ok") throw new Error("The seeded history must be readable");
            const advancing = [];
            const unchanged = [];
            for (let i = 0; i < 100; i += 1) {
              append();
              let start = performance.now();
              const next = writer.historyForThread(threadId);
              advancing.push(performance.now() - start);
              if (next.status !== "ok") throw new Error("The appended history must be readable");
              expect(next.frames).toHaveLength(initialFrames + i + 1);
              start = performance.now();
              const shared = secondReader.historyForThread(threadId);
              unchanged.push(performance.now() - start);
              if (shared.status !== "ok") throw new Error("The shared history must be readable");
              expect(shared.frames).toBe(next.frames);
            }
            expect(retained.frames).toHaveLength(initialFrames);
            measurements.push({
              initialFrames,
              samples: 100,
              advancing: summarize(advancing),
              unchanged: summarize(unchanged),
            });
          } finally {
            connection.close();
          }
        }
        process.stdout.write(`${JSON.stringify({ adapter: runtimeSqliteKind(), measurements })}\n`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  },
);
