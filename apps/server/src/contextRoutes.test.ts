import {
  decodeContextSubjectRef,
  decodeWindowId,
  type ContextSubjectRef,
  type WindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ContextHarnessError } from "./context/contextHarnessService";
import {
  createContextRouteHandler,
  type ContextRoutePrincipal,
  type ContextRouteService,
} from "./contextRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("82000000-0000-4000-8000-000000000001");
const subjectId = "82000000-0000-4000-8000-000000000002";
const subjectOf = (aggregateType: string): ContextSubjectRef =>
  decodeContextSubjectRef({ aggregateType, aggregateId: subjectId });
const subject = subjectOf("chat-thread");
const manifestId = "82000000-0000-4000-8000-000000000003";
const compactionId = "82000000-0000-4000-8000-000000000005";
const commandsFor = (commandSubject: ContextSubjectRef) =>
  [
    {
      kind: "update-context-overrides",
      subject: commandSubject,
      expectedManifestId: manifestId,
      overrides: {
        pinnedEntryIds: ["82000000-0000-4000-8000-000000000004"],
        excludedEntryIds: [],
      },
    },
    { kind: "rebuild-context-plan", subject: commandSubject, expectedManifestId: manifestId },
    { kind: "compact-session", subject: commandSubject, compactionId },
  ] as const;

