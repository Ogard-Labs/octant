import { createWorkspaceViewStore, WorkspaceViewStateContext } from "../shell/workspaceViewState";
import type { CodeClient } from "@octant/client-runtime/code-client";
import {
  MAX_CODE_DEBUG_BREAKPOINT_FILES,
  MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE,
} from "@octant/contracts/code-debug";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  confirmFilesClose,
  filesClosePromptSnapshot,
  filesCloseScope,
  modelUri,
} from "./filesCloseGuard";
import type { MonacoAdapterRuntime } from "./MonacoEditorAdapter";
import { MonacoEditorPane, type CodeEditorFileProjection } from "./MonacoEditorPane";
import { codeDebugThreadKey, codeDebugWindowState } from "../debug/codeDebugWindowState";
import { CodeDebugWindowState, fileBreakpoints } from "../debug/codeDebugWindowState";
import { CodeDebugWindowStoreContext } from "../debug/CodeDebugWindowProvider";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodeCodeFileMetadata } from "@octant/contracts/code";

const codeStyles = readFileSync(resolve(import.meta.dirname, "../styles/code.css"), "utf8");

describe("MonacoEditorPane", () => {
  it("restores the cursor and scroll for the same file version without saving, and drops the position on a changed file", async () => {
    const namespace = `editor-view-${crypto.randomUUID()}`;
    const store = createWorkspaceViewStore(namespace);
    const file = textFile();
    const code = client();
    const first = runtime();
    const mounted = render(
      <WorkspaceViewStateContext.Provider value={store}>
        <MonacoEditorPane client={code} file={file} loadRuntime={first.loadRuntime} />
      </WorkspaceViewStateContext.Provider>,
    );
    await waitFor(() => expect(first.options).toBeDefined());
    act(() =>
      first.options?.onViewState?.({ lineNumber: 12, column: 4, scrollTop: 300, scrollLeft: 5 }),
    );
    mounted.unmount();
    store.flush();
    const restored = createWorkspaceViewStore(namespace);
    const next = runtime();
    const reopened = render(
      <WorkspaceViewStateContext.Provider value={restored}>
        <MonacoEditorPane client={code} file={file} loadRuntime={next.loadRuntime} />
      </WorkspaceViewStateContext.Provider>,
    );
    await waitFor(() =>
      expect(next.options?.viewState).toMatchObject({
        lineNumber: 12,
        column: 4,
        scrollTop: 300,
        scrollLeft: 5,
      }),
    );
    expect(code.save).not.toHaveBeenCalled();
    reopened.unmount();
    const changed = runtime();
    render(
      <WorkspaceViewStateContext.Provider value={restored}>
        <MonacoEditorPane
          client={code}
          file={{
            ...file,
            metadata: decodeCodeFileMetadata({ ...file.metadata, digest: "b".repeat(64) }),
          }}
          loadRuntime={changed.loadRuntime}
        />
      </WorkspaceViewStateContext.Provider>,
    );
    await waitFor(() => expect(changed.options).toBeDefined());
    expect(changed.options?.viewState).toBeUndefined();
    expect(code.save).not.toHaveBeenCalled();
  });

  it("persists actual gutter selections and shows changed restored locations unresolved rather than moving them", async () => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return values.size;
      },
      key: (index) => [...values.keys()][index] ?? null,
      clear: () => values.clear(),
      getItem: (name) => values.get(name) ?? null,
      setItem: (name, value) => {
        values.set(name, value);
      },
      removeItem: (name) => {
        values.delete(name);
      },
    };
    const scope = {
      origin: "http://127.0.0.1:13773",
      windowId: "40000000-0000-4000-8000-000000000001",
      storage,
    };
    const projectId = decodeProjectId("50000000-0000-4000-8000-000000000001");
    const first = new CodeDebugWindowState(scope);
    const firstRuntime = runtime();
    const file = textFile();
    const mounted = render(
      <CodeDebugWindowStoreContext.Provider value={first}>
        <MonacoEditorPane
          debugProjectId={projectId}
          client={client({ text: "first\nsecond\nthird\n" })}
          file={file}
          loadRuntime={firstRuntime.loadRuntime}
        />
      </CodeDebugWindowStoreContext.Provider>,
    );
    await waitFor(() => expect(firstRuntime.options?.onToggleBreakpoint).toBeDefined());
    act(() => firstRuntime.options?.onToggleBreakpoint?.(3));
    const key = codeDebugThreadKey(ids.thread, ids.checkout);
    await waitFor(() =>
      expect(firstRuntime.setDebugDecorations).toHaveBeenLastCalledWith({ breakpoints: [3] }),
    );
    mounted.unmount();
    const restored = new CodeDebugWindowState(scope);
    expect(restored.read(key).breakpoints.get(file.path)).toEqual([3]);
    expect(restored.read(key).session).toBeUndefined();
    const nextRuntime = runtime();
    const changedMetadata = decodeCodeFileMetadata({ ...file.metadata, digest: "b".repeat(64) });
    render(
      <CodeDebugWindowStoreContext.Provider value={restored}>
        <MonacoEditorPane
          debugProjectId={projectId}
          client={client({ text: "changed\nsecond\nthird\n" })}
          file={{
            ...file,
            metadata: changedMetadata,
            content: { ...file.content, digest: changedMetadata.digest },
          }}
          loadRuntime={nextRuntime.loadRuntime}
        />
      </CodeDebugWindowStoreContext.Provider>,
    );
    await waitFor(() =>
      expect(nextRuntime.setDebugDecorations).toHaveBeenLastCalledWith({
        breakpoints: [],
        unresolvedBreakpoints: [3],
      }),
    );
    expect(restored.read(key).breakpointFiles?.get(file.path)?.reason).toBe("changed");
    act(() => nextRuntime.options?.onToggleBreakpoint?.(3));
    expect(new CodeDebugWindowState(scope).read(key).breakpoints.size).toBe(0);
  });

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ] as const)(
    "releases only a discarded pane dirty hold, retained draft=%s shared store=%s",
    async (retainDraft, sharedStore) => {
      const values = new Map<string, string>();
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
        removeItem: (key: string) => {
          values.delete(key);
        },
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() {
          return values.size;
        },
      };
      const store = new CodeDebugWindowState({
        origin: "http://localhost:13773",
        windowId: "window-1",
        storage,
      });
      const draftValues = new Map<string, string>();
      const drafts = {
        read: (key: string) => draftValues.get(key),
        write: (key: string, value: string) => {
          draftValues.set(key, value);
        },
        clear: (key: string) => {
          draftValues.delete(key);
        },
      };
      const projectId = decodeProjectId("50000000-0000-4000-8000-000000000001");
      const file = textFile();
      const first = runtime();
      const code = client();
      const pane = render(
        <CodeDebugWindowStoreContext.Provider value={store}>
          <MonacoEditorPane
            debugProjectId={projectId}
            client={code}
            file={file}
            loadRuntime={first.loadRuntime}
            {...(retainDraft ? { draftStore: drafts } : {})}
          />
        </CodeDebugWindowStoreContext.Provider>,
      );
      await waitFor(() => expect(first.options?.onToggleBreakpoint).toBeDefined());
      act(() => first.options?.onToggleBreakpoint?.(1));
      act(() => first.options?.onChange("unsaved changes"));
      const key = codeDebugThreadKey(ids.thread, ids.checkout);
      await waitFor(() =>
        expect(store.read(key).breakpointFiles?.get(file.path)?.reason).toBe("unsaved"),
      );
      const clean = runtime();
      const other = render(
        <CodeDebugWindowStoreContext.Provider value={store}>
          <MonacoEditorPane
            debugProjectId={projectId}
            client={code}
            file={file}
            loadRuntime={clean.loadRuntime}
            {...(sharedStore ? { draftStore: drafts } : {})}
          />
        </CodeDebugWindowStoreContext.Provider>,
      );
      await waitFor(() => expect(clean.options).toBeDefined());
      if (sharedStore) act(() => clean.options?.onChange("const answer = 42;\n"));
      expect(store.reacceptFile(key, file.path)).toBe(false);
      // The clean pane must not turn another pane's live dirty draft into
      // adapter-ready locations merely by adding another gutter breakpoint.
      act(() => clean.options?.onToggleBreakpoint?.(2));
      expect(store.read(key).breakpointFiles?.get(file.path)?.reason).toBe("unsaved");
      expect(fileBreakpoints(store.read(key))).toEqual([]);
      pane.unmount();
      const read = {
        projectId,
        fileId: file.fileId,
        metadata: file.metadata,
        lineCount: 4,
        clean: true,
      };
      act(() => store.observeFile(key, file.path, read));
      expect(store.reacceptFile(key, file.path)).toBe(!retainDraft || sharedStore);
      if (retainDraft && !sharedStore) {
        draftValues.clear();
        act(() => store.observeFile(key, file.path, read));
        expect(store.reacceptFile(key, file.path)).toBe(true);
      }
      other.unmount();
    },
  );
  it("sets a breakpoint from the gutter for the thread's debugging and marks the line the program stopped on", async () => {
    const fixture = runtime();
    render(
      <MonacoEditorPane client={client()} file={textFile()} loadRuntime={fixture.loadRuntime} />,
    );
    await waitFor(() => expect(fixture.options?.onToggleBreakpoint).toBeDefined());
    const key = codeDebugThreadKey(ids.thread, ids.checkout);

    act(() => fixture.options?.onToggleBreakpoint?.(3));
    expect(codeDebugWindowState.read(key).breakpoints.get("src/index.ts" as never)).toEqual([3]);
    await waitFor(() =>
      expect(fixture.setDebugDecorations).toHaveBeenLastCalledWith({ breakpoints: [3] }),
    );
    // The panel's launch file proposals read the editor's current file.
    expect(codeDebugWindowState.read(key).currentFile).toBe("src/index.ts");

    act(() => codeDebugWindowState.setStopped(key, { path: "src/index.ts" as never, line: 3 }));
    await waitFor(() =>
      expect(fixture.setDebugDecorations).toHaveBeenLastCalledWith({
        breakpoints: [3],
        stoppedLine: 3,
      }),
    );
    act(() => codeDebugWindowState.setStopped(key, undefined));
    act(() => fixture.options?.onToggleBreakpoint?.(3));
    await waitFor(() =>
      expect(fixture.setDebugDecorations).toHaveBeenLastCalledWith({ breakpoints: [] }),
    );
  });

  it("says why a gutter breakpoint was not set once the file, or the thread's files, hold as many as a session takes", async () => {
    const fixture = runtime();
    render(
      <MonacoEditorPane client={client()} file={textFile()} loadRuntime={fixture.loadRuntime} />,
    );
    await waitFor(() => expect(fixture.options?.onToggleBreakpoint).toBeDefined());
    const key = codeDebugThreadKey(ids.thread, ids.checkout);
    const path = "src/index.ts" as never;
    const others = Array.from({ length: MAX_CODE_DEBUG_BREAKPOINT_FILES }, (_, index) => {
      return `src/other-${index}.ts` as never;
    });
    try {
      act(() => {
        for (let line = 1; line <= MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE; line += 1) {
          codeDebugWindowState.toggleBreakpoint(key, path, line);
        }
      });
      act(() => fixture.options?.onToggleBreakpoint?.(MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE + 1));
      expect(
        await screen.findByText(
          "This file already has 256 breakpoints, the most a debug session takes. Remove one to add another.",
        ),
      ).toBeVisible();
      expect(codeDebugWindowState.read(key).breakpoints.get(path)).toHaveLength(256);
      // A toggle that is taken clears the notice.
      act(() => fixture.options?.onToggleBreakpoint?.(1));
      expect(screen.queryByText(/the most a debug session takes/)).not.toBeInTheDocument();

      act(() => {
        for (let line = 2; line <= MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE; line += 1) {
          codeDebugWindowState.toggleBreakpoint(key, path, line);
        }
        for (const other of others) codeDebugWindowState.toggleBreakpoint(key, other, 1);
      });
      act(() => fixture.options?.onToggleBreakpoint?.(4));
      expect(
        await screen.findByText(
          "Breakpoints are already set in 64 files, the most a debug session takes. Clear another file's breakpoints to set one here.",
        ),
      ).toBeVisible();
      expect(codeDebugWindowState.read(key).breakpoints.has(path)).toBe(false);
    } finally {
      act(() => {
        for (const other of others) codeDebugWindowState.toggleBreakpoint(key, other, 1);
        for (const line of codeDebugWindowState.read(key).breakpoints.get(path) ?? []) {
          codeDebugWindowState.toggleBreakpoint(key, path, line);
        }
      });
    }
  });

  it("offers an explicit external-editor handoff when the desktop host provides it", async () => {
    const open = vi.fn(async () => undefined);
    render(
      <MonacoEditorPane
        client={client()}
        file={textFile()}
        loadRuntime={runtime().loadRuntime}
        onOpenExternalEditor={open}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Open src/index.ts externally" }));
    expect(open).toHaveBeenCalledOnce();
  });

  it("loads content into an opaque Monaco model and saves the exact observed file", async () => {
    const fixture = runtime();
    const code = client();
    render(<MonacoEditorPane client={code} file={textFile()} loadRuntime={fixture.loadRuntime} />);

    await screen.findByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => {
      expect(code.content).toHaveBeenCalledWith(ids.content);
      expect(fixture.options?.modelUri).toBe(`octant-code://${ids.checkout}/${ids.file}`);
    });
    expect(fixture.options?.modelUri).not.toContain("src/index.ts");

    act(() => fixture.options?.onChange("const answer = 43;\n"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Save src/index.ts" }));
    await waitFor(() =>
      expect(code.save).toHaveBeenCalledWith({
        threadId: ids.thread,
        checkoutId: ids.checkout,
        path: "src/index.ts",
        expectedIdentity: metadata.identity,
        expectedDigest: metadata.digest,
        text: "const answer = 43;\n",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saved");

    act(() => fixture.options?.onChange("temporary edit"));
    act(() => fixture.options?.onChange("const answer = 43;\n"));
    // Nothing left to save: the button leaves rather than standing disabled.
    expect(screen.queryByRole("button", { name: "Save src/index.ts" })).not.toBeInTheDocument();
  });

  it("handles the platform save shortcut and keeps Plan mode read-only", async () => {
    const editableRuntime = runtime();
    const editableClient = client();
    const { rerender } = render(
      <MonacoEditorPane
        client={editableClient}
        file={textFile()}
        loadRuntime={editableRuntime.loadRuntime}
      />,
    );
    const editor = await screen.findByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => expect(editableRuntime.options).toBeDefined());
    act(() => editableRuntime.options?.onChange("saved by keyboard"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save src/index.ts" })).toBeEnabled(),
    );
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await waitFor(() => expect(editableClient.save).toHaveBeenCalledOnce());

    const planRuntime = runtime();
    rerender(
      <MonacoEditorPane
        client={client()}
        file={{ ...textFile(), executionPolicy: "plan" }}
        loadRuntime={planRuntime.loadRuntime}
      />,
    );
    await waitFor(() => expect(planRuntime.options?.readOnly).toBe(true));
    expect(screen.getByText("Plan · read-only")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();

    // The user's own edits are their approval: approval-gated stays writable.
    const gatedRuntime = runtime();
    rerender(
      <MonacoEditorPane
        client={client()}
        file={{ ...textFile(), executionPolicy: "approval-gated" }}
        loadRuntime={gatedRuntime.loadRuntime}
      />,
    );
    await waitFor(() => expect(gatedRuntime.options?.readOnly).toBe(false));
    expect(screen.queryByText(/read-only/)).not.toBeInTheDocument();
    act(() => gatedRuntime.options?.onChange("edited under approval"));
    expect(screen.getByRole("button", { name: "Save src/index.ts" })).toBeInTheDocument();
  });

  it("keeps edits made while a save is in flight dirty and saveable", async () => {
    const fixture = runtime();
    const code = client();
    let completeSave!: (value: unknown) => void;
    vi.mocked(code.save).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        }) as never,
    );
    render(<MonacoEditorPane client={code} file={textFile()} loadRuntime={fixture.loadRuntime} />);
    await screen.findByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => expect(fixture.options).toBeDefined());

    act(() => fixture.options?.onChange("first edit"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Save src/index.ts" }));
    await waitFor(() => expect(code.save).toHaveBeenCalledOnce());
    act(() => fixture.options?.onChange("edit made during save"));
    act(() =>
      completeSave({
        status: "completed",
        metadata: { ...metadata, digest: "c".repeat(64) },
      }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent("New edits remain unsaved");
    expect(screen.getByRole("button", { name: "Save src/index.ts" })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Save src/index.ts" }));
    expect(code.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "edit made during save", expectedDigest: "c".repeat(64) }),
    );
  });

  it("preserves the user draft when a save conflicts or an external revision arrives", async () => {
    const fixture = runtime();
    const code = client();
    const onRequestRefresh = vi.fn();
    const { rerender } = render(
      <MonacoEditorPane
        client={code}
        file={textFile()}
        loadRuntime={fixture.loadRuntime}
        onRequestRefresh={onRequestRefresh}
      />,
    );
    await screen.findByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => expect(fixture.options).toBeDefined());
    act(() => fixture.options?.onChange("my unsaved draft"));
    const externalClient = client({ text: "external revision" });
    rerender(
      <MonacoEditorPane
        client={externalClient}
        file={{
          ...textFile(),
          content: { ...textFile().content, contentId: ids.externalContent as never },
          metadata: { ...metadata, digest: "b".repeat(64) as never },
        }}
        loadRuntime={fixture.loadRuntime}
        onRequestRefresh={onRequestRefresh}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("new external revision");
    expect(fixture.setValue).not.toHaveBeenCalledWith("external revision");
    await userEvent.setup().click(screen.getByRole("button", { name: "Discard draft and reload" }));
    expect(onRequestRefresh).toHaveBeenCalledOnce();
    await waitFor(() => expect(fixture.options?.value).toBe("external revision"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a dirty draft and an explicit retry when the save transport disconnects", async () => {
    const fixture = runtime();
    const code = client();
    vi.mocked(code.save).mockRejectedValueOnce({
      category: "disconnected",
      message: "Connection lost.",
    });
    render(<MonacoEditorPane client={code} file={textFile()} loadRuntime={fixture.loadRuntime} />);

    await screen.findByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => expect(fixture.options).toBeDefined());
    act(() => fixture.options?.onChange("draft kept while disconnected"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Save src/index.ts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Octant is disconnected. Your draft remains in this editor; reconnect and retry save.",
    );
    expect(screen.getByRole("button", { name: "Save src/index.ts" })).toBeEnabled();
  });

  it("restores a dirty draft after the split tree remounts the file pane", async () => {
    const values = new Map<string, string>();
    const draftStore = {
      clear: (key: string) => values.delete(key),
      read: (key: string) => values.get(key),
      write: (key: string, value: string) => values.set(key, value),
    };
    const firstRuntime = runtime();
    const first = render(
      <MonacoEditorPane
        client={client()}
        draftStore={draftStore}
        file={textFile()}
        loadRuntime={firstRuntime.loadRuntime}
      />,
    );
    await screen.findByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => expect(firstRuntime.options).toBeDefined());
    act(() => firstRuntime.options?.onChange("draft survives pane movement"));
    first.unmount();

    const restoredRuntime = runtime();
    render(
      <MonacoEditorPane
        client={client()}
        draftStore={draftStore}
        file={textFile()}
        loadRuntime={restoredRuntime.loadRuntime}
      />,
    );

    await waitFor(() =>
      expect(restoredRuntime.options?.value).toBe("draft survives pane movement"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  });

  it("still answers for a Files draft after its editor unmounts, saving on the revision it was based on", async () => {
    const scope = filesCloseScope(undefined, ids.thread);
    const values = new Map<string, string>();
    const draftStore = {
      clear: (key: string) => values.delete(key),
      read: (key: string) => values.get(key),
      write: (key: string, value: string) => values.set(key, value),
    };
    const code = client();
    const fixture = runtime();
    const mounted = render(
      <MonacoEditorPane
        client={code}
        draftStore={draftStore}
        file={textFile()}
        filesCloseScope={scope}
        loadRuntime={fixture.loadRuntime}
      />,
    );
    await screen.findByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => expect(fixture.options).toBeDefined());
    act(() => fixture.options?.onChange("draft survives the viewer"));
    mounted.unmount();

    const draftKey = modelUri(ids.checkout as never, ids.file as never);
    expect(values.get(draftKey)).toBe("draft survives the viewer");

    let confirmed!: Promise<boolean>;
    await act(async () => {
      confirmed = confirmFilesClose(scope);
    });
    await vi.waitFor(() => expect(filesClosePromptSnapshot()?.name).toBe("index.ts"));
    let closed!: boolean;
    await act(async () => {
      filesClosePromptSnapshot()?.answer("save");
      closed = await confirmed;
    });
    expect(closed).toBe(true);
    expect(code.save).toHaveBeenCalledWith({
      threadId: ids.thread,
      checkoutId: ids.checkout,
      path: "src/index.ts",
      expectedIdentity: metadata.identity,
      expectedDigest: metadata.digest,
      text: "draft survives the viewer",
    });
    expect(values.get(draftKey)).toBeUndefined();
    expect(values.get(`${draftKey}:base`)).toBeUndefined();
  });

  it("refuses the close and keeps the newer draft that arrived under a detached save", async () => {
    const scope = filesCloseScope(undefined, ids.thread);
    const values = new Map<string, string>();
    const draftStore = {
      clear: (key: string) => values.delete(key),
      read: (key: string) => values.get(key),
      write: (key: string, value: string) => values.set(key, value),
    };
    const code = client();
    let completeSave!: (value: unknown) => void;
    vi.mocked(code.save).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        }) as never,
    );
    const fixture = runtime();
    const mounted = render(
      <MonacoEditorPane
        client={code}
        draftStore={draftStore}
        file={textFile()}
        filesCloseScope={scope}
        loadRuntime={fixture.loadRuntime}
      />,
    );
    await screen.findByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => expect(fixture.options).toBeDefined());
    act(() => fixture.options?.onChange("first draft"));
    mounted.unmount();

    const draftKey = modelUri(ids.checkout as never, ids.file as never);
    let confirmed!: Promise<boolean>;
    await act(async () => {
      confirmed = confirmFilesClose(scope);
    });
    await vi.waitFor(() => expect(filesClosePromptSnapshot()?.name).toBe("index.ts"));
    await act(async () => {
      filesClosePromptSnapshot()?.answer("save");
    });
    await waitFor(() => expect(code.save).toHaveBeenCalledOnce());
    // A remounted editor wrote its newer draft while the detached save ran.
    draftStore.write(draftKey, "newer draft text");
    await act(async () => {
      completeSave({ status: "completed", metadata: { ...metadata, digest: "c".repeat(64) } });
    });
    // The consent covered the draft that was sent, not this one: the close is
    // refused and the newer draft is asked about on its own.
    await vi.waitFor(() =>
      expect(filesClosePromptSnapshot()?.failure).toBe(
        "index.ts could not be saved. Your edits are still here.",
      ),
    );
    let closed!: boolean;
    await act(async () => {
      filesClosePromptSnapshot()?.answer("cancel");
      closed = await confirmed;
    });
    expect(closed).toBe(false);
    expect(values.get(draftKey)).toBe("newer draft text");
    expect(values.get(`${draftKey}:base`)).toBeDefined();
    // Leave the shared registry as the retained clean record found it.
    draftStore.clear(draftKey);
    draftStore.clear(`${draftKey}:base`);
  });

  it("asks once for a document two views hold dirty when one view's save clears both", async () => {
    const scopeA = filesCloseScope(undefined, ids.thread);
    const scopeB = filesCloseScope("host-b", ids.thread);
    const values = new Map<string, string>();
    const draftStore = {
      clear: (key: string) => values.delete(key),
      read: (key: string) => values.get(key),
      write: (key: string, value: string) => values.set(key, value),
    };
    const code = client();
    const fixtureA = runtime();
    const fixtureB = runtime();
    render(
      <MonacoEditorPane
        client={code}
        draftStore={draftStore}
        file={textFile()}
        filesCloseScope={scopeA}
        loadRuntime={fixtureA.loadRuntime}
      />,
    );
    render(
      <MonacoEditorPane
        client={code}
        draftStore={draftStore}
        file={textFile()}
        filesCloseScope={scopeB}
        loadRuntime={fixtureB.loadRuntime}
      />,
    );
    await screen.findAllByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => {
      expect(fixtureA.options).toBeDefined();
      expect(fixtureB.options).toBeDefined();
    });
    // The two views hold the same document's text through their own refs.
    act(() => fixtureA.options?.onChange("shared draft"));
    act(() => fixtureB.options?.onChange("shared draft"));

    // A close spanning both views must ask once for the document, not once
    // per view holding it.
    let confirmed!: Promise<boolean>;
    await act(async () => {
      confirmed = confirmFilesClose();
    });
    await vi.waitFor(() => expect(filesClosePromptSnapshot()?.name).toBe("index.ts"));
    let closed!: boolean;
    await act(async () => {
      filesClosePromptSnapshot()?.answer("save");
      closed = await confirmed;
    });
    expect(closed).toBe(true);
    expect(code.save).toHaveBeenCalledTimes(1);

    // The peer adopted the saved text as its baseline: closing its own view
    // asks nothing.
    await expect(confirmFilesClose(scopeB)).resolves.toBe(true);
    expect(filesClosePromptSnapshot()).toBeUndefined();
  });

  it("keeps a peer view's edit made during the save dirty and loses nothing", async () => {
    const scopeA = filesCloseScope(undefined, ids.thread);
    const scopeB = filesCloseScope("host-b", ids.thread);
    const values = new Map<string, string>();
    const draftStore = {
      clear: (key: string) => values.delete(key),
      read: (key: string) => values.get(key),
      write: (key: string, value: string) => values.set(key, value),
    };
    const code = client();
    let completeSave!: (value: unknown) => void;
    vi.mocked(code.save).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        }) as never,
    );
    const fixtureA = runtime();
    const fixtureB = runtime();
    render(
      <MonacoEditorPane
        client={code}
        draftStore={draftStore}
        file={textFile()}
        filesCloseScope={scopeA}
        loadRuntime={fixtureA.loadRuntime}
      />,
    );
    render(
      <MonacoEditorPane
        client={code}
        draftStore={draftStore}
        file={textFile()}
        filesCloseScope={scopeB}
        loadRuntime={fixtureB.loadRuntime}
      />,
    );
    await screen.findAllByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => {
      expect(fixtureA.options).toBeDefined();
      expect(fixtureB.options).toBeDefined();
    });
    act(() => fixtureA.options?.onChange("shared draft"));
    act(() => fixtureB.options?.onChange("shared draft"));
    const draftKey = modelUri(ids.checkout as never, ids.file as never);

    let confirmed!: Promise<boolean>;
    await act(async () => {
      confirmed = confirmFilesClose();
    });
    await vi.waitFor(() => expect(filesClosePromptSnapshot()?.name).toBe("index.ts"));
    await act(async () => {
      filesClosePromptSnapshot()?.answer("save");
    });
    await waitFor(() => expect(code.save).toHaveBeenCalledTimes(1));
    // An edit to the shared document while the save is in flight is newer
    // than the text that was sent: it stays dirty on both views' refs.
    act(() => fixtureA.options?.onChange("edit during save"));
    act(() => fixtureB.options?.onChange("edit during save"));
    await act(async () => {
      completeSave({ status: "completed", metadata: { ...metadata, digest: "c".repeat(64) } });
    });
    await vi.waitFor(() =>
      expect(filesClosePromptSnapshot()?.failure).toBe(
        "index.ts could not be saved. Your edits are still here.",
      ),
    );
    let closed!: boolean;
    await act(async () => {
      filesClosePromptSnapshot()?.answer("cancel");
      closed = await confirmed;
    });
    expect(closed).toBe(false);
    expect(values.get(draftKey)).toBe("edit during save");

    // The peer stayed dirty against the new baseline rather than going clean
    // on a save its newer text never took part in: a fresh close still asks.
    let peerConfirmed!: Promise<boolean>;
    await act(async () => {
      peerConfirmed = confirmFilesClose();
    });
    await vi.waitFor(() => expect(filesClosePromptSnapshot()?.name).toBe("index.ts"));
    let peerClosed!: boolean;
    await act(async () => {
      filesClosePromptSnapshot()?.answer("cancel");
      peerClosed = await peerConfirmed;
    });
    expect(peerClosed).toBe(false);
    expect(values.get(draftKey)).toBe("edit during save");
    draftStore.clear(draftKey);
    draftStore.clear(`${draftKey}:base`);
  });

  it("discards the shared document once when two views hold it", async () => {
    const scopeA = filesCloseScope(undefined, ids.thread);
    const scopeB = filesCloseScope("host-b", ids.thread);
    const values = new Map<string, string>();
    const draftStore = {
      clear: (key: string) => values.delete(key),
      read: (key: string) => values.get(key),
      write: (key: string, value: string) => values.set(key, value),
    };
    const code = client();
    const fixtureA = runtime();
    const fixtureB = runtime();
    render(
      <MonacoEditorPane
        client={code}
        draftStore={draftStore}
        file={textFile()}
        filesCloseScope={scopeA}
        loadRuntime={fixtureA.loadRuntime}
      />,
    );
    render(
      <MonacoEditorPane
        client={code}
        draftStore={draftStore}
        file={textFile()}
        filesCloseScope={scopeB}
        loadRuntime={fixtureB.loadRuntime}
      />,
    );
    await screen.findAllByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => {
      expect(fixtureA.options).toBeDefined();
      expect(fixtureB.options).toBeDefined();
    });
    act(() => fixtureA.options?.onChange("shared draft"));
    act(() => fixtureB.options?.onChange("shared draft"));

    let confirmed!: Promise<boolean>;
    await act(async () => {
      confirmed = confirmFilesClose();
    });
    await vi.waitFor(() => expect(filesClosePromptSnapshot()?.name).toBe("index.ts"));
    let closed!: boolean;
    await act(async () => {
      filesClosePromptSnapshot()?.answer("discard");
      closed = await confirmed;
    });
    expect(closed).toBe(true);

    // One discard answered for the document: the peer view dropped its draft
    // too rather than asking the same question again.
    await expect(confirmFilesClose(scopeB)).resolves.toBe(true);
    expect(filesClosePromptSnapshot()).toBeUndefined();
  });

  it("adopts a peer's saved revision instead of an older load still in flight", async () => {
    const scopeA = filesCloseScope(undefined, ids.thread);
    const scopeB = filesCloseScope("host-b", ids.thread);
    const code = client();
    // The peer's first-revision read stays pending: the save that lands
    // meanwhile supersedes it, so a late resolve cannot restore stale bytes.
    let resolvePending!: (bytes: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((resolve) => {
      resolvePending = resolve;
    });
    vi.mocked(code.content)
      .mockResolvedValueOnce(new TextEncoder().encode("revision one"))
      .mockReturnValueOnce(pending);
    const fixtureA = runtime();
    const fixtureB = runtime();
    render(
      <MonacoEditorPane
        client={code}
        file={textFile()}
        filesCloseScope={scopeA}
        loadRuntime={fixtureA.loadRuntime}
      />,
    );
    render(
      <MonacoEditorPane
        client={code}
        file={textFile()}
        filesCloseScope={scopeB}
        loadRuntime={fixtureB.loadRuntime}
      />,
    );
    await waitFor(() => expect(fixtureA.options).toBeDefined());

    act(() => fixtureA.options?.onChange("saved revision two"));
    const panes = await screen.findAllByRole("region", { name: "Code editor for src/index.ts" });
    await userEvent
      .setup()
      .click(within(panes[0] as HTMLElement).getByRole("button", { name: "Save src/index.ts" }));
    await waitFor(() => expect(code.save).toHaveBeenCalledOnce());

    // The saved revision is the peer's baseline even though its older read
    // never finished: it became ready on the saved text, and the late resolve
    // lands nothing.
    await waitFor(() => expect(fixtureB.options?.value).toBe("saved revision two"));
    await act(async () => {
      resolvePending(new TextEncoder().encode("revision one"));
      await pending;
    });
    expect(fixtureB.options?.value).toBe("saved revision two");

    // An edit on the peer saves against the saved revision's identity and
    // digest — never a baseline the late read would have installed.
    act(() => fixtureB.options?.onChange("edit on the saved revision"));
    await userEvent
      .setup()
      .click(within(panes[1] as HTMLElement).getByRole("button", { name: "Save src/index.ts" }));
    await waitFor(() =>
      expect(code.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: "edit on the saved revision",
          expectedIdentity: metadata.identity,
          expectedDigest: "c".repeat(64),
        }),
      ),
    );
  });

  it.each([
    ["binary", "Binary files are read-only."],
    ["oversized", "Files larger than 5 MiB are read-only."],
  ] as const)("renders %s files as honest read-only metadata", (reason, message) => {
    const code = client();
    render(
      <MonacoEditorPane
        client={code}
        file={{
          ...commonFile(),
          state: "read-only",
          reason,
          metadata,
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "src/index.ts" })).toBeVisible();
    expect(screen.getByText(message)).toBeVisible();
    expect(code.content).not.toHaveBeenCalled();
  });

  it("renders unavailable files without mounting Monaco", () => {
    const code = client();
    const fixture = runtime();
    render(
      <MonacoEditorPane
        client={code}
        file={{ ...commonFile(), state: "unavailable", reason: "File was deleted." }}
        loadRuntime={fixture.loadRuntime}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("File was deleted.");
    expect(fixture.loadRuntime).not.toHaveBeenCalled();
  });

  it("keeps the header's actions on one line beside the file name in a narrow pane", () => {
    const narrow = /@container workspace \(max-width: 520px\) \{([\s\S]*?)\n\}/.exec(
      codeStyles,
    )?.[1];
    expect(narrow).toBeDefined();
    // Stacking the header put Save on a line of its own at phone width.
    expect(narrow).not.toContain(".code-editor-pane__toolbar");
    expect(codeStyles).toMatch(/\.code-editor-pane__toolbar > h1 \{[^}]*flex: 1 1 auto;/);
    expect(codeStyles).toMatch(
      /\.code-editor-pane__toolbar > \.code-editor-pane__actions \{[^}]*flex: none;/,
    );
  });

  it("offers every editor command in one File actions menu", async () => {
    const user = userEvent.setup();
    const fixture = runtime();
    render(
      <MonacoEditorPane
        client={client()}
        file={textFile()}
        loadRuntime={fixture.loadRuntime}
        onAddSelectionToChat={vi.fn()}
        onOpenExternalEditor={vi.fn(async () => undefined)}
        onOpenInMainArea={vi.fn()}
      />,
    );
    await screen.findByRole("region", { name: "Editor for src/index.ts" });
    expect(screen.getByRole("button", { name: "Open src/index.ts externally" })).toBeVisible();
    expect(screen.queryByText("Code file")).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Editor commands" })).not.toBeInTheDocument();
    await waitFor(() => expect(fixture.options).toBeDefined());
    await user.click(screen.getByRole("button", { name: "File actions" }));
    for (const name of [
      "Commands",
      "Find",
      "Replace",
      "Format",
      "Go to line",
      "Send selection to agent",
      "Editor settings",
      "Open in main area",
    ]) {
      expect(await screen.findByRole("menuitem", { name })).toBeVisible();
    }
  });
});

