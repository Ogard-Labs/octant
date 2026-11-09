import { BrowserDelegatedChildren } from "./browserDelegatedChildren";
import { BrowserSessionGrants } from "./browserSessionGrants";
import type { BrowserRuntimePort } from "./browserRuntimePort";
import { mkdtemp, mkdir, rename, rm, writeFile, readFile, lstat, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  decodeBrowserThreadId,
  decodeProjectId,
  decodeToolActionAuthority,
  decodeProviderModelId,
  decodeWindowId,
  decodeProjectWorkingFolderId,
  decodeAutomationId,
  decodeCodeRelativePath,
} from "@octant/contracts";
import { BrowserUploadPermissions } from "./browserUploadPermissions";
import { admitBrowserUpload } from "./browserUploadFiles";
import type { BrowserSessionTarget } from "@octant/contracts/browser-session-grants";
import { decodeBrowserUploadPermissionsCommand } from "@octant/contracts/browser-upload-permissions";
const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const routineId = decodeAutomationId("20000000-0000-4000-8000-000000000001");
const folder = {
  id: decodeProjectWorkingFolderId(`folder_${"a".repeat(64)}`),
  label: "Reports",
  kind: "extra" as const,
};
const target: BrowserSessionTarget = {
  grantee: { kind: "routine", routineId },
  label: "Send report",
  modelId: decodeProviderModelId("test-model"),
  authority: decodeToolActionAuthority({
    hostId: "30000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId: "40000000-0000-4000-8000-000000000001",
    providerInstanceId: "50000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  }),
};
async function fixture(absoluteFolderLabels = false) {
  const directory = await mkdtemp(join(tmpdir(), "octant-upload-permission-"));
  const root = join(directory, "reports");
  await mkdir(root);
  await writeFile(join(root, "report.txt"), "first report");
  let revision = "definition-one";
  const current = () => ({
    recipient: { target, revision },
    folders: absoluteFolderLabels
      ? [
          { ...folder, label: root },
          {
            ...folder,
            id: decodeProjectWorkingFolderId(`folder_${"b".repeat(64)}`),
            label: join(directory, "other", "reports"),
          },
        ]
      : [folder],
    rootFor: (id: string) =>
      String(id) === String(folder.id) ? root : join(directory, "other", "reports"),
  });
  const record = vi.fn();
  const service = new BrowserUploadPermissions({
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    isLocalWindow: () => true,
    canReview: () => true,
    current,
    targets: () => [current()],
    record,
  });
  const command = decodeBrowserUploadPermissionsCommand({
    kind: "review",
    routineId,
    profile: { kind: "personal" },
    origin: "https://example.com",
    folderId: folder.id,
    files: ["report.txt"],
    maxFiles: 1,
    maxBytes: 1000,
    durationMinutes: 15,
  });
  const review = await service.execute(windowId, command);
  if (review.kind !== "upload-permission-review") throw Error(JSON.stringify(review));
  const input = {
    permissionId: review.permission.permissionId,
    target,
    profile: { kind: "personal" as const },
    origin: "https://example.com",
    files: [decodeCodeRelativePath("report.txt")],
    callerIsCurrent: () => true,
  };
  return {
    service,
    current,
    command,
    review,
    input,
    record,
    root,
    directory,
    setRevision: () => {
      revision = "definition-two";
    },
    grant: () => service.execute(windowId, { kind: "grant", reviewId: review.reviewId }),
    cleanup: async () => {
      service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
it("requires explicit review, rejects changed content and shares one quota across concurrent staged uploads", async () => {
  const f = await fixture();
  try {
    expect(f.service.prepare(f.input)).toBeUndefined();
    expect(await f.grant()).toMatchObject({ kind: "upload-permission-granted" });
    expect(f.service.prepare({ ...f.input, origin: "https://other.example" })).toBeUndefined();
    expect(
      f.service.prepare({
        ...f.input,
        profile: {
          kind: "project",
          projectId: decodeProjectId("40000000-0000-4000-8000-000000000001"),
        },
      }),
    ).toBeUndefined();
    await writeFile(join(f.root, "report.txt"), "other report");
    const changed = f.service.prepare(f.input);
    if (changed === undefined) throw Error("Missing prepared policy");
    expect(
      await admitBrowserUpload({
        workspaceRoot: changed.workspaceRoot,
        files: f.input.files,
        ask: changed.approve,
      }),
    ).toMatchObject({ status: "refused" });
    expect(changed.signal.aborted).toBe(true);
    await writeFile(join(f.root, "report.txt"), "first report");
    const renewed = await f.service.execute(windowId, f.command);
    if (renewed.kind !== "upload-permission-review") throw Error("Missing new review");
    await f.service.execute(windowId, { kind: "grant", reviewId: renewed.reviewId });
    const retryInput = { ...f.input, permissionId: renewed.permission.permissionId };
    const first = f.service.prepare(retryInput);
    const second = f.service.prepare(retryInput);
    if (first === undefined || second === undefined) throw Error("Missing upload policy");
    const outcomes = await Promise.all(
      [first, second].map((policy) =>
        admitBrowserUpload({
          workspaceRoot: policy.workspaceRoot,
          files: f.input.files,
          ask: policy.approve,
        }),
      ),
    );
    expect(outcomes.filter((result) => result.status === "admitted")).toHaveLength(1);
    for (const outcome of outcomes) if (outcome.status === "admitted") await outcome.release();
    expect(f.record.mock.calls.filter(([event]) => event.kind === "consumed")).toHaveLength(1);
    expect(f.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "consumed",
        remainingFiles: 0,
        transferredFiles: ["report.txt"],
      }),
    );
    await f.service.execute(windowId, {
      kind: "revoke",
      permissionId: renewed.permission.permissionId,
    });
    expect(first.signal.aborted).toBe(true);
  } finally {
    await f.cleanup();
  }
});
it("refuses a revoked pending review, changed recipient and a replaced approved source folder identity", async () => {
  const cancelled = await fixture();
  try {
    const pending = cancelled.grant();
    cancelled.service.revokeWindow(windowId);
    expect(await pending).toMatchObject({ kind: "upload-permission-refused" });
    expect(cancelled.record).not.toHaveBeenCalled();
  } finally {
    await cancelled.cleanup();
  }
  const f = await fixture();
  try {
    await f.grant();
    const policy = f.service.prepare(f.input);
    if (policy === undefined) throw Error("Missing policy");
    await rename(f.root, join(f.directory, "old"));
    await mkdir(f.root);
    await writeFile(join(f.root, "report.txt"), "first report");
    expect(
      await admitBrowserUpload({
        workspaceRoot: policy.workspaceRoot,
        files: f.input.files,
        ask: policy.approve,
      }),
    ).toMatchObject({ status: "refused" });
    f.setRevision();
    f.service.revalidate();
    expect(policy.signal.aborted).toBe(true);
    expect(f.service.prepare(f.input)).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

it("keeps file authority separate from account access and revokes the routine's attached private copies", async () => {
  const f = await fixture();
  const accountGrants = new BrowserSessionGrants({
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    isLocalWindow: () => true,
    canReview: () => true,
    targets: () => [f.current().recipient],
    current: () => f.current().recipient,
    profileLabel: async () => "Personal",
    record: () => {},
    onRevoked: () => {},
  });
  let stagedPath = "";
  const runtime: BrowserRuntimePort = {
    available: async () => true,
    nativeAvailable: async () => true,
    createContext: vi.fn(async () => "native-live" as const),
    inspectTarget: async () => ({ sensitive: false }),
    act: vi.fn(async (_id, request) => {
      if (request.kind === "upload") {
        stagedPath = request.files?.[0] ?? "";
        expect(stagedPath.startsWith(f.root)).toBe(false);
        expect(await readFile(stagedPath, "utf8")).toBe("first report");
      }
      return { url: "https://example.com/report", title: "Report", snapshot: "Report form" };
    }),
    closeContext: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
  };
  const delegated = new BrowserDelegatedChildren({
    runtime,
    grants: accountGrants,
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
  });
  const tools = delegated.tools({
    target,
    executionPolicy: "approval-gated",
    executionId: "90000000-0000-4000-8000-000000000001",
    contentThreadId: decodeBrowserThreadId("90000000-0000-4000-8000-000000000002"),
    current: () => target,
    uploadPermissions: f.service,
  });
  expect(JSON.stringify(tools.definitions)).toContain("uploadPermissionId");
  const call = (input: object) =>
    tools.execute({ name: "octant_browser", inputJson: JSON.stringify(input) });
  const navigate = {
    operation: "navigate",
    url: "https://example.com/report",
    profile: "personal",
  };
  try {
    await f.grant();
    expect(await call(navigate)).toMatchObject({
      isError: true,
      result: { error: "browser-session-permission-required" },
    });
    expect(runtime.createContext).not.toHaveBeenCalled();
    const review = await accountGrants.execute(windowId, {
      kind: "review",
      grantee: { kind: "routine", routineId },
      profile: { kind: "personal" },
      origins: ["https://example.com"],
      durationMinutes: 60,
    });
    if (review.kind !== "browser-session-review") throw Error("Missing account review");
    await accountGrants.execute(windowId, { kind: "grant", reviewId: review.reviewId });
    expect(await call(navigate)).toMatchObject({ isError: false });
    expect(
      await call({ operation: "upload", selector: "#file", files: ["report.txt"] }),
    ).toMatchObject({
      isError: true,
      result: {
        error: "upload-permission-required",
        permissions: [expect.objectContaining({ permissionId: f.review.permission.permissionId })],
      },
    });
    expect(
      await call({
        operation: "upload",
        selector: "#file",
        files: ["report.txt"],
        uploadPermissionId: f.review.permission.permissionId,
      }),
    ).toMatchObject({ isError: false });
    expect(runtime.act).toHaveBeenCalledTimes(2);
    await f.service.execute(windowId, {
      kind: "revoke",
      permissionId: f.review.permission.permissionId,
    });
    await vi.waitFor(() => expect(runtime.closeContext).toHaveBeenCalledOnce());
    await vi.waitFor(async () =>
      expect(
        await lstat(stagedPath).then(
          () => true,
          () => false,
        ),
      ).toBe(false),
    );
    expect((await call({ operation: "snapshot" })).isError).toBe(true);
    expect(runtime.act).toHaveBeenCalledTimes(2);
    expect(runtime.closeAll).not.toHaveBeenCalled();
  } finally {
    await tools.close?.();
    await delegated.close();
    accountGrants.close();
    await f.cleanup();
  }
});

it("refuses a newly hard-linked source and does not spend quota when durable admission fails", async () => {
  const linked = await fixture();
  try {
    await linked.grant();
    await link(join(linked.root, "report.txt"), join(linked.directory, "alias.txt"));
    const policy = linked.service.prepare(linked.input);
    if (policy === undefined) throw Error("Missing policy");
    expect(
      await admitBrowserUpload({
        workspaceRoot: policy.workspaceRoot,
        files: linked.input.files,
        ask: policy.approve,
      }),
    ).toMatchObject({ status: "refused" });
    expect(policy.signal.aborted).toBe(true);
  } finally {
    await linked.cleanup();
  }
  const f = await fixture();
  try {
    await f.grant();
    f.record.mockImplementation((event) => {
      if (event.kind === "consumed") throw Error("Disk unavailable");
    });
    const policy = f.service.prepare(f.input);
    if (policy === undefined) throw Error("Missing policy");
    expect(
      await admitBrowserUpload({
        workspaceRoot: policy.workspaceRoot,
        files: f.input.files,
        ask: policy.approve,
      }),
    ).toMatchObject({ status: "refused" });
    expect(f.service.choices(target, f.input.profile, f.input.origin)[0]).toMatchObject({
      remainingFiles: 1,
      remainingBytes: 1000,
    });
    f.record.mockReset();
    const retry = await admitBrowserUpload({
      workspaceRoot: policy.workspaceRoot,
      files: f.input.files,
      ask: policy.approve,
    });
    if (retry.status === "admitted") await retry.release();
    expect(retry.status).toBe("admitted");
  } finally {
    await f.cleanup();
  }
});

it("forgets erased Project authority without recreating erased metadata", async () => {
  const f = await fixture();
  try {
    await f.grant();
    const policy = f.service.prepare(f.input);
    if (policy === undefined) throw Error("Missing policy");
    const before = f.record.mock.calls.length;
    f.service.forgetProject(String(target.authority.projectId));
    expect(policy.signal.aborted).toBe(true);
    expect(f.service.prepare(f.input)).toBeUndefined();
    expect(f.record.mock.calls).toHaveLength(before);
  } finally {
    await f.cleanup();
  }
});

it("keeps duplicate folder roots out of reviewed, journaled and routine-visible manifest metadata", async () => {
  const f = await fixture(true);
  try {
    const choices = await f.service.execute(windowId, { kind: "targets" });
    expect(JSON.stringify(choices)).not.toContain(f.directory);
    if (choices.kind !== "upload-permission-targets") throw Error("Expected choices");
    const labels = choices.targets[0]?.folders.map((row) => row.label);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    expect(JSON.stringify(f.review.permission)).not.toContain(f.directory);
    await f.grant();
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(f.directory);
    expect(
      JSON.stringify(f.service.choices(target, f.input.profile, f.input.origin)),
    ).not.toContain(f.directory);
  } finally {
    await f.cleanup();
  }
});
