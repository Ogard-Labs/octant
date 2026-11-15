import type { CodeCheckoutId, CodeFileListingResult, CodeThreadId } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeFilesViewer, type CodeFilesViewerProps } from "./CodeFilesViewer";

const editorSave = vi.fn(async () => true);
const editorDiscard = vi.fn();

vi.mock("./useCodeEditorFile", () => ({
  useCodeEditorFile: (options: { readonly relativePath?: string }) => ({
    file: { path: options.relativePath, state: "available" },
    refresh: vi.fn(),
  }),
}));

vi.mock("./MonacoEditorPane", () => ({
  MonacoEditorPane: (props: {
    readonly file: { readonly path: string };
    readonly onDirtyChange?: (dirty: boolean) => void;
    readonly onRegisterActions?: (actions: unknown) => void;
    readonly onOpenInMainArea?: () => void;
  }) => (
    <section aria-label={`Code editor for ${props.file.path}`}>
      <button
        onClick={() => {
          props.onDirtyChange?.(true);
          props.onRegisterActions?.({ save: editorSave, discard: editorDiscard });
        }}
        type="button"
      >
        Edit {props.file.path}
      </button>
      <button onClick={props.onOpenInMainArea} type="button">
        Open {props.file.path} in main area
      </button>
    </section>
  ),
}));

const threadId = "00000000-0000-4000-8000-000000000911" as CodeThreadId;
const checkoutId = "00000000-0000-4000-8000-000000000912" as CodeCheckoutId;

function file(path: string, index: number) {
  return {
    kind: "file",
    fileId: `00000000-0000-4000-8000-00000000092${index}`,
    path,
    byteLength: 4,
    availability: { status: "available" },
  };
}

const listing = {
  status: "listed",
  listing: {
    kind: "code-file-listing",
    threadId,
    checkoutId,
    entries: [
      file("a.ts", 1),
      file("b.ts", 2),
      file("notes.md", 3),
      file("logo.png", 4),
      file("data.bin", 5),
    ],
    truncated: false,
    observedAt: "2026-08-14T08:00:00.000Z",
  },
} as unknown as CodeFileListingResult;

function mount(options: { readonly status?: ReadonlyArray<unknown> } = {}) {
  const onOpenInMainArea = vi.fn();
  const executeOperation = vi.fn(async () =>
    options.status === undefined
      ? { kind: "operation-failed", failure: { message: "unavailable" } }
      : { kind: "git-observed", status: options.status },
  );
  const view = {
    thread: { id: threadId, projectId: "p", executionPolicy: "full-access" },
    checkout: { id: checkoutId, kind: "worktree", head: { kind: "branch", name: "main" } },
  } as unknown as CodeFilesViewerProps["view"];
  render(
    <div>
      <p>Thread conversation</p>
      <CodeFilesViewer
        controller={
          {
            client: { executeOperation },
            conversation: [],
            editorDrafts: undefined,
            pendingDraft: "",
            setPendingDraft: vi.fn(),
          } as unknown as CodeFilesViewerProps["controller"]
        }
        explorer={{
          threadId,
          checkoutId,
          client: {
            list: vi.fn(async () => listing),
            watch: vi.fn(async function* () {}),
          } as never,
        }}
        onOpenInMainArea={onOpenInMainArea}
        view={view}
      />
    </div>,
  );
  return { onOpenInMainArea };
}

const tabNames = () => screen.queryAllByRole("tab").map((tab) => tab.textContent);

