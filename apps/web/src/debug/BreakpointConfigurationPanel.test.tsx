import type { CodeClient } from "@octant/client-runtime/code-client";
import {
  CodeDebugClientFailure,
  type CodeDebugClient,
} from "@octant/client-runtime/code-debug-client";
import {
  decodeCodeCheckoutId,
  decodeCodeFileId,
  decodeCodeFileMetadata,
  decodeCodeProjectFilePath,
  decodeCodeThreadId,
} from "@octant/contracts/code";
import { decodeCodeDebugConfigurationsResult } from "@octant/contracts/code-debug";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodeCodeFileOpenResultEnvelope } from "@octant/contracts/code-operations";
import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeDebugWindowState, codeDebugThreadKey } from "./codeDebugWindowState";
import { RunDebugPanel } from "./RunDebugPanel";

const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const checkoutId = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000001");
const projectId = decodeProjectId("50000000-0000-4000-8000-000000000001");
const fileId = decodeCodeFileId("60000000-0000-4000-8000-000000000001");
const path = decodeCodeProjectFilePath("src/main.js");
const key = codeDebugThreadKey(threadId, checkoutId);
const metadata = decodeCodeFileMetadata({
  identity: { device: "1", inode: "2" },
  byteLength: 8,
  modifiedNanoseconds: "1",
  digest: "a".repeat(64),
});
const scope = {
  origin: "http://127.0.0.1:13773",
  windowId: "40000000-0000-4000-8000-000000000001",
};
function fixture() {
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
  const first = new CodeDebugWindowState({ ...scope, storage });
  first.toggleBreakpoint(key, path, 3, { projectId, fileId, metadata, lineCount: 4, clean: true });
  const store = new CodeDebugWindowState({ ...scope, storage });
  const client: CodeDebugClient = {
    configurations: vi.fn(async () =>
      decodeCodeDebugConfigurationsResult({
        status: "listed",
        adapters: [],
        approved: [],
        launchFile: { status: "absent" },
      }),
    ),
    approve: vi.fn(async () => ({ status: "refused", reason: "no-debug-adapter" }) as const),
    start: vi.fn(async () => ({ status: "refused", reason: "no-debug-adapter" }) as const),
    session: vi.fn(async () => ({ status: "refused", reason: "no-session" }) as const),
  };
  let currentMetadata = metadata;
  let missing = false;
  const files: Pick<CodeClient, "openFile" | "content"> = {
    openFile: vi.fn(
      async () =>
        decodeCodeFileOpenResultEnvelope({
          kind: "code-file-open-result",
          result: missing
            ? { status: "failed", fileId, failure: { category: "unavailable", code: "not-found" } }
            : {
                status: "editable",
                fileId,
                metadata: currentMetadata,
                content: {
                  contentId: "70000000-0000-4000-8000-000000000001",
                  digest: currentMetadata.digest,
                  byteLength: 8,
                },
              },
        }).result,
    ),
    content: vi.fn(async () => new TextEncoder().encode("a\nb\nc\nd\n")),
  };
  return {
    store,
    storage,
    client,
    files,
    change: () => {
      currentMetadata = decodeCodeFileMetadata({ ...metadata, digest: "b".repeat(64) });
    },
    remove: () => {
      missing = true;
    },
  };
}
describe("saved breakpoint locations in the actual Run and debug panel", () => {
  it("revalidates reload configuration, lists the exact location, and removes it without starting or attaching", async () => {
    const f = fixture();
    const user = userEvent.setup();
    render(
      <RunDebugPanel
        client={f.client}
        fileClient={f.files}
        projectId={projectId}
        threadId={threadId}
        checkoutId={checkoutId}
        store={f.store}
      />,
    );
    const list = await screen.findByRole("region", { name: "Breakpoints" });
    expect(await within(list).findByText("src/main.js:3")).toBeVisible();
    expect(await within(list).findByText("Verified")).toBeVisible();
    expect(f.files.openFile).toHaveBeenCalledWith(threadId, checkoutId, path);
    expect(f.client.start).not.toHaveBeenCalled();
    expect(f.client.session).not.toHaveBeenCalled();
    await user.click(within(list).getByRole("button", { name: "Remove breakpoint src/main.js:3" }));
    expect(
      new CodeDebugWindowState({ ...scope, storage: f.storage }).read(key).breakpoints.size,
    ).toBe(0);
  });
  it("keeps changed locations unresolved until a fresh explicit acceptance, and retains missing locations without moving them", async () => {
    const f = fixture();
    const user = userEvent.setup();
    f.change();
    render(
      <RunDebugPanel
        client={f.client}
        fileClient={f.files}
        projectId={projectId}
        threadId={threadId}
        checkoutId={checkoutId}
        store={f.store}
      />,
    );
    const list = await screen.findByRole("region", { name: "Breakpoints" });
    expect(await within(list).findByText(/identity or contents changed/)).toBeVisible();
    await user.click(
      within(list).getByRole("button", { name: "Use current locations in src/main.js" }),
    );
    expect(await within(list).findByText("Verified")).toBeVisible();
    expect(f.files.openFile).toHaveBeenCalledTimes(2);
    f.remove();
    await user.click(within(list).getByRole("button", { name: "Recheck breakpoint files" }));
    expect(await within(list).findByText(/this file is missing/)).toBeVisible();
    expect(within(list).getByText("src/main.js:3")).toBeVisible();
    expect(
      within(list).getByRole("button", { name: "Use current locations in src/main.js" }),
    ).toBeDisabled();
    expect(f.client.start).not.toHaveBeenCalled();
    expect(f.client.session).not.toHaveBeenCalled();
  });
  it("offers no saved-file read or breakpoint controls when the existing local-only gate refuses", async () => {
    const f = fixture();
    vi.mocked(f.client.configurations).mockRejectedValue(
      new CodeDebugClientFailure("local-only", "Local only"),
    );
    render(
      <RunDebugPanel
        client={f.client}
        fileClient={f.files}
        projectId={projectId}
        threadId={threadId}
        checkoutId={checkoutId}
        store={f.store}
      />,
    );
    await screen.findByText(/Debugging stays on this computer/);
    expect(screen.queryByRole("region", { name: "Breakpoints" })).not.toBeInTheDocument();
    expect(f.files.openFile).not.toHaveBeenCalled();
    expect(f.client.start).not.toHaveBeenCalled();
    expect(f.client.session).not.toHaveBeenCalled();
  });
  it("rechecks before Start and refuses a file changed since the list was verified", async () => {
    const f = fixture();
    const user = userEvent.setup();
    vi.mocked(f.client.configurations).mockResolvedValue(
      decodeCodeDebugConfigurationsResult({
        status: "listed",
        adapters: [
          {
            adapter: "10000000-0000-4000-8000-000000000001/adapter",
            displayName: "Fixture adapter",
            runtimes: ["node"],
            packageName: "Fixture tools",
            packageVersion: "1.0.0",
          },
        ],
        approved: [
          {
            configurationDigest: `sha256:${"a".repeat(64)}`,
            configuration: {
              name: "Run fixture",
              adapter: "10000000-0000-4000-8000-000000000001/adapter",
              program: "src/main.js",
              args: [],
              env: [],
              stopOnEntry: false,
            },
            scope: "checkout",
          },
        ],
        launchFile: { status: "absent" },
      }),
    );
    render(
      <RunDebugPanel
        client={f.client}
        fileClient={f.files}
        projectId={projectId}
        threadId={threadId}
        checkoutId={checkoutId}
        store={f.store}
      />,
    );
    await screen.findByText("Verified");
    f.change();
    await user.click(screen.getByRole("button", { name: "Start Run fixture" }));
    expect(await screen.findByText(/Nothing was started/)).toBeVisible();
    await waitFor(() => expect(f.files.openFile).toHaveBeenCalledTimes(2));
    expect(f.client.start).not.toHaveBeenCalled();
  });
  it.each(["purge", "client"] as const)(
    "refuses a held Start after %s replaces its original admission",
    async (change) => {
      const f = fixture();
      const user = userEvent.setup();
      vi.mocked(f.client.configurations).mockResolvedValue(
        decodeCodeDebugConfigurationsResult({
          status: "listed",
          adapters: [
            {
              adapter: "10000000-0000-4000-8000-000000000001/adapter",
              displayName: "Fixture adapter",
              runtimes: ["node"],
              packageName: "Fixture tools",
              packageVersion: "1.0.0",
            },
          ],
          approved: [
            {
              configurationDigest: `sha256:${"a".repeat(64)}`,
              configuration: {
                name: "Run fixture",
                adapter: "10000000-0000-4000-8000-000000000001/adapter",
                program: "src/main.js",
                args: [],
                env: [],
                stopOnEntry: false,
              },
              scope: "checkout",
            },
          ],
          launchFile: { status: "absent" },
        }),
      );
      const view = render(
        <RunDebugPanel
          client={f.client}
          fileClient={f.files}
          projectId={projectId}
          threadId={threadId}
          checkoutId={checkoutId}
          store={f.store}
        />,
      );
      await screen.findByText("Verified");
      let release: (value: Uint8Array) => void = () => undefined;
      const held = new Promise<Uint8Array>((resolve) => {
        release = resolve;
      });
      vi.mocked(f.files.content).mockImplementationOnce(() => held);
      await user.click(screen.getByRole("button", { name: "Start Run fixture" }));
      await waitFor(() => expect(f.files.content).toHaveBeenCalledTimes(2));
      const nextClient = { ...f.client, start: vi.fn(f.client.start) };
      if (change === "purge")
        act(() => {
          f.store.purgeThread(threadId);
        });
      else
        view.rerender(
          <RunDebugPanel
            client={nextClient}
            fileClient={f.files}
            projectId={projectId}
            threadId={threadId}
            checkoutId={checkoutId}
            store={f.store}
          />,
        );
      await act(async () => {
        release(new TextEncoder().encode("a\nb\nc\nd\n"));
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Start Run fixture" })).toBeEnabled(),
      );
      expect(f.client.start).not.toHaveBeenCalled();
      expect(nextClient.start).not.toHaveBeenCalled();
    },
  );
  it("hides the previous client's listing until the replacement passes its own local gate", async () => {
    const f = fixture();
    const view = render(
      <RunDebugPanel
        client={f.client}
        fileClient={f.files}
        projectId={projectId}
        threadId={threadId}
        checkoutId={checkoutId}
        store={f.store}
      />,
    );
    await screen.findByText("Verified");
    let refuse: (reason: Error) => void = () => undefined;
    const held = new Promise<never>((_resolve, reject) => {
      refuse = reject;
    });
    const nextClient = { ...f.client, configurations: vi.fn(() => held) };
    view.rerender(
      <RunDebugPanel
        client={nextClient}
        fileClient={f.files}
        projectId={projectId}
        threadId={threadId}
        checkoutId={checkoutId}
        store={f.store}
      />,
    );
    expect(screen.queryByRole("region", { name: "Breakpoints" })).not.toBeInTheDocument();
    expect(f.files.openFile).toHaveBeenCalledTimes(1);
    await act(async () => {
      refuse(new CodeDebugClientFailure("local-only", "Local only"));
    });
    expect(await screen.findByText(/Debugging stays on this computer/)).toBeVisible();
    expect(f.files.openFile).toHaveBeenCalledTimes(1);
    expect(f.client.start).not.toHaveBeenCalled();
  });
});