describe("MonacoEditorPane language services", () => {
  const typeError = {
    path: "src/index.ts",
    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
    severity: "error",
    message: "Type 'string' is not assignable to type 'number'.",
    source: "typescript",
  } as const;
  const scope = { threadId: ids.thread, checkoutId: ids.checkout, fileId: ids.file };

  function languageClient(
    answers: {
      readonly open?: ReadonlyArray<unknown>;
      readonly diagnostics?: ReadonlyArray<unknown>;
      readonly definition?: unknown;
    } = {},
  ) {
    const code = client();
    const opens = [...(answers.open ?? [{ status: "synced", ...scope }])];
    const diagnostics = [
      ...(answers.diagnostics ?? [
        { status: "diagnostics", ...scope, diagnostics: [typeError], truncated: false },
      ]),
    ];
    const syncLanguageDocument = vi.fn(async (request: { readonly kind: string }) =>
      request.kind === "open"
        ? opens.length > 1
          ? opens.shift()
          : opens[0]
        : { status: "synced", ...scope },
    );
    const readLanguage = vi.fn(async (request: { readonly kind: string }) =>
      request.kind === "definition"
        ? answers.definition
        : diagnostics.length > 1
          ? diagnostics.shift()
          : diagnostics[0],
    );
    return Object.assign(code, { syncLanguageDocument, readLanguage }) as CodeClient & {
      readonly syncLanguageDocument: typeof syncLanguageDocument;
      readonly readLanguage: typeof readLanguage;
    };
  }

  function languageRuntime() {
    const base = runtime();
    const setLanguageMarkers = vi.fn();
    const revealRange = vi.fn();
    const loadRuntime = vi.fn(async (): Promise<MonacoAdapterRuntime> => {
      const loaded = await base.loadRuntime();
      return {
        mount: (element, options) => ({
          ...loaded.mount(element, options),
          setLanguageMarkers,
          revealRange,
        }),
      };
    });
    return {
      loadRuntime,
      setLanguageMarkers,
      revealRange,
      get options() {
        return base.options;
      },
    };
  }

  const timing = { debounceMs: 10, pollMs: 10 };

  it("shows the server's diagnostics as markers in place of Monaco's own, Plan included", async () => {
    const code = languageClient();
    const fixture = languageRuntime();
    render(
      <MonacoEditorPane
        client={code}
        file={{ ...textFile(), executionPolicy: "plan" }}
        languageTiming={timing}
        loadRuntime={fixture.loadRuntime}
      />,
    );

    expect(await screen.findByText("1 problem")).toBeVisible();
    expect(code.syncLanguageDocument).toHaveBeenCalledWith({
      kind: "open",
      threadId: ids.thread,
      checkoutId: ids.checkout,
      path: "src/index.ts",
      text: "const answer = 42;\n",
    });
    await waitFor(() =>
      expect(fixture.setLanguageMarkers).toHaveBeenLastCalledWith([
        {
          range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 13 },
          severity: "error",
          message: typeError.message,
          source: "typescript",
        },
      ]),
    );
  });

  it("sends a settled draft as one change and reads its diagnostics again", async () => {
    const code = languageClient({
      diagnostics: [
        { status: "diagnostics", ...scope, diagnostics: [typeError], truncated: false },
        { status: "diagnostics", ...scope, diagnostics: [], truncated: false },
      ],
    });
    const fixture = languageRuntime();
    render(
      <MonacoEditorPane
        client={code}
        file={textFile()}
        languageTiming={timing}
        loadRuntime={fixture.loadRuntime}
      />,
    );
    await screen.findByText("1 problem");

    act(() => fixture.options?.onChange("const answer: number = 4"));
    act(() => fixture.options?.onChange("const answer: number = 42;\n"));

    expect(await screen.findByText("No problems found")).toBeVisible();
    const changes = code.syncLanguageDocument.mock.calls.filter(
      ([request]) => request.kind === "change",
    );
    expect(changes).toEqual([[{ kind: "change", ...scope, text: "const answer: number = 42;\n" }]]);
    await waitFor(() => expect(fixture.setLanguageMarkers).toHaveBeenLastCalledWith([]));
  });

  it("opens a definition in another file through the file-open path at its place, and names one outside the checkout", async () => {
    const code = languageClient({
      definition: {
        status: "definition",
        ...scope,
        targets: [
          {
            kind: "checkout-location",
            path: "src/greet.ts",
            range: { start: { line: 4, character: 16 }, end: { line: 4, character: 21 } },
          },
        ],
      },
    });
    const fixture = languageRuntime();
    const openFile = vi.fn();
    const { rerender } = render(
      <MonacoEditorPane
        client={code}
        file={textFile()}
        languageTiming={timing}
        loadRuntime={fixture.loadRuntime}
        onOpenFile={openFile}
      />,
    );
    await screen.findByText("1 problem");
    const bridge = fixture.options?.languageBridge;
    if (bridge === undefined) throw new Error("the editor has no language bridge");

    const links = await bridge.definitions({ lineNumber: 1, column: 8 });
    expect(code.readLanguage).toHaveBeenLastCalledWith({
      kind: "definition",
      ...scope,
      position: { line: 0, character: 7 },
    });
    expect(links).toEqual([
      {
        kind: "other-file",
        path: "src/greet.ts",
        range: { startLineNumber: 5, startColumn: 17, endLineNumber: 5, endColumn: 22 },
      },
    ]);
    const [link] = links ?? [];
    if (link === undefined || link.kind === "this-file") throw new Error("expected a link");
    act(() => bridge.open(link));
    expect(openFile).toHaveBeenCalledWith("src/greet.ts");

    // The tab the open created takes the place the definition named.
    const target = languageRuntime();
    rerender(
      <MonacoEditorPane
        client={languageClient()}
        file={{ ...textFile(), path: "src/greet.ts" as never }}
        languageTiming={timing}
        loadRuntime={target.loadRuntime}
      />,
    );
    await waitFor(() =>
      expect(target.revealRange).toHaveBeenCalledWith({
        startLineNumber: 5,
        startColumn: 17,
        endLineNumber: 5,
        endColumn: 22,
      }),
    );

    act(() => target.options?.languageBridge?.open({ kind: "outside", label: "bundled-library" }));
    expect(
      screen.getByText(
        "The definition is in the language server's bundled library, outside this checkout.",
      ),
    ).toBeVisible();
  });

  it("says when language services are off, refused, or on another platform, and keeps the editor", async () => {
    for (const [reason, text] of [
      ["turned-off", "Language services are off. Turn them on in Settings › Code."],
      [
        "unsupported-platform",
        "Language services are not available here: they run on macOS and Linux, and on Windows outside Strict.",
      ],
      ["checkout-unavailable", "Language services are unavailable: the checkout is unavailable."],
    ] as const) {
      const fixture = languageRuntime();
      const { unmount } = render(
        <MonacoEditorPane
          client={languageClient({ open: [{ status: "refused", reason }] })}
          file={textFile()}
          languageTiming={timing}
          loadRuntime={fixture.loadRuntime}
        />,
      );
      expect(await screen.findByText(text)).toBeVisible();
      expect(screen.getByRole("region", { name: "Editor for src/index.ts" })).toBeVisible();
      expect(fixture.setLanguageMarkers).not.toHaveBeenCalledWith(expect.any(Array));
      unmount();
    }

    // A file no server reads says nothing at all.
    render(
      <MonacoEditorPane
        client={languageClient({ open: [{ status: "refused", reason: "no-language-server" }] })}
        file={textFile()}
        languageTiming={timing}
        loadRuntime={languageRuntime().loadRuntime}
      />,
    );
    await screen.findByRole("region", { name: "Editor for src/index.ts" });
    await waitFor(() => expect(screen.queryByText(/Language services/)).toBeNull());
  });

  it("asks the person to approve a server that runs the repository's tooling, and opens the file with it once they do", async () => {
    const code = languageClient({
      open: [
        { status: "refused", reason: "approval-required" },
        { status: "synced", ...scope },
      ],
      diagnostics: [{ status: "diagnostics", ...scope, diagnostics: [], truncated: false }],
    });
    const approveLanguageServer = vi.fn(async () => ({
      status: "approved" as const,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      scope: "checkout" as const,
    }));
    render(
      <MonacoEditorPane
        client={Object.assign(code, { approveLanguageServer })}
        file={textFile()}
        languageTiming={timing}
        loadRuntime={languageRuntime().loadRuntime}
      />,
    );

    expect(
      await screen.findByText(
        "This language server runs the repository's own tools. Allowing it lets it write this checkout, run programs, and reach the hosts your Project's network rules allow.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Allow in this Project" })).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Allow in this checkout" }));

    expect(await screen.findByText("No problems found")).toBeVisible();
    expect(approveLanguageServer).toHaveBeenCalledWith({
      threadId: ids.thread,
      checkoutId: ids.checkout,
      path: "src/index.ts",
      scope: "checkout",
    });
    expect(code.syncLanguageDocument.mock.calls.map(([request]) => request.kind)).toEqual([
      "open",
      "open",
    ]);
  });

  it("offers no approval from a client without the approval route, and says when one was not recorded", async () => {
    // A client without the approval route only names the refusal.
    const { unmount } = render(
      <MonacoEditorPane
        client={languageClient({ open: [{ status: "refused", reason: "approval-required" }] })}
        file={textFile()}
        languageTiming={timing}
        loadRuntime={languageRuntime().loadRuntime}
      />,
    );
    expect(
      await screen.findByText(
        "Language services are unavailable: this server needs an approval first.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow in this checkout" })).toBeNull();
    unmount();

    const approveLanguageServer = vi.fn(async () => ({ status: "not-recorded" as const }));
    render(
      <MonacoEditorPane
        client={Object.assign(
          languageClient({ open: [{ status: "refused", reason: "approval-required" }] }),
          { approveLanguageServer },
        )}
        file={textFile()}
        languageTiming={timing}
        loadRuntime={languageRuntime().loadRuntime}
      />,
    );
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Allow in this Project" }));
    expect(
      await screen.findByText("The approval could not be recorded, so the server did not start."),
    ).toBeVisible();
  });

  it("shows a starting server, then a crashed one with a retry that opens the file again", async () => {
    const code = languageClient({
      open: [
        { status: "synced", ...scope },
        { status: "synced", ...scope },
      ],
      diagnostics: [
        { status: "unavailable", reason: "starting" },
        { status: "unavailable", reason: "crashed" },
        { status: "diagnostics", ...scope, diagnostics: [], truncated: false },
      ],
    });
    render(
      <MonacoEditorPane
        client={code}
        file={textFile()}
        languageTiming={{ debounceMs: 10, pollMs: 600 }}
        loadRuntime={languageRuntime().loadRuntime}
      />,
    );

    expect(await screen.findByText("Language services are starting…")).toBeVisible();
    expect(await screen.findByText("The language server stopped.")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No problems found")).toBeVisible();
    expect(code.syncLanguageDocument.mock.calls.map(([request]) => request.kind)).toEqual([
      "open",
      "close",
      "open",
    ]);
  });

  it("sends text typed while the file opened even when the server is still starting", async () => {
    const code = languageClient({
      diagnostics: [
        { status: "unavailable", reason: "starting" },
        { status: "diagnostics", ...scope, diagnostics: [], truncated: false },
      ],
    });
    let settleOpen: (value: unknown) => void = () => undefined;
    code.syncLanguageDocument.mockImplementationOnce(
      () => new Promise((resolve) => (settleOpen = resolve)),
    );
    const fixture = languageRuntime();
    render(
      <MonacoEditorPane
        client={code}
        file={textFile()}
        languageTiming={timing}
        loadRuntime={fixture.loadRuntime}
      />,
    );
    await waitFor(() => expect(code.syncLanguageDocument).toHaveBeenCalledOnce());

    act(() => fixture.options?.onChange("const answer: number = 42;\n"));
    await act(async () => settleOpen({ status: "synced", ...scope }));

    await waitFor(() =>
      expect(code.syncLanguageDocument).toHaveBeenLastCalledWith({
        kind: "change",
        ...scope,
        text: "const answer: number = 42;\n",
      }),
    );
    expect(await screen.findByText("No problems found")).toBeVisible();
  });

  it("leaves a server that stopped on reopening to the person's Retry while they type", async () => {
    const code = languageClient({
      open: [
        { status: "synced", ...scope },
        { status: "unavailable", reason: "crashed" },
      ],
      diagnostics: [{ status: "refused", reason: "file-outside-thread" }],
    });
    const fixture = languageRuntime();
    render(
      <MonacoEditorPane
        client={code}
        file={textFile()}
        languageTiming={timing}
        loadRuntime={fixture.loadRuntime}
      />,
    );
    expect(await screen.findByText("The language server stopped.")).toBeVisible();

    // Opening is the host's retry and resets the crash budget, so an edit
    // must not reopen a server the person has not asked to retry.
    act(() => fixture.options?.onChange("const answer = 43;\n"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(code.syncLanguageDocument.mock.calls.map(([request]) => request.kind)).toEqual([
      "open",
      "open",
    ]);
  });
});

const ids = {
  checkout: "10000000-0000-4000-8000-000000000001",
  content: "10000000-0000-4000-8000-000000000002",
  externalContent: "10000000-0000-4000-8000-000000000006",
  file: "10000000-0000-4000-8000-000000000003",
  thread: "10000000-0000-4000-8000-000000000004",
} as const;

const metadata = {
  identity: { device: "1", inode: "2" },
  byteLength: 19,
  modifiedNanoseconds: "3",
  digest: "a".repeat(64),
} as const;

function commonFile() {
  return {
    checkoutId: ids.checkout as never,
    executionPolicy: "full-access" as const,
    fileId: ids.file as never,
    language: "typescript",
    path: "src/index.ts" as never,
    threadId: ids.thread as never,
  };
}

function textFile(): Extract<CodeEditorFileProjection, { readonly state: "available" }> {
  return {
    ...commonFile(),
    state: "available",
    content: {
      contentId: ids.content as never,
      digest: metadata.digest as never,
      byteLength: metadata.byteLength,
    },
    metadata: metadata as never,
  };
}

function client(
  options: { readonly saveResult?: unknown; readonly text?: string } = {},
): CodeClient {
  return {
    searchTranscript: vi.fn(),
    bootstrap: vi.fn(),
    navigation: vi.fn(),
    queryBoard: vi.fn(),
    queryProjectPullRequests: vi.fn(),
    refreshProjectPullRequests: vi.fn(),
    queryProjectPullRequestDetail: vi.fn(),
    refreshProjectPullRequestDetail: vi.fn(),
    conversation: vi.fn(async (threadId) => ({
      version: 3 as const,
      threadId,
      turns: [],
      nextCursor: 0,
      hasMore: false,
    })),
    content: vi.fn(async () => new TextEncoder().encode(options.text ?? "const answer = 42;\n")),
    execute: vi.fn(),
    executeOperation: vi.fn(),
    inspectTerminal: vi.fn(),
    operationContent: vi.fn(),
    putAttachment: vi.fn(),
    discardAttachment: vi.fn(),
    attachment: vi.fn(),
    putEvidence: vi.fn(),
    save: vi.fn(
      async () =>
        (options.saveResult ?? {
          status: "completed",
          metadata: { ...metadata, digest: "c".repeat(64) },
        }) as never,
    ),
    subscribe: vi.fn(),
    subscribeOperation: vi.fn(),
    thread: vi.fn(),
    readFollowUp: vi.fn(async (threadId) => ({ threadId, followUpVersion: 0 }) as never),
    executeFollowUp: vi.fn(),
    openFile: vi.fn(),
  };
}

function runtime() {
  let options: Parameters<MonacoAdapterRuntime["mount"]>[1] | undefined;
  const setValue = vi.fn();
  const setDebugDecorations = vi.fn();
  const loadRuntime = vi.fn(
    async (): Promise<MonacoAdapterRuntime> => ({
      mount: (_element, value) => {
        options = value;
        return {
          dispose: vi.fn(),
          focus: vi.fn(),
          setReadOnly: vi.fn(),
          setValue,
          setDebugDecorations,
        };
      },
    }),
  );
  return {
    loadRuntime,
    setValue,
    setDebugDecorations,
    get options() {
      return options;
    },
  };
}
