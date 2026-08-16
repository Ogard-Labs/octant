import { decodeWindowId, type ContextSubjectRef } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ContextHarnessError } from "./context/contextHarnessService";
import { createContextRouteHandler } from "./contextRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("82000000-0000-4000-8000-000000000001");
const subject = {
  aggregateType: "project",
  aggregateId: "82000000-0000-4000-8000-000000000002",
} as const;

describe("context routes", () => {
  it("authenticates strict inspect and command bodies without accepting supplied window identity", async () => {
    const inspect = vi.fn(() => ({ subject, sequence: 4 }) as never);
    const execute = vi.fn(() => ({ kind: "context-rebuilt", snapshot: { subject } }) as never);
    const route = handler({ inspect, execute });

    const inspected = await route(request("/api/context/inspect", { subject }));
    expect(inspected?.status).toBe(200);
    expect(inspect).toHaveBeenCalledWith(subject, undefined);

    const command = {
      kind: "rebuild-context-plan",
      subject,
      expectedManifestId: "82000000-0000-4000-8000-000000000003",
    } as const;
    const executed = await route(request("/api/context/commands", command));
    expect(executed?.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(command);

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
});

function handler(
  service: Partial<{
    inspect: (contextSubject: ContextSubjectRef, afterSequence?: number) => never;
    execute: (command: unknown) => never;
  }> = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 1 });
  return createContextRouteHandler({
    service: {
      inspect: service.inspect ?? (() => ({ subject, sequence: 1 }) as never),
      execute:
        service.execute ?? (() => ({ kind: "context-rebuilt", snapshot: { subject } }) as never),
    },
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
