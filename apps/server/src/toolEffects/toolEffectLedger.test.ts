import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventActor,
  TOOL_EFFECT_AGGREGATE_TYPE,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { RoutineProposalService } from "../automation/routineProposalService";
import { BrowserToolApprovalService } from "../browser/browserToolApprovalService";
import { NativeHarnessQuestionStore } from "../harness/nativeHarnessQuestions";
import { ImageGenerationOfferService } from "../image/imageGenerationOfferService";
import { ProjectMemoryProposalService } from "../projectMemory/projectMemoryProposalService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { withRecordedApprovalAnswers } from "./recordedApprovalAnswers";
import {
  executingToolCallId,
  registerToolEffectEvents,
  ToolEffectLedger,
  whileApprovalWaited,
  whileAwaitingToolApproval,
} from "./toolEffectLedger";

const directories: string[] = [];
const now = "2026-11-12T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "system",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const threadId = "00000000-0000-4000-8000-000000000020";
const turnId = "00000000-0000-4000-8000-000000000021";
const otherTurnId = "00000000-0000-4000-8000-000000000022";

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-tool-effects-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

let counter = 0;

function hostOn(connection: SqliteConnection, clock: () => string = () => now) {
  const journal = new Journal({
    connection,
    registry: registerToolEffectEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock,
  });
  const ledger = new ToolEffectLedger({
    journal,
    uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`,
    actor,
    clock,
  });
  const journaled = () =>
    journal
      .replayAggregate({
        aggregateType: TOOL_EFFECT_AGGREGATE_TYPE,
        aggregateId: turnId,
        afterVersion: 0,
        limit: 1_000,
      })
      .map((envelope) => ({ eventName: envelope.eventName, payload: envelope.payload }));
  return { journal, ledger, journaled };
}

function toolSet(
  names: ReadonlyArray<string>,
  execute: AppManagedToolSet["execute"],
): AppManagedToolSet {
  return {
    definitions: names.map((name) => ({
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: "object", properties: {} },
    })),
    execute,
  };
}

function runtimeEvent(event: Record<string, unknown>): ProviderRuntimeEvent {
  return event as never;
}

describe("tool effect ledger", () => {
  it("journals a tool call's intent before the tool takes effect, and that it settled after", async () => {
    const host = hostOn(openConnection());
    let seenByEffect: ReturnType<typeof host.journaled> = [];
    const tools = host.ledger.forTurn({ threadId, turnId }).tools(
      toolSet(["shell"], async () => {
        seenByEffect = host.journaled();
        return { result: { ok: true } };
      }),
    );

    await tools.execute({
      name: "shell",
      inputJson: '{"command":"rm -rf build"}',
      toolCallId: "call-1",
    });

    expect(seenByEffect).toEqual([
      {
        eventName: "tool-effect-intended@1",
        payload: {
          threadId,
          turnId,
          toolCallId: "call-1",
          toolName: "shell",
          effect: "side-effecting",
          origin: "host",
        },
      },
    ]);
    expect(host.journaled().map((entry) => entry.eventName)).toEqual([
      "tool-effect-intended@1",
      "tool-effect-settled@1",
    ]);
    expect(host.journaled()[1]?.payload).toMatchObject({
      toolCallId: "call-1",
      outcome: "succeeded",
    });
    expect(host.ledger.certainty(turnId)).toEqual({ kind: "settled" });
  });

  it("names the executing call to asks it raises while it runs", async () => {
    const host = hostOn(openConnection());
    let ambient: string | undefined;
    const tools = host.ledger.forTurn({ threadId, turnId }).tools(
      toolSet(["shell"], async () => {
        ambient = executingToolCallId();
        return { result: { ok: true } };
      }),
    );
    await tools.execute({ name: "shell", inputJson: "{}", toolCallId: "call-9" });
    expect(ambient).toBe("call-9");
    expect(executingToolCallId()).toBeUndefined();
  });

  it("records the tool's name and never its arguments", async () => {
    const host = hostOn(openConnection());
    const tools = host.ledger
      .forTurn({ threadId, turnId })
      .tools(toolSet(["shell"], async () => ({ result: { output: "secret-output" } })));

    await tools.execute({ name: "shell", inputJson: '{"command":"echo secret-argument"}' });

    const stored = JSON.stringify(host.journaled());
    expect(stored).not.toContain("secret-argument");
    expect(stored).not.toContain("secret-output");
  });

  it("leaves the intent unsettled when the host stops between the intent and the effect", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    const tools = before.ledger.forTurn({ threadId, turnId }).tools(
      // The host stops here: the call never returns, so nothing settles it.
      toolSet(["edit"], () => new Promise(() => {})),
    );
    void tools.execute({ name: "edit", inputJson: "{}", toolCallId: "call-1" });
    await Promise.resolve();

    const restarted = hostOn(connection);

    expect(restarted.ledger.certainty(turnId)).toEqual({ kind: "uncertain", toolName: "edit" });
    expect(restarted.ledger.certainty(otherTurnId)).toEqual({ kind: "settled" });
  });

  it("reads a turn whose only unsettled calls are read-only as settled", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    const tools = before.ledger
      .forTurn({ threadId, turnId })
      .tools(toolSet(["read", "octant_github"], () => new Promise(() => {})));
    void tools.execute({ name: "read", inputJson: "{}", toolCallId: "call-1" });
    void tools.execute({ name: "octant_github", inputJson: "{}", toolCallId: "call-2" });
    await Promise.resolve();

    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({ kind: "settled" });
  });

  it("settles a call whose tool failed or threw", async () => {
    const host = hostOn(openConnection());
    const tools = host.ledger.forTurn({ threadId, turnId }).tools(
      toolSet(["shell", "edit"], async ({ name }) => {
        if (name === "edit") throw new Error("disk full");
        return { result: { error: "command-refused" }, isError: true };
      }),
    );

    await tools.execute({ name: "shell", inputJson: "{}", toolCallId: "call-1" });
    await expect(
      tools.execute({ name: "edit", inputJson: "{}", toolCallId: "call-2" }),
    ).rejects.toThrow("disk full");

    expect(
      host
        .journaled()
        .flatMap((entry) =>
          entry.eventName === "tool-effect-settled@1"
            ? [(entry.payload as { readonly outcome: string }).outcome]
            : [],
        ),
    ).toEqual(["failed", "failed"]);
    expect(host.ledger.certainty(turnId)).toEqual({ kind: "settled" });
  });

  it("refuses to run a tool whose intent the journal did not accept", async () => {
    const host = hostOn(openConnection());
    let ran = false;
    const tools = host.ledger
      // A turn id the journal cannot key an aggregate by.
      .forTurn({ threadId, turnId: "not-a-turn" })
      .tools(
        toolSet(["shell"], async () => {
          ran = true;
          return { result: {} };
        }),
      );

    await expect(tools.execute({ name: "shell", inputJson: "{}" })).resolves.toEqual({
      result: { error: "tool-call-unrecorded" },
      isError: true,
    });
    expect(ran).toBe(false);
  });

  it("records nothing for a tool the set does not offer", async () => {
    const host = hostOn(openConnection());
    const tools = host.ledger
      .forTurn({ threadId, turnId })
      .tools(
        toolSet(["read"], async () => ({ result: { error: "tool-unavailable" }, isError: true })),
      );

    await tools.execute({ name: "shell", inputJson: "{}" });

    expect(host.journaled()).toEqual([]);
  });

  it("holds a runtime's own tool that reported a start and no finish, and clears it on the finish", () => {
    const connection = openConnection();
    const before = hostOn(connection);
    const turn = before.ledger.forTurn({ threadId, turnId });
    turn.observe(runtimeEvent({ kind: "tool-start", toolCallId: "rt-1", toolName: "Bash" }));
    turn.observe(runtimeEvent({ kind: "tool-start", toolCallId: "rt-2", toolName: "Read" }));
    turn.observe(runtimeEvent({ kind: "tool-success", toolCallId: "rt-1", summary: "done" }));

    // A runtime's tool is never declared read-only, whatever it is called.
    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({
      kind: "uncertain",
      toolName: "Read",
    });

    turn.observe(runtimeEvent({ kind: "tool-failure", toolCallId: "rt-2", message: "denied" }));
    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({ kind: "settled" });
  });

  it("gives the same answer when the journal is replayed twice", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    const tools = before.ledger
      .forTurn({ threadId, turnId })
      .tools(
        toolSet(["shell", "edit"], ({ name }) =>
          name === "edit" ? new Promise(() => {}) : Promise.resolve({ result: {} }),
        ),
      );
    await tools.execute({ name: "shell", inputJson: "{}", toolCallId: "call-1" });
    void tools.execute({ name: "edit", inputJson: "{}", toolCallId: "call-2" });
    await Promise.resolve();

    const first = hostOn(connection);
    const second = hostOn(connection);

    expect(first.ledger.certainty(turnId)).toEqual({ kind: "uncertain", toolName: "edit" });
    expect(first.ledger.certainty(turnId)).toEqual(second.ledger.certainty(turnId));
    // Reading appends nothing: the turn's record is what the calls wrote.
    expect(second.journaled()).toHaveLength(3);
  });

  it("keeps recording a turn's calls after a restart, on the same record", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    await before.ledger
      .forTurn({ threadId, turnId })
      .tools(toolSet(["shell"], async () => ({ result: {} })))
      .execute({ name: "shell", inputJson: "{}", toolCallId: "call-1" });

    const restarted = hostOn(connection);
    await restarted.ledger
      .forTurn({ threadId, turnId })
      .tools(toolSet(["shell"], async () => ({ result: {} })))
      .execute({ name: "shell", inputJson: "{}", toolCallId: "call-2" });

    expect(restarted.journaled()).toHaveLength(4);
  });

  it("continues a turn whose tool was still waiting for its own approval when the host stopped", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    const tools = before.ledger.forTurn({ threadId, turnId }).tools(
      // The host stops while the person has not answered: nothing ran.
      toolSet(["shell"], () => whileAwaitingToolApproval(() => new Promise(() => {}))),
    );
    void tools.execute({ name: "shell", inputJson: "{}", toolCallId: "call-1" });
    await Promise.resolve();

    expect(before.journaled().map((entry) => entry.eventName)).toEqual([
      "tool-effect-intended@1",
      "tool-effect-awaiting-approval@1",
    ]);
    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({ kind: "settled" });
  });

  it("holds a turn whose tool was approved and running when the host stopped", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    let seenByEffect: ReadonlyArray<string> = [];
    const tools = before.ledger.forTurn({ threadId, turnId }).tools(
      toolSet(["shell"], async () => {
        await whileAwaitingToolApproval(() => Promise.resolve("approved"));
        seenByEffect = before.journaled().map((entry) => entry.eventName);
        return new Promise(() => {});
      }),
    );
    void tools.execute({ name: "shell", inputJson: "{}", toolCallId: "call-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The answered approval is on record before the tool goes on.
    expect(seenByEffect).toEqual([
      "tool-effect-intended@1",
      "tool-effect-awaiting-approval@1",
      "tool-effect-intended@1",
    ]);
    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({
      kind: "uncertain",
      toolName: "shell",
    });
  });

  it("settles a call whose approval was refused", async () => {
    const host = hostOn(openConnection());
    const tools = host.ledger.forTurn({ threadId, turnId }).tools(
      toolSet(["shell"], async () => {
        const answer = await whileAwaitingToolApproval(() => Promise.resolve("denied"));
        return { result: { error: answer }, isError: true };
      }),
    );

    await tools.execute({ name: "shell", inputJson: "{}", toolCallId: "call-1" });

    expect(host.journaled().at(-1)).toMatchObject({
      eventName: "tool-effect-settled@1",
      payload: { outcome: "failed" },
    });
    expect(host.ledger.certainty(turnId)).toEqual({ kind: "settled" });
  });

  it("records the answer before an ask whose answer acts before the tool hears it", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    let seenByAnswer: ReadonlyArray<string> = [];
    const tools = before.ledger.forTurn({ threadId, turnId }).tools(
      toolSet(["octant_memory"], async () => {
        // The person's confirm applies the change before the tool hears it,
        // as a memory proposal's does, and the host stops right after.
        await whileAwaitingToolApproval((answered) => {
          answered();
          seenByAnswer = before.journaled().map((entry) => entry.eventName);
          return new Promise(() => {});
        });
        return { result: {} };
      }),
    );
    void tools.execute({ name: "octant_memory", inputJson: "{}", toolCallId: "call-1" });
    await Promise.resolve();

    expect(seenByAnswer).toEqual([
      "tool-effect-intended@1",
      "tool-effect-awaiting-approval@1",
      "tool-effect-intended@1",
    ]);
    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({
      kind: "uncertain",
      toolName: "octant_memory",
    });
  });

  it("continues a turn whose runtime tool was waiting for the runtime's approval request", () => {
    const connection = openConnection();
    const before = hostOn(connection);
    const turn = before.ledger.forTurn({ threadId, turnId });
    turn.observe(
      runtimeEvent({ kind: "tool-start", sessionId: "s-1", toolCallId: "rt-1", toolName: "Bash" }),
    );
    turn.observe(
      runtimeEvent({
        kind: "approval-request",
        sessionId: "s-1",
        requestId: "req-1",
        action: "shell",
        description: "Run rm -rf build",
        toolCallId: "rt-1",
      }),
    );

    // Nothing ran: the restart continues the turn, and the runtime asks again.
    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({ kind: "settled" });

    // The answer is on record before the runtime hears it.
    expect(before.ledger.approvalAnswered({ sessionId: "s-1", requestId: "req-1" })).toBe(true);
    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({
      kind: "uncertain",
      toolName: "Bash",
    });
    // A second answer to the same request has nothing left to record.
    expect(before.ledger.approvalAnswered({ sessionId: "s-1", requestId: "req-1" })).toBe(true);
    expect(before.journaled()).toHaveLength(3);
  });

  it("records a runtime approval's answer before the runtime hears it, and refuses the call when it cannot", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    const heard: Array<{ readonly approved: boolean; readonly frames: number }> = [];
    const driver = withRecordedApprovalAnswers(
      {
        acquire: () =>
          Effect.succeed({
            answerApproval: (answer: { readonly approved: boolean }) =>
              Effect.sync(() => {
                heard.push({ approved: answer.approved, frames: before.journaled().length });
              }),
          }),
      } as never,
      before.ledger,
    );
    const turn = before.ledger.forTurn({ threadId, turnId });
    turn.observe(
      runtimeEvent({ kind: "tool-start", sessionId: "s-1", toolCallId: "rt-1", toolName: "Bash" }),
    );
    turn.observe(
      runtimeEvent({
        kind: "approval-request",
        sessionId: "s-1",
        requestId: "req-1",
        action: "shell",
        description: "Run a command",
        toolCallId: "rt-1",
      }),
    );
    const refusing = withRecordedApprovalAnswers(driver, { approvalAnswered: () => false });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const answering = yield* driver.acquire({} as never);
          yield* answering.answerApproval({
            sessionId: "s-1",
            requestId: "req-1",
            approved: true,
          } as never);
          const unrecorded = yield* refusing.acquire({} as never);
          yield* unrecorded.answerApproval({
            sessionId: "s-1",
            requestId: "req-2",
            approved: true,
          } as never);
        }),
      ),
    );

    expect(heard).toEqual([
      // intended, awaiting, intended again: all before the runtime heard "allow".
      { approved: true, frames: 3 },
      { approved: false, frames: 3 },
    ]);
  });

  it("keeps holding a runtime's approval request that names no call it reported", () => {
    const connection = openConnection();
    const turn = hostOn(connection).ledger.forTurn({ threadId, turnId });
    turn.observe(
      runtimeEvent({ kind: "tool-start", sessionId: "s-1", toolCallId: "rt-1", toolName: "Bash" }),
    );
    turn.observe(
      runtimeEvent({
        kind: "approval-request",
        sessionId: "s-1",
        requestId: "req-1",
        action: "shell",
        description: "Run a command",
      }),
    );

    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({
      kind: "uncertain",
      toolName: "Bash",
    });
  });

  it("never holds a turn for a runtime's second report of a host tool the host records", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    const turn = before.ledger.forTurn({ threadId, turnId });
    const host = toolSet(["read"], () => new Promise(() => {}));
    // An ACP agent titles its call freely, so the start alone names nothing.
    turn.observe(
      runtimeEvent({ kind: "tool-start", toolCallId: "tool-1", toolName: "read (octant MCP)" }),
      host,
    );
    turn.observe(
      runtimeEvent({
        kind: "tool-request",
        requestId: "acp-tool-1",
        toolName: "read",
        inputJson: "{}",
        toolCallId: "tool-1",
      }),
      host,
    );
    void turn.tools(host).execute({ name: "read", inputJson: "{}", toolCallId: "acp-tool-1" });
    await Promise.resolve();

    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({ kind: "settled" });
  });

  it("still holds a runtime tool a host request names when the host does not offer that tool", () => {
    const connection = openConnection();
    const turn = hostOn(connection).ledger.forTurn({ threadId, turnId });
    const host = toolSet(["read"], async () => ({ result: {} }));
    turn.observe(runtimeEvent({ kind: "tool-start", toolCallId: "tool-1", toolName: "Run" }), host);
    turn.observe(
      runtimeEvent({
        kind: "tool-request",
        requestId: "acp-tool-1",
        toolName: "shell",
        inputJson: "{}",
        toolCallId: "tool-1",
      }),
      host,
    );

    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({
      kind: "uncertain",
      toolName: "Run",
    });
  });

  it("waits for an approval outside any recorded call without writing a record", async () => {
    const host = hostOn(openConnection());

    await expect(whileAwaitingToolApproval(() => Promise.resolve("approved"))).resolves.toBe(
      "approved",
    );

    expect(host.journaled()).toEqual([]);
  });

  it("bills a host ask's wait to the recorded call without touching its record", async () => {
    let clockNow = now;
    const host = hostOn(openConnection(), () => clockNow);
    const waits: number[] = [];
    const tools = host.ledger.forTurn({ threadId, turnId }).tools(
      toolSet(["shell"], async () => {
        const answer = await whileApprovalWaited(async () => {
          clockNow = "2026-11-12T12:04:00.000Z";
          return "approved";
        });
        return { result: { answer } };
      }),
    );

    await tools.execute({
      name: "shell",
      inputJson: "{}",
      toolCallId: "call-1",
      onApprovalWait: (waitMs) => waits.push(waitMs),
    });

    // The wait is measured, not run time; the record carries only what ran.
    expect(waits).toEqual([240_000]);
    expect(host.journaled().map((entry) => entry.eventName)).toEqual([
      "tool-effect-intended@1",
      "tool-effect-settled@1",
    ]);
  });

  it("never holds a turn for a read-only host tool its runtime also reports starting", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    const turn = before.ledger.forTurn({ threadId, turnId });
    const host = toolSet(["read", "octant_github"], () => new Promise(() => {}));
    // The runtime names the bridged call by its own id and its own spelling
    // of the tool, so nothing pairs it with the host's record of the call.
    turn.observe(
      runtimeEvent({ kind: "tool-start", toolCallId: "rt-1", toolName: "mcp__octant__read" }),
      host,
    );
    turn.observe(
      runtimeEvent({ kind: "tool-start", toolCallId: "rt-2", toolName: "octant_github" }),
      host,
    );
    void turn.tools(host).execute({ name: "read", inputJson: "{}", toolCallId: "request-1" });
    await Promise.resolve();

    expect(before.journaled().map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ toolCallId: "request-1", effect: "read-only", origin: "host" }),
    ]);
    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({ kind: "settled" });
  });

  it("still holds for a runtime tool that only resembles a host tool's name", () => {
    const connection = openConnection();
    const turn = hostOn(connection).ledger.forTurn({ threadId, turnId });
    const host = toolSet(["read"], async () => ({ result: {} }));

    // Another server's tool of the same name is the runtime's own.
    turn.observe(
      runtimeEvent({ kind: "tool-start", toolCallId: "rt-1", toolName: "mcp__files__read" }),
      host,
    );

    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({
      kind: "uncertain",
      toolName: "mcp__files__read",
    });
  });

  it("closes the calls an agent run left open when the run starts again", async () => {
    const connection = openConnection();
    const before = hostOn(connection);
    void before.ledger
      .forTurn({ threadId, turnId })
      .tools(toolSet(["shell"], () => new Promise(() => {})))
      .execute({ name: "shell", inputJson: "{}", toolCallId: "call-1" });
    await Promise.resolve();
    const restarted = hostOn(connection);
    expect(restarted.ledger.certainty(turnId)).toEqual({ kind: "uncertain", toolName: "shell" });

    restarted.ledger.supersede({ threadId, turnId });

    expect(restarted.journaled().at(-1)).toMatchObject({
      eventName: "tool-effect-settled@1",
      payload: { toolCallId: "call-1", outcome: "superseded" },
    });
    expect(hostOn(connection).ledger.certainty(turnId)).toEqual({ kind: "settled" });
  });
});

describe("asks that wait for a person's answer", () => {
  const windowId = "10000000-0000-4000-8000-000000000001" as never;
  const projectId = "10000000-0000-4000-8000-000000000002" as never;
  const authority = {
    hostId: "20000000-0000-4000-8000-000000000001",
    mode: "code",
    providerInstanceId: "30000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  } as never;
  let ids = 0;
  const uuid = () => `bbbbbbbb-bbbb-4bbb-8bbb-${(++ids).toString(16).padStart(12, "0")}`;

  /**
   * Runs `ask` as a recorded call's wait and stops the host while it waits:
   * the turn continues after the restart (it asks again), and nothing ran.
   */
  async function cutOffWhileAsking(ask: () => Promise<unknown>) {
    const connection = openConnection();
    const before = hostOn(connection);
    void before.ledger
      .forTurn({ threadId, turnId })
      .tools(toolSet(["ask"], async () => ({ result: await ask() })))
      .execute({ name: "ask", inputJson: "{}", toolCallId: "call-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      frames: before.journaled().map((entry) => entry.eventName),
      afterRestart: hostOn(connection).ledger.certainty(turnId),
    };
  }

  const waiting = {
    frames: ["tool-effect-intended@1", "tool-effect-awaiting-approval@1"],
    afterRestart: { kind: "settled" },
  };

  it("continues a turn cut off while a question waits for the person", async () => {
    const questions = new NativeHarnessQuestionStore({
      sessions: {
        ensure: () => undefined,
        askQuestion: () => undefined,
        settleQuestion: () => undefined,
        read: () => undefined,
      } as never,
      uuid,
      clock: () => now,
    });
    expect(
      await cutOffWhileAsking(() =>
        questions.ask({
          threadId,
          mode: "code",
          lead: {} as never,
          prompt: "Which branch?",
          options: [],
        }),
      ),
    ).toEqual(waiting);
  });

  it("continues a turn cut off while an image offer waits for the person", async () => {
    const offers = new ImageGenerationOfferService({ wait: () => new Promise(() => {}) });
    expect(await cutOffWhileAsking(() => offers.offer({ windowId, offer: {} as never }))).toEqual(
      waiting,
    );
  });

  it("continues a turn cut off on a Browser site question, and holds one on a download question", async () => {
    const approvals = new BrowserToolApprovalService({
      uuid,
      now: () => Date.parse(now),
      authorityIsCurrent: () => true,
    });
    const site = { windowId, threadId, authority, origin: "https://example.com" };
    expect(await cutOffWhileAsking(() => approvals.request(site))).toEqual(waiting);
    // A download's question can follow the click that started it.
    expect(
      await cutOffWhileAsking(() =>
        approvals.request({
          ...site,
          download: { name: "report.pdf", sizeBytes: 10, mediaType: "application/pdf" },
        }),
      ),
    ).toEqual({
      frames: ["tool-effect-intended@1"],
      afterRestart: { kind: "uncertain", toolName: "ask" },
    });
  });

  it("puts a memory proposal's call back on record before the confirm writes", async () => {
    let framesAtWrite: ReadonlyArray<string> = [];
    let host: ReturnType<typeof hostOn> | undefined;
    const proposals = new ProjectMemoryProposalService({
      uuid,
      now: () => Date.parse(now),
      apply: async () => {
        framesAtWrite = host?.journaled().map((entry) => entry.eventName) ?? [];
        return new Promise(() => {});
      },
    });
    const propose = () =>
      proposals.propose({
        windowId,
        proposal: {
          projectId,
          mode: "code",
          threadId,
          change: { kind: "create", memoryKind: "fact", content: "Waits for the person." },
          expectedVersion: 0 as never,
        },
      });
    expect(await cutOffWhileAsking(propose)).toEqual(waiting);

    host = hostOn(openConnection());
    void host.ledger
      .forTurn({ threadId, turnId })
      .tools(toolSet(["ask"], async () => ({ result: await propose() })))
      .execute({ name: "ask", inputJson: "{}", toolCallId: "call-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const asked = proposals.list(windowId).at(-1);
    if (asked === undefined) throw new Error("No proposal waits.");
    void proposals.decide(windowId, { proposalId: asked.proposalId, decision: "confirm" } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(framesAtWrite).toEqual([
      "tool-effect-intended@1",
      "tool-effect-awaiting-approval@1",
      "tool-effect-intended@1",
    ]);
  });

  it("puts a routine proposal's call back on record when its answer is claimed", async () => {
    const proposals = new RoutineProposalService({ uuid, now: () => Date.parse(now) });
    const propose = () =>
      proposals.propose({
        windowId,
        proposal: {
          threadId: threadId as never,
          mode: "work",
          projectId,
          displayName: "Soon",
          taskPrompt: "Check.",
          trigger: { kind: "once", scheduledAt: "2026-11-13T09:00:00.000Z" as never },
          missedRunPolicy: "skip",
          firstRunAt: "2026-11-13T09:00:00.000Z" as never,
        },
      });
    expect(await cutOffWhileAsking(propose)).toEqual(waiting);

    const host = hostOn(openConnection());
    void host.ledger
      .forTurn({ threadId, turnId })
      .tools(toolSet(["ask"], async () => ({ result: await propose() })))
      .execute({ name: "ask", inputJson: "{}", toolCallId: "call-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const asked = proposals.list(windowId).at(-1);
    if (asked === undefined) throw new Error("No proposal waits.");
    // The route creates the routine only after it holds the claim.
    expect(proposals.claim(windowId, asked.proposalId)).toBeDefined();

    expect(host.journaled().map((entry) => entry.eventName)).toEqual([
      "tool-effect-intended@1",
      "tool-effect-awaiting-approval@1",
      "tool-effect-intended@1",
    ]);
  });
});
