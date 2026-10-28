import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventActor,
  NativeHarnessSessionView,
  decodeHostAnswer,
  decodeNativeHarnessApproval,
  decodeNativeHarnessSlotCandidate,
  decodeNativeHarnessSlotId,
  decodeWindowId,
} from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { registerNativeHarnessEvents } from "./nativeHarnessEvents";
import { createNativeHarnessSessionRouteHandler } from "./nativeHarnessSessionRoutes";
import { NativeHarnessSessionStore } from "./nativeHarnessSessionStore";

const threadId = "00000000-0000-4000-8000-000000000020";
const sessionId = "00000000-0000-4000-8000-000000000021";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000611");

function resumeFrom(status: "recovery-required" | "paused-by-user") {
  const lifted = vi.fn();
  const handler = createNativeHarnessSessionRouteHandler({
    windowAuthorityStore: new WindowAuthorityStore(),
    store: {
      read: () => ({ session: { id: sessionId, version: 3, status, mode: "code" } }),
      pause: () => false,
      resume: () => true,
      turnInFlight: () => false,
    } as never,
    followUps: {} as never,
    authorizeThread: () => true,
    onRecoveryLifted: lifted,
  });
  const request = new Request(`http://127.0.0.1/api/native-harness/sessions/${threadId}/commands`, {
    method: "POST",
    body: JSON.stringify({
      kind: "resume-native-harness-session",
      sessionId,
      expectedVersion: 3,
    }),
  });
  bindPrincipalRouteContext(request, {
    principal: { kind: "local-window" } as never,
    scopeId: windowId,
  });
  return { lifted, response: handler(request) };
}

describe("native harness session routes", () => {
  it("tells the thread's other records the cut-off turn is settled once a resume clears a restart recovery", async () => {
    const { lifted, response } = resumeFrom("recovery-required");
    expect((await response)?.status).toBe(200);
    expect(lifted).toHaveBeenCalledExactlyOnceWith({ threadId, mode: "code" });
  });

  it("settles nothing elsewhere when a resume only lifts a pause", async () => {
    const { lifted, response } = resumeFrom("paused-by-user");
    expect((await response)?.status).toBe(200);
    expect(lifted).not.toHaveBeenCalled();
  });

  it("tells a person a withdrawn approval was withdrawn, not already decided", async () => {
    const handler = createNativeHarnessSessionRouteHandler({
      windowAuthorityStore: new WindowAuthorityStore(),
      store: { read: () => undefined } as never,
      followUps: {} as never,
      authorizeThread: () => true,
      decideApproval: () => "withdrawn",
    });
    const request = new Request(
      `http://127.0.0.1/api/native-harness/sessions/${threadId}/approvals`,
      {
        method: "POST",
        body: JSON.stringify({
          approvalId: "00000000-0000-4000-8000-000000000031",
          decision: "approve",
        }),
      },
    );
    bindPrincipalRouteContext(request, {
      principal: { kind: "local-window" } as never,
      scopeId: windowId,
    });
    const response = await handler(request);
    expect(response?.status).toBe(409);
    const body = (await response?.json()) as { reason?: string; message?: string };
    expect(body.reason).toBe("withdrawn");
    expect(body.message).toContain("withdrawn");
    expect(body.message).not.toContain("already decided");
  });

  it("refuses an answer to the lead's question from a window that may not open the thread", async () => {
    // The thread's inline question card and the Agents tab both post here; the
    // window's reach is checked on the host, never only by the card.
    const questionId = "00000000-0000-4000-8000-000000000022";
    let mayOpen = false;
    const answerQuestion = vi.fn(() => "answered" as const);
    const handler = createNativeHarnessSessionRouteHandler({
      windowAuthorityStore: new WindowAuthorityStore(),
      store: {
        read: () => ({
          session: { id: sessionId, version: 3, status: "running", mode: "work" },
          questions: [
            {
              id: questionId,
              prompt: "Which quarter?",
              options: [],
              status: "answered",
              answer: "Q3",
              askedAt: "2026-10-06T08:00:00.000Z",
            },
          ],
        }),
      } as never,
      followUps: {} as never,
      authorizeThread: () => mayOpen,
      answerQuestion,
    });
    const answer = () => {
      const request = new Request(
        `http://127.0.0.1/api/native-harness/sessions/${threadId}/questions`,
        { method: "POST", body: JSON.stringify({ questionId, answer: "Q3" }) },
      );
      bindPrincipalRouteContext(request, {
        principal: { kind: "local-window" } as never,
        scopeId: windowId,
      });
      return handler(request);
    };
    expect((await answer())?.status).toBe(403);
    expect(answerQuestion).not.toHaveBeenCalled();
    mayOpen = true;
    expect((await answer())?.status).toBe(200);
    expect(answerQuestion).toHaveBeenCalledExactlyOnceWith({ threadId, questionId, answer: "Q3" });
  });
});

