import { appendFileSync } from "node:fs";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createClaudeLocalUsageHistorySource,
  createCodexLocalUsageHistorySource,
} from "./providerUsageHistorySources";
import { readLocalUsageHistory } from "./localUsageHistoryReader";

const request = {
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-30T23:59:59.999Z",
  timeZone: "UTC",
} as never;

describe("local provider usage history", () => {
  it("projects Codex per-turn token_count events without cumulative double counting", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-codex-history-"));
    await writeFile(
      join(root, "rollout-2026-09-09T10-00-00-00000000-0000-4000-8000-000000000001.jsonl"),
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
              total_token_usage: { input_tokens: 50, output_tokens: 8 },
              last_token_usage: { input_tokens: 20, cached_input_tokens: 15, output_tokens: 3 },
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
              total_token_usage: { input_tokens: 50, output_tokens: 8 },
              last_token_usage: { input_tokens: 20, cached_input_tokens: 15, output_tokens: 3 },
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
    expect(result.coverage.status).toBe("ready");
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
        cost: expect.objectContaining({ amount: 0.001, kind: "api-estimate", currency: "USD" }),
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
    });
    expect(result.records[1]?.cost).toBeUndefined();
    expect(result.records[1]?.cacheWriteInputTokens).toBe(5);
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
