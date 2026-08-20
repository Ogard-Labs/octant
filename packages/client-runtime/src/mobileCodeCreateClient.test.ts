import { describe, expect, it, vi } from "vitest";
import { decodeCodeDeliveryTarget, MAX_CODE_OPERATION_TEXT_BYTES } from "@octant/contracts";
import {
  MobileCodeCreationFailure,
  createMobileCodeFromPrompt,
  fetchMobileCodeProjects,
  listMobileCodeProjects,
} from "./mobileCodeCreateClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const hostId = "11111111-1111-4111-8111-111111111111";
const projectId = "20000000-0000-4000-8000-000000000001";
const providerInstanceId = "10000000-0000-4000-8000-000000000001";
const threadId = "60000000-0000-4000-8000-000000000099";
const checkoutId = "70000000-0000-4000-8000-000000000001";
const bindingRevisionId = "30000000-0000-4000-8000-000000000001";
const repositoryId = `repo_${"a".repeat(64)}`;
const now = "2026-08-10T09:30:00.000Z";
const confirmedDeliveryTarget = decodeCodeDeliveryTarget({
  branchIntent: "feature/mobile-code-flow",
  remoteName: "origin",
  proposedBaseRepository: "octocat/octant",
  proposedBaseBranch: "development",
  outcomeKind: "opened-pr",
  confirmedAt: now,
});

const codeProject = {
  id: projectId,
  name: "Octant",
  lifecycle: "active",
  pinned: true,
  rank: "0/1",
  version: 1,
  createdAt: now,
  updatedAt: now,
  type: "code",
  binding: { canonicalRoot: "/repos/octant" },
  bindingRevisionId,
  codeAccessPersistence: "current-session",
} as const;

const checkout = {
  id: checkoutId,
  repositoryId,
  kind: "existing-worktree",
  availability: "available",
  head: { kind: "branch", name: "development", oid: "a".repeat(40) },
  observedAt: now,
} as const;

