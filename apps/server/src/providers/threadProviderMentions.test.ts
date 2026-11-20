import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  decodeBindingRevisionId,
  decodeCodeCheckoutId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeThreadWorkingDirectory,
  decodeWindowId,
  decodeWorkThreadId,
  decodeWorktreeReceiptId,
  type ProviderMention,
} from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readThreadProviderMentions,
  type ThreadProviderMentionsSources,
} from "./threadProviderMentions";

const windowId = decodeWindowId("80000000-0000-4000-8000-000000000001");
const projectId = decodeProjectId("80000000-0000-4000-8000-000000000002");
const codeThreadId = decodeCodeThreadId("80000000-0000-4000-8000-000000000003");
const workThreadId = decodeWorkThreadId("80000000-0000-4000-8000-000000000004");
const checkoutId = decodeCodeCheckoutId("80000000-0000-4000-8000-000000000005");
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000006");
const revisionId = decodeBindingRevisionId("80000000-0000-4000-8000-000000000007");
const receiptId = decodeWorktreeReceiptId("80000000-0000-4000-8000-000000000008");

const accountMentions: ReadonlyArray<ProviderMention> = [
  { kind: "skill", name: "tidy", description: "Tidy the code" },
  { kind: "plugin", name: "docs", description: "Search the docs" },
];

const projectAndAccountMentions: ReadonlyArray<ProviderMention> = [
  { kind: "skill", name: "local", scope: "project", description: "Deploy this Project" },
  ...accountMentions,
];

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFolder(...subfolders: ReadonlyArray<string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-thread-mentions-")));
  tempRoots.push(root);
  for (const sub of subfolders) mkdirSync(join(root, sub), { recursive: true });
  return root;
}

