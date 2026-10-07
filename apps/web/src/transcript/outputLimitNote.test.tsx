import { decodeUtcTimestamp, type TurnMetricsSummary } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { composerThreadDrafts } from "../composer/composerThreadDraftStore";
import { ThreadStatsProvider } from "../threadStats/threadStatsScope";
import {
  OUTPUT_LIMIT_CONTINUE_DRAFT,
  OutputLimitContinueProvider,
  OutputLimitNote,
  TranscriptOutputLimitNote,
} from "./outputLimitNote";

const THREAD_ID = "0b6f7ac4-4d7e-4d07-8f35-2f64d7a2e3a1";

function summary(stopReason: "end-of-turn" | "max-tokens"): TurnMetricsSummary {
  return {
    turns: [
      {
        threadId: THREAD_ID,
        mode: "chat",
        providerInstanceId: "provider" as never,
        modelId: "model" as never,
        stopReason,
        metrics: {
          precision: "unavailable",
          wallMs: 1_000,
        },
        startedAt: decodeUtcTimestamp("2026-10-06T10:00:00.000Z"),
        endedAt: decodeUtcTimestamp("2026-10-06T10:00:01.000Z"),
      },
    ],
    turnCount: 1,
    metrics: {
      turns: 1,
      measuredTurns: 0,
      precision: "unavailable",
      decodeOutputTokens: 0,
      decodeMs: 0,
      toolMs: 0,
      timeToFirstTokenTotalMs: 0,
    },
  };
}

describe("a reply cut off at the output limit", () => {
  it("offers Continue and drafts a follow-up without sending", async () => {
    const user = userEvent.setup();
    const onDraft = vi.fn();
    const onSend = vi.fn();

    render(<OutputLimitNote cutOff onDraft={onDraft} />);

    expect(screen.getByRole("note")).toHaveTextContent("cut off at the output limit");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(onDraft).toHaveBeenCalledWith(OUTPUT_LIMIT_CONTINUE_DRAFT);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("says nothing when the reply finished on its own", () => {
    render(<OutputLimitNote cutOff={false} onDraft={vi.fn()} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("writes the continuation into the composer draft and leaves sending to the person", async () => {
    const user = userEvent.setup();
    render(
      <ThreadStatsProvider
        lineVisible
        onLineVisibleChange={() => undefined}
        subjectKey={THREAD_ID}
        summary={summary("max-tokens")}
      >
        <OutputLimitContinueProvider mode="chat" threadId={THREAD_ID}>
          <TranscriptOutputLimitNote restoreKey={THREAD_ID} />
        </OutputLimitContinueProvider>
      </ThreadStatsProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(composerThreadDrafts.read("chat", THREAD_ID)?.text).toBe(OUTPUT_LIMIT_CONTINUE_DRAFT);
  });
});
