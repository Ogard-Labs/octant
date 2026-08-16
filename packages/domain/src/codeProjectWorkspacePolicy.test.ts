import type { CodeProject } from "@octant/contracts/projects";
import { describe, expect, it } from "vitest";
import {
  changeCodeProjectNewThreadWorkspace,
  resolveCodeNewThreadWorkspace,
} from "./codeProjectWorkspacePolicy";
import { ProjectPolicyRejected } from "./projectPolicy";

const createdAt = "2026-08-14T08:00:00.000Z" as CodeProject["createdAt"];

function codeProject(overrides: Partial<CodeProject> = {}): CodeProject {
  return {
    id: "11111111-1111-4111-8111-111111111111" as CodeProject["id"],
    name: "Octant",
    type: "code",
    lifecycle: "active",
    pinned: false,
    rank: "1/1" as CodeProject["rank"],
    version: 3 as CodeProject["version"],
    createdAt,
    updatedAt: createdAt,
    binding: { canonicalRoot: "/Users/example/code/octant" },
    bindingHistory: [
      {
        revisionId:
          "22222222-2222-4222-8222-222222222222" as CodeProject["bindingHistory"][0]["revisionId"],
        revision: 1,
        currentBinding: { canonicalRoot: "/Users/example/code/octant" },
        actor: {
          kind: "local-user",
          actorId:
            "33333333-3333-4333-8333-333333333333" as CodeProject["bindingHistory"][0]["actor"]["actorId"],
        },
        changedAt: createdAt,
      },
    ],
    codeAccessPersistence: "current-session",
    ...overrides,
  };
}

describe("code project new-thread workspace habit", () => {
  it("falls back to the current checkout when no habit was ever chosen", () => {
    expect(resolveCodeNewThreadWorkspace(codeProject())).toBe("current-checkout");
    expect(resolveCodeNewThreadWorkspace(undefined)).toBe("current-checkout");
  });

  it("resolves a stored managed-worktree habit", () => {
    expect(resolveCodeNewThreadWorkspace(codeProject({ newThreadWorkspace: "managed-worktree" })));
    expect(
      resolveCodeNewThreadWorkspace(codeProject({ newThreadWorkspace: "managed-worktree" })),
    ).toBe("managed-worktree");
  });

  it("records a change and bumps the aggregate version", () => {
    const changed = changeCodeProjectNewThreadWorkspace(
      codeProject(),
      "managed-worktree",
      "2026-08-14T09:00:00.000Z" as CodeProject["updatedAt"],
    );
    expect(changed.newThreadWorkspace).toBe("managed-worktree");
    expect(changed.version).toBe(4);
    expect(changed.updatedAt).toBe("2026-08-14T09:00:00.000Z");
  });

  it("rejects a no-op change so the journal never records nothing", () => {
    expect(() =>
      changeCodeProjectNewThreadWorkspace(codeProject(), "current-checkout", createdAt),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      changeCodeProjectNewThreadWorkspace(
        codeProject({ newThreadWorkspace: "managed-worktree" }),
        "managed-worktree",
        createdAt,
      ),
    ).toThrow(ProjectPolicyRejected);
  });

  it("rejects a non-Code Project", () => {
    const chat = {
      ...codeProject(),
      type: "chat",
    } as unknown as Parameters<typeof changeCodeProjectNewThreadWorkspace>[0];
    expect(() => changeCodeProjectNewThreadWorkspace(chat, "managed-worktree", createdAt)).toThrow(
      ProjectPolicyRejected,
    );
  });
});
