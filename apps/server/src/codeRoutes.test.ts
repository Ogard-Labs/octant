import {
  decodeCodeCheckoutIdentity,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeCodeOperationId,
  decodeWindowId,
  type CodeEventFrame,
  type CodeOperationEventFrame,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import {
  MAX_CODE_FILE_BODY_SIZE,
  MAX_CODE_NDJSON_LINE_BYTES,
  createCodeRouteHandler,
} from "./codeRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000902");
const operationId = decodeCodeOperationId("00000000-0000-4000-8000-000000000909");
const checkoutId = "00000000-0000-4000-8000-000000000903";
const contentId = "00000000-0000-4000-8000-000000000904";
const projectId = "00000000-0000-4000-8000-000000000906";
const bindingRevisionId = "00000000-0000-4000-8000-000000000907";
const providerInstanceId = "00000000-0000-4000-8000-000000000908";
const now = "2026-07-20T22:00:00.000Z";
const digest = "a".repeat(64);
const repositoryId = `repo_${"b".repeat(64)}`;

const checkout = decodeCodeCheckoutIdentity({
  id: checkoutId,
  repositoryId,
  kind: "existing-worktree",
  availability: "available",
  head: { kind: "branch", name: "feature/phase-7", oid: "c".repeat(40) },
  observedAt: now,
});

const thread = decodeCodeThread({
  id: threadId,
  projectId,
  bindingRevisionId,
  repositoryId,
  checkoutId,
  title: "Authority foundation",
  lifecycle: "active",
  providerInstanceId,
  modelId: "model-a",
  executionPolicy: "full-access",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/phase-7",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "development",
    outcomeKind: "opened-pr",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});

const frame = {
  threadId,
  sequence: 42,
  event: { kind: "thread-updated" as const, thread: { ...thread, version: 2 } },
} as CodeEventFrame;

