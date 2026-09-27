import { describe, expect, it } from "vitest";
import { resolveProjectCliCommand, runProjectCliCommand } from "./projectCommand";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";

const receiptId = `${"a".repeat(42)}A`;

function session(responses: (request: LocalControlRequest) => LocalControlResponse): {
  readonly session: Parameters<typeof runProjectCliCommand>[0]["session"];
  readonly sent: LocalControlRequest[];
  readonly out: string[];
  readonly err: string[];
} {
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    session: {
      kind: "opened",
      windowId: "11111111-1111-4111-8111-111111111111",
      send: async (request) => {
        sent.push(request);
        return responses(request);
      },
      close: async () => undefined,
    },
    sent,
    out,
    err,
  };
}

const bootstrap = (
  projects: ReadonlyArray<{ id: string; name: string; version: number }>,
): unknown => ({
  active: projects.map((project) => ({
    id: project.id,
    name: project.name,
    type: "chat",
    lifecycle: "active",
    pinned: false,
    rank: "1/2",
    version: project.version,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
  archived: [],
  availability: [],
  memory: [],
});

const codeProject = (
  project: { id: string; name: string; version: number },
  codeAccessPersistence: "current-session" | "project-default" = "current-session",
): unknown => ({
  active: [
    {
      id: project.id,
      name: project.name,
      type: "code",
      lifecycle: "active",
      pinned: false,
      rank: "1/2",
      version: project.version,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      binding: { canonicalRoot: "/home/user/repo" },
      bindingRevisionId: "66666666-6666-4666-8666-666666666666",
      codeAccessPersistence,
    },
  ],
  archived: [],
  availability: [],
  memory: [],
});

describe("resolveProjectCliCommand", () => {
  it("adds a Code Project from a folder by default", () => {
    expect(resolveProjectCliCommand(["add", "./repo"], {})).toEqual({
      action: "add",
      path: "./repo",
      projectType: "code",
    });
  });

  it("adds a Work Project when the caller asks for one", () => {
    expect(resolveProjectCliCommand(["add", "./notes"], { type: "work", name: "Notes" })).toEqual({
      action: "add",
      path: "./notes",
      projectType: "work",
      name: "Notes",
    });
  });

  it("refuses a Project type Octant does not bind to a folder", () => {
    expect(resolveProjectCliCommand(["add", "./repo"], { type: "chat" })).toBeUndefined();
  });

  it("refuses a rename without the new name", () => {
    expect(resolveProjectCliCommand(["rename", "Old"], {})).toBeUndefined();
  });

  it("resolves a Full-access grant for a named Project", () => {
    expect(resolveProjectCliCommand(["access", "Repo", "full-access"], {})).toEqual({
      action: "access",
      name: "Repo",
      access: "full-access",
    });
    expect(resolveProjectCliCommand(["access", "Repo", "approval-gated"], {})).toEqual({
      action: "access",
      name: "Repo",
      access: "approval-gated",
    });
  });

  it("refuses an access posture Octant does not define", () => {
    expect(resolveProjectCliCommand(["access", "Repo", "plan"], {})).toBeUndefined();
    expect(resolveProjectCliCommand(["access", "Repo"], {})).toBeUndefined();
    expect(
      resolveProjectCliCommand(["access", "Repo", "full-access", "extra"], {}),
    ).toBeUndefined();
    expect(
      resolveProjectCliCommand(["access", "Repo", "full-access"], { force: true }),
    ).toBeUndefined();
  });
});

describe("runProjectCliCommand", () => {
  it("binds the folder and creates the Code Project the web UI will list", async () => {
    const fixture = session((request) =>
      request.path === "/api/desktop/project-binding-receipts"
        ? { status: 201, body: { receiptId, projectType: "code", expiresAt: 1 } }
        : { status: 200, body: { kind: "code-project-created" } },
    );
    const code = await runProjectCliCommand({
      command: { action: "add", path: "repo", projectType: "code" },
      session: fixture.session,
      cwd: "/home/user/work",
      stdout: { write: (chunk) => fixture.out.push(chunk) },
      stderr: { write: (chunk) => fixture.err.push(chunk) },
    });
    expect(code).toBe(0);
    expect(fixture.sent[0]?.body).toMatchObject({
      projectType: "code",
      path: "/home/user/work/repo",
    });
    expect(fixture.sent[1]?.body).toMatchObject({
      kind: "create-code-project",
      name: "repo",
      receiptId,
    });
    expect(fixture.out.join("")).toContain("Code Project repo");
  });

  it("reports the reason Octant refused a Project root", async () => {
    const fixture = session(() => ({
      status: 400,
      body: { category: "invalid", message: "The selected Project root is unavailable." },
    }));
    const code = await runProjectCliCommand({
      command: { action: "add", path: "missing", projectType: "work" },
      session: fixture.session,
      cwd: "/home/user",
      stdout: { write: (chunk) => fixture.out.push(chunk) },
      stderr: { write: (chunk) => fixture.err.push(chunk) },
    });
    expect(code).toBe(1);
    expect(fixture.err.join("")).toContain("Project root is unavailable");
  });

  it("archives the named Project instead of erasing its threads", async () => {
    const fixture = session((request) =>
      request.path === "/api/projects/bootstrap"
        ? {
            status: 200,
            body: bootstrap([
              { id: "22222222-2222-4222-8222-222222222222", name: "Notes", version: 3 },
            ]),
          }
        : { status: 200, body: { kind: "project-lifecycle-changed" } },
    );
    const code = await runProjectCliCommand({
      command: { action: "remove", name: "Notes" },
      session: fixture.session,
      cwd: "/home/user",
      stdout: { write: (chunk) => fixture.out.push(chunk) },
      stderr: { write: (chunk) => fixture.err.push(chunk) },
    });
    expect(code).toBe(0);
    expect(fixture.sent[1]?.body).toEqual({
      kind: "change-project-lifecycle",
      projectId: "22222222-2222-4222-8222-222222222222",
      expectedVersion: 3,
      lifecycle: "archived",
    });
  });

  it("renames the named Project at the version Octant last projected", async () => {
    const fixture = session((request) =>
      request.path === "/api/projects/bootstrap"
        ? {
            status: 200,
            body: bootstrap([
              { id: "33333333-3333-4333-8333-333333333333", name: "Old", version: 7 },
            ]),
          }
        : { status: 200, body: { kind: "project-renamed" } },
    );
    const code = await runProjectCliCommand({
      command: { action: "rename", name: "Old", newName: "New" },
      session: fixture.session,
      cwd: "/home/user",
      stdout: { write: (chunk) => fixture.out.push(chunk) },
      stderr: { write: (chunk) => fixture.err.push(chunk) },
    });
    expect(code).toBe(0);
    expect(fixture.sent[1]?.body).toEqual({
      kind: "rename-project",
      projectId: "33333333-3333-4333-8333-333333333333",
      expectedVersion: 7,
      name: "New",
    });
  });

  it("remembers Full access for a Code Project at the version Octant last projected", async () => {
    const fixture = session((request) =>
      request.path === "/api/projects/bootstrap"
        ? {
            status: 200,
            body: codeProject({
              id: "77777777-7777-4777-8777-777777777777",
              name: "Repo",
              version: 4,
            }),
          }
        : { status: 200, body: { kind: "code-project-access-changed" } },
    );
    const code = await runProjectCliCommand({
      command: { action: "access", name: "Repo", access: "full-access" },
      session: fixture.session,
      cwd: "/home/user",
      stdout: { write: (chunk) => fixture.out.push(chunk) },
      stderr: { write: (chunk) => fixture.err.push(chunk) },
    });
    expect(code).toBe(0);
    expect(fixture.sent[1]?.body).toEqual({
      kind: "change-code-project-access",
      projectId: "77777777-7777-4777-8777-777777777777",
      expectedVersion: 4,
      codeAccessPersistence: "project-default",
    });
    expect(fixture.out.join("")).toContain("Project Repo remembers Full access");
  });

  it("returns a remembered Code Project to approval-gated", async () => {
    const fixture = session((request) =>
      request.path === "/api/projects/bootstrap"
        ? {
            status: 200,
            body: codeProject(
              {
                id: "77777777-7777-4777-8777-777777777777",
                name: "Repo",
                version: 5,
              },
              "project-default",
            ),
          }
        : { status: 200, body: { kind: "code-project-access-changed" } },
    );
    const code = await runProjectCliCommand({
      command: { action: "access", name: "Repo", access: "approval-gated" },
      session: fixture.session,
      cwd: "/home/user",
      stdout: { write: (chunk) => fixture.out.push(chunk) },
      stderr: { write: (chunk) => fixture.err.push(chunk) },
    });
    expect(code).toBe(0);
    expect(fixture.sent[1]?.body).toEqual({
      kind: "change-code-project-access",
      projectId: "77777777-7777-4777-8777-777777777777",
      expectedVersion: 5,
      codeAccessPersistence: "current-session",
    });
    expect(fixture.out.join("")).toContain("starts Code threads approval-gated");
  });

  it("changes nothing when the named Code Project is not a Code Project", async () => {
    const fixture = session(() => ({
      status: 200,
      body: bootstrap([{ id: "22222222-2222-4222-8222-222222222222", name: "Notes", version: 3 }]),
    }));
    const code = await runProjectCliCommand({
      command: { action: "access", name: "Notes", access: "full-access" },
      session: fixture.session,
      cwd: "/home/user",
      stdout: { write: (chunk) => fixture.out.push(chunk) },
      stderr: { write: (chunk) => fixture.err.push(chunk) },
    });
    expect(code).toBe(1);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.err.join("")).toContain("Only Code Projects can remember Full access");
  });

  it("sends nothing when the Code Project already remembers Full access", async () => {
    const fixture = session(() => ({
      status: 200,
      body: codeProject(
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "Repo",
          version: 5,
        },
        "project-default",
      ),
    }));
    const code = await runProjectCliCommand({
      command: { action: "access", name: "Repo", access: "full-access" },
      session: fixture.session,
      cwd: "/home/user",
      stdout: { write: (chunk) => fixture.out.push(chunk) },
      stderr: { write: (chunk) => fixture.err.push(chunk) },
    });
    expect(code).toBe(0);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.out.join("")).toContain("already remembers Full access");
  });

  it("prints the reason Octant refused an access change", async () => {
    const fixture = session((request) =>
      request.path === "/api/projects/bootstrap"
        ? {
            status: 200,
            body: codeProject({
              id: "77777777-7777-4777-8777-777777777777",
              name: "Repo",
              version: 4,
            }),
          }
        : {
            status: 400,
            body: { category: "stale", message: "Code state changed; reload and retry." },
          },
    );
    const code = await runProjectCliCommand({
      command: { action: "access", name: "Repo", access: "full-access" },
      session: fixture.session,
      cwd: "/home/user",
      stdout: { write: (chunk) => fixture.out.push(chunk) },
      stderr: { write: (chunk) => fixture.err.push(chunk) },
    });
    expect(code).toBe(1);
    expect(fixture.err.join("")).toContain("Code state changed");
  });

  it("refuses to change a Project when the name matches more than one", async () => {
    const fixture = session(() => ({
      status: 200,
      body: bootstrap([
        { id: "44444444-4444-4444-8444-444444444444", name: "Notes", version: 1 },
        { id: "55555555-5555-4555-8555-555555555555", name: "Notes", version: 1 },
      ]),
    }));
    const code = await runProjectCliCommand({
      command: { action: "remove", name: "Notes" },
      session: fixture.session,
      cwd: "/home/user",
      stdout: { write: (chunk) => fixture.out.push(chunk) },
      stderr: { write: (chunk) => fixture.err.push(chunk) },
    });
    expect(code).toBe(1);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.err.join("")).toContain("More than one active Project");
  });
});
