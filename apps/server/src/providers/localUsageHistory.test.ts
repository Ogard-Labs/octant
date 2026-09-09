import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createClaudeLocalUsageHistorySource,
  createCodexLocalUsageHistorySource,
} from "./providerUsageHistorySources";
import { readLocalUsageHistory } from "./localUsageHistoryReader";

async function codexFixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "sessions"), { recursive: true });
  await mkdir(join(root, "archived_sessions"), { recursive: true });
  return root;
}

const request = {
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-30T23:59:59.999Z",
  timeZone: "UTC",
} as never;

describe("local provider usage history", () => {
  it("projects Codex per-turn token_count events without cumulative double counting", async () => {
    const root = await codexFixtureRoot("octant-codex-history-");
    await writeFile(
      join(
        root,
        "sessions",
        "rollout-2026-09-09T10-00-00-00000000-0000-4000-8000-000000000001.jsonl",
      ),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "session-1", base_instructions: { provenance: { model: "gpt-5.6-sol" } } },
        }),
        JSON.stringify({
          timestamp: "2026-09-09T10:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            thread_id: "session-1",
            info: {
              total_token_usage: { input_tokens: 30, output_tokens: 5 },
              last_token_usage: {
                input_tokens: 20,
                cached_input_tokens: 15,
                output_tokens: 4,
                reasoning_output_tokens: 1,
              },
            },
          },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { thread_id: "session-1", model: "gpt-5.6-luna" },
        }),
        JSON.stringify({
          timestamp: "2026-09-09T10:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            thread_id: "session-1",
            info: {
              total_token_usage: {
                inputTokens: 50,
                cachedInputTokens: 15,
                cacheWriteInputTokens: 0,
                outputTokens: 8,
              },
              last_token_usage: {
                inputTokens: 20,
                cachedInputTokens: 15,
                cacheWriteInputTokens: 0,
                outputTokens: 3,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-09-09T10:02:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            thread_id: "session-1",
            info: {
              total_token_usage: {
                inputTokens: 50,
                cachedInputTokens: 15,
                cacheWriteInputTokens: 0,
                outputTokens: 8,
              },
              last_token_usage: { input_tokens: 20, cached_input_tokens: 15, output_tokens: 3 },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-09-09T10:03:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            thread_id: "session-1",
            info: {
              total_token_usage: { input_tokens: 40, output_tokens: 6 },
              last_token_usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 1 },
            },
          },
        }),
      ].join("\n"),
    );
    const source = createCodexLocalUsageHistorySource({ root });
    const result = await Effect.runPromise(source.read(request));
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      inputTokens: 20,
      cacheReadInputTokens: 15,
      outputTokens: 4,
      reasoningTokens: 1,
      modelId: "gpt-5.6-sol",
    });
    expect(result.records[1]?.modelId).toBe("gpt-5.6-luna");
    expect(result.records[1]?.cacheWriteInputTokens).toBe(0);
    expect(result.coverage.status).toBe("ready");
  });

  it("scans only Codex sessions and archived_sessions directories", async () => {
    const root = await codexFixtureRoot("octant-codex-scope-");
    await mkdir(join(root, "worktrees", "repo", "node_modules"), { recursive: true });
    const usage = JSON.stringify({
      timestamp: "2026-09-09T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
        },
      },
    });
    await writeFile(join(root, "sessions", "session.jsonl"), usage);
    await writeFile(join(root, "archived_sessions", "archived.jsonl"), usage);
    await writeFile(join(root, "worktrees", "repo", "node_modules", "hostile.jsonl"), usage);
    await writeFile(join(root, "auth.jsonl"), usage);
    const source = createCodexLocalUsageHistorySource({ root });
    const result = await Effect.runPromise(source.read(request));
    expect(result.records).toHaveLength(2);
    expect(result.coverage.scannedFileCount).toBe(2);
  });

  it("leaves unvisited files pending when the per-pass byte budget is exhausted", async () => {
    const root = await codexFixtureRoot("octant-codex-byte-budget-");
    const usage = (session: string) =>
      JSON.stringify({
        timestamp: "2026-09-09T10:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          thread_id: session,
          info: { last_token_usage: { input_tokens: 10, output_tokens: 3 } },
        },
      });
    const body = (session: string) => `${usage(session)}\n${"x".repeat(300 * 1024)}\n`;
    await writeFile(join(root, "sessions", "a.jsonl"), body("session-a"));
    await writeFile(join(root, "sessions", "b.jsonl"), body("session-b"));
    const options = { maxFiles: 1, maxTotalBytes: 350 * 1024 };
    const source = createCodexLocalUsageHistorySource({ root, ...options });
    const first = await Effect.runPromise(source.read(request));
    expect(first.records).toHaveLength(1);
    expect(first.coverage.hasMore).toBe(true);
    const second = await Effect.runPromise(source.read(request));
    expect(second.records).toHaveLength(2);
    expect(second.coverage.hasMore).toBe(false);
  });

  it("prioritizes a pending long-file cursor before untouched files", async () => {
    const root = await codexFixtureRoot("octant-codex-pending-priority-");
    const usage = (session: string) =>
      JSON.stringify({
        timestamp: "2026-09-09T10:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          thread_id: session,
          info: { last_token_usage: { input_tokens: 10, output_tokens: 3 } },
        },
      });
    const hugeFile = join(root, "sessions", "huge.jsonl");
    const otherFile = join(root, "sessions", "other.jsonl");
    await writeFile(hugeFile, `${usage("huge-session")}\n${"x".repeat(9 * 1024 * 1024)}\n`);
    await writeFile(otherFile, `${usage("other-session")}\n`);
    await utimes(
      hugeFile,
      new Date("2026-09-09T00:00:00.000Z"),
      new Date("2026-09-09T00:00:00.000Z"),
    );
    await utimes(
      otherFile,
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-01T00:00:00.000Z"),
    );
    const source = createCodexLocalUsageHistorySource({ root, maxFiles: 1, maxFileBytes: 1024 });
    const first = await Effect.runPromise(source.read(request));
    expect(first.records).toHaveLength(1);
    expect(first.coverage.hasMore).toBe(true);
    const second = await Effect.runPromise(source.read(request));
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.sourceSessionId).toBe("huge-session");
    expect(second.coverage.hasMore).toBe(true);
  });

  it("keeps no-identity Codex events distinct by timestamp and line position", async () => {
    const root = await codexFixtureRoot("octant-codex-no-identity-");
    const makeLine = (timestamp: string) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
          },
        },
      });
    await writeFile(
      join(root, "sessions", "rollout.jsonl"),
      `${makeLine("2026-09-09T10:00:00.000Z")}\n${makeLine("2026-09-09T10:01:00.000Z")}\n`,
    );
    const source = createCodexLocalUsageHistorySource({ root });
    const result = await Effect.runPromise(source.read(request));
    expect(result.records).toHaveLength(2);
    expect(result.records[0]?.sourceEventId).not.toBe(result.records[1]?.sourceEventId);
  });

  it("retains Codex session model metadata while a long rollout resumes", async () => {
    const root = await codexFixtureRoot("octant-codex-resume-model-");
    const meta = JSON.stringify({
      type: "session_meta",
      payload: {
        id: "session-resume",
        base_instructions: { provenance: { model: "gpt-5.6-sol" } },
      },
    });
    const token = JSON.stringify({
      timestamp: "2026-09-09T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        thread_id: "session-resume",
        info: {
          total_token_usage: { input_tokens: 30, output_tokens: 5 },
          last_token_usage: { input_tokens: 20, cached_input_tokens: 15, output_tokens: 4 },
        },
      },
    });
    await writeFile(join(root, "sessions", "rollout.jsonl"), `${meta}\n${token}\n`);
    const source = createCodexLocalUsageHistorySource({
      root,
      maxFileBytes: Buffer.byteLength(`${meta}\n`),
    });
    const first = await Effect.runPromise(source.read(request));
    expect(first.records).toHaveLength(0);
    expect(first.coverage.status).toBe("partial");
    expect(first.coverage.hasMore).toBe(true);
    const second = await Effect.runPromise(source.read(request));
    expect(second.records[0]?.modelId).toBe("gpt-5.6-sol");
  });

  it("normalizes Claude uncached input plus cache dimensions into processed input", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-claude-history-"));
    await writeFile(
      join(root, "session.jsonl"),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        timestamp: "2026-09-09T11:00:00.000Z",
        message: {
          id: "message-1",
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 4,
          },
        },
        cost_usd: 0.001,
      }),
    );
    const source = createClaudeLocalUsageHistorySource({ root });
    const result = await Effect.runPromise(source.read(request));
    expect(result.records).toEqual([
      expect.objectContaining({
        inputTokens: 35,
        uncachedInputTokens: 10,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 5,
        outputTokens: 4,
        cost: expect.objectContaining({
          amount: 0.001,
          kind: "provider-recorded",
          currency: "USD",
        }),
      }),
    ]);
  });

  it("estimates Claude API-equivalent cost only when cache-write TTL is explicit", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-claude-pricing-"));
    await writeFile(
      join(root, "session.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          session_id: "claude-session-priced",
          timestamp: "2026-09-09T11:00:00.000Z",
          message: {
            id: "message-priced",
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 20,
              cache_creation: { ephemeral_5m_input_tokens: 5 },
              output_tokens: 4,
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          session_id: "claude-session-unpriced",
          timestamp: "2026-09-09T11:01:00.000Z",
          message: {
            id: "message-unpriced",
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 5,
              output_tokens: 4,
            },
          },
        }),
      ].join("\n"),
    );
    const source = createClaudeLocalUsageHistorySource({ root });
    const result = await Effect.runPromise(source.read(request));
    expect(result.records[0]?.cost).toMatchObject({
      kind: "api-estimate",
      amount: 0.00011475,
      pricingRevision: "2026-09-09",
      pricingSource: "https://platform.claude.com/docs/en/about-claude/pricing",
      cacheSavingsUsd: expect.any(Number),
    });
    expect(result.records[1]?.cost).toBeUndefined();
    expect(result.records[1]?.cacheWriteInputTokens).toBe(5);
  });

  it("prices a realistic Claude record with both cache-write TTL partitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-claude-mixed-cache-pricing-"));
    await writeFile(
      join(root, "session.jsonl"),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-mixed-cache",
        timestamp: "2026-09-09T11:02:00.000Z",
        message: {
          id: "message-mixed-cache",
          model: "claude-sonnet-4-5-20250929",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 200,
            cache_creation: {
              ephemeral_5m_input_tokens: 50,
              ephemeral_1h_input_tokens: 25,
            },
            output_tokens: 30,
          },
        },
      }),
    );
    const source = createClaudeLocalUsageHistorySource({ root });
    const result = await Effect.runPromise(source.read(request));
    expect(result.records[0]).toMatchObject({
      modelId: "claude-sonnet-4-5-20250929",
      inputTokens: 375,
      cacheReadInputTokens: 200,
      cacheWriteInputTokens: 75,
      cacheWrite5mInputTokens: 50,
      cacheWrite1hInputTokens: 25,
      cacheWriteDuration: "unknown",
      cost: {
        kind: "api-estimate",
        amount: 0.0011475,
        pricingRevision: "2026-09-09",
        pricingSource: "https://platform.claude.com/docs/en/about-claude/pricing",
      },
    });
  });

  it("does not treat an empty Claude cache object as a measured zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-claude-empty-cache-"));
    await writeFile(
      join(root, "session.jsonl"),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-empty-cache",
        timestamp: "2026-09-09T11:00:00.000Z",
        message: {
          id: "message-empty-cache",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 10, cache_creation: {}, output_tokens: 4 },
        },
      }),
    );
    const source = createClaudeLocalUsageHistorySource({ root });
    const result = await Effect.runPromise(source.read(request));
    expect(result.records[0]?.cacheWriteInputTokens).toBeUndefined();
    expect(result.records[0]?.cacheWriteDuration).toBeUndefined();
  });

  it("reads a fixed file snapshot and honors cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-history-snapshot-"));
    const file = join(root, "events.jsonl");
    const firstLine = JSON.stringify({ marker: "first" });
    const secondLine = JSON.stringify({ marker: "appended" });
    await writeFile(file, `${firstLine}\n`);
    const parser = ({ line }: { readonly line: string }) => {
      if (line.includes("first")) appendFileSync(file, `${secondLine}\n`);
      return {
        sourceKind: "fixture",
        sourceInstallationId: "fixture-install",
        sourceSessionId: "fixture-session",
        sourceEventId: "fixture-event",
        providerKey: "fixture",
        modelId: "fixture",
        observedAt: "2026-09-09T12:00:00.000Z" as never,
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const result = await readLocalUsageHistory(
      { sourceKind: "fixture" as never, providerKey: "fixture", root },
      request,
      parser as never,
    );
    expect(result.records).toHaveLength(1);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      readLocalUsageHistory(
        { sourceKind: "fixture" as never, providerKey: "fixture", root },
        request,
        parser as never,
        controller.signal,
      ),
    ).rejects.toBeDefined();
  });

  it("does not let one coalesced caller cancellation cancel another", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-history-coalesced-cancel-"));
    await writeFile(join(root, "events.jsonl"), JSON.stringify({ marker: "event" }));
    const parser = ({ line }: { readonly line: string }) => ({
      sourceKind: "fixture",
      sourceInstallationId: "fixture-install",
      sourceSessionId: "fixture-session",
      sourceEventId: JSON.parse(line).marker,
      providerKey: "fixture",
      modelId: "fixture",
      observedAt: "2026-09-09T12:00:00.000Z" as never,
      inputTokens: 1,
      outputTokens: 1,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const options = { sourceKind: "fixture" as never, providerKey: "fixture", root };
    const first = readLocalUsageHistory(options, request, parser as never, firstController.signal);
    const second = readLocalUsageHistory(
      options,
      request,
      parser as never,
      secondController.signal,
    );
    firstController.abort(new Error("first caller cancelled"));
    await expect(first).rejects.toBeDefined();
    await expect(second).resolves.toMatchObject({ records: [{ sourceEventId: "event" }] });
  });

  it("resumes a long file from its bounded cursor across refreshes", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-history-resume-"));
    const file = join(root, "events.jsonl");
    const firstLine = JSON.stringify({ marker: "first" });
    const secondLine = JSON.stringify({ marker: "second" });
    await writeFile(file, `${firstLine}\n${secondLine}\n`);
    const parser = ({ line }: { readonly line: string }) => {
      const marker = JSON.parse(line).marker;
      return {
        sourceKind: "fixture",
        sourceInstallationId: "fixture-install",
        sourceSessionId: "fixture-session",
        sourceEventId: marker,
        providerKey: "fixture",
        modelId: "fixture",
        observedAt: "2026-09-09T12:00:00.000Z" as never,
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const options = {
      sourceKind: "fixture" as never,
      providerKey: "fixture",
      root,
      maxFileBytes: Buffer.byteLength(`${firstLine}\n`),
    };
    const first = await readLocalUsageHistory(options, request, parser as never);
    expect(first.records).toHaveLength(1);
    expect(first.coverage.status).toBe("partial");
    const second = await readLocalUsageHistory(options, request, parser as never);
    expect(second.records).toHaveLength(2);
    expect(second.records.map((record) => record.sourceEventId)).toEqual(["first", "second"]);
    expect(second.coverage.status).toBe("ready");
    expect(second.coverage.hasMore).toBe(false);
  });

  it("prioritizes the newest files when a bounded file-count window applies", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-history-newest-"));
    const older = join(root, "older.jsonl");
    const newer = join(root, "newer.jsonl");
    await writeFile(older, JSON.stringify({ marker: "older" }));
    await writeFile(newer, JSON.stringify({ marker: "newer" }));
    await utimes(older, new Date("2026-09-01T00:00:00.000Z"), new Date("2026-09-01T00:00:00.000Z"));
    await utimes(newer, new Date("2026-09-09T00:00:00.000Z"), new Date("2026-09-09T00:00:00.000Z"));
    const parser = ({ line }: { readonly line: string }) => {
      const marker = JSON.parse(line).marker;
      return {
        sourceKind: "fixture",
        sourceInstallationId: "fixture-install",
        sourceSessionId: "fixture-session",
        sourceEventId: marker,
        providerKey: "fixture",
        modelId: "fixture",
        observedAt: "2026-09-09T12:00:00.000Z" as never,
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const result = await readLocalUsageHistory(
      { sourceKind: "fixture" as never, providerKey: "fixture", root, maxFiles: 1 },
      request,
      parser as never,
    );
    expect(result.records[0]?.sourceEventId).toBe("newer");
    expect(result.coverage.truncated).toBe(true);
    const next = await readLocalUsageHistory(
      { sourceKind: "fixture" as never, providerKey: "fixture", root, maxFiles: 1 },
      request,
      parser as never,
    );
    expect(next.records.map((record) => record.sourceEventId)).toEqual(["newer", "older"]);
    expect(next.coverage.status).toBe("ready");
  });

  it("retains the newest observed records when its cache bound evicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-history-cache-order-"));
    await writeFile(
      join(root, "events.jsonl"),
      ["old", "newest", "middle"].map((marker) => JSON.stringify({ marker })).join("\n"),
    );
    const observedAt: Record<string, string> = {
      old: "2026-09-01T00:00:00.000Z",
      middle: "2026-09-03T00:00:00.000Z",
      newest: "2026-09-09T00:00:00.000Z",
    };
    const parser = ({ line }: { readonly line: string }) => {
      const marker = JSON.parse(line).marker as string;
      return {
        sourceKind: "fixture",
        sourceInstallationId: "fixture-install",
        sourceSessionId: "fixture-session",
        sourceEventId: marker,
        providerKey: "fixture",
        modelId: "fixture",
        observedAt: observedAt[marker] as never,
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const result = await readLocalUsageHistory(
      { sourceKind: "fixture" as never, providerKey: "fixture", root, maxRecords: 2 },
      request,
      parser as never,
    );
    expect(result.records.map((record) => record.sourceEventId)).toEqual(["newest", "middle"]);
    expect(result.coverage.status).toBe("partial");
    expect(result.coverage.hasMore).toBe(false);
  });

  it("invalidates cached records when a file is replaced in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-history-replace-"));
    const file = join(root, "events.jsonl");
    const parser = ({ line }: { readonly line: string }) => {
      const marker = JSON.parse(line).marker;
      return {
        sourceKind: "fixture",
        sourceInstallationId: "fixture-install",
        sourceSessionId: "fixture-session",
        sourceEventId: marker,
        providerKey: "fixture",
        modelId: "fixture",
        observedAt: "2026-09-09T12:00:00.000Z" as never,
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const stable = join(root, "stable.jsonl");
    await writeFile(file, JSON.stringify({ marker: "old" }));
    await writeFile(stable, JSON.stringify({ marker: "stable" }));
    const options = { sourceKind: "fixture" as never, providerKey: "fixture", root, maxFiles: 2 };
    const first = await readLocalUsageHistory(options, request, parser as never);
    expect(first.records.map((record) => record.sourceEventId)).toEqual(
      expect.arrayContaining(["old", "stable"]),
    );
    await writeFile(file, "");
    const empty = await readLocalUsageHistory(options, request, parser as never);
    expect(empty.records.map((record) => record.sourceEventId)).toEqual(["stable"]);
    expect(empty.coverage.status).toBe("partial");
    expect(empty.coverage.hasMore).toBe(false);
    await writeFile(file, JSON.stringify({ marker: "new" }));
    const second = await readLocalUsageHistory(options, request, parser as never);
    expect(second.records.map((record) => record.sourceEventId)).toEqual(
      expect.arrayContaining(["new", "stable"]),
    );
    expect(second.coverage.status).toBe("ready");
    expect(second.coverage.hasMore).toBe(false);
  });

  it("keeps cached records when a small append extends the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-history-append-"));
    const file = join(root, "events.jsonl");
    const parser = ({ line }: { readonly line: string }) => {
      const marker = JSON.parse(line).marker;
      return {
        sourceKind: "fixture",
        sourceInstallationId: "fixture-install",
        sourceSessionId: "fixture-session",
        sourceEventId: marker,
        providerKey: "fixture",
        modelId: "fixture",
        observedAt: "2026-09-09T12:00:00.000Z" as never,
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    await writeFile(file, JSON.stringify({ marker: "first" }));
    const options = { sourceKind: "fixture" as never, providerKey: "fixture", root };
    const first = await readLocalUsageHistory(options, request, parser as never);
    appendFileSync(file, `\n${JSON.stringify({ marker: "second" })}`);
    const second = await readLocalUsageHistory(options, request, parser as never);
    expect(first.records).toHaveLength(1);
    expect(second.records.map((record) => record.sourceEventId)).toEqual(["first", "second"]);
    expect(second.coverage.status).toBe("ready");
  });

  it("reports partial coverage for malformed input and does not follow symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-history-bounded-"));
    const outside = await mkdtemp(join(tmpdir(), "octant-history-outside-"));
    await writeFile(join(outside, "outside.jsonl"), "not-read\n");
    await symlink(join(outside, "outside.jsonl"), join(root, "linked.jsonl"));
    await writeFile(join(root, "partial.jsonl"), "{malformed}\n");
    const source = createClaudeLocalUsageHistorySource({ root });
    const result = await Effect.runPromise(source.read(request));
    expect(result.records).toEqual([]);
    expect(result.coverage.status).toBe("partial");
    expect(result.coverage.omittedRecordCount).toBeGreaterThan(0);
  });
});
