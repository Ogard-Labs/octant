import { describe, expect, it } from "vitest";
import * as codeContracts from "./code";
import {
  decodeCodeCheckoutIdentity,
  decodeCodeCommand,
  decodeCodeCommandResult,
  decodeCodeDeliveryOutcomeKind,
  decodeCodeDeliveryTarget,
  decodeCodeEventFrame,
  decodeCodeRelativePath,
  decodeCodeRepositoryId,
  decodeCodeSettings,
  decodeCodeThread,
  decodeCodeWorktreeSourcePreview,
} from "./code";

const ids = {
  thread: "10000000-0000-4000-8000-000000000001",
  project: "20000000-0000-4000-8000-000000000001",
  bindingRevision: "30000000-0000-4000-8000-000000000001",
  checkout: "40000000-0000-4000-8000-000000000001",
  receipt: "50000000-0000-4000-8000-000000000001",
  provider: "60000000-0000-4000-8000-000000000001",
  file: "70000000-0000-4000-8000-000000000001",
  content: "70000000-0000-4000-8000-000000000002",
  runtime: "70000000-0000-4000-8000-000000000003",
} as const;
const repositoryId = `repo_${"a".repeat(64)}`;
const now = "2026-07-20T21:00:00.000Z";

const deliveryTarget = {
  branchIntent: "feature/phase-7-authority-foundation",
  remoteName: "origin",
  proposedBaseRepository: "octocat/octant",
  proposedBaseBranch: "development",
  outcomeKind: "opened-pr",
  confirmedAt: now,
} as const;

const thread = {
  id: ids.thread,
  projectId: ids.project,
  bindingRevisionId: ids.bindingRevision,
  repositoryId,
  checkoutId: ids.checkout,
  title: "Code authority",
  lifecycle: "active",
  providerInstanceId: ids.provider,
  modelId: "model-a",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget,
  version: 1,
  createdAt: now,
  updatedAt: now,
} as const;

describe("Code identity and path contracts", () => {
  it("accepts only the repository identity format", () => {
    expect(decodeCodeRepositoryId(repositoryId)).toBe(repositoryId);
    expect(() => decodeCodeRepositoryId("repo_short")).toThrow();
    expect(() => decodeCodeRepositoryId(`repo_${"A".repeat(64)}`)).toThrow();
  });

  it("accepts canonical checkout-relative UTF-8 paths and rejects escape forms", () => {
    expect(decodeCodeRelativePath("src/code/file.ts")).toBe("src/code/file.ts");
    for (const value of [
      "",
      "/etc/passwd",
      "../secret",
      "src/../secret",
      "src//file.ts",
      "src\\file.ts",
      "src/./file.ts",
      "src/file.ts/",
      "src/\0file.ts",
      "e\u0301.txt",
      "a".repeat(4_097),
      "é".repeat(2_049),
    ]) {
      expect(() => decodeCodeRelativePath(value)).toThrow();
    }
  });
});

