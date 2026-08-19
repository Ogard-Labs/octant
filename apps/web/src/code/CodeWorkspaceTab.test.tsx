import type { CodeFileChangeNotice } from "@octant/contracts";
import type { WorkspaceTab } from "@octant/contracts/shell";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { codeClient, ids } from "./CodeDeliveryPane.test-fixtures";
import CodeWorkspaceTab from "./CodeWorkspaceTab";
import { nativeCodeWorkspaceApprovals } from "./codeWorkspaceApprovals";

/**
 * The editor engine only has to make the mounted text observable, so the tab's
 * wiring can be asserted on what the pane actually shows.
 */
const editor = vi.hoisted(() => ({ change: undefined as ((value: string) => void) | undefined }));
vi.mock("./monacoRuntime", () => ({
  mount: (
    element: HTMLElement,
    options: { readonly onChange: (value: string) => void; readonly value: string },
  ) => {
    editor.change = options.onChange;
    element.textContent = options.value;
    return {
      dispose: () => void (element.textContent = ""),
      focus: () => undefined,
      setReadOnly: () => undefined,
      setValue: (value: string) => void (element.textContent = value),
    };
  },
}));

/**
 * The host's watch transport is covered where it lives; this file only needs to
 * deliver a notice to the surface under test.
 */
const fileWatch = vi.hoisted(() => ({
  notify: undefined as ((notice: CodeFileChangeNotice) => void) | undefined,
}));
vi.mock("./useCodeFileChangeWatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useCodeFileChangeWatch")>()),
  useCodeFileChangeWatch: (options: { readonly onChanged: (n: CodeFileChangeNotice) => void }) => {
    fileWatch.notify = options.onChanged;
  },
}));

const view = {
  thread: { id: "10000000-0000-4000-8000-000000000001" },
  checkout: { id: "20000000-0000-4000-8000-000000000001" },
} as never;
const operationId = "30000000-0000-4000-8000-000000000001" as never;
const approvalId = "40000000-0000-4000-8000-000000000001";

describe("native Code workspace approvals", () => {
  it("maps each pane to an exact native-host operation request", async () => {
    const requestCodeOperationApproval = vi.fn(async () => approvalId);
    const approvals = nativeCodeWorkspaceApprovals({ requestCodeOperationApproval } as never, view);
    const terminal = {
      kind: "start-terminal",
      threadId: "10000000-0000-4000-8000-000000000001",
      checkoutId: "20000000-0000-4000-8000-000000000001",
      operationId,
      terminalId: "50000000-0000-4000-8000-000000000001",
      columns: 100,
      rows: 30,
      credentialRefs: [],
    } as never;
    expect(await approvals?.git?.(terminal)).toBe(approvalId);
    expect(await approvals?.pullRequest?.(terminal)).toBe(approvalId);
    expect(requestCodeOperationApproval.mock.calls).toEqual([
      [{ effect: { kind: "operation", command: terminal } }],
      [{ effect: { kind: "operation", command: terminal } }],
    ]);
  });

  it("keeps approval unavailable without the native host bridge", () => {
    expect(nativeCodeWorkspaceApprovals(undefined, view)).toBeUndefined();
  });
});

/**
 * The Tests tab is only usable when the host's discovered definitions reach the
 * pane. Nothing else in the renderer may invent one.
 */