describe("context routes", () => {
  it("authenticates strict inspect and command bodies without accepting supplied window identity", async () => {
    const inspect = vi.fn(() => ({ subject, sequence: 4 }) as never);
    const execute = vi.fn(() => ({ kind: "context-rebuilt", snapshot: { subject } }) as never);
    const route = handler({ inspect, execute });

    const inspected = await route(request("/api/context/inspect", { subject }));
    expect(inspected?.status).toBe(200);
    expect(inspect).toHaveBeenCalledWith(subject, undefined, "local-window");

    const command = {
      kind: "rebuild-context-plan",
      subject,
      expectedManifestId: "82000000-0000-4000-8000-000000000003",
    } as const;
    const executed = await route(request("/api/context/commands", command));
    expect(executed?.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(command, "local-window", windowId);

    const forged = await route(request("/api/context/inspect", { subject, windowId }, capability));
    expect(forged?.status).toBe(400);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("fails closed for missing authority, malformed input, non-loopback hosts, and unsupported methods", async () => {
    const route = handler();
    const unauthorized = await route(request("/api/context/inspect", { subject }, ""));
    expect(unauthorized?.status).toBe(401);
    await expect(unauthorized?.json()).resolves.toEqual({
      category: "unauthorized",
      message: "Context request is unauthorized.",
    });

    expect((await route(request("/api/context/inspect", { nope: true })))?.status).toBe(400);
    expect(
      (
        await route(
          new Request("http://192.168.1.4/api/context/inspect", {
            method: "POST",
            headers: headers(capability),
            body: JSON.stringify({ subject }),
          }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await route(
          new Request("http://127.0.0.1/api/context/inspect", {
            method: "GET",
            headers: headers(capability),
          }),
        )
      )?.status,
    ).toBe(400);
    expect(await route(new Request("http://127.0.0.1/not-context"))).toBeUndefined();
  });

  it("maps stale and unavailable service outcomes to closed public failures", async () => {
    const stale = handler({
      execute: () => {
        throw new ContextHarnessError("stale", "private stale detail");
      },
    });
    const command = {
      kind: "rebuild-context-plan",
      subject,
      expectedManifestId: "82000000-0000-4000-8000-000000000003",
    };
    const staleResponse = await stale(request("/api/context/commands", command));
    expect(staleResponse?.status).toBe(409);
    await expect(staleResponse?.json()).resolves.toEqual({
      category: "stale",
      message: "Reload context before retrying.",
    });

    const unavailable = handler({
      inspect: () => {
        throw new ContextHarnessError("unavailable", "private storage detail");
      },
    });
    const unavailableResponse = await unavailable(request("/api/context/inspect", { subject }));
    expect(unavailableResponse?.status).toBe(503);
    await expect(unavailableResponse?.json()).resolves.toEqual({
      category: "unavailable",
      message: "Octant Context service is unavailable.",
    });
  });

  it.each(commandsFor(subject))(
    "refuses a $kind command for a thread this window cannot open before it has any effect",
    async (command) => {
      const execute = vi.fn(() => ({ kind: "context-rebuilt", snapshot: { subject } }) as never);
      const windowCanOpenThread = vi.fn(async () => false);
      const route = handler({ execute }, windowCanOpenThread);

      const response = await route(request("/api/context/commands", command));

      expect(response?.status).toBe(403);
      await expect(response?.json()).resolves.toEqual({
        category: "unauthorized",
        message: "Context subject is not available to this window.",
      });
      expect(windowCanOpenThread).toHaveBeenCalledWith(windowId, "chat-thread", subjectId);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("refuses to compact a Code thread this window cannot open before it has any effect", async () => {
    const execute = vi.fn(() => ({ kind: "compaction-started" }) as never);
    const windowCanOpenThread = vi.fn(async () => false);
    const route = handler({ execute }, windowCanOpenThread);

    const response = await route(
      request("/api/context/commands", {
        kind: "compact-session",
        subject: subjectOf("code-thread"),
        compactionId,
      }),
    );

    expect(response?.status).toBe(403);
    expect(windowCanOpenThread).toHaveBeenCalledWith(windowId, "code-thread", subjectId);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["chat-thread", "work-thread", "code-thread"] as const)(
    "runs context commands on a %s the window can open",
    async (aggregateType) => {
      const threadSubject = subjectOf(aggregateType);
      const execute = vi.fn(
        () => ({ kind: "context-rebuilt", snapshot: { subject: threadSubject } }) as never,
      );
      const windowCanOpenThread = vi.fn(async () => true);
      const route = handler({ execute }, windowCanOpenThread);

      for (const command of commandsFor(threadSubject)) {
        const response = await route(request("/api/context/commands", command));
        expect(response?.status).toBe(200);
        // The service learns which window asked: a Code thread's session is
        // opened in its checkout under that window's authority.
        expect(execute).toHaveBeenLastCalledWith(command, "local-window", windowId);
      }
      expect(windowCanOpenThread).toHaveBeenCalledWith(windowId, aggregateType, subjectId);
    },
  );

  it.each(["project", "agent-run", "context-subject"])(
    "refuses context commands on a %s subject, which is no thread any window can open",
    async (aggregateType) => {
      const execute = vi.fn(() => ({ kind: "context-rebuilt", snapshot: { subject } }) as never);
      const windowCanOpenThread = vi.fn(async () => true);
      const route = handler({ execute }, windowCanOpenThread);

      for (const command of commandsFor(subjectOf(aggregateType))) {
        const response = await route(request("/api/context/commands", command));
        expect(response?.status).toBe(403);
      }
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("answers a refused compaction with its reason and no private detail", async () => {
    const route = handler({
      execute: () => ({ kind: "compaction-refused", reason: "turn-running" }),
    });

    const response = await route(
      request("/api/context/commands", { kind: "compact-session", subject, compactionId }),
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      category: "compaction-refused",
      message: "Octant cannot compact this session now.",
      reason: "turn-running",
    });
  });

  it("tells the service a paired device is asking, so it refuses that device a compaction", async () => {
    const execute = vi.fn((_command: unknown, principal: ContextRoutePrincipal) => {
      if (principal === "remote-device") {
        return { kind: "compaction-refused", reason: "remote-client" } as const;
      }
      return { kind: "compaction-started" } as never;
    });
    const route = handler({ execute });
    const remote = request("/api/context/commands", {
      kind: "compact-session",
      subject,
      compactionId,
    });
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: windowId,
    });

    const response = await route(remote);

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({ reason: "remote-client" });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "compact-session" }),
      "remote-device",
      windowId,
    );
  });

  it("answers a subject nothing has planned yet without claiming the service failed", async () => {
    const notPlanned = handler({
      inspect: () => {
        throw new ContextHarnessError("not-planned", "private subject detail");
      },
    });

    const response = await notPlanned(request("/api/context/inspect", { subject }));

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      kind: "not-planned",
      subject,
    });
  });

  describe("inspect", () => {
    const refusal = {
      category: "unauthorized",
      message: "Context subject is not available to this window.",
    };

    it.each(["chat-thread", "work-thread", "code-thread"] as const)(
      "answers a window that can open its %s",
      async (aggregateType) => {
        const threadSubject = subjectOf(aggregateType);
        const inspect = vi.fn(() => ({ subject: threadSubject, sequence: 2 }) as never);
        const windowCanOpenThread = vi.fn(async () => true);
        const route = handler({ inspect }, windowCanOpenThread);

        const response = await route(
          request("/api/context/inspect", { subject: threadSubject, afterSequence: 1 }),
        );

        expect(response?.status).toBe(200);
        expect(windowCanOpenThread).toHaveBeenCalledWith(windowId, aggregateType, subjectId);
        expect(inspect).toHaveBeenCalledWith(threadSubject, 1, "local-window");
      },
    );

    it.each(["chat-thread", "work-thread", "code-thread"] as const)(
      "refuses a %s in a Project this window cannot open before the service reads it",
      async (aggregateType) => {
        const inspect = vi.fn(() => ({ subject, sequence: 1 }) as never);
        const windowCanOpenThread = vi.fn(async () => false);
        const route = handler({ inspect }, windowCanOpenThread);

        const response = await route(
          request("/api/context/inspect", { subject: subjectOf(aggregateType) }),
        );

        expect(response?.status).toBe(403);
        await expect(response?.json()).resolves.toEqual(refusal);
        expect(windowCanOpenThread).toHaveBeenCalledWith(windowId, aggregateType, subjectId);
        expect(inspect).not.toHaveBeenCalled();
      },
    );

    it("answers a Project subject only for a window that can open the Project", async () => {
      const projectSubject = subjectOf("project");
      const inspect = vi.fn(() => {
        throw new ContextHarnessError("not-planned", "private subject detail");
      });
      const windowCanOpenThread = vi.fn(async () => true);
      const opens = vi.fn(async () => true);
      const opened = await handler(
        { inspect },
        windowCanOpenThread,
        opens,
      )(request("/api/context/inspect", { subject: projectSubject }));
      expect(opened?.status).toBe(200);
      await expect(opened?.json()).resolves.toEqual({
        kind: "not-planned",
        subject: projectSubject,
      });
      expect(opens).toHaveBeenCalledWith(windowId, subjectId);
      expect(windowCanOpenThread).not.toHaveBeenCalled();

      const refuses = vi.fn(async () => false);
      const refused = await handler(
        { inspect },
        windowCanOpenThread,
        refuses,
      )(request("/api/context/inspect", { subject: projectSubject }));
      expect(refused?.status).toBe(403);
      await expect(refused?.json()).resolves.toEqual(refusal);
      expect(refuses).toHaveBeenCalledWith(windowId, subjectId);
      expect(inspect).toHaveBeenCalledTimes(1);
    });

    it("answers a paired device only for what its own scope can read", async () => {
      const deviceScope = decodeWindowId("82000000-0000-4000-8000-0000000000d1");
      const readable = "82000000-0000-4000-8000-0000000000d2";
      const inspect = vi.fn((threadSubject: ContextSubjectRef) => ({
        subject: threadSubject,
        sequence: 1,
      })) as never;
      const windowCanOpenThread = vi.fn(
        async (scope: WindowId, _kind: string, threadId: string) =>
          String(scope) === String(deviceScope) && threadId === readable,
      );
      const route = handler({ inspect }, windowCanOpenThread);
      const fromDevice = (threadId: string) => {
        const remote = request("/api/context/inspect", {
          subject: decodeContextSubjectRef({ aggregateType: "work-thread", aggregateId: threadId }),
        });
        bindPrincipalRouteContext(remote, {
          principal: { kind: "remote-device" } as never,
          scopeId: deviceScope,
        });
        return remote;
      };

      const inScope = await route(fromDevice(readable));
      expect(inScope?.status).toBe(200);
      expect(inspect).toHaveBeenCalledWith(
        expect.objectContaining({ aggregateId: readable }),
        undefined,
        "remote-device",
      );

      const outOfScope = await route(fromDevice(subjectId));
      expect(outOfScope?.status).toBe(403);
      await expect(outOfScope?.json()).resolves.toEqual(refusal);
      expect(windowCanOpenThread).toHaveBeenCalledWith(deviceScope, "work-thread", subjectId);
      expect(inspect).toHaveBeenCalledTimes(1);
    });

    it("refuses an unknown subject in the same words as one it may not read", async () => {
      const unknownId = "82000000-0000-4000-8000-0000000000e1";
      const inspect = vi.fn(() => ({ subject, sequence: 1 }) as never);
      // The thread rule finds the known thread in a Project this window cannot
      // open, and no thread at all for the unknown id; both answer false.
      const route = handler(
        { inspect },
        async () => false,
        async () => false,
      );
      const answer = async (aggregateType: string, aggregateId: string) => {
        const response = await route(
          request("/api/context/inspect", {
            subject: decodeContextSubjectRef({ aggregateType, aggregateId }),
          }),
        );
        return { status: response?.status, body: await response?.json() };
      };

      const notReadable = await answer("chat-thread", subjectId);
      expect(notReadable).toEqual({ status: 403, body: refusal });
      expect(await answer("chat-thread", unknownId)).toEqual(notReadable);
      expect(await answer("project", unknownId)).toEqual(notReadable);
      expect(await answer("context-subject", unknownId)).toEqual(notReadable);
      expect(inspect).not.toHaveBeenCalled();
    });
  });

  describe("compaction state", () => {
    const codeSubject = subjectOf("code-thread");
    const query = (threadSubject: ContextSubjectRef) =>
      `/api/context/compaction?aggregateType=${String(threadSubject.aggregateType)}&aggregateId=${String(threadSubject.aggregateId)}`;

    it("answers a window that can open the thread, Code included", async () => {
      const compactionState = vi.fn((threadSubject: ContextSubjectRef) => ({
        subject: threadSubject,
        compaction: { status: "refused" as const, reason: "no-session" as const },
      }));
      const windowCanOpenThread = vi.fn(async () => true);
      const route = handler({ compactionState }, windowCanOpenThread);

      const response = await route(read(query(codeSubject)));

      expect(response?.status).toBe(200);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      await expect(response?.json()).resolves.toEqual({
        subject: codeSubject,
        compaction: { status: "refused", reason: "no-session" },
      });
      expect(windowCanOpenThread).toHaveBeenCalledWith(windowId, "code-thread", subjectId);
      expect(compactionState).toHaveBeenCalledWith(codeSubject, "local-window");
    });

    it("refuses a window that cannot open the thread before the service is asked", async () => {
      const compactionState = vi.fn();
      const route = handler({ compactionState }, async () => false);

      const response = await route(read(query(codeSubject)));

      expect(response?.status).toBe(403);
      expect(compactionState).not.toHaveBeenCalled();
    });

    it("refuses missing authority, a malformed or widened query, and any method but GET", async () => {
      const compactionState = vi.fn();
      const route = handler({ compactionState });

      expect((await route(read(query(codeSubject), "")))?.status).toBe(401);
      expect((await route(read("/api/context/compaction")))?.status).toBe(400);
      expect(
        (await route(read(`${query(codeSubject)}&windowId=${String(windowId)}`)))?.status,
      ).toBe(400);
      expect(
        (await route(read(`/api/context/compaction?aggregateType=code-thread&aggregateId=x`)))
          ?.status,
      ).toBe(400);
      expect((await route(request(query(codeSubject), {})))?.status).toBe(400);
      expect(
        (await route(read(query(subjectOf("project")))))?.status,
        "a subject that is no thread",
      ).toBe(403);
      expect(compactionState).not.toHaveBeenCalled();
    });

    it("tells the service a paired device is asking", async () => {
      const compactionState = vi.fn((threadSubject: ContextSubjectRef) => ({
        subject: threadSubject,
        compaction: { status: "refused" as const, reason: "remote-client" as const },
      }));
      const route = handler({ compactionState });
      const remote = read(query(subject));
      bindPrincipalRouteContext(remote, {
        principal: { kind: "remote-device" } as never,
        scopeId: windowId,
      });

      const response = await route(remote);

      expect(response?.status).toBe(200);
      expect(compactionState).toHaveBeenCalledWith(subject, "remote-device");
    });
  });
});

function handler(
  service: Partial<{
    inspect: (
      contextSubject: ContextSubjectRef,
      afterSequence: number | undefined,
      principal: ContextRoutePrincipal,
    ) => never;
    execute: (
      command: unknown,
      principal: ContextRoutePrincipal,
      window: WindowId,
    ) => ReturnType<ContextRouteService["execute"]>;
    compactionState: ContextRouteService["compactionState"];
  }> = {},
  windowCanOpenThread: (
    windowId: WindowId,
    threadKind: "chat-thread" | "work-thread" | "code-thread",
    threadId: string,
  ) => Promise<boolean> = async () => true,
  windowCanOpenProject: (windowId: WindowId, projectId: string) => Promise<boolean> = async () =>
    true,
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 1 });
  return createContextRouteHandler({
    service: {
      inspect: service.inspect ?? (() => ({ subject, sequence: 1 }) as never),
      execute:
        service.execute ?? (() => ({ kind: "context-rebuilt", snapshot: { subject } }) as never),
      compactionState:
        service.compactionState ??
        ((threadSubject) => ({
          subject: threadSubject,
          compaction: { status: "refused", reason: "no-session" },
        })),
    },
    windowCanOpenThread,
    windowCanOpenProject,
    windowAuthorityStore: store,
    now: () => 2,
  });
}

function request(path: string, body: unknown, authority = capability): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: headers(authority),
    body: JSON.stringify(body),
  });
}

function read(path: string, authority = capability): Request {
  return new Request(`http://127.0.0.1${path}`, { method: "GET", headers: headers(authority) });
}

function headers(authority: string): HeadersInit {
  return {
    "content-type": "application/json",
    "x-octant-window-capability": authority,
  };
}