describe("Code aggregate contracts", () => {
  it("decodes a managed checkout without exposing a canonical path", () => {
    const checkout = {
      id: ids.checkout,
      repositoryId,
      kind: "managed-worktree",
      availability: "available",
      head: { kind: "branch", name: "feature/phase-7", oid: "b".repeat(40) },
      ownershipReceiptId: ids.receipt,
      observedAt: now,
    } as const;
    expect(decodeCodeCheckoutIdentity(checkout)).toEqual(checkout);
    expect(() =>
      decodeCodeCheckoutIdentity({ ...checkout, canonicalPath: "/private/repo" }),
    ).toThrow();
    expect(() =>
      decodeCodeCheckoutIdentity({
        ...checkout,
        kind: "existing-worktree",
        ownershipReceiptId: ids.receipt,
      }),
    ).toThrow();
  });

  it("decodes one strict Code thread with an immutable delivery target", () => {
    expect(decodeCodeThread(thread)).toEqual(thread);
    // A completed or snoozed thread carries its rest on the record; a journal
    // written before either existed still decodes because both are optional.
    expect(
      decodeCodeThread({
        ...thread,
        completedAt: now,
        snooze: { until: "2026-01-02T09:00:00.000Z", at: now, duringTurn: true },
      }),
    ).toMatchObject({
      completedAt: now,
      snooze: { until: "2026-01-02T09:00:00.000Z", at: now, duringTurn: true },
    });
    expect(() =>
      decodeCodeThread({ ...thread, snooze: { until: now, at: now, reason: "later" } }),
    ).toThrow();
    expect(decodeCodeThread({ ...thread, workingDirectory: "packages/app" })).toMatchObject({
      workingDirectory: "packages/app",
    });
    expect(
      decodeCodeThread({
        ...thread,
        profileId: "00000000-0000-4000-8000-000000000099",
        profileDisplayName: "Reviewer",
        toolConstraints: ["octant_browser"],
        profileContext: {
          displayName: "Reviewer",
          instructions: "Review as a skeptic.",
          approvedSkillIds: ["code-reviewer"],
        },
      }),
    ).toMatchObject({
      profileDisplayName: "Reviewer",
      toolConstraints: ["octant_browser"],
      profileContext: {
        displayName: "Reviewer",
        instructions: "Review as a skeptic.",
        approvedSkillIds: ["code-reviewer"],
      },
    });
    expect(() => decodeCodeThread({ ...thread, repositoryRoot: "/private/repo" })).toThrow();
    expect(() =>
      decodeCodeCommand({
        kind: "change-code-delivery-target",
        threadId: ids.thread,
        expectedVersion: 1,
        deliveryTarget,
      }),
    ).toThrow();
  });

  it("decodes shell-free Code settings and rejects raw checkout/file paths", () => {
    const settings = {
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      externalEditor: {
        executable: "/usr/local/bin/editor",
        arguments: ["--goto", "{file}:{line}:{column}"],
      },
      version: 1,
      updatedAt: now,
    } as const;
    expect(decodeCodeSettings(settings)).toEqual(settings);
    expect(() =>
      decodeCodeSettings({
        ...settings,
        externalEditor: { ...settings.externalEditor, checkoutPath: "/private/repo" },
      }),
    ).toThrow();
    expect(() =>
      decodeCodeSettings({
        ...settings,
        externalEditor: { executable: "/bin/sh", command: "editor $FILE" },
      }),
    ).toThrow();
  });

  it("decodes strict Code commands and bounded replay frames", () => {
    expect(
      decodeCodeCommand({
        kind: "create-code-thread",
        thread,
      }).kind,
    ).toBe("create-code-thread");
    expect(
      decodeCodeCommand({
        kind: "prepare-code-project-checkout",
        projectId: ids.project,
      }).kind,
    ).toBe("prepare-code-project-checkout");
    expect(
      decodeCodeCommand({
        kind: "change-code-thread-access",
        threadId: ids.thread,
        expectedVersion: 1,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      }).kind,
    ).toBe("change-code-thread-access");
    expect(
      decodeCodeCommand({
        kind: "rebind-code-thread-checkout",
        threadId: ids.thread,
        expectedVersion: 1,
      }).kind,
    ).toBe("rebind-code-thread-checkout");
    expect(
      decodeCodeCommand({
        kind: "change-code-thread-provider",
        threadId: ids.thread,
        expectedVersion: 1,
        providerInstanceId: ids.provider,
        modelId: "model-b",
      }),
    ).toEqual({
      kind: "change-code-thread-provider",
      threadId: ids.thread,
      expectedVersion: 1,
      providerInstanceId: ids.provider,
      modelId: "model-b",
    });
    expect(
      decodeCodeCommand({
        kind: "change-code-thread-working-directory",
        threadId: ids.thread,
        expectedVersion: 1,
        workingDirectory: "packages/app",
      }).kind,
    ).toBe("change-code-thread-working-directory");
    for (const kind of [
      "complete-code-thread",
      "reopen-code-thread",
      "wake-code-thread",
    ] as const) {
      expect(decodeCodeCommand({ kind, threadId: ids.thread, expectedVersion: 1 })).toEqual({
        kind,
        threadId: ids.thread,
        expectedVersion: 1,
      });
    }
    expect(
      decodeCodeCommand({
        kind: "snooze-code-thread",
        threadId: ids.thread,
        expectedVersion: 1,
        until: "2026-01-02T09:00:00.000Z",
      }),
    ).toEqual({
      kind: "snooze-code-thread",
      threadId: ids.thread,
      expectedVersion: 1,
      until: "2026-01-02T09:00:00.000Z",
    });
    expect(() =>
      decodeCodeCommand({ kind: "snooze-code-thread", threadId: ids.thread, expectedVersion: 1 }),
    ).toThrow();
    expect(
      decodeCodeCommand({
        kind: "update-code-settings",
        expectedVersion: 1,
        defaultExecutionPolicy: "approval-gated",
        defaultPermissionPersistence: "current-session",
        externalEditor: {
          executable: "/usr/local/bin/editor",
          arguments: ["--goto", "{file}:{line}:{column}"],
        },
      }).kind,
    ).toBe("update-code-settings");
    expect(() =>
      decodeCodeCommand({
        kind: "prepare-code-project-checkout",
        projectId: ids.project,
        repositoryRoot: "/private/repository",
      }),
    ).toThrow();
    expect(() =>
      decodeCodeCommand({
        kind: "change-code-thread-access",
        threadId: ids.thread,
        expectedVersion: 1,
        executionPolicy: "plan",
        permissionPersistence: "project-default",
        bypassApprovals: true,
      }),
    ).toThrow();
    expect(() =>
      decodeCodeCommand({
        kind: "update-code-settings",
        expectedVersion: 1,
        defaultExecutionPolicy: "approval-gated",
        defaultPermissionPersistence: "current-session",
        shellCommand: "editor $FILE",
      }),
    ).toThrow();

    const frame = {
      threadId: ids.thread,
      sequence: 1,
      event: { kind: "thread-created", thread },
    } as const;
    expect(decodeCodeEventFrame(frame)).toEqual(frame);
    expect(() => decodeCodeEventFrame({ ...frame, sequence: 0 })).toThrow();
    expect(() =>
      decodeCodeEventFrame({
        ...frame,
        event: { ...frame.event, rawOutput: "private" },
      }),
    ).toThrow();

    expect(
      codeContracts.decodeCodeCommandResult({
        kind: "checkout-prepared",
        bindingRevisionId: ids.bindingRevision,
        checkout: {
          id: ids.checkout,
          repositoryId,
          kind: "existing-worktree",
          availability: "available",
          head: { kind: "branch", name: "feature/phase-7", oid: "b".repeat(40) },
          observedAt: now,
        },
      }),
    ).toMatchObject({ kind: "checkout-prepared", bindingRevisionId: ids.bindingRevision });
  });

  it("carries a per-thread activity sequence through the bootstrap", () => {
    const settings = {
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      version: 1,
      updatedAt: now,
    } as const;
    const checkout = {
      id: ids.checkout,
      repositoryId,
      kind: "existing-worktree",
      availability: "available",
      head: { kind: "branch", name: "feature/phase-7", oid: "b".repeat(40) },
      observedAt: now,
    } as const;
    const bootstrap = {
      settings,
      threads: [thread],
      checkouts: [checkout],
      activity: [{ threadId: ids.thread, lastSequence: 42 }],
    } as const;

    expect(codeContracts.decodeCodeBootstrap(bootstrap)).toEqual({ ...bootstrap, runtime: [] });
    // A thread with no journaled operation event is absent, not reported at
    // zero, so the client can tell silence from "nothing has happened yet".
    expect(codeContracts.decodeCodeBootstrap({ ...bootstrap, activity: [] }).activity).toEqual([]);
    // A host that predates the field says nothing rather than an empty list.
    // Refusing that would fail Code bootstrap outright on a paired client that
    // updated first, instead of losing only the unread mark it feeds.
    expect(
      codeContracts.decodeCodeBootstrap({ settings, threads: [], checkouts: [] }).activity,
    ).toEqual([]);
    expect(
      codeContracts.decodeCodeBootstrap({ settings, threads: [], checkouts: [] }).runtime,
    ).toEqual([]);
    expect(codeContracts.decodeCodeNavigation({ threads: [thread] })).toEqual({
      threads: [thread],
      activity: [],
      runtime: [],
    });
    expect(
      codeContracts.decodeCodeNavigation({
        threads: [thread],
        activity: [{ threadId: ids.thread, lastSequence: 42 }],
        runtime: [
          {
            threadId: ids.thread,
            executing: true,
            checkoutChip: { checkoutKind: "managed-worktree", label: "feature/x" },
          },
        ],
      }),
    ).toEqual({
      threads: [thread],
      activity: [{ threadId: ids.thread, lastSequence: 42 }],
      runtime: [
        {
          threadId: ids.thread,
          executing: true,
          checkoutChip: { checkoutKind: "managed-worktree", label: "feature/x" },
        },
      ],
    });
    expect(() =>
      codeContracts.decodeCodeNavigation({
        threads: [thread],
        checkouts: [checkout],
      }),
    ).toThrow();
    expect(() =>
      codeContracts.decodeCodeNavigationRuntime({
        threadId: ids.thread,
        executing: true,
        checkoutChip: { checkoutKind: "existing-worktree", label: "main" },
      }),
    ).toThrow();
    expect(() =>
      codeContracts.decodeCodeThreadActivity({ threadId: ids.thread, lastSequence: -1 }),
    ).toThrow();
    expect(() =>
      codeContracts.decodeCodeThreadActivity({
        threadId: ids.thread,
        lastSequence: 1,
        version: 1,
      }),
    ).toThrow();
  });
});

