import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeClient } from "@octant/client-runtime/code-client";
import {
  decodeCodeThreadId,
  decodeCodeCheckoutId,
  decodeCodeFileId,
  decodeCodeProjectFilePath,
  decodeCodeFileMetadata,
} from "@octant/contracts/code";
import {
  decodeCodeLanguageDocumentResult,
  decodeCodeLanguageReadResult,
  type CodeLanguageReadRequest,
} from "@octant/contracts/code-language";
import { decodeCodeEvidenceReference } from "@octant/contracts/code-operations";
import { MonacoEditorPane } from "./MonacoEditorPane";
import type { MonacoAdapterRuntime } from "./MonacoEditorAdapter";
const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const checkoutId = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000001");
const fileId = decodeCodeFileId("60000000-0000-4000-8000-000000000001");
const path = decodeCodeProjectFilePath("b.ts");
const text = 'import { value } from "./a";\nconsole.log(value);\n';
const scope = { threadId, checkoutId, fileId };
const range = { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } };
function fixture() {
  let version = 1;
  const revision = () => `90000000-0000-4000-8000-${String(version).padStart(12, "0")}`;
  const requests: CodeLanguageReadRequest[] = [];
  const state: {
    support: string;
    oldHost: boolean;
    beforeReference?: () => Promise<void>;
    beforeCapability?: () => Promise<void>;
    wrongRevision?: boolean;
    guardedStale?: boolean;
  } = { support: "supported", oldHost: false };
  const signals: Array<AbortSignal | undefined> = [];
  const client: Pick<CodeClient, "content" | "save" | "syncLanguageDocument" | "readLanguage"> = {
    content: vi.fn(async () => new TextEncoder().encode(text)),
    save: vi.fn(async () => {
      throw new Error("References must not save a file");
    }),
    syncLanguageDocument: vi.fn(async (request) => {
      if (request.kind === "change") {
        if (
          request.expectedRevision !== undefined &&
          (state.guardedStale || request.expectedRevision !== revision())
        )
          return decodeCodeLanguageDocumentResult({ status: "stale" });
        version++;
      }
      return decodeCodeLanguageDocumentResult({
        status: "synced",
        ...scope,
        ...(state.oldHost ? {} : { documentVersion: version, documentRevision: revision() }),
      });
    }),
    readLanguage: vi.fn(async (request, signal) => {
      requests.push(request);
      if (request.kind === "references") {
        signals.push(signal);
        await state.beforeReference?.();
      }
      if (request.kind === "capabilities") await state.beforeCapability?.();
      return decodeCodeLanguageReadResult(
        request.kind === "diagnostics"
          ? { status: "diagnostics", ...scope, diagnostics: [], truncated: false }
          : request.kind === "capabilities"
            ? { status: "capabilities", ...scope, references: state.support }
            : request.kind === "references"
              ? {
                  status: "references",
                  ...scope,
                  documentVersion: request.expectedVersion,
                  documentRevision: state.wrongRevision
                    ? "90000000-0000-4000-8000-999999999999"
                    : request.expectedRevision,
                  targets: [
                    { kind: "checkout-location", path: "a.ts", range },
                    {
                      kind: "checkout-location",
                      path: "b.ts",
                      range: { start: { line: 1, character: 12 }, end: { line: 1, character: 17 } },
                    },
                    { kind: "outside-checkout", label: "elsewhere" },
                  ],
                  truncated: false,
                }
              : { status: "definition", ...scope, targets: [] },
      );
    }),
  };
  let options: Parameters<MonacoAdapterRuntime["mount"]>[1] | undefined;
  const reveal = vi.fn();
  const loadRuntime = vi.fn(
    async (): Promise<MonacoAdapterRuntime> => ({
      mount: (_element, input) => {
        options = input;
        return {
          dispose: vi.fn(),
          focus: vi.fn(),
          setReadOnly: vi.fn(),
          setValue: vi.fn(),
          revealRange: reveal,
          setDebugDecorations: vi.fn(),
          setLanguageMarkers: vi.fn(),
        };
      },
    }),
  );
  const file = {
    threadId,
    checkoutId,
    fileId,
    path,
    language: "typescript",
    executionPolicy: "plan" as const,
    state: "available" as const,
    content: decodeCodeEvidenceReference({
      contentId: "70000000-0000-4000-8000-000000000001",
      digest: "a".repeat(64),
      byteLength: new TextEncoder().encode(text).length,
    }),
    metadata: decodeCodeFileMetadata({
      identity: { device: "1", inode: "2" },
      digest: "a".repeat(64),
      byteLength: new TextEncoder().encode(text).length,
      modifiedNanoseconds: "1",
    }),
  };
  return {
    client,
    file,
    loadRuntime,
    reveal,
    state,
    requests,
    signals,
    get options() {
      return options;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
});
describe("references in the actual Code editor pane", () => {
  it("checks current capability and acknowledged unsaved text before showing bounded references in the explicit checkout", async () => {
    const f = fixture();
    const user = userEvent.setup();
    const open = vi.fn();
    render(
      <MonacoEditorPane
        client={f.client}
        file={f.file}
        loadRuntime={f.loadRuntime}
        checkoutLabel="feature/references"
        onOpenFile={open}
        languageTiming={{ debounceMs: 10000, pollMs: 10000 }}
      />,
    );
    await screen.findByText("No problems found");
    act(() => {
      f.options?.onChange(text + "// unsaved draft\n");
      f.options?.onCursorPosition?.({ lineNumber: 2, column: 13 });
    });
    await user.click(screen.getByRole("button", { name: "Find references in checkout" }));
    const list = await screen.findByRole("region", { name: "References" });
    expect(await within(list).findByText(/feature\/references/)).toBeVisible();
    await user.click(await within(list).findByRole("button", { name: "Open a.ts:1:14" }));
    expect(open).toHaveBeenCalledWith("a.ts");
    expect(f.requests.find((request) => request.kind === "references")).toMatchObject({
      kind: "references",
      ...scope,
      position: { line: 1, character: 12 },
      includeDeclaration: true,
      expectedVersion: 2,
      expectedRevision: "90000000-0000-4000-8000-000000000002",
    });
    expect(f.client.syncLanguageDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "change",
        text: text + "// unsaved draft\n",
        expectedRevision: "90000000-0000-4000-8000-000000000001",
      }),
      expect.any(AbortSignal),
    );
    expect(f.client.save).not.toHaveBeenCalled();
  });
  it.each(["unsupported", "unknown", "old-host"] as const)(
    "offers an explicit external handoff without sending a references query for %s",
    async (kind) => {
      const f = fixture();
      if (kind === "old-host") f.state.oldHost = true;
      else f.state.support = kind;
      const external = vi.fn(async () => undefined);
      const user = userEvent.setup();
      render(
        <MonacoEditorPane
          client={f.client}
          file={f.file}
          loadRuntime={f.loadRuntime}
          onOpenExternalEditor={external}
          languageTiming={{ debounceMs: 10000, pollMs: 10000 }}
        />,
      );
      await screen.findByText("No problems found");
      await user.click(screen.getByRole("button", { name: "Find references in checkout" }));
      const region = await screen.findByRole("region", { name: "References" });
      await within(region).findByRole("alert");
      expect(f.requests.filter((request) => request.kind === "references")).toHaveLength(0);
      await user.click(within(region).getByRole("button", { name: "Open externally" }));
      expect(external).toHaveBeenCalledOnce();
      expect(f.client.save).not.toHaveBeenCalled();
    },
  );
  it.each(["draft", "close", "client", "thread"] as const)(
    "aborts an optional transport and ignores a held result after %s changes",
    async (change) => {
      const f = fixture();
      const user = userEvent.setup();
      let release: () => void = () => undefined;
      f.state.beforeReference = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const props = {
        client: f.client,
        file: f.file,
        loadRuntime: f.loadRuntime,
        languageTiming: { debounceMs: 10000, pollMs: 10000 },
      };
      const view = render(<MonacoEditorPane {...props} />);
      await screen.findByText("No problems found");
      await user.click(screen.getByRole("button", { name: "Find references in checkout" }));
      await waitFor(() => expect(f.signals).toHaveLength(1));
      if (change === "draft") act(() => f.options?.onChange(text + "// new draft"));
      else if (change === "close") await user.keyboard("{Escape}");
      else if (change === "client") {
        const replacement = fixture();
        view.rerender(<MonacoEditorPane {...props} client={replacement.client} />);
      } else
        view.rerender(
          <MonacoEditorPane
            {...props}
            file={{
              ...f.file,
              threadId: decodeCodeThreadId("20000000-0000-4000-8000-000000000002"),
            }}
          />,
        );
      await waitFor(() => expect(f.signals[0]?.aborted).toBe(true));
      await act(async () => {
        release();
        await Promise.resolve();
      });
      expect(screen.queryByRole("region", { name: "References" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open a.ts:1:14" })).not.toBeInTheDocument();
      if (change === "close")
        expect(screen.getByRole("button", { name: "Find references in checkout" })).toHaveFocus();
    },
  );
  it("shows stale foreground preparation without an implicit retry and recovers only on explicit recheck", async () => {
    const f = fixture();
    f.state.guardedStale = true;
    const user = userEvent.setup();
    render(
      <MonacoEditorPane
        client={f.client}
        file={f.file}
        loadRuntime={f.loadRuntime}
        languageTiming={{ debounceMs: 10000, pollMs: 10000 }}
      />,
    );
    await screen.findByText("No problems found");
    await user.click(screen.getByRole("button", { name: "Find references in checkout" }));
    const region = await screen.findByRole("region", { name: "References" });
    await within(region).findByText(/file changed while finding references/);
    expect(f.requests.filter((request) => request.kind === "references")).toHaveLength(0);
    expect(f.requests.filter((request) => request.kind === "capabilities")).toHaveLength(1);
    expect(f.client.syncLanguageDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "change",
        expectedRevision: "90000000-0000-4000-8000-000000000001",
      }),
      expect.any(AbortSignal),
    );
    f.state.guardedStale = false;
    await user.click(within(region).getByRole("button", { name: "Recheck references" }));
    await within(region).findByText(/snapshot/);
    expect(f.requests.filter((request) => request.kind === "references")).toHaveLength(1);
    expect(f.requests.filter((request) => request.kind === "capabilities")).toHaveLength(2);
    expect(f.client.save).not.toHaveBeenCalled();
  });
  it("settles a never-answering optional transport at the total budget and suppresses its late reply", async () => {
    const f = fixture();
    let release: () => void = () => undefined;
    f.state.beforeReference = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    render(
      <MonacoEditorPane
        client={f.client}
        file={f.file}
        loadRuntime={f.loadRuntime}
        languageTiming={{ debounceMs: 100000, pollMs: 100000 }}
      />,
    );
    await screen.findByText("No problems found");
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Find references in checkout" }));
      });
      expect(f.signals).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15001);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByText(/did not answer in time/)).toBeVisible();
    expect(f.signals[0]?.aborted).toBe(true);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Open a.ts:1:14" })).not.toBeInTheDocument();
    expect(f.requests.filter((request) => request.kind === "references")).toHaveLength(1);
  });
  it("keeps a newer explicit query when a cancelled earlier query finally answers", async () => {
    const f = fixture();
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    f.state.beforeReference = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    render(
      <MonacoEditorPane
        client={f.client}
        file={f.file}
        loadRuntime={f.loadRuntime}
        languageTiming={{ debounceMs: 10000, pollMs: 10000 }}
      />,
    );
    await screen.findByText("No problems found");
    await user.click(screen.getByRole("button", { name: "Find references in checkout" }));
    await waitFor(() => expect(f.signals).toHaveLength(1));
    await user.keyboard("{Escape}");
    delete f.state.beforeReference;
    await user.click(screen.getByRole("button", { name: "Find references in checkout" }));
    const region = await screen.findByRole("region", { name: "References" });
    await within(region).findByText(/snapshot/);
    f.state.wrongRevision = true;
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(within(region).getByRole("button", { name: "Open b.ts:2:13" })).toBeVisible();
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
    expect(f.signals[0]?.aborted).toBe(true);
  });
  it("checks absolute elapsed budget when a reply wins before a delayed timer", async () => {
    const f = fixture();
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    f.state.beforeReference = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    render(
      <MonacoEditorPane
        client={f.client}
        file={f.file}
        loadRuntime={f.loadRuntime}
        languageTiming={{ debounceMs: 10000, pollMs: 10000 }}
      />,
    );
    await screen.findByText("No problems found");
    const base = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(base);
    await user.click(screen.getByRole("button", { name: "Find references in checkout" }));
    await waitFor(() => expect(f.signals).toHaveLength(1));
    clock.mockReturnValue(base + 15001);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    const region = screen.getByRole("region", { name: "References" });
    expect(await within(region).findByText(/did not answer in time/)).toBeVisible();
    expect(f.signals[0]?.aborted).toBe(true);
    expect(
      within(region).queryByRole("button", { name: "Open a.ts:1:14" }),
    ).not.toBeInTheDocument();
    expect(f.requests.filter((request) => request.kind === "references")).toHaveLength(1);
  });
  it("discards an old snapshot on failed explicit recheck and refuses another document revision", async () => {
    const f = fixture();
    const user = userEvent.setup();
    render(
      <MonacoEditorPane
        client={f.client}
        file={f.file}
        loadRuntime={f.loadRuntime}
        languageTiming={{ debounceMs: 10000, pollMs: 10000 }}
      />,
    );
    await screen.findByText("No problems found");
    await user.click(screen.getByRole("button", { name: "Find references in checkout" }));
    const region = await screen.findByRole("region", { name: "References" });
    await within(region).findByText(/snapshot/);
    f.state.wrongRevision = true;
    await user.click(within(region).getByRole("button", { name: "Recheck references" }));
    expect(await within(region).findByText(/another file revision/)).toBeVisible();
    expect(within(region).queryByText("a.ts:1:14")).not.toBeInTheDocument();
    expect(f.client.save).not.toHaveBeenCalled();
  });
});
