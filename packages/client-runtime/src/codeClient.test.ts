import { describe, expect, it, vi } from "vitest";
import { decodeProjectId } from "@octant/contracts/projects";
import {
  CodeClientFailure,
  CodeClientSnapshotRequiredError,
  createCodeClient,
  MAX_CODE_NDJSON_LINE_BYTES,
} from "./codeClient";

const baseUrl = "http://127.0.0.1:4310";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const now = "2026-07-20T21:00:00.000Z";
const ids = {
  thread: "10000000-0000-4000-8000-000000000001",
  project: "20000000-0000-4000-8000-000000000001",
  bindingRevision: "30000000-0000-4000-8000-000000000001",
  checkout: "40000000-0000-4000-8000-000000000001",
  content: "60000000-0000-4000-8000-000000000001",
  operation: "70000000-0000-4000-8000-000000000001",
  terminal: "80000000-0000-4000-8000-000000000001",
  provider: "50000000-0000-4000-8000-000000000001",
} as const;
const repositoryId = `repo_${"a".repeat(64)}`;

const thread = {
  id: ids.thread,
  projectId: ids.project,
  bindingRevisionId: ids.bindingRevision,
  repositoryId,
  checkoutId: ids.checkout,
  title: "Authority notes",
  lifecycle: "active",
  providerInstanceId: ids.provider,
  modelId: "model-a",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/phase-7-authority-foundation",
    remoteName: "origin",
    proposedBaseRepository: "octocat/octant",
    proposedBaseBranch: "development",
    outcomeKind: "opened-pr",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
} as const;

const settings = {
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  version: 1,
  updatedAt: now,
} as const;

function frame(sequence: number) {
  return {
    threadId: ids.thread,
    sequence,
    event: { kind: "thread-updated", thread: { ...thread, version: sequence } },
  } as const;
}