describe("CodeWorkspaceTab repository tests", () => {
  it("hands the Tests pane the definitions the host discovered", async () => {
    const client = codeClient();
    render(<CodeWorkspaceTab controller={controller(client)} tab={testTab()} />);

    expect(await screen.findByRole("button", { name: "Run Web tests" })).toBeVisible();
    expect(client.listTests).toHaveBeenCalledWith(ids.thread, ids.checkout);
  });

  it("keeps the tests unavailable when the host answers nothing", async () => {
    const client = codeClient();
    (client.listTests as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unavailable"));
    render(<CodeWorkspaceTab controller={controller(client)} tab={testTab()} />);

    expect(
      await screen.findByRole("heading", { name: "Repository tests unavailable" }),
    ).toBeVisible();
  });

  it("does not read the checkout for a tab that is not the Tests surface", () => {
    const client = codeClient();
    render(
      <CodeWorkspaceTab
        controller={controller(client)}
        tab={{
          ...testTab(),
          kind: "code-file",
          title: "README.md",
          relativePath: "README.md" as never,
        }}
      />,
    );

    expect(client.listTests).not.toHaveBeenCalled();
  });
});

/**
 * A code-file tab is only usable when the host's authoritative open answer
 * reaches the editor pane. The renderer never invents file content.
 */
describe("CodeWorkspaceTab code files", () => {
  it("opens the selected file through the host and renders the editor surface", async () => {
    const client = codeClient();
    render(<CodeWorkspaceTab controller={controller(client)} tab={fileTab()} />);

    expect(await screen.findByLabelText("Code editor for src/index.ts")).toBeVisible();
    expect(client.openFile).toHaveBeenCalledWith(ids.thread, ids.checkout, "src/index.ts");
  });

  it("keeps the file honestly unavailable when the host refuses to open it", async () => {
    const client = codeClient();
    (client.openFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unauthorized"));
    render(<CodeWorkspaceTab controller={controller(client)} tab={fileTab()} />);

    expect(
      await screen.findByRole("heading", { name: "src/index.ts is unavailable" }),
    ).toBeVisible();
  });

  it("renders the host's read-only answer instead of an editable surface", async () => {
    const client = codeClient();
    (client.openFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "read-only",
      fileId: ids.file as never,
      metadata: {
        identity: { device: "1", inode: "2" },
        byteLength: 7,
        modifiedNanoseconds: "3",
        digest: "d".repeat(64),
      },
      reason: "binary",
    });
    render(<CodeWorkspaceTab controller={controller(client)} tab={fileTab()} />);

    expect(await screen.findByText("Binary files are read-only.")).toBeVisible();
  });

  // Plan mode is read-only, so it has to take effect when the thread enters it
  // — not when the next open happens to answer. A stalled request used to leave
  // the previous writable projection, Save included, on screen. The unsaved
  // draft has to survive that: it is the user's work, and the revision it was
  // based on is what makes a later external change a conflict.
  it("stops offering Save the moment the thread enters Plan mode, and keeps the draft", async () => {
    const client = codeClient();
    const view = render(<CodeWorkspaceTab controller={controller(client)} tab={fileTab()} />);
    expect(await screen.findByText("const answer = 42;")).toBeVisible();
    act(() => editor.change?.("my unsaved draft"));
    expect(await screen.findByText("Unsaved changes")).toBeVisible();

    vi.mocked(client.openFile).mockReturnValue(new Promise(() => undefined));
    view.rerender(
      <CodeWorkspaceTab controller={controller(client, undefined, "plan")} tab={fileTab()} />,
    );

    expect(await screen.findByText("Plan · read-only")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save src/index.ts" })).toBeNull();

    // Back under Full access, the same draft saves against the revision it was
    // written on. A remount would have re-read the file and anchored the save
    // to whatever is on disk by then, overwriting an outside edit silently.
    view.rerender(<CodeWorkspaceTab controller={controller(client)} tab={fileTab()} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Save src/index.ts" }));

    expect(client.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedDigest: "d".repeat(64), text: "my unsaved draft" }),
    );
  });

  it("re-opens the file through the host when the conflict action reloads it", async () => {
    const client = codeClient();
    vi.mocked(client.openFile)
      .mockResolvedValueOnce(openedFile(ids.content, "d".repeat(64)))
      .mockResolvedValue(openedFile(reloadedContentId, "e".repeat(64)));
    vi.mocked(client.content).mockImplementation(async (contentId) =>
      new TextEncoder().encode(
        contentId === reloadedContentId ? "reloaded from disk" : "staged before the edit",
      ),
    );
    vi.mocked(client.save).mockResolvedValue({ status: "conflict" } as never);
    const drafts = draftStore("my unsaved draft");
    render(<CodeWorkspaceTab controller={controller(client, drafts)} tab={fileTab()} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save src/index.ts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file changed outside this editor.",
    );

    await user.click(screen.getByRole("button", { name: "Discard draft and reload" }));

    expect(await screen.findByText("reloaded from disk")).toBeVisible();
    expect(client.openFile).toHaveBeenCalledTimes(2);
    expect(client.openFile).toHaveBeenLastCalledWith(ids.thread, ids.checkout, "src/index.ts");
    expect(client.content).toHaveBeenLastCalledWith(reloadedContentId);

    act(() => editor.change?.("edited after the reload"));
    await user.click(await screen.findByRole("button", { name: "Save src/index.ts" }));
    expect(client.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedDigest: "e".repeat(64), text: "edited after the reload" }),
    );
  });

  it("reloads a clean editor when the host reports that file changed", async () => {
    const client = codeClient();
    vi.mocked(client.openFile)
      .mockResolvedValueOnce(openedFile(ids.content, "d".repeat(64)))
      .mockResolvedValue(openedFile(reloadedContentId, "e".repeat(64)));
    vi.mocked(client.content).mockImplementation(async (contentId) =>
      new TextEncoder().encode(
        contentId === reloadedContentId ? "changed on disk" : "opened before the edit",
      ),
    );
    render(<CodeWorkspaceTab controller={controller(client)} tab={fileTab()} />);

    expect(await screen.findByText("opened before the edit")).toBeVisible();
    act(() => fileWatch.notify?.({ paths: ["src/index.ts"], truncated: false } as never));

    expect(await screen.findByText("changed on disk")).toBeVisible();
    expect(client.openFile).toHaveBeenCalledTimes(2);
  });

  it("reloads a clean editor when a truncated notice cannot name every change", async () => {
    const client = codeClient();
    vi.mocked(client.openFile)
      .mockResolvedValueOnce(openedFile(ids.content, "d".repeat(64)))
      .mockResolvedValue(openedFile(reloadedContentId, "e".repeat(64)));
    vi.mocked(client.content).mockImplementation(async (contentId) =>
      new TextEncoder().encode(
        contentId === reloadedContentId ? "checked out on disk" : "opened before the checkout",
      ),
    );
    render(<CodeWorkspaceTab controller={controller(client)} tab={fileTab()} />);

    expect(await screen.findByText("opened before the checkout")).toBeVisible();
    act(() => fileWatch.notify?.({ paths: [], truncated: true } as never));

    expect(await screen.findByText("checked out on disk")).toBeVisible();
    expect(client.openFile).toHaveBeenCalledTimes(2);
  });

  it("reloads a clean editor when the host names the directory that holds the file", async () => {
    const client = codeClient();
    vi.mocked(client.openFile)
      .mockResolvedValueOnce(openedFile(ids.content, "d".repeat(64)))
      .mockResolvedValue(openedFile(reloadedContentId, "e".repeat(64)));
    vi.mocked(client.content).mockImplementation(async (contentId) =>
      new TextEncoder().encode(
        contentId === reloadedContentId ? "directory changed on disk" : "opened before the rename",
      ),
    );
    render(<CodeWorkspaceTab controller={controller(client)} tab={fileTab()} />);

    expect(await screen.findByText("opened before the rename")).toBeVisible();
    act(() => fileWatch.notify?.({ paths: ["src"], truncated: false } as never));

    expect(await screen.findByText("directory changed on disk")).toBeVisible();
    expect(client.openFile).toHaveBeenCalledTimes(2);
  });

  it("does not reopen a file the notice does not concern", async () => {
    const client = codeClient();
    render(<CodeWorkspaceTab controller={controller(client)} tab={fileTab()} />);

    expect(await screen.findByText("const answer = 42;")).toBeVisible();
    act(() => fileWatch.notify?.({ paths: ["README.md"], truncated: false } as never));

    expect(client.openFile).toHaveBeenCalledTimes(1);
  });

  it("reports a watched external change as a conflict instead of saving over it", async () => {
    const client = codeClient();
    vi.mocked(client.openFile)
      .mockResolvedValueOnce(openedFile(ids.content, "d".repeat(64)))
      .mockResolvedValue(openedFile(reloadedContentId, "e".repeat(64)));
    vi.mocked(client.content).mockImplementation(async (contentId) =>
      new TextEncoder().encode(
        contentId === reloadedContentId ? "changed on disk" : "opened before the edit",
      ),
    );
    vi.mocked(client.save).mockResolvedValue({ status: "conflict" } as never);
    render(<CodeWorkspaceTab controller={controller(client)} tab={fileTab()} />);

    await screen.findByText("opened before the edit");
    act(() => editor.change?.("my unsaved draft"));
    act(() => fileWatch.notify?.({ paths: ["src/index.ts"], truncated: false } as never));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A new external revision is available.",
    );

    // The draft still belongs to the revision the user opened, so the save
    // carries that revision and the host refuses it. Adopting the external
    // digest here would overwrite the change nobody has looked at yet.
    await userEvent.setup().click(screen.getByRole("button", { name: "Save src/index.ts" }));
    expect(client.save).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDigest: "d".repeat(64), text: "my unsaved draft" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file changed outside this editor.",
    );
  });

  it("keeps the file honestly unavailable when the reload cannot re-open it", async () => {
    const client = codeClient();
    vi.mocked(client.openFile)
      .mockResolvedValueOnce(openedFile(ids.content, "d".repeat(64)))
      .mockRejectedValue(new Error("unauthorized"));
    vi.mocked(client.content).mockResolvedValue(new TextEncoder().encode("staged before the edit"));
    vi.mocked(client.save).mockResolvedValue({ status: "conflict" } as never);
    const drafts = draftStore("my unsaved draft");
    render(<CodeWorkspaceTab controller={controller(client, drafts)} tab={fileTab()} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save src/index.ts" }));
    await screen.findByRole("button", { name: "Discard draft and reload" });
    await user.click(screen.getByRole("button", { name: "Discard draft and reload" }));

    expect(
      await screen.findByRole("heading", { name: "src/index.ts is unavailable" }),
    ).toBeVisible();
    expect(screen.queryByText("staged before the edit")).not.toBeInTheDocument();
  });
});

