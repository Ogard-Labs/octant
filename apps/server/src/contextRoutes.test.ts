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
    expect(execute).toHaveBeenCalledWith(command, "local-window");

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
        expect(execute).toHaveBeenLastCalledWith(command, "local-window");
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
    ) => ReturnType<ContextRouteService["execute"]>;
  }> = {},
  windowCanOpenThread: (
    windowId: WindowId,
    threadKind: "chat-thread" | "work-thread" | "code-thread",
    threadId: string,
  ) => Promise<boolean> = async () => true,
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 1 });
  return createContextRouteHandler({
    service: {
      inspect: service.inspect ?? (() => ({ subject, sequence: 1 }) as never),
      execute:
        service.execute ?? (() => ({ kind: "context-rebuilt", snapshot: { subject } }) as never),
    },
    windowCanOpenThread,
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

function headers(authority: string): HeadersInit {
  return {
    "content-type": "application/json",
    "x-octant-window-capability": authority,
  };
}