describe("one harness session on every surface", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function journaledStore(): NativeHarnessSessionStore {
    const now = "2026-10-06T12:00:00.000Z";
    const directory = mkdtempSync(join(tmpdir(), "octant-harness-surfaces-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "events.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    let counter = 0;
    return new NativeHarnessSessionStore({
      journal: new Journal({
        connection,
        registry: registerNativeHarnessEvents(new EventRegistry()),
        projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
        clock: () => now,
      }),
      uuid: () => `cccccccc-cccc-4ccc-8ccc-${(++counter).toString(16).padStart(12, "0")}`,
      actor: Schema.decodeUnknownSync(EventActor)({
        kind: "local-user",
        actorId: "77777777-7777-4777-8777-777777777777",
      }),
      clock: () => now,
    });
  }

  it("shows the app window, the terminal, and the phone the same session, and each sees what another changed", async () => {
    const store = journaledStore();
    store.ensure({
      threadId,
      mode: "work",
      leadSlotId: decodeNativeHarnessSlotId("default"),
      lead: decodeNativeHarnessSlotCandidate({
        hostId: "00000000-0000-4000-8000-0000000000aa",
        providerInstanceId: "00000000-0000-4000-8000-000000000001",
        modelId: "frontier-large",
      }),
    });
    store.markRunning(threadId);
    store.askApproval(
      threadId,
      decodeNativeHarnessApproval({
        id: "00000000-0000-4000-8000-000000000061",
        toolName: "write",
        summary: "write: summary.md",
        approvalClass: "file-writes",
        status: "pending",
        askedAt: "2026-10-06T12:00:00.000Z",
      }),
    );

    const windows = new WindowAuthorityStore();
    const handler = createNativeHarnessSessionRouteHandler({
      windowAuthorityStore: windows,
      store,
      followUps: {} as never,
      authorizeThread: () => true,
    });
    const route = `http://127.0.0.1/api/native-harness/sessions/${threadId}`;
    // A local window is whatever registered a capability: the desktop and web
    // windows run one renderer, and `octant agent` registers its own window
    // and sends every request under it. Neither keeps a session of its own.
    const localWindow = (id: string) => {
      const capability = randomBytes(32).toString("base64url");
      windows.register({ windowId: decodeWindowId(id), capability, now: Date.now() });
      return (path: string, init: RequestInit = {}) =>
        handler(
          new Request(`${route}${path}`, {
            ...init,
            headers: {
              "content-type": "application/json",
              "x-octant-window-capability": capability,
            },
          }),
        );
    };
    // A paired phone reaches the same route through the remote gateway, which
    // has already authenticated it as a device.
    const pairedDeviceId = "55000000-0000-4000-8000-000000000001";
    const phone = (path: string, init: RequestInit = {}) => {
      const request = new Request(`${route}${path}`, init);
      bindPrincipalRouteContext(request, {
        principal: {
          kind: "remote-device",
          hostId: "local",
          deviceId: pairedDeviceId,
          credentialGeneration: 1,
          origin: "https://remote.example",
          protocolVersion: 1,
          capabilityDigest: "a".repeat(64),
          sessionId: "55000000-0000-4000-8000-000000000002",
        } as never,
        scopeId: pairedDeviceId as never,
      });
      return handler(request);
    };
    const surfaces = {
      app: localWindow("00000000-0000-4000-8000-000000000612"),
      terminal: localWindow("00000000-0000-4000-8000-000000000613"),
      phone,
    };
    const read = async (surface: keyof typeof surfaces) => {
      const response = await surfaces[surface]("");
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as { readonly view: unknown };
      return decodeHostAnswer(NativeHarnessSessionView)(body.view);
    };
    const command = (
      surface: keyof typeof surfaces,
      kind: "pause-native-harness-session" | "resume-native-harness-session",
      session: NativeHarnessSessionView["session"],
    ) =>
      surfaces[surface]("/commands", {
        method: "POST",
        body: JSON.stringify({ kind, sessionId: session.id, expectedVersion: session.version }),
      });

    const inApp = await read("app");
    expect(inApp.session.status).toBe("running");
    expect(inApp.approvals?.map((entry) => entry.summary)).toEqual(["write: summary.md"]);
    expect(await read("terminal")).toEqual(inApp);
    expect(await read("phone")).toEqual(inApp);

    // A pause from the terminal is the session every other surface reads next.
    expect((await command("terminal", "pause-native-harness-session", inApp.session))?.status).toBe(
      200,
    );
    const paused = await read("app");
    expect(paused.session.status).toBe("paused-by-user");
    expect(paused.session.version).toBeGreaterThan(inApp.session.version);
    expect(await read("phone")).toEqual(paused);
    expect(await read("terminal")).toEqual(paused);

    // No surface acts on a copy of its own: the phone's resume against the
    // version it read before the pause is refused, and nothing changes.
    const stale = await command("phone", "resume-native-harness-session", inApp.session);
    expect(stale?.status).toBe(409);
    expect(await stale?.json()).toMatchObject({ reason: "stale-version" });
    expect(await read("app")).toEqual(paused);
  });
});
