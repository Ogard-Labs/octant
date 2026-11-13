import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
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
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import {
  registerToolEffectEvents,
  ToolEffectLedger,
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

function hostOn(connection: SqliteConnection) {
  const journal = new Journal({
    connection,
    registry: registerToolEffectEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const ledger = new ToolEffectLedger({
    journal,
    uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`,
    actor,
    clock: () => now,
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

  it("waits for an approval outside any recorded call without writing a record", async () => {
    const host = hostOn(openConnection());

    await expect(whileAwaitingToolApproval(() => Promise.resolve("approved"))).resolves.toBe(
      "approved",
    );

    expect(host.journaled()).toEqual([]);
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
