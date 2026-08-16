import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeOllamaHistorySnapshot,
  decodeProviderInstanceId,
  decodeProviderSessionId,
} from "@octant/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import { JournalOllamaHistoryStore } from "./ollamaHistoryStore";

const directories: string[] = [];
const now = "2026-07-18T09:30:00.000Z";
const snapshot = decodeOllamaHistorySnapshot({
  instanceId: decodeProviderInstanceId("80000000-0000-4000-8000-000000000741"),
  sessionId: decodeProviderSessionId("80000000-0000-4000-8000-000000000742"),
  root: "/tmp/octant-ollama-history",
  mode: "code",
  modelId: "qwen3:latest",
  history: [
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi" },
  ],
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Ollama history journal store", () => {
  it("restores the latest bounded Octant history after persistence restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-ollama-history-"));
    directories.push(directory);
    let identity = 0;
    const uuid = () => `80000000-0000-4000-8000-${String(++identity).padStart(12, "0")}`;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const store = new JournalOllamaHistoryStore({ persistence, uuid, clock: () => now });
          yield* Effect.promise(() => store.save(snapshot));
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );

    const restored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const store = new JournalOllamaHistoryStore({ persistence, uuid, clock: () => now });
          return yield* Effect.promise(() => store.load(snapshot.sessionId));
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );

    expect(restored).toEqual(snapshot);
  });
});