describe("Code delivery outcome contracts", () => {
  it("accepts only the four ordered delivery outcome kinds", () => {
    for (const kind of [
      "investigation-result",
      "local-implementation",
      "opened-pr",
      "merged-pr",
    ] as const) {
      expect(decodeCodeDeliveryOutcomeKind(kind)).toBe(kind);
    }
    for (const invalid of ["done", "opened pr", "OPENED-PR", "closed-pr", ""]) {
      expect(() => decodeCodeDeliveryOutcomeKind(invalid)).toThrow();
    }
  });

  it("requires a confirmed outcome kind on every delivery target and rejects excess fields", () => {
    expect(decodeCodeDeliveryTarget(deliveryTarget)).toEqual(deliveryTarget);
    const { outcomeKind: _omitted, ...withoutOutcome } = deliveryTarget;
    expect(() => decodeCodeDeliveryTarget(withoutOutcome)).toThrow();
    expect(() => decodeCodeDeliveryTarget({ ...deliveryTarget, outcomeKind: "unknown" })).toThrow();
    expect(() => decodeCodeDeliveryTarget({ ...deliveryTarget, satisfiedAt: now })).toThrow();
  });

  it("carries an optional advisory outcome proposal without redefining the confirmed kind", () => {
    const proposed = {
      ...deliveryTarget,
      proposedOutcome: { outcomeKind: "merged-pr", rationale: "CI is green", proposedAt: now },
    } as const;
    expect(decodeCodeDeliveryTarget(proposed)).toEqual(proposed);
    expect(decodeCodeDeliveryTarget(proposed).outcomeKind).toBe("opened-pr");
    expect(() =>
      decodeCodeDeliveryTarget({
        ...deliveryTarget,
        proposedOutcome: { outcomeKind: "merged-pr" },
      }),
    ).toThrow();
    expect(() =>
      decodeCodeDeliveryTarget({
        ...deliveryTarget,
        proposedOutcome: { outcomeKind: "merged-pr", proposedAt: now, confirmed: true },
      }),
    ).toThrow();
  });

  it("decodes an agent proposal command that never carries confirmation authority", () => {
    const command = decodeCodeCommand({
      kind: "propose-code-delivery-outcome",
      threadId: ids.thread,
      expectedVersion: 1,
      outcomeKind: "merged-pr",
      rationale: "The pull request has been merged upstream.",
    });
    expect(command).toEqual({
      kind: "propose-code-delivery-outcome",
      threadId: ids.thread,
      expectedVersion: 1,
      outcomeKind: "merged-pr",
      rationale: "The pull request has been merged upstream.",
    });
    expect(
      decodeCodeCommand({
        kind: "propose-code-delivery-outcome",
        threadId: ids.thread,
        expectedVersion: 1,
        outcomeKind: "local-implementation",
      }).kind,
    ).toBe("propose-code-delivery-outcome");
    expect(() =>
      decodeCodeCommand({
        kind: "propose-code-delivery-outcome",
        threadId: ids.thread,
        expectedVersion: 1,
        outcomeKind: "merged-pr",
        confirmed: true,
      }),
    ).toThrow();
  });

  it("decodes a user confirmation command that only carries the outcome kind", () => {
    expect(
      decodeCodeCommand({
        kind: "confirm-code-delivery-outcome",
        threadId: ids.thread,
        expectedVersion: 2,
        outcomeKind: "merged-pr",
      }),
    ).toEqual({
      kind: "confirm-code-delivery-outcome",
      threadId: ids.thread,
      expectedVersion: 2,
      outcomeKind: "merged-pr",
    });
    // The confirmed Git-level delivery target remains immutable: there is no
    // command that redefines branch, remote, or base fields.
    expect(() =>
      decodeCodeCommand({
        kind: "confirm-code-delivery-outcome",
        threadId: ids.thread,
        expectedVersion: 2,
        outcomeKind: "merged-pr",
        deliveryTarget,
      }),
    ).toThrow();
    expect(() =>
      decodeCodeCommand({
        kind: "confirm-code-delivery-outcome",
        threadId: ids.thread,
        expectedVersion: 2,
      }),
    ).toThrow();
  });
});

