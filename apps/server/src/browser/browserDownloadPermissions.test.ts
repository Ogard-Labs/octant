import { mkdtemp, mkdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  decodeAutomationId,
  decodeThreadWorkingDirectory,
  decodeBrowserAccountProfileId,
  decodeProjectWorkingFolderId,
  decodeToolActionAuthority,
  decodeProviderModelId,
  decodeWindowId,
} from "@octant/contracts";
import type { BrowserSessionTarget } from "@octant/contracts/browser-session-grants";
import { decodeBrowserDownloadPermissionsCommand } from "@octant/contracts/browser-download-permissions";
import { BrowserDownloadPermissions } from "./browserDownloadPermissions";
const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const routineId = decodeAutomationId("20000000-0000-4000-8000-000000000001");
const folder = {
  id: decodeProjectWorkingFolderId(`folder_${"a".repeat(64)}`),
  label: "Reports",
  kind: "extra" as const,
};
const target: BrowserSessionTarget = {
  grantee: { kind: "routine", routineId },
  label: "Collect report",
  modelId: decodeProviderModelId("test-model"),
  authority: decodeToolActionAuthority({
    hostId: "30000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId: "40000000-0000-4000-8000-000000000001",
    providerInstanceId: "50000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  }),
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "octant-download-permission-"));
  const root = join(directory, "reports");
  await mkdir(root);
  await mkdir(join(root, "inbox"));
  let revision = "definition-one";
  let now = Date.now();
  let local = true;
  const current = () => ({
    recipient: { target, revision },
    folders: [{ ...folder, label: root }],
    rootFor: (id: string) => (id === String(folder.id) ? root : undefined),
  });
  const record = vi.fn();
  const service = new BrowserDownloadPermissions({
    now: () => now,
    uuid: () => crypto.randomUUID(),
    isLocalWindow: () => local,
    canReview: () => true,
    current,
    targets: () => [current()],
    record,
  });
  const command = decodeBrowserDownloadPermissionsCommand({
    kind: "review",
    routineId,
    profile: { kind: "personal" },
    origin: "https://reports.example",
    sourceOrigins: ["https://reports.example", "https://files.example"],
    folderId: folder.id,
    directory: "inbox",
    mediaTypes: ["text/plain"],
    maxFiles: 1,
    maxBytes: 1000,
    durationMinutes: 15,
  });
  if (command.kind !== "review") throw Error("Invalid fixture review command");
  const review = await service.execute(windowId, command);
  if (review.kind !== "download-permission-review")
    await rm(directory, { recursive: true, force: true });
  expect(review.kind).toBe("download-permission-review");
  if (review.kind !== "download-permission-review") throw Error("Missing review");
  const input = {
    permissionId: review.permission.permissionId,
    target,
    profile: { kind: "personal" as const },
    callerIsCurrent: () => true,
  };
  const facts = {
    name: "report.txt",
    sizeBytes: 12,
    mediaType: "text/plain",
    source: {
      kind: "https-origin-chain" as const,
      origins: ["https://reports.example", "https://files.example"],
    },
  };
  return {
    service,
    current,
    command,
    review,
    input,
    record,
    facts,
    root,
    directory,
    expire: () => {
      now += 16 * 60_000;
    },
    change: () => {
      revision = "definition-two";
    },
    remote: () => {
      local = false;
    },
    grant: () => service.execute(windowId, { kind: "grant", reviewId: review.reviewId }),
    cleanup: async () => {
      service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
it("requires review and grant, retains complete source evidence, and reserves one shared budget only at final admission", async () => {
  const f = await fixture();
  try {
    expect(await f.service.prepare(f.input)).toBeUndefined();
    expect(JSON.stringify(f.review)).not.toContain(f.root);
    expect(await f.grant()).toMatchObject({ kind: "download-permission-granted" });
    const prepared = await f.service.prepare(f.input);
    if (prepared === undefined) throw Error("Missing permission");
    expect(prepared.inspect(f.facts, "https://reports.example")).toBe("approved");
    expect(f.record.mock.calls.filter(([event]) => event.kind === "consumed")).toHaveLength(0);
    expect(prepared.reserve(f.facts, "https://reports.example")).toBe("approved");
    expect(prepared.reserve(f.facts, "https://reports.example")).toBe("denied");
    expect(f.record.mock.calls.filter(([event]) => event.kind === "consumed")).toHaveLength(1);
    expect(prepared.destination.directory).toBe("inbox");
  } finally {
    await f.cleanup();
  }
});
it("refuses unverified sources, any foreign redirect origin, wrong page, type, profile and caller without charging", async () => {
  const f = await fixture();
  try {
    await f.grant();
    const p = await f.service.prepare(f.input);
    if (p === undefined) throw Error("Missing permission");
    for (const facts of [
      { name: f.facts.name, sizeBytes: f.facts.sizeBytes, mediaType: f.facts.mediaType },
      {
        ...f.facts,
        source: {
          ...f.facts.source,
          origins: ["https://reports.example", "https://foreign.example"],
        },
      },
      { ...f.facts, mediaType: "application/pdf" },
      { ...f.facts, sizeBytes: 1001 },
    ])
      expect(p.reserve(facts, "https://reports.example")).toBe("denied");
    expect(p.reserve(f.facts, "https://foreign.example")).toBe("denied");
    expect(await f.service.prepare({ ...f.input, callerIsCurrent: () => false })).toBeUndefined();
    expect(
      await f.service.prepare({
        ...f.input,
        profile: {
          kind: "account",
          profileId: decodeBrowserAccountProfileId("60000000-0000-4000-8000-000000000001"),
        },
      }),
    ).toBeUndefined();
    expect(f.record.mock.calls.filter(([event]) => event.kind === "consumed")).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});
it("refuses a replaced reviewed folder and never falls back to a workspace", async () => {
  const f = await fixture();
  try {
    await f.grant();
    await rename(join(f.root, "inbox"), join(f.root, "old"));
    await mkdir(join(f.root, "inbox"));
    expect(await f.service.prepare(f.input)).toBeUndefined();
    const changed = await f.service.execute(windowId, {
      ...f.command,
      directory: decodeThreadWorkingDirectory("old"),
    });
    expect(changed.kind).toBe("download-permission-review");
    await symlink(join(f.root, "old"), join(f.root, "link"));
    expect(
      await f.service.execute(windowId, {
        ...f.command,
        directory: decodeThreadWorkingDirectory("link"),
      }),
    ).toMatchObject({
      kind: "download-permission-refused",
    });
  } finally {
    await f.cleanup();
  }
});
it.each(["revoke", "expire", "change", "erase"] as const)(
  "ends retained download permission on %s",
  async (kind) => {
    const f = await fixture();
    try {
      await f.grant();
      const p = await f.service.prepare(f.input);
      if (p === undefined) throw Error("Missing permission");
      const records = f.record.mock.calls.length;
      if (kind === "revoke")
        await f.service.execute(windowId, {
          kind: "revoke",
          permissionId: f.review.permission.permissionId,
        });
      if (kind === "expire") {
        f.expire();
        f.service.revalidate();
      }
      if (kind === "change") {
        f.change();
        f.service.revalidate();
      }
      if (kind === "erase") f.service.forgetProject(String(target.authority.projectId));
      expect(p.signal.aborted).toBe(true);
      expect(p.reserve(f.facts, "https://reports.example")).toBe("denied");
      if (kind === "erase") expect(f.record.mock.calls.length).toBe(records);
    } finally {
      await f.cleanup();
    }
  },
);
it("cannot promote another window's review or a review after local authority disappears", async () => {
  const f = await fixture();
  try {
    expect(
      await f.service.execute(decodeWindowId("10000000-0000-4000-8000-000000000002"), {
        kind: "grant",
        reviewId: f.review.reviewId,
      }),
    ).toMatchObject({ kind: "download-permission-refused" });
    f.remote();
    expect(await f.grant()).toMatchObject({
      kind: "download-permission-refused",
      reason: "not-local",
    });
  } finally {
    await f.cleanup();
  }
});

it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "requires independent account access and routes one native held file through the reviewed destination and owning thread audit",
  async () => {
    const { BrowserDelegatedChildren } = await import("./browserDelegatedChildren");
    const { BrowserSessionGrants } = await import("./browserSessionGrants");
    const { browserDownloadHoldRoot } = await import("@octant/host-runtime");
    const { writeFile, readFile, readdir } = await import("node:fs/promises");
    const { decodeBrowserThreadId } = await import("@octant/contracts");
    const f = await fixture();
    const holdRoot = browserDownloadHoldRoot("headless");
    await mkdir(holdRoot, { recursive: true, mode: 0o700 });
    const heldFolder = await mkdtemp(join(holdRoot, "manifest-test-"));
    const heldPath = join(heldFolder, "file");
    await writeFile(heldPath, "first report");
    const account = new BrowserSessionGrants({
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
    const saved = vi.fn();
    let enabled = true;
    const runtime: import("./browserRuntimePort").BrowserRuntimePort = {
      available: async () => true,
      nativeAvailable: async () => true,
      createContext: vi.fn(async () => "native-live" as const),
      inspectTarget: async () => ({ sensitive: false }),
      act: vi.fn(async (_id, request) => ({
        url: "https://reports.example/report",
        title: "Report",
        snapshot: "Report",
        ...(request.downloads === "hold" && request.kind === "click"
          ? {
              downloads: [
                {
                  state: "held" as const,
                  downloadId: "d1",
                  name: "report.txt",
                  sizeBytes: 12,
                  mediaType: "text/plain",
                  source: f.facts.source,
                },
              ],
            }
          : {}),
      })),
      claimDownload: async () => heldPath,
      discardDownload: async () => {},
      closeContext: vi.fn(async () => {}),
      closeAll: async () => {},
    };
    const delegated = new BrowserDelegatedChildren({
      runtime,
      grants: account,
      now: Date.now,
      uuid: () => crypto.randomUUID(),
      agentDownloadsEnabled: () => enabled,
      downloads: { saved, refused: () => {} },
      recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
    });
    const owningThread = decodeBrowserThreadId("90000000-0000-4000-8000-000000000002");
    const tools = delegated.tools({
      target,
      executionPolicy: "approval-gated",
      executionId: "90000000-0000-4000-8000-000000000001",
      contentThreadId: owningThread,
      current: () => target,
      downloadPermissions: f.service,
    });
    const call = (input: object) =>
      tools.execute({ name: "octant_browser", inputJson: JSON.stringify(input) });
    try {
      await f.grant();
      expect(
        await call({
          operation: "navigate",
          url: "https://reports.example/report",
          profile: "personal",
        }),
      ).toMatchObject({ isError: true, result: { error: "browser-session-permission-required" } });
      expect(runtime.createContext).not.toHaveBeenCalled();
      const review = await account.execute(windowId, {
        kind: "review",
        grantee: { kind: "routine", routineId },
        profile: { kind: "personal" },
        origins: ["https://reports.example"],
        durationMinutes: 60,
      });
      if (review.kind !== "browser-session-review") throw Error("Missing account review");
      await account.execute(windowId, { kind: "grant", reviewId: review.reviewId });
      expect(
        await call({
          operation: "navigate",
          url: "https://reports.example/report",
          profile: "personal",
        }),
      ).toMatchObject({ isError: false });
      expect(await call({ operation: "download-save", downloadId: "d1" })).toMatchObject({
        isError: true,
        result: { error: "download-permission-required" },
      });
      await call({ operation: "click", selector: "#download" });
      enabled = false;
      const save = {
        operation: "download-save",
        downloadId: "d1",
        downloadPermissionId: f.review.permission.permissionId,
      };
      expect(await call(save)).toMatchObject({
        isError: true,
        result: { error: "download-permission-unavailable" },
      });
      expect(await readdir(join(f.root, "inbox"))).toEqual([]);
      enabled = true;
      expect(await call(save)).toMatchObject({
        isError: false,
        result: {
          saved: "inbox/report.txt",
          destination: { approvedFolderId: folder.id, pathBase: "selected-root" },
        },
      });
      expect(await readFile(join(f.root, "inbox", "report.txt"), "utf8")).toBe("first report");
      expect(saved).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: owningThread }),
        expect.objectContaining({
          destination: expect.objectContaining({ pathBase: "selected-root" }),
        }),
      );
      expect(await call(save)).toMatchObject({
        isError: true,
        result: { error: "download-not-found" },
      });
      expect(await readdir(join(f.root, "inbox"))).toEqual(["report.txt"]);
      await f.service.execute(windowId, {
        kind: "revoke",
        permissionId: f.review.permission.permissionId,
      });
      await vi.waitFor(() => expect(runtime.closeContext).toHaveBeenCalledOnce());
    } finally {
      await tools.close?.();
      account.close();
      await f.cleanup();
      await rm(heldFolder, { recursive: true, force: true });
    }
  },
);