const reloadedContentId = "e0000000-0000-4000-8000-000000000001";

function openedFile(contentId: string, digest: string) {
  return {
    status: "editable" as const,
    fileId: ids.file as never,
    metadata: {
      identity: { device: "1", inode: "2" },
      byteLength: 22,
      modifiedNanoseconds: "3",
      digest,
    } as never,
    content: { contentId, digest, byteLength: 22 } as never,
  };
}

/** The pane restores its draft under the checkout-scoped model key. */
function draftStore(draft: string) {
  const values = new Map<string, string>([[`octant-code://${ids.checkout}/${ids.file}`, draft]]);
  return {
    clear: (key: string) => void values.delete(key),
    read: (key: string) => values.get(key),
    write: (key: string, value: string) => void values.set(key, value),
  };
}

function fileTab() {
  return {
    ...testTab(),
    kind: "code-file",
    title: "src/index.ts",
    relativePath: "src/index.ts" as never,
  } as Extract<WorkspaceTab, { readonly mode: "code" }>;
}

function testTab() {
  return {
    id: "d0000000-0000-4000-8000-000000000001",
    kind: "code-test",
    mode: "code",
    threadId: ids.thread,
    title: "Tests",
  } as Extract<WorkspaceTab, { readonly mode: "code" }>;
}

function controller(
  client: ReturnType<typeof codeClient>,
  editorDrafts?: ReturnType<typeof draftStore>,
  executionPolicy: "full-access" | "plan" = "full-access",
) {
  return {
    client,
    ...(editorDrafts === undefined ? {} : { editorDrafts }),
    activeView: {
      checkout: {
        id: ids.checkout,
        repositoryId: "c0000000-0000-4000-8000-000000000001",
        kind: "existing-worktree",
        availability: "available",
        head: { kind: "branch", name: "feature/tests", oid: "a".repeat(40) },
        observedAt: "2026-08-15T08:00:00.000Z",
      },
      thread: {
        id: ids.thread,
        checkoutId: ids.checkout,
        executionPolicy,
        lifecycle: "active",
        title: "Tests",
      },
      lastSequence: 1,
    },
    conversation: [],
    followUps: new Map(),
    status: "ready",
    turnStatus: "idle",
  } as never;
}