describe("Code persistence contracts", () => {
  const checkout = {
    id: ids.checkout,
    repositoryId,
    kind: "managed-worktree",
    availability: "available",
    head: { kind: "branch", name: "feature/phase-7", oid: "b".repeat(40) },
    ownershipReceiptId: ids.receipt,
    observedAt: now,
  } as const;
  const file = {
    id: ids.file,
    threadId: ids.thread,
    checkoutId: ids.checkout,
    contentId: ids.content,
    digest: "c".repeat(64),
    byteLength: 12,
    state: "available",
    version: 1,
    updatedAt: now,
  } as const;
  const runtimeWork = {
    id: ids.runtime,
    threadId: ids.thread,
    kind: "provider-turn",
    state: "running",
    updatedAt: now,
  } as const;

  it("exports the complete deterministic Code journal registry", () => {
    expect(codeContracts.CODE_EVENT_NAMES).toEqual([
      "code.settings-updated@1",
      "code.thread-created@1",
      "code.thread-updated@1",
      "code.checkout-observed@1",
      "code.checkout-removed@1",
      "code.file-reference-updated@1",
      "code.runtime-work-updated@1",
    ]);
  });

  it("decodes strict metadata-only Code journal payloads", () => {
    const decode = (codeContracts as Record<string, unknown>)[
      "decodeCodePersistenceEventPayload"
    ] as ((eventName: string, payload: unknown) => unknown) | undefined;
    expect(decode).toBeTypeOf("function");
    if (decode === undefined) return;

    expect(
      decode("code.settings-updated@1", {
        kind: "settings-updated",
        settings: {
          defaultExecutionPolicy: "approval-gated",
          defaultPermissionPersistence: "current-session",
          version: 1,
          updatedAt: now,
        },
      }),
    ).toMatchObject({ kind: "settings-updated" });
    expect(decode("code.thread-created@1", { kind: "thread-created", thread })).toEqual({
      kind: "thread-created",
      thread,
    });
    expect(decode("code.thread-updated@1", { kind: "thread-updated", thread })).toEqual({
      kind: "thread-updated",
      thread,
    });
    expect(decode("code.checkout-observed@1", { kind: "checkout-observed", checkout })).toEqual({
      kind: "checkout-observed",
      checkout,
    });
    expect(
      decode("code.file-reference-updated@1", {
        kind: "file-reference-updated",
        file,
      }),
    ).toEqual({ kind: "file-reference-updated", file });
    expect(
      decode("code.runtime-work-updated@1", {
        kind: "runtime-work-updated",
        work: runtimeWork,
      }),
    ).toEqual({ kind: "runtime-work-updated", work: runtimeWork });

    for (const [eventName, payload] of [
      [
        "code.checkout-observed@1",
        { kind: "checkout-observed", checkout: { ...checkout, canonicalPath: "/private/repo" } },
      ],
      [
        "code.file-reference-updated@1",
        { kind: "file-reference-updated", file: { ...file, body: "private bytes" } },
      ],
      [
        "code.runtime-work-updated@1",
        { kind: "runtime-work-updated", work: { ...runtimeWork, rawOutput: "private bytes" } },
      ],
    ] as const) {
      expect(() => decode(eventName, payload)).toThrow();
    }
    expect(() => decode("code.future-event@1", {})).toThrow();
    expect(() =>
      decode("code.file-reference-updated@1", {
        kind: "file-reference-updated",
        file: { ...file, version: undefined },
      }),
    ).toThrow();
    expect(() =>
      decode("code.runtime-work-updated@1", {
        kind: "runtime-work-updated",
        work: { ...runtimeWork, digest: "e".repeat(64) },
      }),
    ).toThrow();
    expect(
      decode("code.file-reference-updated@1", {
        kind: "file-reference-updated",
        file: { ...file, state: "failed", version: 2 },
      }),
    ).toEqual({
      kind: "file-reference-updated",
      file: { ...file, state: "failed", version: 2 },
    });
  });

  it("replays pre-outcome thread journals by defaulting a missing delivery outcome", () => {
    // Compatibility rule: delivery outcome kinds were introduced after Code
    // threads already persisted delivery targets. Historical
    // `code.thread-created@1` / `code.thread-updated@1` events embed a delivery
    // target with no `outcomeKind`. Replaying them must never fail; the missing
    // kind decodes as `CODE_DELIVERY_OUTCOME_REPLAY_DEFAULT` so the thread is
    // treated as targeting the committed work it already carried a branch and
    // remote for, without fabricating a PR-level outcome the user never
    // confirmed. New writes always stamp a confirmed `outcomeKind`.
    const decode = (codeContracts as Record<string, unknown>)[
      "decodeCodePersistenceEventPayload"
    ] as ((eventName: string, payload: unknown) => unknown) | undefined;
    expect(decode).toBeTypeOf("function");
    if (decode === undefined) return;

    expect(codeContracts.CODE_DELIVERY_OUTCOME_REPLAY_DEFAULT).toBe("local-implementation");

    const { outcomeKind: _confirmed, ...deliveryTargetWithoutOutcome } = deliveryTarget;
    const legacyThread = { ...thread, deliveryTarget: deliveryTargetWithoutOutcome } as const;

    for (const [eventName, kind] of [
      ["code.thread-created@1", "thread-created"],
      ["code.thread-updated@1", "thread-updated"],
    ] as const) {
      expect(decode(eventName, { kind, thread: legacyThread })).toEqual({
        kind,
        thread: {
          ...legacyThread,
          deliveryTarget: {
            ...deliveryTargetWithoutOutcome,
            outcomeKind: codeContracts.CODE_DELIVERY_OUTCOME_REPLAY_DEFAULT,
          },
        },
      });
      // A confirmed outcome on the persisted event is preserved verbatim.
      expect(decode(eventName, { kind, thread })).toEqual({ kind, thread });
    }

    // The persisted decode still rejects unknown outcome kinds and excess
    // fields: it only tolerates the single missing-field compatibility case.
    expect(() =>
      decode("code.thread-created@1", {
        kind: "thread-created",
        thread: {
          ...thread,
          deliveryTarget: { ...deliveryTargetWithoutOutcome, outcomeKind: "shipped" },
        },
      }),
    ).toThrow();

    // The live (non-replay) delivery target contract keeps `outcomeKind`
    // required, so new writes can never omit it.
    expect(() => decodeCodeDeliveryTarget(deliveryTargetWithoutOutcome)).toThrow();
  });

  it("decodes public file-save metadata and all strict terminal results", () => {
    const decodeMetadata = (codeContracts as Record<string, unknown>)["decodeCodeFileMetadata"] as
      | ((input: unknown) => unknown)
      | undefined;
    const decodeResult = (codeContracts as Record<string, unknown>)[
      "decodeCodeFileSaveResultEnvelope"
    ] as ((input: unknown) => unknown) | undefined;
    expect(decodeMetadata).toBeTypeOf("function");
    expect(decodeResult).toBeTypeOf("function");
    if (decodeMetadata === undefined || decodeResult === undefined) return;

    const metadata = {
      identity: { device: "16777234", inode: "123456" },
      byteLength: 7,
      modifiedNanoseconds: "123000000000",
      digest: "d".repeat(64),
    };
    expect(decodeMetadata(metadata)).toEqual(metadata);
    for (const result of [
      { status: "completed", metadata },
      { status: "conflict", failure: { category: "conflict", code: "digest-mismatch" } },
      { status: "interrupted", rescanRequired: true },
      { status: "failed", failure: { category: "failed", code: "helper-failed" } },
    ] as const) {
      expect(decodeResult({ kind: "code-file-save-result", result })).toEqual({
        kind: "code-file-save-result",
        result,
      });
    }

    expect(() => decodeMetadata({ ...metadata, body: "private bytes" })).toThrow();
    expect(() => decodeMetadata({ ...metadata, canonicalPath: "/private/repo" })).toThrow();
    expect(() => decodeMetadata({ ...metadata, digest: "D".repeat(64) })).toThrow();
    expect(() =>
      decodeResult({
        kind: "code-file-save-result",
        result: { status: "interrupted", rescanRequired: false },
      }),
    ).toThrow();
  });
});