function fixture(
  overrides: {
    readonly root?: string;
    readonly worktreePath?: string;
    readonly projectType?: "code" | "work" | "chat";
    readonly checkoutKind?: "existing-worktree" | "managed-worktree" | "remote-root";
    readonly executionPolicy?: "approval-gated" | "full-access" | "plan";
    readonly workingDirectory?: string;
    readonly accountNativeSetup?: boolean;
    readonly nativeProviders?: ReadonlyArray<string>;
    readonly threadChoice?: "on" | "off";
    readonly strict?: boolean;
    readonly canAccessProject?: boolean;
    readonly serverProject?: boolean;
    readonly listMentions?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const root = overrides.root ?? makeFolder("packages/app");
  const listMentions =
    overrides.listMentions ?? vi.fn(() => Effect.succeed(projectAndAccountMentions));
  const projectType = overrides.projectType ?? "code";
  const checkoutKind = overrides.checkoutKind ?? "existing-worktree";
  const sources: ThreadProviderMentionsSources = {
    canAccessProject: async () => overrides.canAccessProject ?? true,
    readCodeThread: () =>
      ({
        id: codeThreadId,
        projectId,
        checkoutId,
        providerInstanceId: instanceId,
        bindingRevisionId: revisionId,
        lifecycle: "active",
        executionPolicy: overrides.executionPolicy ?? "approval-gated",
      }) as never,
    readCodeCheckout: () =>
      (checkoutKind === "managed-worktree"
        ? { id: checkoutId, kind: "managed-worktree", ownershipReceiptId: receiptId }
        : { id: checkoutId, kind: checkoutKind }) as never,
    readWorkThread: () =>
      ({
        id: workThreadId,
        projectId,
        providerInstanceId: instanceId,
        bindingRevisionId: revisionId,
        lifecycle: "active",
        access: "ask-first",
        ...(overrides.workingDirectory === undefined
          ? {}
          : { workingDirectory: decodeThreadWorkingDirectory(overrides.workingDirectory) }),
      }) as never,
    readProject: () =>
      (projectType === "chat"
        ? { id: projectId, type: "chat", lifecycle: "active" }
        : {
            id: projectId,
            type: projectType,
            lifecycle: "active",
            binding: { canonicalRoot: root },
            bindingHistory: [{ revisionId }],
            ...(overrides.nativeProviders === undefined
              ? {}
              : { nativeProviders: overrides.nativeProviders }),
          }) as never,
    readProviderInstance: () =>
      ({
        id: instanceId,
        driverKind: "codex",
        enabled: true,
        ...(overrides.accountNativeSetup === undefined
          ? {}
          : { nativeSetup: overrides.accountNativeSetup }),
      }) as never,
    readThreadNativeSetup: () => overrides.threadChoice,
    readStrict: () => overrides.strict ?? false,
    isServerProject: () => overrides.serverProject ?? false,
    resolveManagedWorktreePath: async () => overrides.worktreePath,
    observedMentions: () => accountMentions,
    resolveDriver: () => ({ kind: "codex", listMentions }) as never,
  };
  return { root, sources, listMentions };
}

describe("reading a thread's provider mentions for the composer @ menu", () => {
  it("queries the Code thread's checkout folder and returns Project skills when nativeSetup.skills is on", async () => {
    const worktreePath = makeFolder();
    const f = fixture({ checkoutKind: "managed-worktree", worktreePath });
    const result = await readThreadProviderMentions(f.sources, windowId, {
      kind: "mentions",
      mode: "code",
      threadId: String(codeThreadId),
    });
    expect(result).toEqual({ status: "ok", mentions: projectAndAccountMentions });
    expect(f.listMentions).toHaveBeenCalledExactlyOnceWith({
      instanceId,
      projectRoot: worktreePath,
      nativeSetup: expect.objectContaining({ skills: true }),
    });
  });

  it("omits Project skills without querying the folder when nativeSetup.skills is off", async () => {
    const threadOff = fixture({ threadChoice: "off", executionPolicy: "full-access" });
    expect(
      await readThreadProviderMentions(threadOff.sources, windowId, {
        kind: "mentions",
        mode: "code",
        threadId: String(codeThreadId),
      }),
    ).toEqual({ status: "ok", mentions: accountMentions });
    expect(threadOff.listMentions).not.toHaveBeenCalled();

    const accountOff = fixture({ accountNativeSetup: false, executionPolicy: "approval-gated" });
    expect(
      await readThreadProviderMentions(accountOff.sources, windowId, {
        kind: "mentions",
        mode: "code",
        threadId: String(codeThreadId),
      }),
    ).toEqual({ status: "ok", mentions: accountMentions });
    expect(accountOff.listMentions).not.toHaveBeenCalled();
  });

  it("queries the Work thread's working directory when Project skills are on", async () => {
    const f = fixture({ projectType: "work", workingDirectory: "packages/app" });
    const result = await readThreadProviderMentions(f.sources, windowId, {
      kind: "mentions",
      mode: "work",
      threadId: String(workThreadId),
    });
    expect(result).toEqual({ status: "ok", mentions: projectAndAccountMentions });
    expect(f.listMentions).toHaveBeenCalledExactlyOnceWith({
      instanceId,
      projectRoot: join(f.root, "packages/app"),
      nativeSetup: expect.objectContaining({ skills: true }),
    });
  });

  it("never lists local Project skills for a server Project or remote checkout", async () => {
    const serverCode = fixture({ checkoutKind: "remote-root", serverProject: true });
    expect(
      await readThreadProviderMentions(serverCode.sources, windowId, {
        kind: "mentions",
        mode: "code",
        threadId: String(codeThreadId),
      }),
    ).toEqual({ status: "ok", mentions: accountMentions });
    expect(serverCode.listMentions).not.toHaveBeenCalled();

    const serverWork = fixture({ projectType: "work", serverProject: true });
    expect(
      await readThreadProviderMentions(serverWork.sources, windowId, {
        kind: "mentions",
        mode: "work",
        threadId: String(workThreadId),
      }),
    ).toEqual({ status: "ok", mentions: accountMentions });
    expect(serverWork.listMentions).not.toHaveBeenCalled();
  });

  it("refuses a window that does not have access to the thread's or draft's Project", async () => {
    const f = fixture({ canAccessProject: false });
    expect(
      await readThreadProviderMentions(f.sources, windowId, {
        kind: "mentions",
        mode: "code",
        threadId: String(codeThreadId),
      }),
    ).toEqual({ status: "unauthorized" });
    expect(
      await readThreadProviderMentions(f.sources, windowId, {
        kind: "draft-mentions",
        mode: "code",
        projectId,
        providerInstanceId: instanceId,
      }),
    ).toEqual({ status: "unauthorized" });
    expect(f.listMentions).not.toHaveBeenCalled();
  });

  it("lists Project skills for a local Code draft and omits them for a Chat Project or off setup", async () => {
    const localDraft = fixture({ accountNativeSetup: false });
    expect(
      await readThreadProviderMentions(localDraft.sources, windowId, {
        kind: "draft-mentions",
        mode: "code",
        projectId,
        providerInstanceId: instanceId,
        executionPolicy: "full-access",
      }),
    ).toEqual({ status: "ok", mentions: projectAndAccountMentions });
    expect(localDraft.listMentions).toHaveBeenCalledExactlyOnceWith({
      instanceId,
      projectRoot: localDraft.root,
      nativeSetup: expect.objectContaining({ skills: true }),
    });

    const chatProject = fixture({ projectType: "chat" });
    expect(
      await readThreadProviderMentions(chatProject.sources, windowId, {
        kind: "draft-mentions",
        mode: "code",
        projectId,
        providerInstanceId: instanceId,
      }),
    ).toEqual({ status: "ok", mentions: accountMentions });
    expect(chatProject.listMentions).not.toHaveBeenCalled();
  });
});