describe("CodeFilesViewer", () => {
  it("opens a clicked file beside the thread and never in the main area", async () => {
    const { onOpenInMainArea } = mount();
    await userEvent.click(await screen.findByRole("treeitem", { name: "a.ts" }));
    expect(await screen.findByRole("region", { name: "Code editor for a.ts" })).toBeVisible();
    expect(screen.getByText("Thread conversation")).toBeVisible();
    expect(onOpenInMainArea).not.toHaveBeenCalled();
  });

  it("replaces the preview tab on the next single click and keeps a double-clicked one", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("treeitem", { name: "a.ts" }));
    expect(tabNames()).toEqual(["a.ts, preview"]);
    await user.click(screen.getByRole("treeitem", { name: "b.ts" }));
    expect(tabNames()).toEqual(["b.ts, preview"]);
    await user.dblClick(screen.getByRole("treeitem", { name: "b.ts" }));
    expect(tabNames()).toEqual(["b.ts"]);
    await user.click(screen.getByRole("treeitem", { name: "notes.md" }));
    expect(tabNames()).toEqual(["b.ts", "notes.md, preview"]);
  });

  it("keeps a previewed file once it is edited", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("treeitem", { name: "a.ts" }));
    await user.click(await screen.findByRole("button", { name: "Edit a.ts" }));
    await user.click(screen.getByRole("treeitem", { name: "b.ts" }));
    expect(tabNames()).toEqual(["a.ts, unsaved changes", "b.ts, preview"]);
  });

  it("closes a tab and falls back to its neighbour", async () => {
    const user = userEvent.setup();
    mount();
    await user.dblClick(await screen.findByRole("treeitem", { name: "a.ts" }));
    await user.dblClick(screen.getByRole("treeitem", { name: "b.ts" }));
    await user.click(screen.getByRole("button", { name: "Close b.ts" }));
    expect(tabNames()).toEqual(["a.ts"]);
    expect(await screen.findByRole("region", { name: "Code editor for a.ts" })).toBeVisible();
  });

  it("offers the file as a workspace tab only from the file menu action", async () => {
    const user = userEvent.setup();
    const { onOpenInMainArea } = mount();
    await user.click(await screen.findByRole("treeitem", { name: "a.ts" }));
    await user.click(await screen.findByRole("button", { name: "Open a.ts in main area" }));
    expect(onOpenInMainArea).toHaveBeenCalledWith("a.ts");
  });

  it("hides and shows the file tree from the strip", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("treeitem", { name: "a.ts" });
    await user.click(screen.getByRole("button", { name: "Hide file tree" }));
    expect(screen.getByRole("button", { name: "Show file tree" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Files", hidden: true })).toBeInTheDocument();
  });

  it("draws each file by type and marks the changed ones", async () => {
    mount({ status: [{ path: "a.ts", index: " ", worktree: "M" }] });
    const kind = (name: string | RegExp) =>
      screen
        .getByRole("treeitem", { name })
        .querySelector("[data-file-kind]")
        ?.getAttribute("data-file-kind");
    await screen.findByRole("treeitem", { name: /^a\.ts/ });
    expect(kind(/^a\.ts/)).toBe("code");
    expect(kind("notes.md")).toBe("document");
    expect(kind("logo.png")).toBe("image");
    expect(kind("data.bin")).toBe("file");
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: "a.ts (modified)" })).toBeVisible(),
    );
    expect(screen.getByRole("treeitem", { name: "b.ts" })).toBeVisible();
  });

  describe("closing a file with unsaved edits", () => {
    async function openDirty() {
      const user = userEvent.setup();
      mount();
      await user.dblClick(await screen.findByRole("treeitem", { name: "a.ts" }));
      await user.click(await screen.findByRole("button", { name: "Edit a.ts" }));
      return user;
    }
    const closeA = (user: ReturnType<typeof userEvent.setup>) =>
      user.click(screen.getByRole("button", { name: "Close a.ts" }));

    it("closes a clean tab without asking", async () => {
      const user = userEvent.setup();
      mount();
      await user.dblClick(await screen.findByRole("treeitem", { name: "a.ts" }));
      await user.click(screen.getByRole("button", { name: "Close a.ts" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(tabNames()).toEqual([]);
    });

    it("marks the tab with a dot and asks before closing it", async () => {
      const user = await openDirty();
      expect(screen.getByTestId("tab-dirty-dot")).toBeInTheDocument();
      await closeA(user);
      expect(await screen.findByRole("dialog", { name: "Save changes to a.ts?" })).toBeVisible();
      expect(screen.getByText("Your edits will be lost if you don't save them.")).toBeVisible();
    });

    it("keeps the tab when the person cancels", async () => {
      editorSave.mockClear();
      const user = await openDirty();
      await closeA(user);
      await user.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(tabNames()).toHaveLength(1);
      expect(editorSave).not.toHaveBeenCalled();
    });

    it("saves and then closes the tab on Save", async () => {
      editorSave.mockClear();
      const user = await openDirty();
      await closeA(user);
      await user.click(await screen.findByRole("button", { name: "Save" }));
      await waitFor(() => expect(tabNames()).toEqual([]));
      expect(editorSave).toHaveBeenCalledTimes(1);
    });

    it("keeps the tab open when saving fails", async () => {
      editorSave.mockResolvedValueOnce(false);
      const user = await openDirty();
      await closeA(user);
      await user.click(await screen.findByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(tabNames()).toHaveLength(1);
    });

    it("drops the edits and closes the tab on Don't save", async () => {
      editorDiscard.mockClear();
      const user = await openDirty();
      await closeA(user);
      await user.click(await screen.findByRole("button", { name: "Don't save" }));
      await waitFor(() => expect(tabNames()).toEqual([]));
      expect(editorDiscard).toHaveBeenCalledTimes(1);
    });
  });
});
