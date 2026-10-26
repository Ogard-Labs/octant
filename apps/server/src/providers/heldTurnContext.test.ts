import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type CorrelationId,
  type ProviderContextBlock,
  type ProviderRuntimeEvent,
  type UtcTimestamp,
} from "@octant/contracts";
import { PROVIDER_CONTEXT_RESTATED } from "@octant/provider-sdk/chat-conformance";
import { describe, expect, it } from "vitest";
import { HeldTurnContext } from "./heldTurnContext";

const sessionId = decodeProviderSessionId("90000000-0000-4000-8000-000000000001");
const fields = {
  instanceId: decodeProviderInstanceId("90000000-0000-4000-8000-000000000002"),
  sessionId,
  sequence: 1,
  correlationId: "90000000-0000-4000-8000-000000000003" as CorrelationId,
  occurredAt: "2026-10-25T10:00:00.000Z" as UtcTimestamp,
};
const completed: ProviderRuntimeEvent = { ...fields, kind: "completed" };
const keptUsage: ProviderRuntimeEvent = {
  ...fields,
  kind: "usage",
  inputTokens: 100,
  outputTokens: 10,
  promptRetention: "kept",
};
const instructions = { kind: "instructions", text: "Stay concise." } as const;
const mention = { kind: "user-message", text: "Mentioned thread." } as const;

function completeTurn(
  ledger: HeldTurnContext,
  resumed: boolean,
  context: ReadonlyArray<ProviderContextBlock>,
) {
  const delta = ledger.forTurn({ sessionId, resumed, context });
  ledger.observe(keptUsage);
  ledger.observe(completed);
  return delta;
}

describe("HeldTurnContext", () => {
  it("sends standing context once, then only the new turn on the resumed session", () => {
    const ledger = new HeldTurnContext();
    expect(completeTurn(ledger, false, [instructions]).context).toEqual([instructions]);
    expect(completeTurn(ledger, true, [instructions, mention]).context).toEqual([mention]);
    expect(completeTurn(ledger, true, [instructions]).context).toEqual([]);
  });

  it("resends standing context after a turn that did not complete", () => {
    const ledger = new HeldTurnContext();
    ledger.forTurn({ sessionId, resumed: false, context: [instructions] });
    ledger.observe({
      ...fields,
      kind: "failed",
      failure: { category: "provider-failed", message: "The runtime stopped." },
    });
    expect(ledger.forTurn({ sessionId, resumed: true, context: [instructions] }).context).toEqual([
      instructions,
    ]);
  });

  it("keeps sending standing context to a runtime that never says it keeps its prompts", () => {
    const ledger = new HeldTurnContext();
    ledger.forTurn({ sessionId, resumed: false, context: [instructions] });
    ledger.observe(completed);
    expect(ledger.forTurn({ sessionId, resumed: true, context: [instructions] }).context).toEqual([
      instructions,
    ]);
  });

  it("holds nothing for a session started afresh under the same id", () => {
    const ledger = new HeldTurnContext();
    completeTurn(ledger, false, [instructions]);
    expect(completeTurn(ledger, false, [instructions]).context).toEqual([instructions]);
  });

  it("resends standing context once the runtime compacts the session", () => {
    const ledger = new HeldTurnContext();
    completeTurn(ledger, false, [instructions]);
    ledger.forTurn({ sessionId, resumed: true, context: [instructions] });
    ledger.observe({ ...fields, kind: "context-compacted", trigger: "automatic" });
    ledger.observe(completed);
    expect(completeTurn(ledger, true, [instructions]).context).toEqual([instructions]);
  });

  it("resends standing context after a requested compaction", () => {
    const ledger = new HeldTurnContext();
    completeTurn(ledger, false, [instructions]);
    ledger.forget(sessionId);
    expect(completeTurn(ledger, true, [instructions]).context).toEqual([instructions]);
  });

  it("restates the standing context when a held block is withdrawn", () => {
    const ledger = new HeldTurnContext();
    const skill = { kind: "instructions", text: "Review as a skeptic." } as const;
    ledger.forTurn({ sessionId, resumed: false, context: [instructions, skill] });
    ledger.observe(keptUsage);
    ledger.observe(completed);
    expect(ledger.forTurn({ sessionId, resumed: true, context: [instructions] }).context).toEqual([
      { kind: "instructions", text: PROVIDER_CONTEXT_RESTATED },
      instructions,
    ]);
    ledger.observe(keptUsage);
    ledger.observe(completed);
    expect(completeTurn(ledger, true, [instructions]).context).toEqual([]);
  });

  it("restates everything after a restating turn fails, since the runtime may have kept its restatement", () => {
    const ledger = new HeldTurnContext();
    const skill = { kind: "instructions", text: "Review as a skeptic." } as const;
    completeTurn(ledger, false, [instructions, skill]);
    ledger.forTurn({ sessionId, resumed: true, context: [instructions] });
    ledger.observe(keptUsage);
    ledger.observe({
      ...fields,
      kind: "failed",
      failure: { category: "provider-failed", message: "The runtime stopped." },
    });
    expect(
      ledger.forTurn({ sessionId, resumed: true, context: [instructions, skill] }).context,
    ).toEqual([instructions, skill]);
  });
});