describe("code client", () => {
  it("authenticates strict bootstrap and command requests, rejecting invalid commands before send", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          settings,
          threads: [thread],
          checkouts: [
            {
              id: ids.checkout,
              repositoryId,
              kind: "existing-worktree",
              availability: "available",
              head: { kind: "branch", name: "main", oid: "a".repeat(40) },
              observedAt: now,
            },
          ],
          activity: [{ threadId: ids.thread, lastSequence: 7 }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          kind: "thread-lifecycle-changed",
          threadId: ids.thread,
          lifecycle: "archived",
          version: 2,
        }),
      );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.bootstrap()).resolves.toMatchObject({
      threads: [thread],
      activity: [{ threadId: ids.thread, lastSequence: 7 }],
    });
    await expect(
      client.execute({
        kind: "change-code-thread-lifecycle",
        threadId: ids.thread as never,
        expectedVersion: 1 as never,
        lifecycle: "archived",
      }),
    ).resolves.toMatchObject({ kind: "thread-lifecycle-changed" });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      `${baseUrl}/api/code/bootstrap`,
      expect.objectContaining({
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `${baseUrl}/api/code/commands`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
      }),
    );

    await expect(client.execute({ kind: "not-code" } as never)).rejects.toMatchObject({
      category: "invalid",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends strict opaque Code operations through the authenticated command endpoint", async () => {
    const result = {
      kind: "operation-accepted",
      operationId: "70000000-0000-4000-8000-000000000001",
    } as const;
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });
    const operation = {
      kind: "start-terminal",
      operationId: result.operationId,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      terminalId: "70000000-0000-4000-8000-000000000002",
      columns: 100,
      rows: 30,
      credentialRefs: [],
    } as const;

    await expect(client.executeOperation(operation as never)).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/commands`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
        body: JSON.stringify(operation),
      }),
    );

    await expect(
      client.executeOperation({ ...operation, checkoutRoot: "/private/repository" } as never),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("inspects a thread terminal without creating a journaled operation", async () => {
    const inspection = { terminalId: ids.terminal, state: "running" } as const;
    const fetch = vi.fn().mockResolvedValue(Response.json(inspection));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });
    const request = {
      threadId: ids.thread,
      checkoutId: ids.checkout,
      terminalId: ids.terminal,
    } as const;

    await expect(client.inspectTerminal(request as never)).resolves.toEqual(inspection);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/terminals/inspect`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        }),
        body: JSON.stringify(request),
      }),
    );
  });

  it("queries the Code Thread Board and decodes the resolved view", async () => {
    const view = {
      version: 1,
      query: { version: 1, statuses: ["ready", "in-progress", "waiting", "done"] },
      cards: [],
      generatedAt: now,
    } as const;
    const fetch = vi.fn().mockResolvedValue(Response.json(view));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(
      client.queryBoard({ version: 1, statuses: ["waiting"] } as never),
    ).resolves.toEqual(view);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/board`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
        body: JSON.stringify({ version: 1, statuses: ["waiting"] }),
      }),
    );
  });

  it("rejects an invalid board query before sending it", async () => {
    const fetch = vi.fn();
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(
      client.queryBoard({ version: 1, statuses: ["blocked"] } as never),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("queries the cached project pull-request snapshot without a refresh flag", async () => {
    const view = {
      version: 1,
      query: { version: 1 },
      projects: [],
      rows: [],
      repositoriesTruncated: false,
      pullRequestsTruncated: false,
      freshness: { status: "empty" },
      generatedAt: now,
    } as const;
    const fetch = vi.fn().mockResolvedValue(Response.json(view));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.queryProjectPullRequests({ version: 1 })).resolves.toEqual(view);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/project-pull-requests`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ version: 1 }),
      }),
    );
  });

  it("refreshes project pull requests through a distinct envelope and refuses owner credentials", async () => {
    const view = {
      version: 1,
      query: { version: 1 },
      projects: [],
      rows: [],
      repositoriesTruncated: false,
      pullRequestsTruncated: false,
      freshness: { status: "fresh", lastSuccessfulRefreshAt: now },
      generatedAt: now,
    } as const;
    const fetch = vi.fn().mockResolvedValue(Response.json(view));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.refreshProjectPullRequests({ kind: "refresh-all" })).resolves.toEqual(view);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/project-pull-requests/refresh`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "refresh-all" }),
      }),
    );
    await expect(
      client.refreshProjectPullRequests({
        kind: "refresh-all",
        owner: "octant",
        credentials: "secret",
      } as never),
    ).rejects.toMatchObject({ category: "invalid" });
    await expect(
      client.queryProjectPullRequests({ version: 1, refresh: true, owner: "octant" } as never),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("queries cached project pull-request detail without a refresh flag", async () => {
    const detailQuery = {
      projectId: decodeProjectId("10000000-0000-4000-8000-000000000001"),
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 12,
    };
    const view = {
      version: 1,
      query: detailQuery,
      detail: { state: "empty" },
      freshness: { status: "empty" },
      linkedThreads: [],
      generatedAt: now,
    } as const;
    const fetch = vi.fn().mockResolvedValue(Response.json(view));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.queryProjectPullRequestDetail(detailQuery)).resolves.toEqual(view);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/project-pull-requests/detail`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(detailQuery),
      }),
    );
  });

  it("refreshes project pull-request detail through a distinct envelope and refuses owner credentials", async () => {
    const detailQuery = {
      projectId: decodeProjectId("10000000-0000-4000-8000-000000000001"),
      repositoryOwner: "octant",
      repositoryName: "octant",
      number: 12,
    };
    const view = {
      version: 1,
      query: detailQuery,
      detail: { state: "empty" },
      freshness: { status: "empty" },
      linkedThreads: [],
      generatedAt: now,
    } as const;
    const fetch = vi.fn().mockResolvedValue(Response.json(view));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.refreshProjectPullRequestDetail(detailQuery)).resolves.toEqual(view);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/project-pull-requests/detail/refresh`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(detailQuery),
      }),
    );
    await expect(
      client.refreshProjectPullRequestDetail({
        ...detailQuery,
        owner: "octant",
        credentials: "secret",
      } as never),
    ).rejects.toMatchObject({ category: "invalid" });
    await expect(
      client.queryProjectPullRequestDetail({ ...detailQuery, refresh: true } as never),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads a Code thread follow-up view over the authenticated endpoint", async () => {
    const view = {
      threadId: ids.thread,
      followUpVersion: 3,
      followUp: {
        threadId: ids.thread,
        state: "open",
        origin: "automatic",
        reason: "Awaiting approval",
        triggerSequence: 7,
        acknowledgedThroughSequence: 0,
        createdAt: now,
      },
    } as const;
    const fetch = vi.fn().mockResolvedValue(Response.json(view));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.readFollowUp(ids.thread as never)).resolves.toEqual(view);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/threads/${ids.thread}/follow-up`,
      expect.objectContaining({
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );
  });

  it("executes a Code follow-up command and decodes the updated marker", async () => {
    const command = {
      kind: "complete-code-follow-up",
      threadId: ids.thread,
      expectedVersion: 3,
      acknowledgedThroughSequence: 7,
    } as const;
    const updated = {
      kind: "follow-up-updated",
      followUp: {
        threadId: ids.thread,
        state: "completed",
        origin: "automatic",
        reason: "Awaiting approval",
        triggerSequence: 7,
        acknowledgedThroughSequence: 7,
        createdAt: now,
        completedAt: now,
      },
    } as const;
    const fetch = vi.fn().mockResolvedValue(Response.json(updated));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.executeFollowUp(command as never)).resolves.toEqual(updated);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/threads/${ids.thread}/follow-up`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
        body: JSON.stringify(command),
      }),
    );
  });

  it("rejects an invalid Code follow-up command before sending it", async () => {
    const fetch = vi.fn();
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(
      client.executeFollowUp({ kind: "open-code-follow-up" } as never),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-loopback base URLs before exposing the window capability", () => {
    const fetch = vi.fn();

    expect(() =>
      createCodeClient({ baseUrl: "https://example.com", fetch, windowCapability: capability }),
    ).toThrow("loopback");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a crossed operation response identity", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        kind: "operation-accepted",
        operationId: "70000000-0000-4000-8000-000000000099",
      }),
    );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(
      client.executeOperation({
        kind: "stop-terminal",
        operationId: "70000000-0000-4000-8000-000000000001",
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: "70000000-0000-4000-8000-000000000002",
      } as never),
    ).rejects.toMatchObject({ category: "unavailable" });
  });

  it("rejects oversized evidence before buffering the response body", async () => {
    const response = new Response(new Uint8Array(), {
      headers: {
        "content-type": "application/octet-stream",
        "x-octant-content-length": String(64 * 1024 * 1024 + 1),
        "x-octant-content-digest": "a".repeat(64),
      },
    });
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    const client = createCodeClient({
      baseUrl,
      fetch: vi.fn().mockResolvedValue(response),
      windowCapability: capability,
    });

    await expect(
      client.content("60000000-0000-4000-8000-000000000001" as never),
    ).rejects.toMatchObject({ category: "unavailable" });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("sends text saves as exact UTF-8 with only compact identity metadata headers", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        kind: "code-file-save-result",
        result: {
          status: "completed",
          metadata: {
            identity: { device: "1", inode: "2" },
            byteLength: 5,
            modifiedNanoseconds: "3",
            digest: "b".repeat(64),
          },
        },
      }),
    );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(
      client.save({
        threadId: ids.thread as never,
        checkoutId: ids.checkout as never,
        path: "src/caf\u00e9.ts" as never,
        expectedIdentity: { device: "1", inode: "2" },
        expectedDigest: "a".repeat(64),
        text: "caf\u00e9",
      }),
    ).resolves.toMatchObject({ status: "completed", metadata: { byteLength: 5 } });

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/files/content`,
      expect.objectContaining({ method: "PUT" }),
    );
    expect(init.headers).toEqual({
      "x-octant-window-capability": capability,
      "content-type": "text/plain; charset=utf-8",
      "x-octant-code-thread-id": ids.thread,
      "x-octant-code-checkout-id": ids.checkout,
      "x-octant-code-relative-path": encodeURIComponent("src/caf\u00e9.ts"),
      "x-octant-code-file-device": "1",
      "x-octant-code-file-inode": "2",
      "x-octant-code-expected-digest": "a".repeat(64),
    });
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe("caf\u00e9");
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  it("strictly decodes server failures and raw-save results", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ category: "conflict", message: "File changed." }, { status: 409 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          kind: "code-file-save-result",
          result: { status: "completed", metadata: { byteLength: 0 } },
        }),
      );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.thread(ids.thread as never)).rejects.toMatchObject({
      category: "conflict",
    });
    await expect(
      client.save({
        threadId: ids.thread as never,
        checkoutId: ids.checkout as never,
        path: "src/file.ts" as never,
        expectedIdentity: { device: "1", inode: "2" },
        expectedDigest: "a".repeat(64),
        text: "",
      }),
    ).rejects.toBeInstanceOf(CodeClientFailure);
  });

  it("uses the canonical save envelope constraints for response metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        kind: "code-file-save-result",
        result: {
          status: "completed",
          metadata: {
            identity: { device: " ", inode: "2" },
            byteLength: 0,
            modifiedNanoseconds: "3",
            digest: "b".repeat(64),
          },
        },
      }),
    );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(
      client.save({
        threadId: ids.thread as never,
        checkoutId: ids.checkout as never,
        path: "src/file.ts" as never,
        expectedIdentity: { device: "1", inode: "2" },
        expectedDigest: "a".repeat(64),
        text: "",
      }),
    ).rejects.toMatchObject({ category: "unavailable" });
  });

  it("verifies content response length and digest before returning raw bytes", async () => {
    const bytes = new TextEncoder().encode("content");
    const fetch = vi.fn().mockResolvedValue(
      new Response(bytes, {
        headers: {
          "content-type": "application/octet-stream",
          "x-octant-content-length": String(bytes.byteLength),
          "x-octant-content-digest":
            "ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73",
        },
      }),
    );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.content("60000000-0000-4000-8000-000000000001" as never)).resolves.toEqual(
      bytes,
    );
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/content/60000000-0000-4000-8000-000000000001`,
      expect.objectContaining({
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );
  });

  it("reads operation evidence through its authoritative thread and operation scope", async () => {
    const bytes = new TextEncoder().encode("content");
    const fetch = vi.fn().mockResolvedValue(
      new Response(bytes, {
        headers: {
          "content-type": "application/octet-stream",
          "x-octant-content-length": String(bytes.byteLength),
          "x-octant-content-digest":
            "ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73",
        },
      }),
    );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(
      client.operationContent(ids.thread as never, ids.operation as never, ids.content as never),
    ).resolves.toEqual(bytes);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/threads/${ids.thread}/operations/${ids.operation}/evidence/${ids.content}`,
      expect.objectContaining({
        method: "GET",
        headers: { "x-octant-window-capability": capability },
      }),
    );
  });

  it("replays only ordered bounded same-thread frames and requests a snapshot after a gap", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(`${JSON.stringify(frame(42))}\n${JSON.stringify(frame(44))}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });
    const observed: number[] = [];

    await expect(async () => {
      for await (const event of client.subscribe(
        ids.thread as never,
        41,
        new AbortController().signal,
      )) {
        observed.push(event.sequence);
      }
    }).rejects.toBeInstanceOf(CodeClientSnapshotRequiredError);
    expect(observed).toEqual([42]);

    for (const invalid of [
      `${JSON.stringify({ ...frame(42), threadId: "90000000-0000-4000-8000-000000000001" })}\n`,
      `${JSON.stringify(frame(41))}\n`,
      `${JSON.stringify(frame(42))}\n${JSON.stringify(frame(42))}\n`,
      `${"x".repeat(MAX_CODE_NDJSON_LINE_BYTES + 1)}\n`,
    ]) {
      const invalidClient = createCodeClient({
        baseUrl,
        fetch: vi.fn().mockResolvedValue(new Response(invalid)),
        windowCapability: capability,
      });
      await expect(async () => {
        for await (const event of invalidClient.subscribe(
          ids.thread as never,
          41,
          new AbortController().signal,
        )) {
          void event;
        }
      }).rejects.toBeInstanceOf(CodeClientFailure);
    }
  });

  it("replays only ordered same-operation frames through the operation event endpoint", async () => {
    const operationId = "70000000-0000-4000-8000-000000000001";
    const operationFrame = (cursor: number) => ({
      threadId: ids.thread,
      operationId,
      cursor,
      occurredAt: now,
      event: { kind: "operation-state", state: "completed" },
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(`${JSON.stringify(operationFrame(1))}\n${JSON.stringify(operationFrame(3))}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });
    const observed: number[] = [];

    await expect(async () => {
      for await (const event of client.subscribeOperation(
        ids.thread as never,
        operationId as never,
        0,
        new AbortController().signal,
      )) {
        observed.push(event.cursor);
      }
    }).rejects.toBeInstanceOf(CodeClientSnapshotRequiredError);
    expect(observed).toEqual([1]);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/threads/${ids.thread}/operations/${operationId}/events?afterCursor=0`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("puts prompt evidence for a Code thread", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ contentId: ids.content, digest: "a".repeat(64), byteLength: 3 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.putEvidence(ids.thread as never, "hei")).resolves.toEqual({
      contentId: ids.content,
      digest: "a".repeat(64),
      byteLength: 3,
    });
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/evidence`,
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "content-type": "text/plain; charset=utf-8",
          "x-octant-code-thread-id": ids.thread,
          "x-octant-window-capability": capability,
        }),
        body: "hei",
      }),
    );
  });

  it("reads a strict paginated Code conversation projection", async () => {
    const page = {
      version: 3,
      threadId: ids.thread,
      turns: [],
      nextCursor: 42,
      hasMore: false,
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(page));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.conversation(ids.thread as never, 40, 25)).resolves.toEqual(page);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/threads/${ids.thread}/conversation?afterCursor=40&limit=25`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("opens a confined file and unwraps the strict open envelope", async () => {
    const result = {
      status: "editable",
      fileId: "90000000-0000-4000-8000-000000000001",
      metadata: {
        identity: { device: "1", inode: "2" },
        byteLength: 5,
        modifiedNanoseconds: "3",
        digest: "a".repeat(64),
      },
      content: { contentId: ids.content, digest: "a".repeat(64), byteLength: 5 },
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ kind: "code-file-open-result", result }));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(
      client.openFile(ids.thread as never, ids.checkout as never, "src/file.ts" as never),
    ).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/files/open?threadId=${ids.thread}&checkoutId=${ids.checkout}&path=src%2Ffile.ts`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
      }),
    );
  });

  it("refuses an invalid open path locally and surfaces the host's typed failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { category: "unauthorized", message: "Code file open is unauthorized." },
          { status: 401 },
        ),
      );
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(
      client.openFile(ids.thread as never, ids.checkout as never, "../secret" as never),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(fetch).not.toHaveBeenCalled();

    await expect(
      client.openFile(ids.thread as never, ids.checkout as never, "src/file.ts" as never),
    ).rejects.toMatchObject({ category: "unauthorized" });
  });

  it("reads the host's repository test definitions for a checkout", async () => {
    const listing = {
      kind: "code-repository-test-listing",
      threadId: ids.thread,
      checkoutId: ids.checkout,
      definitions: [
        {
          id: "90000000-0000-4000-8000-000000000001",
          name: "test",
          source: {
            kind: "package-script",
            packagePath: "package.json",
            packageManager: "bun",
            script: "test",
          },
          argv: ["bun", "run", "test"],
          cwd: ".",
          environmentRefs: [],
          timeoutMs: 900_000,
          artifactPaths: [],
        },
      ],
      observedAt: now,
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(listing));
    const client = createCodeClient({ baseUrl, fetch, windowCapability: capability });

    await expect(client.listTests?.(ids.thread as never, ids.checkout as never)).resolves.toEqual(
      listing,
    );
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/code/tests/listing?threadId=${ids.thread}&checkoutId=${ids.checkout}`,
      expect.objectContaining({ method: "GET" }),
    );
  });
});
