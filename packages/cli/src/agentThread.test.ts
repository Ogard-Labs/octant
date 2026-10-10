import { describe, expect, it } from "vitest";
import { createAgentThread } from "./agentThread";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";

const now = "2026-10-09T09:00:00.000Z";
const ids = {
  project: "20000000-0000-4000-8000-000000000001",
  binding: "30000000-0000-4000-8000-000000000001",
  checkout: "40000000-0000-4000-8000-000000000001",
  provider: "50000000-0000-4000-8000-000000000001",
} as const;

function projects(codeAccessPersistence: "current-session" | "project-default"): unknown {
  return {
    active: [
      {
        id: ids.project,
        name: "Repo",
        type: "code",
        lifecycle: "active",
        pinned: false,
        rank: "1/2",
        version: 1,
        createdAt: now,
        updatedAt: now,
        binding: { canonicalRoot: "/home/user/repo" },
        bindingRevisionId: ids.binding,
        codeAccessPersistence,
      },
    ],
    archived: [],
    availability: [],
    memory: [],
  };
}

const providers = {
  instances: [
    {
      id: ids.provider,
      displayName: "Loopback",
      driverKind: "openai-compatible",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "http://127.0.0.1:9/v1/",
        authentication: "none",
        protocol: "responses",
        manualModelIds: [],
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ],
  defaults: { permissionPersistence: "current-session", version: 0 },
  observedStates: [
    {
      instanceId: ids.provider,
      readiness: "ready",
      processState: "running",
      models: [
        {
          id: "loopback-model",
          displayName: "Loopback model",
          reasoning: "unavailable",
          inputModalities: ["text"],
          options: [],
          source: "discovered",
          verification: "verified",
        },
      ],
      capabilities: {
        streaming: "supported",
        resume: "unavailable",
        interruption: "supported",
        approvals: "supported",
        userQuestions: "supported",
        reasoning: "unavailable",
        usage: "supported",
        toolActivity: "supported",
        fileChanges: "unavailable",
        diffs: "unavailable",
        taskProgress: "supported",
        nativeChildAgents: "unavailable",
        harnessAutoReview: "unsupported",
        nativeAttachments: "unavailable",
        nativeWebResearch: "unavailable",
        appManagedTools: "supported",
        citations: "unavailable",
      },
      observedAt: now,
    },
  ],
};

/**
 * A loopback host that answers the routes `octant agent` walks to start a
 * Code thread, and records what the terminal asked for.
 */
function host(codeAccessPersistence: "current-session" | "project-default") {
  const seen: LocalControlRequest[] = [];
  const session: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "11111111-1111-4111-8111-111111111111",
    send: async (request) => {
      seen.push(request);
      if (request.path === "/api/projects/bootstrap") {
        return { status: 200, body: projects(codeAccessPersistence) };
      }
      if (request.path === "/api/providers/bootstrap") return { status: 200, body: providers };
      if (request.path === "/api/shell/bootstrap") {
        return { status: 200, body: { workspaceVersion: 1 } };
      }
      if (request.path === "/api/shell/commands") return { status: 200, body: {} };
      const body = request.body as { kind: string; thread?: unknown };
      if (body.kind === "prepare-code-project-checkout") {
        return {
          status: 200,
          body: {
            kind: "checkout-prepared",
            bindingRevisionId: ids.binding,
            checkout: {
              id: ids.checkout,
              repositoryId: `repo_${"a".repeat(64)}`,
              kind: "existing-worktree",
              availability: "available",
              head: { kind: "branch", name: "main", oid: "b".repeat(40) },
              observedAt: now,
            },
          },
        };
      }
      if (body.kind === "create-code-thread") {
        return { status: 200, body: { kind: "thread-created", thread: body.thread } };
      }
      return { status: 404, body: { message: `Unexpected ${request.path}` } };
    },
    close: async () => undefined,
  };
  const created = () =>
    seen.find(
      (request) => (request.body as { kind?: string } | undefined)?.kind === "create-code-thread",
    )?.body as { thread: { executionPolicy: string; permissionPersistence: string } } | undefined;
  return { session, created };
}

describe("starting a Code thread from the terminal", () => {
  it("asks for the Project's remembered Full access, the request the app's composer sends", async () => {
    const fake = host("project-default");

    const result = await createAgentThread(fake.session, {
      mode: "code",
      title: "Run the terminal",
      projectName: "Repo",
    });

    expect(result).toMatchObject({ kind: "created", mode: "code", projectName: "Repo" });
    expect(fake.created()?.thread).toMatchObject({
      executionPolicy: "full-access",
      permissionPersistence: "project-default",
    });
  });

  it("starts approval-gated in a Project that never remembered Full access", async () => {
    const fake = host("current-session");

    const result = await createAgentThread(fake.session, {
      mode: "code",
      title: "Run the terminal",
      projectName: "Repo",
    });

    expect(result).toMatchObject({ kind: "created", mode: "code" });
    expect(fake.created()?.thread).toMatchObject({
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    });
  });
});
