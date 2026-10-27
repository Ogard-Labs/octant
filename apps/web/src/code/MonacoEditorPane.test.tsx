import type { CodeClient } from "@octant/client-runtime/code-client";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MonacoAdapterRuntime } from "./MonacoEditorAdapter";
import { MonacoEditorPane, type CodeEditorFileProjection } from "./MonacoEditorPane";
import { codeDebugThreadKey, codeDebugWindowState } from "../debug/codeDebugWindowState";

describe("MonacoEditorPane", () => {
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
      ["unsupported-platform", "Language services are not available on this host's platform."],
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
