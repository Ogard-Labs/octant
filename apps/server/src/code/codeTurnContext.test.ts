import { describe, expect, it } from "vitest";
import { decodeCodeThread } from "@octant/contracts";
import { composeCodeProfileContext } from "./codeTurnContext";

const now = "2026-07-21T10:00:00.000Z";
const thread = decodeCodeThread({
  id: "22222222-2222-4222-8222-222222222222",
  projectId: "66666666-6666-4666-8666-666666666666",
  bindingRevisionId: "77777777-7777-4777-8777-777777777777",
  repositoryId: `repo_${"8".repeat(64)}`,
  checkoutId: "33333333-3333-4333-8333-333333333333",
  title: "Exact checkout",
  lifecycle: "active",
  providerInstanceId: "99999999-9999-4999-8999-999999999999",
  modelId: "model-id",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/exact",
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

describe("composeCodeProfileContext", () => {
  it("includes snapshotted profile instructions with attribution", () => {
    let n = 0;
    const composed = composeCodeProfileContext({
      thread: decodeCodeThread({
        ...thread,
        profileId: "60000000-0000-4000-8000-000000000001",
        profileContext: {
          displayName: "Reviewer",
          instructions: "Review as a skeptic.",
          approvedSkillIds: [],
        },
      }),
      uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`,
    });

    expect(composed.entries).toEqual([
      expect.objectContaining({
        category: "user-instructions",
        label: "Reviewer profile instructions",
        source: {
          kind: "instruction",
          referenceId: "profile:60000000-0000-4000-8000-000000000001",
        },
      }),
    ]);
    expect(composed.blocks).toEqual([{ kind: "instructions", text: "Review as a skeptic." }]);
  });

  it("leaves a thread without a profile unchanged", () => {
    const composed = composeCodeProfileContext({
      thread,
      skills: [
        {
          qualifiedId: "agents-skills-directory:project:code-reviewer:sha256:aa",
          displayName: "Code reviewer",
          text: "should never load",
        },
      ],
      uuid: () => "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    });
    expect(composed).toEqual({ entries: [], blocks: [] });
  });

  it("attributes admitted skills as extension instructions", () => {
    let n = 0;
    const composed = composeCodeProfileContext({
      thread: decodeCodeThread({
        ...thread,
        profileId: "60000000-0000-4000-8000-000000000001",
        profileContext: {
          displayName: "Reviewer",
          approvedSkillIds: ["code-reviewer"],
        },
      }),
      skills: [
        {
          qualifiedId: "agents-skills-directory:project:code-reviewer:sha256:aa",
          displayName: "Code reviewer",
          text: "Review diffs in isolation.",
        },
      ],
      uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`,
    });

    expect(composed.entries).toEqual([
      expect.objectContaining({
        category: "extension-instructions",
        label: "Code reviewer",
        source: {
          kind: "skill",
          referenceId: "agents-skills-directory:project:code-reviewer:sha256:aa",
        },
      }),
    ]);
    expect(composed.blocks).toEqual([{ kind: "instructions", text: "Review diffs in isolation." }]);
  });
});