describe("Code worktree source preview contracts", () => {
  const sha = "a".repeat(40);

  it("decodes a preview command carrying the source intent", () => {
    const command = decodeCodeCommand({
      kind: "preview-code-worktree-source",
      projectId: ids.project,
      bindingRevisionId: ids.bindingRevision,
      repositoryId,
      refIntent: "refs/heads/development",
      startFromOrigin: true,
      remoteName: "origin",
    });
    expect(command).toEqual({
      kind: "preview-code-worktree-source",
      projectId: ids.project,
      bindingRevisionId: ids.bindingRevision,
      repositoryId,
      refIntent: "refs/heads/development",
      startFromOrigin: true,
      remoteName: "origin",
    });
  });

  it("rejects a preview command with an invalid object id or excess field", () => {
    expect(() =>
      decodeCodeCommand({
        kind: "preview-code-worktree-source",
        projectId: ids.project,
        bindingRevisionId: ids.bindingRevision,
        repositoryId,
        refIntent: "",
        startFromOrigin: true,
      }),
    ).toThrow();
  });

  it("decodes an exact origin preview with resolved SHA and fetch time", () => {
    expect(
      decodeCodeWorktreeSourcePreview({
        kind: "origin",
        remoteName: "origin",
        branch: "development",
        resolvedHead: sha,
        fetchedAt: now,
      }),
    ).toEqual({
      kind: "origin",
      remoteName: "origin",
      branch: "development",
      resolvedHead: sha,
      fetchedAt: now,
    });
  });

  it("decodes a local preview and a typed failure", () => {
    expect(
      decodeCodeWorktreeSourcePreview({ kind: "local", branch: "development", resolvedHead: sha }),
    ).toEqual({ kind: "local", branch: "development", resolvedHead: sha });
    expect(decodeCodeWorktreeSourcePreview({ kind: "failed", reason: "fetch-rejected" })).toEqual({
      kind: "failed",
      reason: "fetch-rejected",
    });
    expect(() =>
      decodeCodeWorktreeSourcePreview({ kind: "failed", reason: "not-a-reason" }),
    ).toThrow();
    expect(() =>
      decodeCodeWorktreeSourcePreview({
        kind: "origin",
        remoteName: "origin",
        branch: "development",
        resolvedHead: "nothex",
        fetchedAt: now,
      }),
    ).toThrow();
  });

  it("decodes the previewed command result without persisting it", () => {
    expect(
      decodeCodeCommandResult({
        kind: "worktree-source-previewed",
        preview: { kind: "local", branch: "development", resolvedHead: sha },
      }),
    ).toEqual({
      kind: "worktree-source-previewed",
      preview: { kind: "local", branch: "development", resolvedHead: sha },
    });
    expect(codeContracts.CODE_EVENT_NAMES).not.toContain("code.worktree-source-previewed@1");
  });
});

