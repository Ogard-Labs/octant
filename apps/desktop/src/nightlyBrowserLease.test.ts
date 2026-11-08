import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ownNightlyWindowLeases,
  type NativeWindowEvent,
  type NativeWindowReply,
} from "./nightlyBrowserLease";

const clientHandle = "00000000-0000-4000-8000-000000000593";
const peer = "a".repeat(64);
const hostFeatures = ["project-root-receipts", "a-feature-from-a-newer-host"];

function fixture(onCount?: (count: number) => void, nativeMain = true, peerKey = peer) {
  let receive: (event: unknown) => void = () => {};
  let elapsed = 0;
  let expire = () => {};
  let host = {
    origin: "http://127.0.0.1:13773",
    instanceId: "00000000-0000-4000-8000-000000000594",
    desktopBridgeSecret: "private-admin",
  };
  const responses = new Map<number, (reply: NativeWindowReply) => void>();
  const replies = vi.fn((id: number, reply: NativeWindowReply) => {
    responses.get(id)?.(reply);
    return true;
  });
  const closeContexts = vi.fn(async (_id: string) => {});
  const requests: Array<{ readonly method: string; readonly body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body));
    if (typeof body !== "object" || body === null) throw new Error("invalid fixture request");
    requests.push({ method: init?.method ?? "", body: Object.fromEntries(Object.entries(body)) });
    return init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json(
          { expiresAt: 15_000, generation: 1, leaseMs: 15_000, hostFeatures },
          { status: init?.method === "POST" ? 201 : 200 },
        );
  });
  const owner = ownNightlyWindowLeases({
    native: {
      listenWindows: async (listener) => {
        receive = listener;
        return { kind: "started" };
      },
      replyWindow: replies,
      stopWindows: async () => ({ kind: "closed" }),
    },
    host: () => host,
    elapsedNow: () => elapsed,
    schedule: (_delay, callback) => {
      expire = callback;
      return () => {};
    },
    closeOwnerContexts: closeContexts,
    ...(onCount === undefined ? {} : { onClientLifetimeCountChanged: onCount }),
    fetch,
  });
  const send = (requestId: number, operation: "register" | "renew" | "revoke") =>
    new Promise<NativeWindowReply>((resolve) => {
      responses.set(requestId, resolve);
      receive({
        kind: "request",
        request: {
          requestId,
          peer: peerKey,
          windowId: clientHandle,
          generation: 1,
          operation,
          nativeMain,
        },
      } satisfies NativeWindowEvent);
    });
  return {
    owner,
    send,
    fetch,
    requests,
    closeContexts,
    replies,
    exitPeer: () => receive({ kind: "peer-exited", peer: peerKey }),
    expire: () => {
      elapsed = 15_000;
      expire();
    },
    replaceHost: () => {
      host = { ...host, instanceId: "00000000-0000-4000-8000-000000000595" };
    },
  };
}

// The key the Linux binding derives for boot 00000000-0000-4000-8000-000000000001,
// pid 4242, start time 98765. desktopPeerLinux.test.cpp checks the binding's
// policy produces exactly this value, so a key shape the owner drops cannot
// pass both suites.
const LINUX_PEER_KEY_FIXTURE = "4be26660a400e0f5562c36dbe1d8253f815932426a83dde813a3cd721315422b";

describe("a Linux peer's window registration", () => {
  it("is the binding's SHA-256 key, and the lease owner registers and revokes by it", async () => {
    expect(
      createHash("sha256")
        .update("octant.linux-peer.v1\0")
        .update("00000000-0000-4000-8000-000000000001\0")
        .update("4242\0")
        .update("98765")
        .digest("hex"),
    ).toBe(LINUX_PEER_KEY_FIXTURE);
    const counts: number[] = [];
    const f = fixture((count) => counts.push(count), true, LINUX_PEER_KEY_FIXTURE);
    try {
      const reply = await f.send(1, "register");
      expect(reply.kind).toBe("registered");
      if (reply.kind !== "registered") throw new Error("Fixture registration failed");
      expect(f.owner.hasWindow(reply.windowId)).toBe(true);
      f.exitPeer();
      await vi.waitFor(() => expect(f.owner.hasWindow(reply.windowId)).toBe(false));
    } finally {
      await f.owner.close();
    }
  });
});

