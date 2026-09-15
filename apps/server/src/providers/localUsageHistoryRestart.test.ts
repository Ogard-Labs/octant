import { mkdtemp, writeFile, appendFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { decodeLocalUsageHistoryRecord, decodeLocalUsageHistoryRequest } from "@octant/contracts";
import { createLocalUsageHistoryCheckpointStore } from "../persistence/localUsageHistoryCheckpointStore";

const request = decodeLocalUsageHistoryRequest({
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-30T23:59:59.999Z",
  timeZone: "UTC",
});

describe("persistent provider usage", () => {
  it("restores usage without parsing unchanged logs and resumes appended records after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-usage-restart-"));
    const file = join(directory, "session.jsonl");
    await writeFile(file, '"first"\n');
    const store = createLocalUsageHistoryCheckpointStore(join(directory, "cache.sqlite3"));
    const options = {
      root: directory,
      sourceKind: "codex",
      providerKey: "codex",
      checkpointStore: store,
    } as const;
    const parse = vi.fn(({ line }: { readonly line: string }) =>
      decodeLocalUsageHistoryRecord({
        sourceKind: "codex",
        sourceInstallationId: "fixture",
        sourceSessionId: "session",
        sourceEventId: String(JSON.parse(line)),
        providerKey: "codex",
        modelId: "model",
        observedAt: "2026-09-09T10:00:00.000Z",
        inputTokens: 10,
        outputTokens: 2,
      }),
    );
    const firstReader = await import("./localUsageHistoryReader");
    expect((await firstReader.readLocalUsageHistory(options, request, parse)).records).toHaveLength(
      1,
    );
    vi.resetModules();
    parse.mockClear();
    const restarted = await import("./localUsageHistoryReader");
    expect((await restarted.readLocalUsageHistory(options, request, parse)).records).toHaveLength(
      1,
    );
    expect(parse).not.toHaveBeenCalled();
    await appendFile(file, '"second"\n');
    expect((await restarted.readLocalUsageHistory(options, request, parse)).records).toHaveLength(
      2,
    );
    expect(parse).toHaveBeenCalledTimes(1);
    await writeFile(file, '"replacement"\n');
    expect(
      (await restarted.readLocalUsageHistory(options, request, parse)).records.map(
        (r) => r.sourceEventId,
      ),
    ).toEqual(["replacement"]);
    expect(await readFile(file, "utf8")).toBe('"replacement"\n');
  });
  it("resumes Codex cumulative counters and model identity after restart without importing conversation content", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-codex-restart-"));
    await mkdir(join(root, "sessions"));
    const file = join(root, "sessions", "session.jsonl");
    const event = (total: number, timestamp: string) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          thread_id: "session",
          info: {
            total_token_usage: { input_tokens: total, output_tokens: 0 },
            last_token_usage: { input_tokens: total, output_tokens: 0 },
          },
        },
      });
    await writeFile(
      file,
      JSON.stringify({ type: "session_meta", payload: { id: "session", model: "gpt-5.6-sol" } }) +
        "\n" +
        JSON.stringify({
          type: "response_item",
          payload: { text: "PRIVATE_CONVERSATION_MARKER" },
        }) +
        "\n" +
        event(10, "2026-09-09T10:00:00.000Z") +
        "\n",
    );
    const store = createLocalUsageHistoryCheckpointStore(join(root, "cache.sqlite3"));
    const first = await import("./codexUsageHistory");
    expect(
      (
        await Effect.runPromise(
          first.createCodexLocalUsageHistorySource({ root, checkpointStore: store }).read(request),
        )
      ).records,
    ).toHaveLength(1);
    vi.resetModules();
    await appendFile(file, event(15, "2026-09-09T10:01:00.000Z") + "\n");
    const restarted = await import("./codexUsageHistory");
    const result = await Effect.runPromise(
      restarted.createCodexLocalUsageHistorySource({ root, checkpointStore: store }).read(request),
    );
    expect(result.records.map((record) => record.inputTokens)).toEqual([10, 5]);
    expect(result.records.map((record) => record.modelId)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol"]);
    expect(
      (await readFile(join(root, "cache.sqlite3"))).includes(
        Buffer.from("PRIVATE_CONVERSATION_MARKER"),
      ),
    ).toBe(false);
  });
  it("continues a bounded import across restarts and keeps a complete import cached", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-claude-restart-"));
    for (const id of ["one", "two"]) {
      await writeFile(
        join(root, `${id}.jsonl`),
        JSON.stringify({
          type: "assistant",
          sessionId: id,
          timestamp: "2026-09-09T10:00:00.000Z",
          message: {
            id,
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        }) + "\n",
      );
    }
    const checkpointStore = createLocalUsageHistoryCheckpointStore(join(root, "cache.sqlite3"));
    const first = await import("./claudeUsageHistory");
    const partial = await Effect.runPromise(
      first
        .createClaudeLocalUsageHistorySource({ root, checkpointStore, maxFiles: 1 })
        .read(request),
    );
    expect(partial.records).toHaveLength(1);
    expect(partial.coverage.hasMore).toBe(true);
    vi.resetModules();
    const second = await import("./claudeUsageHistory");
    const complete = await Effect.runPromise(
      second
        .createClaudeLocalUsageHistorySource({ root, checkpointStore, maxFiles: 1 })
        .read(request),
    );
    expect(complete.records).toHaveLength(2);
    expect(complete.coverage.hasMore).toBe(false);
    vi.resetModules();
    const third = await import("./claudeUsageHistory");
    const cached = await Effect.runPromise(
      third.createClaudeLocalUsageHistorySource({ root, checkpointStore }).read(request),
    );
    expect(cached.records).toHaveLength(2);
    expect(cached.coverage.scannedFileCount).toBe(0);
  });

  it("returns current usage with an honest warning when its restart checkpoint cannot be saved", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-usage-cache-failure-"));
    await writeFile(
      join(root, "one.jsonl"),
      JSON.stringify({
        type: "assistant",
        sessionId: "one",
        timestamp: "2026-09-09T10:00:00.000Z",
        message: {
          id: "one",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }) + "\n",
    );
    const source = await import("./claudeUsageHistory");
    const result = await Effect.runPromise(
      source
        .createClaudeLocalUsageHistorySource({
          root,
          checkpointStore: {
            read: () => "invalid cache",
            write: () => {
              throw new Error("disk full");
            },
          },
        })
        .read(request),
    );
    expect(result.records).toHaveLength(1);
    expect(result.coverage.status).toBe("partial");
    expect(result.coverage.detail).toContain("checkpoint could not be saved");
  });
});
