import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { resolveDraftExtensionReference } from "@octant/plugin-host";
import { buildCatalogs } from "./extensionChatResolver";
import { decodeWorkThread } from "@octant/contracts";
import { decodeExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { ExtensionSelection, ExtensionProviderFamily } from "@octant/contracts/extensions";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createSelectedSkillContextResolver } from "./selectedSkillContext";
import {
  ExtensionActivationService,
  createLocalExtensionActivationPolicy,
} from "./extensionActivationService";
import { createStoredExtensionMaterialLoader } from "./extensionChatResolver";

const digest = `sha256:${"a".repeat(64)}`;
const now = "2026-09-15T00:00:00.000Z";
const thread = decodeWorkThread({
  id: "94000000-0000-4000-8000-000000000004",
  projectId: "94000000-0000-4000-8000-000000000005",
  providerInstanceId: "94000000-0000-4000-8000-000000000003",
  modelId: "model-a",
  title: "Synthetic skill validation",
  lifecycle: "active",
  version: 1,
  createdAt: now,
  updatedAt: now,
});
function fixture(mode: "work" | "code") {
  const qualifiedId = `agents-skills-directory:project:review:${digest}`;
  let snapshot = decodeExtensionSnapshot({
    sequence: 1,
    snapshotAt: now,
    packages: [],
    collisions: [],
    skills: [
      {
        skill: {
          qualifiedId,
          name: "review",
          sourceKind: "agents-skills-directory",
          digest,
          available: true,
        },
        source: { kind: "agents-skills-directory", sourceRef: "project" },
        scope: { mode, projectId: thread.projectId, threadRef: thread.id },
        displayName: "Review",
        contentBytes: 29,
        instructions: "Use the synthetic checklist.",
        provenance: { reviewed: true },
        reviewed: true,
        desiredEnabled: true,
        effectiveState: { kind: "effective" },
      },
    ],
  });
  const activation = new ExtensionActivationService({
    policy: createLocalExtensionActivationPolicy({
      project: () => ({ allowed: true, revision: 1 }),
      thread: () => ({ allowed: true, revision: 1 }),
    }),
    compatibility: () => true,
    catalogStatus: () => "available",
  });
  const scope = {
    hostId: LOCAL_HOST_ID,
    mode,
    projectId: thread.projectId,
    threadId: thread.id,
    providerFamily: Schema.decodeUnknownSync(ExtensionProviderFamily)("openai-compatible"),
  } as const;
  const selection = Schema.decodeUnknownSync(ExtensionSelection)({
    kind: "skill",
    skillId: qualifiedId,
    packageDigest: digest,
    catalogEpoch: activation.resolve(snapshot, { scope }).catalogEpoch,
    origin: { kind: "draft", reference: "review" },
  });
  const resolver = createSelectedSkillContextResolver({
    snapshot: async () => snapshot,
    resolveEffectiveState: (state, query) => activation.resolve(state, query),
    providerFamily: () => Schema.decodeUnknownSync(ExtensionProviderFamily)("openai-compatible"),
    materialLoader: createStoredExtensionMaterialLoader({
      readVerifiedComponentText: async () => {
        throw new Error("No installed package");
      },
    }),
  });
  return {
    resolver,
    selection,
    draftEpoch: activation.resolve(snapshot, { scope: { ...scope, threadId: null } }).catalogEpoch,
    catalog: () =>
      buildCatalogs(snapshot, activation.resolve(snapshot, { scope }), {
        mode,
        threadId: String(thread.id),
        projectId: String(thread.projectId),
        threadVersion: 1,
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
      }).addressing,
    snapshot: () => snapshot,
    update: (next: typeof snapshot) => {
      snapshot = next;
    },
  };
}

describe("selected skill context", () => {
  it.each(["work", "code"] as const)(
    "loads reviewed standalone instructions for %s",
    async (mode) => {
      const test = fixture(mode);
      await expect(test.resolver({ mode, thread, selections: [test.selection] })).resolves.toEqual({
        kind: "resolved",
        context: [{ kind: "instructions", text: "Use the synthetic checklist." }],
      });
    },
  );
  it("revalidates a new-task draft selection against its created thread", async () => {
    const test = fixture("code");
    test.update(
      decodeExtensionSnapshot({
        ...test.snapshot(),
        skills: test.snapshot().skills?.map((skill) => ({ ...skill, scope: undefined })),
      }),
    );
    await expect(
      test.resolver({
        mode: "code",
        thread,
        selections: [{ ...test.selection, catalogEpoch: test.draftEpoch }],
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      context: [{ kind: "instructions", text: "Use the synthetic checklist." }],
    });
  });

  it("refuses an unrelated stale catalog epoch", async () => {
    const test = fixture("work");
    await expect(
      test.resolver({
        mode: "work",
        thread,
        selections: [
          Schema.decodeUnknownSync(ExtensionSelection)({
            ...test.selection,
            catalogEpoch: `sha256:${"d".repeat(64)}`,
          }),
        ],
      }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  it.each(["disabled", "changed", "out-of-scope", "missing-material"] as const)(
    "refuses a %s skill at execution",
    async (reason) => {
      const test = fixture("work");
      test.update(
        decodeExtensionSnapshot({
          ...test.snapshot(),
          skills: test.snapshot().skills?.map((skill) => ({
            ...skill,
            ...(reason === "disabled"
              ? {
                  desiredEnabled: false,
                  effectiveState: { kind: "blocked", reason: "component-disabled" },
                }
              : {}),
            ...(reason === "changed"
              ? {
                  skill: {
                    ...skill.skill,
                    digest: `sha256:${"c".repeat(64)}`,
                    qualifiedId: `agents-skills-directory:project:review:sha256:${"c".repeat(64)}`,
                  },
                  instructions: "Changed, unreviewed instructions",
                  reviewed: false,
                  desiredEnabled: false,
                  effectiveState: { kind: "blocked", reason: "review-required" },
                }
              : {}),
            ...(reason === "out-of-scope"
              ? { scope: { mode: "code", projectId: thread.projectId, threadRef: thread.id } }
              : {}),
            ...(reason === "missing-material" ? { instructions: undefined } : {}),
          })),
        }),
      );
      await expect(
        test.resolver({ mode: "work", thread, selections: [test.selection] }),
      ).resolves.toMatchObject({ kind: "unavailable" });
    },
  );

  it("requires an exact source for colliding names and sends only that source", async () => {
    const test = fixture("code");
    test.update(
      decodeExtensionSnapshot({
        ...test.snapshot(),
        skills: [
          ...(test.snapshot().skills ?? []),
          ...(test.snapshot().skills ?? []).map((skill) => ({
            ...skill,
            skill: {
              ...skill.skill,
              qualifiedId: `agents-skills-directory:user-global:review:${digest}`,
            },
            source: { kind: "agents-skills-directory", sourceRef: "user-global" },
            instructions: "Other source instructions.",
          })),
        ],
      }),
    );
    expect(resolveDraftExtensionReference("$review", test.catalog(), "draft").kind).toBe(
      "ambiguous",
    );
    await expect(
      test.resolver({ mode: "code", thread, selections: [test.selection] }),
    ).resolves.toEqual({
      kind: "resolved",
      context: [{ kind: "instructions", text: "Use the synthetic checklist." }],
    });
  });
});