describe("mobile Code creation", () => {
  it("lists only active Code projects with their repository roots", () => {
    expect(
      listMobileCodeProjects([
        codeProject,
        { ...codeProject, id: "20000000-0000-4000-8000-000000000002", lifecycle: "archived" },
      ] as never),
    ).toEqual([{ projectId, name: "Octant", root: "/repos/octant" }]);
  });

  it("carries a stored new-thread workspace habit with the listed Project", () => {
    expect(
      listMobileCodeProjects([{ ...codeProject, newThreadWorkspace: "managed-worktree" }] as never),
    ).toEqual([
      {
        projectId,
        name: "Octant",
        root: "/repos/octant",
        newThreadWorkspace: "managed-worktree",
      },
    ]);
  });

  /**
   * A Project that never chose, or that chose the current checkout, must bind
   * that checkout. Inventing a managed worktree here would ignore the habit
   * desktop already honors.
   */
  it("binds the Project's current checkout instead of creating a managed worktree", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (request: { method: string; path: string; body?: string }) => {
      if (request.method === "GET" && request.path === "/api/code/bootstrap") {
        return Response.json({
          settings: {
            defaultExecutionPolicy: "full-access",
            defaultPermissionPersistence: "project-default",
            version: 1,
            updatedAt: now,
          },
          threads: [],
          checkouts: [checkout],
          activity: [],
        });
      }
      if (request.method === "POST" && request.path === "/api/code/commands") {
        const payload = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        commands.push(payload);
        if (payload.kind === "prepare-code-project-checkout") {
          return Response.json({ kind: "checkout-prepared", bindingRevisionId, checkout });
        }
        if (payload.kind === "get-worktree-remote-facts") {
          return Response.json({
            kind: "worktree-remote-facts-retrieved",
            projectId,
            facts: { remotes: ["origin"], defaultRemote: "origin" },
          });
        }
        if (payload.kind === "create-code-thread") {
          const thread = payload.thread as {
            readonly id: string;
            readonly checkoutId: string;
            readonly title: string;
          };
          return Response.json({
            kind: "thread-created",
            thread: {
              id: thread.id,
              projectId,
              bindingRevisionId,
              repositoryId,
              checkoutId: thread.checkoutId,
              title: thread.title,
              lifecycle: "active",
              providerInstanceId,
              modelId: "gpt-5.6",
              executionPolicy: "approval-gated",
              permissionPersistence: "current-session",
              deliveryTarget: confirmedDeliveryTarget,
              version: 1,
              createdAt: now,
              updatedAt: now,
            },
          });
        }
        if (payload.kind === "start-provider-turn") {
          return Response.json({
            kind: "provider-turn-state",
            operationId: payload.operationId,
            state: "running",
          });
        }
        return new Response("unexpected command", { status: 500 });
      }
      if (request.method === "PUT" && request.path === "/api/code/evidence") {
        return Response.json({
          contentId: "80000000-0000-4000-8000-000000000001",
          digest: "b".repeat(64),
          byteLength: 16,
        });
      }
      return new Response("missing", { status: 404 });
    });
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    await expect(
      createMobileCodeFromPrompt({
        transport,
        prompt: "Fix search in the current checkout",
        project: { projectId, name: "Octant", root: "/repos/octant" },
        providerInstanceId,
        modelId: "gpt-5.6",
        threadId,
        confirmDeliveryTarget: vi.fn(async (proposal) => {
          expect(proposal).toMatchObject({
            workspace: "current-checkout",
            boundRoot: "/repos/octant",
            proposedBaseBranch: "development",
            branchIntent: "development",
          });
          return decodeCodeDeliveryTarget({
            ...confirmedDeliveryTarget,
            branchIntent: "development",
            proposedBaseBranch: "development",
          });
        }),
        uuid: vi
          .fn()
          .mockReturnValueOnce("81000000-0000-4000-8000-000000000001")
          .mockReturnValueOnce("82000000-0000-4000-8000-000000000001"),
      }),
    ).resolves.toMatchObject({ threadId, mode: "code" });

    expect(commands.map((command) => command.kind)).toEqual([
      "prepare-code-project-checkout",
      "get-worktree-remote-facts",
      "create-code-thread",
      "start-provider-turn",
    ]);
    expect(commands[2]).toMatchObject({
      kind: "create-code-thread",
      thread: {
        checkoutId,
        executionPolicy: "approval-gated",
        deliveryTarget: { branchIntent: "development" },
      },
    });
  });

  it("fails closed when the host refuses the Project checkout", async () => {
    const fetch = vi.fn(async (request: { method: string; path: string }) => {
      if (request.method === "GET" && request.path === "/api/code/bootstrap") {
        return Response.json({
          settings: {
            defaultExecutionPolicy: "approval-gated",
            defaultPermissionPersistence: "current-session",
            version: 1,
            updatedAt: now,
          },
          threads: [],
          checkouts: [],
          activity: [],
        });
      }
      if (request.method === "POST" && request.path === "/api/code/commands") {
        return new Response("Code Project checkout is unauthorized.", { status: 403 });
      }
      return new Response("missing", { status: 404 });
    });

    await expect(
      createMobileCodeFromPrompt({
        transport: {
          hostId,
          authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
        },
        prompt: "Fix search",
        project: { projectId, name: "Octant", root: "/repos/octant" },
        providerInstanceId,
        modelId: "gpt-5.6",
        threadId,
        confirmDeliveryTarget: vi.fn(async () => confirmedDeliveryTarget),
      }),
    ).rejects.toMatchObject({ category: "rejected" });
  });

  it("fails closed when the bound checkout cannot be prepared", async () => {
    const fetch = vi.fn(async (request: { method: string; path: string }) => {
      if (request.method === "GET" && request.path === "/api/code/bootstrap") {
        return Response.json({
          settings: {
            defaultExecutionPolicy: "approval-gated",
            defaultPermissionPersistence: "current-session",
            version: 1,
            updatedAt: now,
          },
          threads: [],
          checkouts: [],
          activity: [],
        });
      }
      if (request.method === "POST" && request.path === "/api/code/commands") {
        return new Response("The bound Code repository is unavailable.", { status: 409 });
      }
      return new Response("missing", { status: 404 });
    });

    await expect(
      createMobileCodeFromPrompt({
        transport: {
          hostId,
          authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
        },
        prompt: "Fix search",
        project: { projectId, name: "Octant", root: "/repos/octant" },
        providerInstanceId,
        modelId: "gpt-5.6",
        threadId,
        confirmDeliveryTarget: vi.fn(async () => confirmedDeliveryTarget),
      }),
    ).rejects.toMatchObject({ category: "unavailable" });
  });

  it("prepares a checkout, creates an approval-gated thread, and starts its first turn", async () => {
    const editedBaseDeliveryTarget = decodeCodeDeliveryTarget({
      ...confirmedDeliveryTarget,
      proposedBaseBranch: "release",
    });
    const calls: Array<{
      method: string;
      path: string;
      body?: string;
      headers?: Record<string, string>;
    }> = [];
    const fetch = vi.fn(
      async (request: {
        method: string;
        path: string;
        body?: string;
        headers?: Record<string, string>;
      }) => {
        calls.push(request);
        if (request.method === "GET" && request.path === "/api/projects/bootstrap") {
          return Response.json({
            active: [codeProject],
            archived: [],
            availability: [{ projectId, status: "available", observedAt: now }],
            memory: [],
          });
        }
        if (request.method === "GET" && request.path === "/api/code/bootstrap") {
          return Response.json({
            settings: {
              defaultExecutionPolicy: "full-access",
              defaultPermissionPersistence: "project-default",
              version: 1,
              updatedAt: now,
            },
            threads: [],
            checkouts: [checkout],
            activity: [],
          });
        }
        if (request.method === "POST" && request.path === "/api/code/commands") {
          const payload = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
          if (payload.kind === "prepare-code-project-checkout") {
            return Response.json({ kind: "checkout-prepared", bindingRevisionId, checkout });
          }
          if (payload.kind === "get-worktree-remote-facts") {
            return Response.json({
              kind: "worktree-remote-facts-retrieved",
              projectId,
              facts: { remotes: ["origin"], defaultRemote: "origin" },
            });
          }
          if (payload.kind === "create-managed-code-thread") {
            expect(payload).toMatchObject({
              projectId,
              providerInstanceId,
              modelId: "gpt-5.6",
              executionPolicy: "approval-gated",
              permissionPersistence: "current-session",
              sourceBranch: "release",
              startFromOrigin: false,
              deliveryTarget: {
                ...editedBaseDeliveryTarget,
              },
            });
            const thread = {
              id: threadId,
              projectId,
              bindingRevisionId,
              repositoryId,
              checkoutId,
              title: "Polish the mobile Code flow",
              lifecycle: "active",
              providerInstanceId,
              modelId: "gpt-5.6",
              executionPolicy: "approval-gated",
              permissionPersistence: "current-session",
              deliveryTarget: payload.deliveryTarget,
              version: 1,
              createdAt: now,
              updatedAt: now,
            };
            return Response.json({
              kind: "managed-thread-created",
              thread,
              checkout,
              provenance: {
                receiptId: "90000000-0000-4000-8000-000000000001",
                mode: "local",
                branch: "development",
                resolvedHead: "a".repeat(40),
              },
            });
          }
          if (payload.kind === "start-provider-turn") {
            return Response.json({
              kind: "provider-turn-state",
              operationId: payload.operationId,
              state: "running",
            });
          }
        }
        if (request.method === "PUT" && request.path === "/api/code/evidence") {
          expect(request.headers).toMatchObject({
            "content-type": "text/plain; charset=utf-8",
            "x-octant-code-thread-id": threadId,
          });
          expect(request.body).toBe("Polish the mobile Code flow");
          return Response.json({
            contentId: "80000000-0000-4000-8000-000000000001",
            digest: "b".repeat(64),
            byteLength: 27,
          });
        }
        return new Response("missing", { status: 404 });
      },
    );
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    await expect(fetchMobileCodeProjects(transport)).resolves.toEqual([
      { projectId, name: "Octant", root: "/repos/octant" },
    ]);
    await expect(
      createMobileCodeFromPrompt({
        transport,
        prompt: "Polish the mobile Code flow",
        project: {
          projectId,
          name: "Octant",
          root: "/repos/octant",
          newThreadWorkspace: "managed-worktree" as const,
        },
        providerInstanceId,
        modelId: "gpt-5.6",
        threadId,
        confirmDeliveryTarget: vi.fn(async (proposal) => {
          expect(proposal).toMatchObject({
            branchIntent: expect.any(String),
            remoteName: "origin",
            proposedBaseRepository: "",
            proposedBaseBranch: "development",
            suggestedOutcomeKind: "local-implementation",
            workspace: "managed-worktree",
            boundRoot: "/repos/octant",
          });
          return editedBaseDeliveryTarget;
        }),
        uuid: vi
          .fn()
          .mockReturnValueOnce("81000000-0000-4000-8000-000000000001")
          .mockReturnValueOnce("82000000-0000-4000-8000-000000000001"),
      }),
    ).resolves.toMatchObject({
      hostId,
      mode: "code",
      threadId,
      title: "Polish the mobile Code flow",
    });

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/projects/bootstrap",
      "GET /api/code/bootstrap",
      "POST /api/code/commands",
      "POST /api/code/commands",
      "POST /api/code/commands",
      "PUT /api/code/evidence",
      "POST /api/code/commands",
    ]);
  });

  it("reuses the created thread after evidence staging or first-turn startup fails", async () => {
    const calls: string[] = [];
    const startRequestIdentities: Array<{
      readonly kind?: string;
      readonly operationId?: unknown;
      readonly sessionId?: unknown;
    }> = [];
    let createCount = 0;
    let evidenceAttempts = 0;
    let startAttempts = 0;
    const createdThread = {
      id: threadId,
      projectId,
      bindingRevisionId,
      repositoryId,
      checkoutId,
      title: "Open a pull request for the mobile Code flow",
      lifecycle: "active",
      providerInstanceId,
      modelId: "gpt-5.6",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: confirmedDeliveryTarget,
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as const;
    const fetch = vi.fn(async (request: { method: string; path: string; body?: string }) => {
      calls.push(`${request.method} ${request.path}`);
      if (request.method === "GET" && request.path === "/api/code/bootstrap") {
        return Response.json({
          settings: {
            defaultExecutionPolicy: "full-access",
            defaultPermissionPersistence: "project-default",
            version: 1,
            updatedAt: now,
          },
          threads: createCount === 0 ? [] : [createdThread],
          checkouts: [checkout],
          activity: [],
        });
      }
      if (request.method === "GET" && request.path === `/api/code/threads/${threadId}`) {
        return Response.json({ thread: createdThread, checkout, lastSequence: 0 });
      }
      if (request.method === "POST" && request.path === "/api/code/commands") {
        const payload = JSON.parse(request.body ?? "{}") as {
          kind?: string;
          operationId?: string;
          sessionId?: string;
        };
        if (payload.kind === "prepare-code-project-checkout") {
          return Response.json({ kind: "checkout-prepared", bindingRevisionId, checkout });
        }
        if (payload.kind === "get-worktree-remote-facts") {
          return Response.json({
            kind: "worktree-remote-facts-retrieved",
            projectId,
            facts: { remotes: ["origin"], defaultRemote: "origin" },
          });
        }
        if (payload.kind === "create-managed-code-thread") {
          createCount += 1;
          return Response.json({
            kind: "managed-thread-created",
            thread: createdThread,
            checkout,
            provenance: {
              receiptId: "90000000-0000-4000-8000-000000000001",
              mode: "local",
              branch: "development",
              resolvedHead: "a".repeat(40),
            },
          });
        }
        if (payload.kind === "start-provider-turn") {
          startRequestIdentities.push({
            kind: payload.kind,
            operationId: payload.operationId,
            sessionId: payload.sessionId,
          });
          startAttempts += 1;
          if (startAttempts === 1) return new Response("offline", { status: 503 });
          return Response.json({
            kind: "provider-turn-state",
            operationId: payload.operationId,
            state: "running",
          });
        }
      }
      if (request.method === "PUT" && request.path === "/api/code/evidence") {
        evidenceAttempts += 1;
        if (evidenceAttempts === 1) return new Response("offline", { status: 503 });
        return Response.json({
          contentId: "80000000-0000-4000-8000-000000000001",
          digest: "b".repeat(64),
          byteLength: 45,
        });
      }
      return new Response("missing", { status: 404 });
    });
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    const uuid = vi
      .fn()
      .mockReturnValueOnce("81000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("82000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("83000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("84000000-0000-4000-8000-000000000001");
    const baseInput = {
      transport,
      prompt: "Open a pull request for the mobile Code flow",
      project: {
        projectId,
        name: "Octant",
        root: "/repos/octant",
        newThreadWorkspace: "managed-worktree" as const,
      },
      providerInstanceId,
      modelId: "gpt-5.6",
      threadId,
      confirmDeliveryTarget: vi.fn(async () => confirmedDeliveryTarget),
      uuid,
    };

    const firstFailure = await createMobileCodeFromPrompt(baseInput).then(
      () => undefined,
      (cause) => cause,
    );
    expect(firstFailure).toBeInstanceOf(MobileCodeCreationFailure);
    const firstRetry = (firstFailure as MobileCodeCreationFailure).retry;
    expect(firstRetry).toMatchObject({
      threadId,
      operationId: "81000000-0000-4000-8000-000000000001",
      sessionId: "82000000-0000-4000-8000-000000000001",
    });
    await expect(
      createMobileCodeFromPrompt({
        ...baseInput,
        retry: firstRetry,
      }),
    ).rejects.toMatchObject({ retry: { threadId } });
    const secondFailure = await createMobileCodeFromPrompt({
      ...baseInput,
      retry: firstRetry,
    }).then(
      () => undefined,
      (cause) => cause,
    );
    expect(secondFailure).toBeUndefined();

    expect(createCount).toBe(1);
    expect(baseInput.confirmDeliveryTarget).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call === "POST /api/code/commands")).toHaveLength(5);
    expect(startRequestIdentities).toEqual([
      {
        kind: "start-provider-turn",
        operationId: "81000000-0000-4000-8000-000000000001",
        sessionId: "82000000-0000-4000-8000-000000000001",
      },
      {
        kind: "start-provider-turn",
        operationId: "81000000-0000-4000-8000-000000000001",
        sessionId: "82000000-0000-4000-8000-000000000001",
      },
    ]);
    expect(uuid).toHaveBeenCalledTimes(2);
  });

  it("reconciles a recorded provider result instead of retrying the start command", async () => {
    const operationId = "81000000-0000-4000-8000-000000000001";
    const createdThread = {
      id: threadId,
      projectId,
      bindingRevisionId,
      repositoryId,
      checkoutId,
      title: "Start a Code task",
      lifecycle: "active",
      providerInstanceId,
      modelId: "gpt-5.6",
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: confirmedDeliveryTarget,
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as const;
    let startCalls = 0;
    const fetch = vi.fn(async (request: { method: string; path: string; body?: string }) => {
      if (request.method === "GET" && request.path === "/api/code/bootstrap") {
        return Response.json({
          settings: {
            defaultExecutionPolicy: "full-access",
            defaultPermissionPersistence: "project-default",
            version: 1,
            updatedAt: now,
          },
          threads: [createdThread],
          checkouts: [checkout],
          activity: [],
        });
      }
      if (request.method === "GET" && request.path === `/api/code/threads/${threadId}`) {
        return Response.json({ thread: createdThread, checkout, lastSequence: 0 });
      }
      if (
        request.method === "GET" &&
        request.path ===
          `/api/code/threads/${threadId}/operations/${operationId}/events?afterCursor=0`
      ) {
        return new Response(
          `${JSON.stringify({
            threadId,
            operationId,
            cursor: 1,
            occurredAt: now,
            event: {
              kind: "operation-result",
              result: { kind: "provider-turn-state", operationId, state: "running" },
            },
          })}\n`,
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }
      if (request.method === "PUT" && request.path === "/api/code/evidence") {
        return Response.json({
          contentId: "80000000-0000-4000-8000-000000000001",
          digest: "b".repeat(64),
          byteLength: 16,
        });
      }
      if (request.method === "POST" && request.path === "/api/code/commands") {
        const payload = JSON.parse(request.body ?? "{}") as { kind?: string };
        if (payload.kind === "prepare-code-project-checkout") {
          return Response.json({ kind: "checkout-prepared", bindingRevisionId, checkout });
        }
        if (payload.kind === "get-worktree-remote-facts") {
          return Response.json({
            kind: "worktree-remote-facts-retrieved",
            projectId,
            facts: { remotes: ["origin"], defaultRemote: "origin" },
          });
        }
        if (payload.kind === "create-managed-code-thread") {
          return Response.json({
            kind: "managed-thread-created",
            thread: createdThread,
            checkout,
            provenance: {
              receiptId: "90000000-0000-4000-8000-000000000001",
              mode: "local",
              branch: "development",
              resolvedHead: "a".repeat(40),
            },
          });
        }
        if (payload.kind === "start-provider-turn") {
          startCalls += 1;
          return new Response("response lost", { status: 503 });
        }
        return new Response("unexpected command", { status: 500 });
      }
      return new Response("missing", { status: 404 });
    });
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };
    const baseInput = {
      transport,
      prompt: "Start a Code task",
      project: {
        projectId,
        name: "Octant",
        root: "/repos/octant",
        newThreadWorkspace: "managed-worktree" as const,
      },
      providerInstanceId,
      modelId: "gpt-5.6",
      threadId,
      confirmDeliveryTarget: vi.fn(async () => confirmedDeliveryTarget),
      uuid: vi.fn().mockReturnValue(operationId),
    };

    const firstFailure = await createMobileCodeFromPrompt(baseInput).then(
      () => undefined,
      (cause) => cause,
    );
    expect(firstFailure).toBeInstanceOf(MobileCodeCreationFailure);
    const retry = (firstFailure as MobileCodeCreationFailure).retry;

    await expect(createMobileCodeFromPrompt({ ...baseInput, retry })).resolves.toMatchObject({
      threadId,
      mode: "code",
    });
    expect(startCalls).toBe(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: `/api/code/threads/${threadId}/operations/${operationId}/events?afterCursor=0`,
      }),
    );
  });

  it("rejects an oversized Code prompt before creating a thread", async () => {
    const fetch = vi.fn();
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
    };

    await expect(
      createMobileCodeFromPrompt({
        transport,
        prompt: "x".repeat(MAX_CODE_OPERATION_TEXT_BYTES + 1),
        project: { projectId, name: "Octant", root: "/repos/octant" },
        providerInstanceId,
        modelId: "gpt-5.6",
        threadId,
        confirmDeliveryTarget: vi.fn(async () => confirmedDeliveryTarget),
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      message: expect.stringContaining("64 KiB"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