describe("Code routes", () => {
  it("authenticates before invoking bootstrap or reading a command body", async () => {
    const bootstrap = vi.fn();
    const route = routeFixture({ bootstrap });

    const response = await route(new Request("http://127.0.0.1/api/code/bootstrap"));
    expect(response?.status).toBe(401);
    expect(bootstrap).not.toHaveBeenCalled();

    const command = new Request("http://127.0.0.1/api/code/commands", {
      method: "POST",
      body: "{}",
    });
    const bodyRead = vi.spyOn(command, "arrayBuffer");
    expect((await route(command))?.status).toBe(401);
    expect(bodyRead).not.toHaveBeenCalled();
  });

  it("passes only the authenticated window identity to bootstrap", async () => {
    const bootstrap = vi.fn(async () => ({ settings: settings(), threads: [], checkouts: [] }));
    const route = routeFixture({ bootstrap });

    const response = await route(request("/api/code/bootstrap"));

    expect(response?.status).toBe(200);
    expect(bootstrap).toHaveBeenCalledWith(windowId);
  });

  it("rejects malformed and oversized JSON commands within the one MiB envelope", async () => {
    const execute = vi.fn();
    const route = routeFixture({ execute }, 16);

    const malformed = await route(
      request("/api/code/commands", { method: "POST", body: "not-json" }),
    );
    const oversized = await route(
      request("/api/code/commands", {
        method: "POST",
        headers: { "content-length": "17", "content-type": "application/json" },
        body: "x".repeat(17),
      }),
    );

    expect(malformed?.status).toBe(400);
    expect(oversized?.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });

  it("routes strict Code operations through the authenticated command boundary", async () => {
    const execute = vi.fn();
    const executeOperation = vi.fn(async (authenticatedWindowId, command) => ({
      kind: "operation-accepted",
      operationId: command.operationId,
    }));
    const route = routeFixture({ execute, executeOperation });
    const operation = {
      kind: "start-terminal",
      operationId: "00000000-0000-4000-8000-000000000910",
      threadId,
      checkoutId,
      terminalId: "00000000-0000-4000-8000-000000000911",
      columns: 100,
      rows: 30,
      credentialRefs: [],
    } as const;

    const response = await route(
      request("/api/code/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(operation),
      }),
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      kind: "operation-accepted",
      operationId: operation.operationId,
    });
    expect(executeOperation).toHaveBeenCalledWith(windowId, operation);
    expect(execute).not.toHaveBeenCalled();

    const forged = await route(
      request("/api/code/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...operation, checkoutRoot: "/private/repository" }),
      }),
    );
    expect(forged?.status).toBe(400);
    expect(executeOperation).toHaveBeenCalledOnce();
  });

  it("inspects a terminal through a non-journaling authenticated route", async () => {
    const inspectTerminal = vi.fn(async () => ({
      terminalId: "00000000-0000-4000-8000-000000000911",
      state: "running" as const,
    }));
    const executeOperation = vi.fn();
    const route = routeFixture({ inspectTerminal, executeOperation });
    const input = {
      threadId,
      checkoutId,
      terminalId: "00000000-0000-4000-8000-000000000911",
    };

    const response = await route(
      request("/api/code/terminals/inspect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      terminalId: input.terminalId,
      state: "running",
    });
    expect(inspectTerminal).toHaveBeenCalledWith(windowId, input);
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("rejects a crossed Code operation response identity", async () => {
    const route = routeFixture({
      executeOperation: vi.fn(async () => ({
        kind: "operation-accepted",
        operationId: "00000000-0000-4000-8000-000000000999",
      })),
    });

    const response = await route(
      request("/api/code/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "stop-terminal",
          operationId: "00000000-0000-4000-8000-000000000910",
          threadId,
          checkoutId,
          terminalId: "00000000-0000-4000-8000-000000000911",
        }),
      }),
    );

    expect(response?.status).toBe(503);
  });

  it("reads a strict thread identity without accepting caller window identity", async () => {
    const read = vi.fn(() => ({ thread, checkout, lastSequence: 0 }));
    const route = routeFixture({ read });

    expect((await route(request(`/api/code/threads/${threadId}`)))?.status).toBe(200);
    expect(read).toHaveBeenCalledWith(windowId, threadId);
    expect(
      (
        await route(
          request(`/api/code/threads/${threadId}?windowId=00000000-0000-4000-8000-000000000999`),
        )
      )?.status,
    ).toBe(400);
  });

  it("returns at most 100 bounded NDJSON frames after a strict cursor", async () => {
    const subscribe = vi.fn(async function* () {
      for (let index = 0; index < 101; index += 1) {
        yield { ...frame, sequence: 42 + index } as CodeEventFrame;
      }
    });
    const route = routeFixture({ subscribe });

    const response = await route(request(`/api/code/threads/${threadId}/events?afterSequence=41`));
    const lines = (await response?.text())?.trim().split("\n") ?? [];

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/x-ndjson");
    expect(lines).toHaveLength(100);
    expect(
      lines.every((line) => Buffer.byteLength(`${line}\n`) <= MAX_CODE_NDJSON_LINE_BYTES),
    ).toBe(true);
    expect(subscribe).toHaveBeenCalledWith(windowId, threadId, 41, expect.any(AbortSignal));
  });

  it("replays strict operation frames through the authenticated thread scope", async () => {
    const operationFrame = {
      threadId,
      operationId,
      cursor: 1,
      occurredAt: now,
      event: { kind: "operation-state", state: "completed" },
    } as CodeOperationEventFrame;
    const subscribeOperation = vi.fn(async function* () {
      yield operationFrame;
    });
    const route = routeFixture({ subscribeOperation });

    const response = await route(
      request(`/api/code/threads/${threadId}/operations/${operationId}/events?afterCursor=0`),
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe(`${JSON.stringify(operationFrame)}\n`);
    expect(subscribeOperation).toHaveBeenCalledWith(
      windowId,
      threadId,
      operationId,
      0,
      expect.any(AbortSignal),
    );
  });

  it("reads a versioned paginated conversation through authenticated thread authority", async () => {
    const conversation = vi.fn(async () => ({
      version: 2,
      threadId,
      turns: [],
      nextCursor: 41,
      hasMore: false,
    }));
    const route = routeFixture({ conversation });

    const response = await route(
      request(`/api/code/threads/${threadId}/conversation?afterCursor=40&limit=25`),
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      version: 2,
      threadId,
      turns: [],
      nextCursor: 41,
      hasMore: false,
    });
    expect(conversation).toHaveBeenCalledWith(windowId, threadId, 40, 25);
    expect(
      (await route(request(`/api/code/threads/${threadId}/conversation?afterCursor=-1&limit=25`)))
        ?.status,
    ).toBe(400);
  });

  it("rejects cursor gaps and overlong replay lines instead of skipping them", async () => {
    const gapRoute = routeFixture({
      subscribe: vi.fn(async function* () {
        yield* [];
        throw Object.assign(new Error("snapshot required"), {
          failure: { category: "stale", message: "Code replay requires a snapshot." },
        });
      }),
    });
    const gap = await gapRoute(request(`/api/code/threads/${threadId}/events?afterSequence=41`));
    expect(gap?.status).toBe(409);

    const oversizedRoute = routeFixture({
      subscribe: vi.fn(async function* () {
        yield {
          ...frame,
          event: {
            kind: "thread-updated",
            thread: { ...thread, title: "x".repeat(MAX_CODE_NDJSON_LINE_BYTES) },
          },
        } as CodeEventFrame;
      }),
    });
    expect(
      (await oversizedRoute(request(`/api/code/threads/${threadId}/events?afterSequence=41`)))
        ?.status,
    ).toBe(400);
  });

  it("returns snapshot-required conflict for a cursor ahead of the thread head", async () => {
    const subscribe = vi.fn(async function* () {
      yield* [];
      throw Object.assign(new Error("snapshot required"), {
        failure: { category: "stale", message: "Code replay requires a snapshot." },
      });
    });
    const route = routeFixture({ subscribe });

    const response = await route(request(`/api/code/threads/${threadId}/events?afterSequence=999`));

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      category: "stale",
      message: "Code replay requires a snapshot.",
    });
    expect(subscribe).toHaveBeenCalledWith(windowId, threadId, 999, expect.any(AbortSignal));
  });

  it("returns authorized content as raw bytes with digest and length metadata", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const readContent = vi.fn(() => ({ bytes, digest, byteLength: bytes.byteLength }));
    const route = routeFixture({ readContent });

    const response = await route(
      request(`/api/code/content/${contentId}`, {
        headers: { origin: "http://127.0.0.1:5181" },
      }),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/octet-stream");
    expect(response?.headers.get("content-length")).toBe("4");
    expect(response?.headers.get("x-octant-content-length")).toBe("4");
    expect(response?.headers.get("x-octant-content-digest")).toBe(digest);
    expect(response?.headers.get("access-control-expose-headers")).toBe(
      "x-octant-content-length, x-octant-content-digest",
    );
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(bytes);
    expect(readContent).toHaveBeenCalledWith(windowId, contentId);
  });

  it("discards a pending attachment by thread and attachment identity alone", async () => {
    const discardAttachment = vi.fn(async () => undefined);
    const route = routeFixture({
      discardAttachment,
      readAttachment: vi.fn(),
      stageAttachment: vi.fn(),
    });
    const attachmentId = "00000000-0000-4000-8000-000000000910";

    const response = await route(
      request(`/api/code/attachments?thread=${threadId}&attachment=${attachmentId}`, {
        method: "DELETE",
        headers: { origin: "http://127.0.0.1:5181" },
      }),
    );

    expect(response?.status).toBe(200);
    expect(discardAttachment).toHaveBeenCalledWith(windowId, threadId, attachmentId);
    // Reads still require the digest-pinned identity.
    const read = await route(
      request(`/api/code/attachments?thread=${threadId}&attachment=${attachmentId}`, {
        headers: { origin: "http://127.0.0.1:5181" },
      }),
    );
    expect(read?.status).toBe(400);
  });

  it("returns operation evidence only through its thread and operation authority scope", async () => {
    const bytes = new TextEncoder().encode("diff evidence");
    const readOperationContent = vi.fn(() => ({
      bytes,
      digest: "ccca685709aa9e68d44defdeaa97fcd6da17e124ec1b1e7e0e83e85b8b45cc9a",
      byteLength: bytes.byteLength,
    }));
    const route = routeFixture({ readOperationContent });

    const response = await route(
      request(`/api/code/threads/${threadId}/operations/${operationId}/evidence/${contentId}`),
    );

    expect(response?.status).toBe(200);
    expect(new TextDecoder().decode(await response!.arrayBuffer())).toBe("diff evidence");
    expect(readOperationContent).toHaveBeenCalledWith(windowId, threadId, operationId, contentId);
  });

  it("accepts canonical raw UTF-8 save metadata without exposing a root path", async () => {
    const saveFile = vi.fn(async () => ({
      kind: "code-file-save-result",
      result: {
        status: "completed",
        metadata: {
          identity: { device: "1", inode: "3" },
          digest,
          byteLength: 5,
          modifiedNanoseconds: "4",
        },
      },
    }));
    const route = routeFixture({ saveFile });

    const response = await route(
      request("/api/code/files/content", {
        method: "PUT",
        headers: saveHeaders({ "content-length": "5" }),
        body: "hello",
      }),
    );

    expect(response?.status).toBe(200);
    expect(saveFile).toHaveBeenCalledWith(windowId, {
      threadId,
      checkoutId,
      relativePath: "src/file.ts",
      expectedIdentity: { device: "1", inode: "2" },
      expectedDigest: digest,
      text: "hello",
    });
    expect(JSON.stringify(saveFile.mock.calls[0])).not.toContain("rootPath");
  });

  it("opens a confined file through the authenticated read query", async () => {
    const envelope = {
      kind: "code-file-open-result",
      result: {
        status: "editable",
        fileId: "00000000-0000-4000-8000-000000000905",
        metadata: {
          identity: { device: "1", inode: "2" },
          byteLength: 5,
          modifiedNanoseconds: "4",
          digest,
        },
        content: { contentId, digest, byteLength: 5 },
      },
    };
    const openFile = vi.fn(async () => envelope);
    const route = routeFixture({ openFile });

    const response = await route(
      request(
        `/api/code/files/open?threadId=${threadId}&checkoutId=${checkoutId}&path=${encodeURIComponent("src/file.ts")}`,
      ),
    );

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual(envelope);
    expect(openFile).toHaveBeenCalledWith(windowId, {
      threadId,
      checkoutId,
      relativePath: "src/file.ts",
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(openFile.mock.calls[0]?.slice(0, 2))).not.toContain("rootPath");
  });

  it("maps an unauthorized open to the shared failure envelope", async () => {
    const openFile = vi.fn(async () => {
      throw Object.assign(new Error("unauthorized"), {
        failure: { category: "unauthorized", message: "Code file open is unauthorized." },
      });
    });
    const route = routeFixture({ openFile });

    const response = await route(
      request(
        `/api/code/files/open?threadId=${threadId}&checkoutId=${checkoutId}&path=${encodeURIComponent("src/file.ts")}`,
      ),
    );

    expect(response?.status).toBe(401);
    expect(await response!.json()).toEqual({
      category: "unauthorized",
      message: "Code file open is unauthorized.",
    });
  });

  it("rejects a wrong-method, malformed, and unauthenticated open before the service", async () => {
    const openFile = vi.fn();
    const route = routeFixture({ openFile });

    const wrongMethod = await route(
      request(
        `/api/code/files/open?threadId=${threadId}&checkoutId=${checkoutId}&path=src%2Ffile.ts`,
        { method: "PUT", body: "x" },
      ),
    );
    const traversal = await route(
      request(
        `/api/code/files/open?threadId=${threadId}&checkoutId=${checkoutId}&path=${encodeURIComponent("../secret")}`,
      ),
    );
    const missingPath = await route(
      request(`/api/code/files/open?threadId=${threadId}&checkoutId=${checkoutId}`),
    );
    const unauthenticated = await route(
      new Request(
        `http://127.0.0.1/api/code/files/open?threadId=${threadId}&checkoutId=${checkoutId}&path=src%2Ffile.ts`,
      ),
    );

    expect(wrongMethod?.status).toBe(400);
    expect(traversal?.status).toBe(400);
    expect(missingPath?.status).toBe(400);
    expect(unauthenticated?.status).toBe(401);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("stages provider-turn prompt evidence for an authorized Code thread", async () => {
    const stageEvidence = vi.fn(async () => ({
      contentId,
      digest,
      byteLength: 3,
    }));
    const route = routeFixture({ stageEvidence });

    const response = await route(
      request("/api/code/evidence", {
        method: "PUT",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-octant-code-thread-id": String(threadId),
        },
        body: "hei",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ contentId, digest, byteLength: 3 });
    expect(stageEvidence).toHaveBeenCalledWith(windowId, threadId, "hei");
  });

  it("rejects invalid UTF-8, metadata, media type, and bodies above the inclusive 5 MiB limit", async () => {
    const saveFile = vi.fn();
    const route = routeFixture({ saveFile });
    const invalidUtf8 = await route(
      request("/api/code/files/content", {
        method: "PUT",
        headers: saveHeaders({ "content-length": "2" }),
        body: new Uint8Array([0x61, 0x80]),
      }),
    );
    const badPath = await route(
      request("/api/code/files/content", {
        method: "PUT",
        headers: saveHeaders({
          "content-length": "1",
          "x-octant-code-relative-path": "../secret",
        }),
        body: "x",
      }),
    );
    const badType = await route(
      request("/api/code/files/content", {
        method: "PUT",
        headers: saveHeaders({ "content-length": "1", "content-type": "text/plain" }),
        body: "x",
      }),
    );
    const tooLarge = await route(
      request("/api/code/files/content", {
        method: "PUT",
        headers: saveHeaders({ "content-length": String(MAX_CODE_FILE_BODY_SIZE + 1) }),
        body: "x",
      }),
    );

    expect(invalidUtf8?.status).toBe(400);
    expect(badPath?.status).toBe(400);
    expect(badType?.status).toBe(400);
    expect(tooLarge?.status).toBe(413);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("does not pass request cancellation into accepted file mutations", async () => {
    let release: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saveFile = vi.fn(async () => {
      await accepted;
      return {
        kind: "code-file-save-result",
        result: {
          status: "completed",
          metadata: {
            identity: { device: "1", inode: "3" },
            digest,
            byteLength: 1,
            modifiedNanoseconds: "4",
          },
        },
      };
    });
    const route = routeFixture({ saveFile });
    const controller = new AbortController();
    const responsePromise = route(
      request("/api/code/files/content", {
        method: "PUT",
        headers: saveHeaders({ "content-length": "1" }),
        body: "x",
        signal: controller.signal,
      }),
    );
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
    controller.abort();
    release?.();

    expect((await responsePromise)?.status).toBe(200);
    expect(saveFile.mock.calls[0]).toHaveLength(2);
  });
});

describe("Code board route", () => {
  const boardView = {
    version: 1 as const,
    query: { version: 1 as const, statuses: ["ready", "in-progress", "waiting", "done"] as const },
    cards: [],
    generatedAt: now,
  };

  it("decodes a board query and returns the resolved board view", async () => {
    const queryBoard = vi.fn(() => boardView);
    const route = routeFixture({ queryBoard });

    const response = await route(
      request("/api/code/board", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, statuses: ["waiting"] }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual(boardView);
    expect(queryBoard).toHaveBeenCalledWith(windowId, { version: 1, statuses: ["waiting"] });
  });

  it("rejects an invalid board query and a query that supplies window identity", async () => {
    const queryBoard = vi.fn(() => boardView);
    const route = routeFixture({ queryBoard });

    const invalid = await route(
      request("/api/code/board", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, statuses: ["blocked"] }),
      }),
    );
    const spoofed = await route(
      request("/api/code/board", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, windowId }),
      }),
    );

    expect(invalid?.status).toBe(400);
    expect(spoofed?.status).toBe(400);
    expect(queryBoard).not.toHaveBeenCalled();
  });

  it("reports the board unavailable when no board service is mounted", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const route = createCodeRouteHandler({
      service: {
        bootstrap: vi.fn(),
        read: vi.fn(),
        execute: vi.fn(),
        subscribe: vi.fn(async function* () {}),
        readContent: vi.fn(),
        saveFile: vi.fn(),
      } as never,
      windowAuthorityStore: store,
      now: () => 1,
    });

    const response = await route(
      request("/api/code/board", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      }),
    );

    expect(response?.status).toBe(503);
  });
});