describe("Nightly native window lease ownership", () => {
  it("issues a fresh server window ID and returns only its scoped bootstrap", async () => {
    const f = fixture();
    try {
      const reply = await f.send(1, "register");
      expect(reply.kind).toBe("registered");
      if (reply.kind !== "registered") throw new Error("Fixture registration failed");
      expect(reply.windowId).not.toBe(clientHandle);
      expect(f.owner.hasWindow(reply.windowId)).toBe(true);
      expect(JSON.stringify(reply)).not.toContain("private-admin");
      expect(f.requests[0]?.body.windowId).toBe(reply.windowId);
      // The host learns the main-only token; the reply carries it and the
      // host's brokered features, and it is never the renderer identity.
      expect(reply.nativeMainToken).toBeDefined();
      expect(f.requests[0]?.body.nativeMainToken).toBe(reply.nativeMainToken);
      expect(reply.nativeMainToken).not.toBe(reply.rendererIdentity);
      expect(reply.nativeMainToken).not.toBe(reply.capability);
      expect(reply.hostFeatures).toEqual(hostFeatures);
      f.replaceHost();
      expect(f.owner.hasWindow(reply.windowId)).toBe(false);
    } finally {
      await f.owner.close();
    }
  });

  it("gives a client that does not accept native-main fields only its original bootstrap", async () => {
    const f = fixture(undefined, false);
    try {
      const reply = await f.send(1, "register");
      if (reply.kind !== "registered") throw new Error("Fixture registration failed");
      // An older client decodes these exact keys strictly and refuses any other.
      expect(Object.keys(reply).sort()).toEqual(
        [
          "capability",
          "generation",
          "hostInstance",
          "hostOrigin",
          "kind",
          "leaseMs",
          "protocol",
          "rendererIdentity",
          "windowId",
        ].sort(),
      );
      expect(JSON.stringify(reply)).not.toContain(String(f.requests[0]?.body.nativeMainToken));
      expect(f.owner.hasWindow(reply.windowId)).toBe(true);
    } finally {
      await f.owner.close();
    }
  });

  it("registers the original way with an older host and opens the window without brokered fields", async () => {
    const f = fixture();
    const normal = f.fetch.getMockImplementation();
    f.fetch.mockImplementationOnce(async (input, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      if (typeof body === "object" && body !== null && "nativeMainToken" in body)
        return Response.json(
          { category: "invalid", message: "Request body is invalid." },
          { status: 400 },
        );
      return normal === undefined ? new Response(null, { status: 500 }) : normal(input, init);
    });
    try {
      const reply = await f.send(1, "register");
      if (reply.kind !== "registered") throw new Error("Fixture registration failed");
      const posts = f.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(posts).toHaveLength(2);
      expect(Object.keys(JSON.parse(String(posts[0]?.[1]?.body)))).toContain("nativeMainToken");
      expect(Object.keys(JSON.parse(String(posts[1]?.[1]?.body))).sort()).toEqual(
        ["capability", "rendererIdentity", "source", "windowId"].sort(),
      );
      expect(reply.nativeMainToken).toBeUndefined();
      expect(reply.hostFeatures).toBeUndefined();
      expect(f.owner.hasWindow(reply.windowId)).toBe(true);
    } finally {
      await f.owner.close();
    }
  });

  it("does not retry a registration the host refused for any other reason", async () => {
    for (const refusal of [
      new Response(null, { status: 409 }),
      new Response(null, { status: 500 }),
      Response.json({ category: "unauthorized" }, { status: 400 }),
      new Response("not json", { status: 400 }),
    ]) {
      const f = fixture();
      f.fetch.mockImplementationOnce(async () => refusal);
      try {
        expect((await f.send(1, "register")).kind).toBe("refused");
        expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      } finally {
        await f.owner.close();
      }
    }
  });

  it("drops native availability and closes the issued context on local expiry", async () => {
    const f = fixture();
    try {
      const reply = await f.send(1, "register");
      if (reply.kind !== "registered") throw new Error("Fixture registration failed");
      f.expire();
      expect(f.owner.hasWindow(reply.windowId)).toBe(false);
      await f.owner.close();
      expect(f.closeContexts).toHaveBeenCalledWith(reply.windowId);
      expect(
        f.requests.some(
          (request) => request.method === "DELETE" && request.body.windowId === reply.windowId,
        ),
      ).toBe(true);
    } finally {
      await f.owner.close();
    }
  });

  it("never closes a context after a refused registration that established no ownership", async () => {
    const f = fixture();
    f.fetch.mockImplementationOnce(async () => new Response(null, { status: 409 }));
    try {
      expect((await f.send(1, "register")).kind).toBe("refused");
      expect(f.closeContexts).not.toHaveBeenCalled();
    } finally {
      await f.owner.close();
    }
  });

  it("revokes a late successful acquisition after its owner exits, without skipping sibling cleanup", async () => {
    const f = fixture();
    let finish = () => {};
    let acquired = false;
    const normalFetch = f.fetch.getMockImplementation();
    f.fetch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      acquired = true;
      return Response.json(
        { expiresAt: 15_000, generation: 1, leaseMs: 15_000, hostFeatures },
        { status: 201 },
      );
    });
    f.fetch.mockImplementation(async (input, init) => {
      if (init?.method === "DELETE") expect(acquired).toBe(true);
      if (normalFetch === undefined) throw new Error("Fixture fetch missing");
      return normalFetch(input, init);
    });
    try {
      void f.send(1, "register");
      f.exitPeer();
      expect(f.closeContexts).not.toHaveBeenCalled();
      finish();
      await f.owner.close();
      expect(f.closeContexts).toHaveBeenCalledOnce();
      expect(f.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    } finally {
      finish();
      await f.owner.close();
    }
  });

  it("reserves a closing client handle until its previous context cleanup finishes", async () => {
    const f = fixture();
    let finish = () => {};
    f.closeContexts.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      await f.send(1, "register");
      const revoked = f.send(2, "revoke");
      expect((await f.send(3, "register")).kind).toBe("refused");
      finish();
      expect((await revoked).kind).toBe("revoked");
      expect((await f.send(4, "register")).kind).toBe("registered");
      expect(
        f.requests
          .filter((request) => request.method === "POST")
          .map((request) => request.body.windowId),
      ).toHaveLength(2);
    } finally {
      finish();
      await f.owner.close();
    }
  });
});

