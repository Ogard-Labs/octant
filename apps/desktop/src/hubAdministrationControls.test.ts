import { describe, expect, it, vi } from "vitest";
import {
  HubAdministrationControlFailure,
  sendHubAdministrationOperation,
} from "./hubAdministrationControls";

const MEMBER_ID = "77777777-7777-4777-8777-777777777777";

function runtime(respond: (url: string, init: RequestInit | undefined) => Response) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  return {
    calls,
    runtime: {
      serverUrl: "http://127.0.0.1:4317",
      desktopBridgeSecret: "bridge-secret",
      windowCapability: "A".repeat(43),
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        return respond(url, init);
      }) as unknown as typeof globalThis.fetch,
    },
  };
}

describe("hub administration controls", () => {
  it("sends a valid operation to its fixed route with this window's authority and hands back a refusal as an answer", async () => {
    const { calls, runtime: controls } = runtime(() =>
      Response.json({ status: "refused", kind: "not-a-member" }, { status: 409 }),
    );
    expect(
      await sendHubAdministrationOperation(controls, "remove", { memberId: MEMBER_ID }),
    ).toEqual({ status: 409, body: { status: "refused", kind: "not-a-member" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/api/desktop/hub/members/remove");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ memberId: MEMBER_ID }));
    expect(calls[0]?.init?.headers).toEqual({
      "x-octant-desktop-secret": "bridge-secret",
      "x-octant-window-capability": "A".repeat(43),
      "content-type": "application/json",
    });
  });

  it("reads the hub status with a GET and no body", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ hub: {}, spoke: {} }));
    expect(await sendHubAdministrationOperation(controls, "status", undefined)).toEqual({
      status: 200,
      body: { hub: {}, spoke: {} },
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/api/desktop/hub/status");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("refuses an operation it does not name or a path in its place, sending nothing", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({}));
    for (const operation of ["../desktop/remote/pairing-tickets", "__proto__", "toString", 7]) {
      expect(await sendHubAdministrationOperation(controls, operation, {})).toMatchObject({
        status: 400,
        body: { category: "invalid" },
      });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a body that fails its schema, sending nothing", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({}));
    const refused: ReadonlyArray<readonly [string, unknown]> = [
      ["remove", { memberId: "not-a-uuid" }],
      ["remove", { memberId: MEMBER_ID, extra: true }],
      ["join-code", { owner: "yes" }],
      ["join-code", undefined],
      ["join", { code: 7 }],
      ["join", { code: "x".repeat(4_097) }],
      ["grant", { items: ["shell"], actProjects: [] }],
      ["grant", { items: ["status"], actProjects: ["99999999-9999-4999-8999-999999999999"] }],
      ["enable", { anything: true }],
      ["leave", {}],
    ];
    for (const [operation, body] of refused) {
      expect(await sendHubAdministrationOperation(controls, operation, body)).toMatchObject({
        status: 400,
      });
    }
    expect(calls).toEqual([]);
  });

  it("sends the decoded grant, not the window's own object", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ status: "granted" }));
    await sendHubAdministrationOperation(controls, "grant", {
      items: ["roster", "introduce"],
      actProjects: [],
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/api/desktop/hub/grant");
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ items: ["roster", "introduce"], actProjects: [] }),
    );
  });

  it("throws when the host cannot be reached", async () => {
    const { runtime: controls } = runtime(() => {
      throw new Error("connection refused");
    });
    await expect(
      sendHubAdministrationOperation(controls, "status", undefined),
    ).rejects.toBeInstanceOf(HubAdministrationControlFailure);
  });
});
