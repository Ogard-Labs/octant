import type { CodeClient, CodeFileOpenResult } from "@octant/client-runtime/code-client";
import { CodeClientFailure } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts/code";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCodeEditorFile } from "./useCodeEditorFile";

const threadId = "00000000-0000-4000-8000-000000000991" as unknown as CodeThreadId;
const checkoutId = "00000000-0000-4000-8000-000000000992" as unknown as CodeCheckoutId;
const filePath = "src/main.ts" as unknown as CodeRelativePath;
const fileId = "00000000-0000-4000-8000-000000000993";

const editable: CodeFileOpenResult = {
  status: "editable",
  fileId,
  metadata: {
    identity: { device: "dev-1", inode: "ino-1" },
    byteLength: 7,
    modifiedNanoseconds: "1",
    digest: "e".repeat(64),
  },
  content: { contentId: "content-1", digest: "e".repeat(64), byteLength: 7 },
} as unknown as CodeFileOpenResult;

function refused(code: string): CodeFileOpenResult {
  return {
    status: "failed",
    fileId,
    failure: { category: "unavailable", code },
  } as unknown as CodeFileOpenResult;
}

function opening(openFile: (() => Promise<CodeFileOpenResult>) | ReturnType<typeof vi.fn>) {
  // One stable client identity, as callers hand the hook: a fresh literal each
  // render would re-run the open on every state change.
  const client = { openFile } as unknown as CodeClient;
  return renderHook(
    (props: { readonly relativePath?: string }) =>
      useCodeEditorFile({
        checkoutId,
        client,
        enabled: true,
        executionPolicy: "full-access",
        ...(props.relativePath === undefined
          ? {}
          : { relativePath: props.relativePath as CodeRelativePath }),
        threadId,
      }),
    { initialProps: { relativePath: filePath as string } },
  );
}

describe("useCodeEditorFile when the open is refused or fails", () => {
  it("says the file is gone on a missing-path refusal instead of opening forever", async () => {
    const { result } = opening(vi.fn(async () => refused("not-found")));
    await waitFor(() => expect(result.current.openError).toBeDefined());
    expect(result.current.openError).toBe(
      "The file is no longer there. It may have been moved, renamed or deleted.",
    );
    expect(result.current.file).toBeUndefined();
    expect(result.current.openError).not.toContain("not-found");
  });

  it("names the file port's refusal reasons instead of their codes", async () => {
    const named: ReadonlyArray<readonly [string, string]> = [
      ["symlink", "The file is a link. Only real files inside the checkout can be opened."],
      ["hardlink", "The file is a link. Only real files inside the checkout can be opened."],
      ["not-regular", "That is not a regular file, so it cannot be opened."],
      ["escaped", "That path leaves the checkout."],
      ["device-mismatch", "The file changed while it was being opened. Try again."],
      ["oversized", "The host's answer was too large to read. Reconnect and retry."],
    ];
    for (const [code, expected] of named) {
      const { result, unmount } = opening(vi.fn(async () => refused(code)));
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(result.current.openError).toBe(expected));
      unmount();
    }
  });

  it("names the folder problem on a typed host refusal, not the transport's words", async () => {
    const { result } = opening(
      vi.fn(async () => {
        throw new CodeClientFailure({
          category: "unavailable",
          message: "Code file authority is unavailable.",
        });
      }),
    );
    await waitFor(() => expect(result.current.openError).toBeDefined());
    expect(result.current.openError).toBe(
      "The thread's folder can't be opened. It may have been moved, renamed or deleted, or this window no longer has access to it.",
    );
    expect(result.current.file).toBeUndefined();
  });

  it("falls back to a plain sentence when the failure is not a typed refusal", async () => {
    const { result } = opening(
      vi.fn(async () => {
        throw new Error("ECONNRESET read tcp");
      }),
    );
    await waitFor(() => expect(result.current.openError).toBeDefined());
    expect(result.current.openError).toBe("Code file is unavailable. Reconnect and retry.");
  });

  it("keeps the mounted file when a refresh is refused, and reports the refusal", async () => {
    const openFile = vi
      .fn<() => Promise<CodeFileOpenResult>>()
      .mockResolvedValueOnce(editable)
      .mockResolvedValueOnce(refused("helper-failed"));
    const { result } = opening(openFile);
    await waitFor(() => expect(result.current.file).toBeDefined());
    const mounted = result.current.file;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.openError).toBeDefined());
    expect(result.current.file).toBe(mounted);
    expect(result.current.openError).toBe("The file could not be opened. Reconnect and retry.");
    expect(result.current.openError).not.toContain("helper-failed");
  });

  it("clears the refusal and the file when the path it answers for changes", async () => {
    const openFile = vi
      .fn<() => Promise<CodeFileOpenResult>>()
      .mockResolvedValueOnce(refused("not-found"))
      .mockResolvedValueOnce(editable);
    const { result, rerender } = opening(openFile);
    await waitFor(() => expect(result.current.openError).toBeDefined());
    rerender({ relativePath: "src/other.ts" });
    await waitFor(() => expect(result.current.file).toBeDefined());
    expect(result.current.openError).toBeUndefined();
  });
});