it("counts only acknowledged current-host leases and not pending registration", async () => {
  const counts: number[] = [];
  const f = fixture((count) => counts.push(count));
  let settle: (response: Response) => void = () => {};
  f.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        settle = resolve;
      }),
  );
  const pending = f.send(1, "register");
  expect(f.owner.activeWindowCount()).toBe(0);
  settle(Response.json({ generation: 1, leaseMs: 15_000, hostFeatures }, { status: 201 }));
  await pending;
  expect(f.owner.activeWindowCount()).toBe(1);
  f.replaceHost();
  expect(f.owner.activeWindowCount()).toBe(0);
  await f.send(2, "renew");
  expect(counts).toEqual([1, 0]);
  await f.owner.close();
});

it("keeps the host alive until a revoked Nightly lease receives its native reply", async () => {
  const counts: number[] = [];
  const order: string[] = [];
  const f = fixture((count) => {
    counts.push(count);
    order.push(`count:${count}`);
  });
  const originalReply = f.replies.getMockImplementation();
  if (originalReply === undefined) throw new Error("Fixture reply is missing");
  f.replies.mockImplementation((requestId, reply) => {
    if (reply.kind === "revoked") order.push("reply:revoked");
    return originalReply(requestId, reply);
  });
  let finishDelete = (_response: Response) => {};
  try {
    const registered = await f.send(1, "register");
    if (registered.kind !== "registered") throw new Error("Fixture registration failed");
    order.length = 0;
    const deleteResponse = new Promise<Response>((resolve) => {
      finishDelete = resolve;
    });
    f.fetch.mockImplementationOnce(() => deleteResponse);
    const revoking = f.send(2, "revoke");
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    expect(f.fetch.mock.calls[1]?.[1]?.method).toBe("DELETE");
    expect(order).toEqual([]);
    expect(f.owner.activeWindowCount()).toBe(0);
    expect(f.owner.lifetimeWindowCount()).toBe(1);
    expect(await f.send(3, "register")).toEqual({ kind: "refused", reason: "invalid-request" });
    expect(f.owner.lifetimeWindowCount()).toBe(1);
    finishDelete(new Response(null, { status: 204 }));
    expect(await revoking).toEqual({ kind: "revoked" });
    expect(counts).toEqual([1, 0]);
    expect(order).toEqual(["reply:revoked", "count:0"]);
    expect(f.owner.activeWindowCount()).toBe(0);
    expect(f.owner.lifetimeWindowCount()).toBe(0);
  } finally {
    finishDelete(new Response(null, { status: 204 }));
    await f.owner.close();
  }
});

it("revokes state before a failing count observer without skipping lease cleanup", async () => {
  const snapshots: number[] = [];
  let current = () => -1;
  const f = fixture((count) => {
    snapshots.push(current());
    if (count === 0) throw new Error("observer failed");
  });
  current = f.owner.activeWindowCount;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const reply = await f.send(1, "register");
    if (reply.kind !== "registered") throw new Error("Fixture registration failed");
    f.expire();
    expect(f.owner.activeWindowCount()).toBe(0);
    await expect(f.owner.close()).resolves.toEqual({ kind: "closed" });
    expect(snapshots).toEqual([1, 0]);
    expect(f.closeContexts).toHaveBeenCalledWith(reply.windowId);
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

it("does not count a server acquisition before its native registration reply succeeds", async () => {
  const f = fixture();
  let beforeAcknowledgement = -1;
  const reply = f.replies.getMockImplementation();
  if (reply === undefined) throw new Error("Fixture reply is missing");
  f.replies.mockImplementationOnce((requestId, result) => {
    beforeAcknowledgement = f.owner.activeWindowCount();
    return reply(requestId, result);
  });
  try {
    await f.send(1, "register");
    expect(beforeAcknowledgement).toBe(0);
    expect(f.owner.activeWindowCount()).toBe(1);
  } finally {
    await f.owner.close();
  }
});
