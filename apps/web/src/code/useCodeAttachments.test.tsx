import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodeAttachmentReference } from "@octant/contracts";
import { useCodeAttachments } from "./useCodeAttachments";

const threadId = "10000000-0000-4000-8000-000000000001" as never;

describe("Code composer attachment ownership", () => {
  it("detaches accepted images and restores them when the waiting send is refused", async () => {
    const reference: CodeAttachmentReference = {
      attachmentId: "40000000-0000-4000-8000-000000000001" as never,
      displayName: "pasted.png",
      mediaType: "image/png",
      byteLength: 3,
      digest: "a".repeat(64) as never,
    };
    const putAttachment = vi.fn(async () => reference);
    const discardAttachment = vi.fn(async () => undefined);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pasted");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      const { result } = renderHook(() =>
        useCodeAttachments({
          client: { putAttachment, discardAttachment },
          threadId,
        }),
      );
      await act(async () => {
        await result.current.attach([
          new File([new Uint8Array([137, 80, 78])], "pasted.png", { type: "image/png" }),
        ]);
      });

      let detached = [] as ReturnType<typeof result.current.detachForSend>;
      act(() => {
        detached = result.current.detachForSend();
      });
      expect(detached).toHaveLength(1);
      expect(result.current.staged).toEqual([]);

      act(() => {
        result.current.restoreDetached(detached);
      });
      expect(result.current.staged).toHaveLength(1);
      expect(discardAttachment).not.toHaveBeenCalled();
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it("discards detached host bytes when a refused message has been superseded", async () => {
    const reference: CodeAttachmentReference = {
      attachmentId: "40000000-0000-4000-8000-000000000002" as never,
      displayName: "superseded.png",
      mediaType: "image/png",
      byteLength: 3,
      digest: "b".repeat(64) as never,
    };
    const putAttachment = vi.fn(async () => reference);
    const discardAttachment = vi.fn(async () => undefined);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:superseded");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      const { result } = renderHook(() =>
        useCodeAttachments({
          client: { putAttachment, discardAttachment },
          threadId,
        }),
      );
      await act(async () => {
        await result.current.attach([
          new File([new Uint8Array([1, 2, 3])], "superseded.png", { type: "image/png" }),
        ]);
      });

      let detached = [] as ReturnType<typeof result.current.detachForSend>;
      act(() => {
        detached = result.current.detachForSend();
        result.current.discardDetached(detached);
      });
      expect(result.current.staged).toEqual([]);
      expect(discardAttachment).toHaveBeenCalledWith(threadId, reference.attachmentId);
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it("discards detached host bytes and revokes previews on unmount", async () => {
    const reference: CodeAttachmentReference = {
      attachmentId: "40000000-0000-4000-8000-000000000003" as never,
      displayName: "unmounted.png",
      mediaType: "image/png",
      byteLength: 3,
      digest: "c".repeat(64) as never,
    };
    const putAttachment = vi.fn(async () => reference);
    const discardAttachment = vi.fn(async () => undefined);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:unmounted");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      const { result, unmount } = renderHook(() =>
        useCodeAttachments({
          client: { putAttachment, discardAttachment },
          threadId,
        }),
      );
      await act(async () => {
        await result.current.attach([
          new File([new Uint8Array([1, 2, 3])], "unmounted.png", { type: "image/png" }),
        ]);
      });
      act(() => {
        result.current.detachForSend();
      });

      unmount();

      expect(discardAttachment).toHaveBeenCalledOnce();
      expect(discardAttachment).toHaveBeenCalledWith(threadId, reference.attachmentId);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:unmounted");
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });
});