function settings() {
  return {
    defaultExecutionPolicy: "approval-gated" as const,
    defaultPermissionPersistence: "current-session" as const,
    version: 0,
    updatedAt: now,
  };
}

function saveHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "text/plain; charset=utf-8",
    "x-octant-code-thread-id": String(threadId),
    "x-octant-code-checkout-id": checkoutId,
    "x-octant-code-relative-path": encodeURIComponent("src/file.ts"),
    "x-octant-code-file-device": "1",
    "x-octant-code-file-inode": "2",
    "x-octant-code-expected-digest": digest,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("x-octant-window-capability")) {
    headers.set("x-octant-window-capability", capability);
  }
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

function routeFixture(overrides: Record<string, unknown> = {}, maxJsonBodySize?: number) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const service = {
    bootstrap: vi.fn(async () => ({ settings: settings(), threads: [], checkouts: [] })),
    read: vi.fn(() => ({ thread, checkout, lastSequence: 0 })),
    execute: vi.fn(),
    executeOperation: vi.fn(),
    subscribeOperation: vi.fn(async function* () {}),
    subscribe: vi.fn(async function* () {}),
    readContent: vi.fn(),
    readOperationContent: vi.fn(),
    saveFile: vi.fn(),
    openFile: vi.fn(),
    ...overrides,
  };
  return createCodeRouteHandler({
    service: service as never,
    windowAuthorityStore: store,
    now: () => 1,
    ...(maxJsonBodySize === undefined ? {} : { maxJsonBodySize }),
  });
}