describe("Code managed thread creation contracts", () => {
  const managedCommand = {
    kind: "create-managed-code-thread",
    threadId: ids.thread,
    projectId: ids.project,
    bindingRevisionId: ids.bindingRevision,
    title: "Managed work",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget,
    sourceBranch: "development",
    startFromOrigin: true,
    remoteName: "origin",
  } as const;

  it("decodes a managed thread creation command carrying the source intent", () => {
    expect(decodeCodeCommand(managedCommand)).toEqual(managedCommand);
  });

  it("accepts an issue reference on managed thread creation and rejects assembled issue text", () => {
    expect(
      decodeCodeCommand({
        ...managedCommand,
        issueContext: { owner: "octant", name: "octant", number: 7 },
      }),
    ).toMatchObject({
      issueContext: { owner: "octant", name: "octant", number: 7 },
    });
    expect(
      decodeCodeCommand({
        ...managedCommand,
        linearIssueContext: { id: "11111111-1111-4111-8111-111111111111" },
      }),
    ).toMatchObject({
      linearIssueContext: { id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(() =>
      decodeCodeCommand({
        ...managedCommand,
        issueContext: { owner: "octant", name: "octant", number: 7, body: "assembled" },
      }),
    ).toThrow();
  });

  it("rejects a managed thread creation command with an empty source branch or excess field", () => {
    expect(() => decodeCodeCommand({ ...managedCommand, sourceBranch: "" })).toThrow();
    expect(() => decodeCodeCommand({ ...managedCommand, extra: 1 })).toThrow();
  });

  it("decodes the managed-thread-created result with exact provenance", () => {
    const managedCheckout = {
      id: ids.checkout,
      repositoryId,
      kind: "managed-worktree",
      availability: "available",
      head: { kind: "branch", name: "octant/managed", oid: "a".repeat(40) },
      ownershipReceiptId: ids.receipt,
      observedAt: now,
    } as const;
    const result = decodeCodeCommandResult({
      kind: "managed-thread-created",
      thread,
      checkout: managedCheckout,
      provenance: {
        receiptId: ids.receipt,
        mode: "origin",
        branch: "development",
        resolvedHead: "a".repeat(40),
        remoteName: "origin",
        fetchedAt: now,
      },
    });
    expect(result).toMatchObject({
      kind: "managed-thread-created",
      provenance: { mode: "origin", resolvedHead: "a".repeat(40), receiptId: ids.receipt },
    });
    expect(codeContracts.CODE_EVENT_NAMES).not.toContain("code.managed-thread-created@1");
  });

  it("carries a checkout rebind refusal as a value rather than an absent result", () => {
    // A rebind that cannot happen is an ordinary answer — the Project may be
    // unreadable, or the thread may already be where it belongs — so the result
    // has to say so in a shape every caller must destructure.
    const refused = decodeCodeCommandResult({
      kind: "thread-checkout-rebind",
      threadId: ids.thread,
      outcome: { status: "refused", reason: "checkout-unavailable" },
    });
    expect(refused).toEqual({
      kind: "thread-checkout-rebind",
      threadId: ids.thread,
      outcome: { status: "refused", reason: "checkout-unavailable" },
    });
    expect(() =>
      decodeCodeCommandResult({
        kind: "thread-checkout-rebind",
        threadId: ids.thread,
        outcome: { status: "refused", reason: "because-i-said-so" },
      }),
    ).toThrow();
    // The rebind is a command, never a journaled event name of its own: it is
    // recorded as the thread update and checkout observation it actually makes.
    expect(codeContracts.CODE_EVENT_NAMES).not.toContain("code.thread-checkout-rebind@1");
  });
});
