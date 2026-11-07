import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import {
  EventActor,
  decodeToolActionAuthority,
  decodeToolActionRequest,
  nativeHarnessToolCapabilityId,
} from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { ExternalContentClearStore } from "./externalContentClearStore";
import { ExternalContentIngestionStore } from "./externalContentIngestionStore";
import { readThreadExternalContentTaint } from "./externalContentTaintProjection";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";

// A deterministic Auto reviewer has approved these exact calls. Count only
// outside-content prompts, never claim this is a live provider's total count.
it("measures fixed Auto research → edit → test outside-content prompts with and without the existing person clear", () => {
  const directory = mkdtempSync(join(tmpdir(), "octant-access-prompt-measure-"));
  const connection = openSqlite(join(directory, "host.sqlite3"));
  const clock = () => "2026-11-02T21:00:00.000Z";
  const ids = {
    thread: "82000000-0000-4000-8000-000000000002",
    window: "82000000-0000-4000-8000-000000000001",
    actor: "82000000-0000-4000-8000-000000000099",
  };
  try {
    applyMigrations(connection, MIGRATIONS, clock);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock,
    });
    const ingestions = new ExternalContentIngestionStore({
      connection,
      journal,
      uuid: randomUUID,
      clock,
      actor: Schema.decodeUnknownSync(EventActor)({ kind: "system", actorId: ids.actor }),
    });
    const clears = new ExternalContentClearStore({
      connection,
      journal,
      uuid: randomUUID,
      clock,
      actor: Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor }),
    });
    const granted = decodeToolActionAuthority({
      hostId: "82000000-0000-4000-8000-000000000030",
      mode: "code",
      projectId: "82000000-0000-4000-8000-000000000020",
      rootId: "82000000-0000-4000-8000-000000000040",
      worktreeId: "82000000-0000-4000-8000-000000000041",
      providerInstanceId: "82000000-0000-4000-8000-000000000010",
      extension: { kind: "core" },
    });
    const authority = new ToolCallAuthorityService({
      resolveGrantedAuthority: () => granted,
      resolveLiveFacts: () => ({
        providerAppManagedTools: "supported",
        host: { computerUseEnabled: true },
        executionPolicy: "approval-gated",
        approvalSatisfied: true,
        externalContentIngested: readThreadExternalContentTaint(connection, ids.thread)
          .externalContentIngested,
      }),
      clock,
    });
    const call = (tool: "web-search" | "edit" | "bash", args: unknown) =>
      authority.authorize({
        threadId: ids.thread,
        request: decodeToolActionRequest({
          actionId: randomUUID(),
          correlationId: randomUUID(),
          capability: { id: nativeHarnessToolCapabilityId(tool), version: 1 },
          authority: granted,
          intent: "Fixed research, edit and test measurement.",
          approval: { kind: "approved", approvalId: randomUUID() },
        }),
        arguments: args,
      });
    const research = () => {
      expect(call("web-search", { query: "public documentation on unit testing" }).kind).toBe(
        "allow",
      );
      expect(
        ingestions.record({
          threadId: ids.thread,
          provenance: { origin: "tool-result", sourceLabel: "web-search" },
          contentReference: "fixed-research-result",
          correlationId: randomUUID(),
          authorized: true,
        }).kind,
      ).toBe("recorded");
    };
    const clear = () =>
      expect(
        clears.clear({
          threadId: ids.thread,
          windowId: ids.window,
          expectedVersion: clears.read(ids.thread).version,
          principal: "local-window",
          turn: "idle",
        }).kind,
      ).toBe("cleared");
    const editAndTest = () => [
      call("edit", { path: "src/example.ts", oldText: "before", newText: "after" }),
      call("bash", { command: "bun run test" }),
    ];
    const count = (decisions: ReturnType<typeof editAndTest>) =>
      decisions.filter(
        (decision) =>
          decision.kind === "prompt" && decision.reason === "taint-requires-fresh-confirmation",
      ).length;
    research();
    const withoutClear = count(editAndTest());
    expect(withoutClear).toBe(2);
    clear();
    const withClear = count(editAndTest());
    expect(withClear).toBe(0);
    research();
    expect(count(editAndTest())).toBe(2);
    console.info(
      JSON.stringify({
        scenario: "fixed Auto research-edit-test",
        outsideContentPrompts: { withoutClear, withClear, afterNewResearch: 2 },
        provider: "deterministic approval port; no live call",
        actualStores: "SQLite Journal ingestion/clear and ToolCallAuthorityService",
      }),
    );
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
