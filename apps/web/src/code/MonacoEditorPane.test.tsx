import type { CodeClient } from "@octant/client-runtime/code-client";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MonacoAdapterRuntime } from "./MonacoEditorAdapter";
import { MonacoEditorPane, type CodeEditorFileProjection } from "./MonacoEditorPane";

describe("MonacoEditorPane", () => {
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
    expect(screen.getByRole("button", { name: "Save src/index.ts" })).toBeDisabled();
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
    bootstrap: vi.fn(),
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
  const loadRuntime = vi.fn(
    async (): Promise<MonacoAdapterRuntime> => ({
      mount: (_element, value) => {
        options = value;
        return {
          dispose: vi.fn(),
          focus: vi.fn(),
          setReadOnly: vi.fn(),
          setValue,
        };
      },
    }),
  );
  return {
    loadRuntime,
    setValue,
    get options() {
      return options;
    },
  };
}
