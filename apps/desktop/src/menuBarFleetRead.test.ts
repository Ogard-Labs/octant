import { describe, expect, it, vi } from "vitest";
import { createMenuBarFleetReader } from "./menuBarFleetRead";

const roster = {
  threads: [
    {
      mode: "code",
      threadId: "a",
      title: "Fix startup",
      state: "working",
      activitySource: "journal",
    },
  ],
  truncated: false,
};

function fixture(responses: Array<() => Response>) {
  const revoked: string[] = [];
  let registered = 0;
  const register = vi.fn(async () => {
    registered += 1;
    const capability = `capability-${registered}`;
    return { capability, revoke: async () => void revoked.push(capability) };
  });
  const fetch = vi.fn(async (_input: string, _init: RequestInit) => {
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected read");
    return next();
  });
  return { reader: createMenuBarFleetReader({ register, fetch }), register, fetch, revoked };
}

describe("menu-bar fleet read", () => {
  it("reads with the menu bar's own window authority, registered once per host instance", async () => {
    const { reader, register, fetch, revoked } = fixture([
      () => Response.json(roster),
      () => Response.json(roster),
      () => Response.json(roster),
    ]);
    const host = { url: "http://127.0.0.1:4100", instanceId: "one" };
    expect(await reader.read(host)).toEqual(roster);
    await reader.read(host);
    expect(register).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenLastCalledWith("http://127.0.0.1:4100/api/fleet-activity", {
      method: "GET",
      headers: { "x-octant-window-capability": "capability-1" },
    });
    await reader.read({ ...host, instanceId: "two" });
    expect(revoked).toEqual(["capability-1"]);
    expect(register).toHaveBeenCalledTimes(2);
    await reader.revoke();
    expect(revoked).toEqual(["capability-1", "capability-2"]);
  });

  it("returns nothing rather than an empty roster when a read fails", async () => {
    const { reader, register } = fixture([
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 503 }),
      () => Response.json({ threads: "not a roster" }),
    ]);
    const host = { url: "http://127.0.0.1:4100", instanceId: "one" };
    expect(await reader.read(host)).toBeUndefined();
    expect(await reader.read(host)).toBeUndefined();
    // A refused authority is dropped, so the read after it registers afresh.
    expect(register).toHaveBeenCalledTimes(2);
    expect(await reader.read(host)).toBeUndefined();
  });
});
