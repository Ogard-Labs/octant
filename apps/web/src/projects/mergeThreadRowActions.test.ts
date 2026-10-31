import { describe, expect, it, vi } from "vitest";
import { mergeThreadRowActions } from "./mergeThreadRowActions";

describe("merged thread row actions", () => {
  it("sends each row's action to its own kind's command and nowhere else", () => {
    const chat = { onArchiveThread: vi.fn(), onPinThread: vi.fn() };
    const work = { onArchiveThread: vi.fn(), onSnoozeThread: vi.fn() };
    const merged = mergeThreadRowActions((id) => id.startsWith("chat-"), chat, work);

    merged.onArchiveThread?.("chat-1");
    merged.onArchiveThread?.("work-1");
    merged.onPinThread?.("chat-1", true);
    merged.onSnoozeThread?.("chat-1", "2026-10-02T09:00:00.000Z");
    merged.onSnoozeThread?.("work-1", "2026-10-02T09:00:00.000Z");

    expect(chat.onArchiveThread).toHaveBeenCalledExactlyOnceWith("chat-1");
    expect(work.onArchiveThread).toHaveBeenCalledExactlyOnceWith("work-1");
    expect(chat.onPinThread).toHaveBeenCalledWith("chat-1", true);
    // Chat cannot snooze here, so a Chat row's snooze reaches nothing.
    expect(work.onSnoozeThread).toHaveBeenCalledExactlyOnceWith(
      "work-1",
      "2026-10-02T09:00:00.000Z",
    );
    expect(merged.onExportThread).toBeUndefined();
  });

  it("offers Move to Project only on the rows whose kind can move", () => {
    const chat = { onArchiveThread: vi.fn() };
    const work = { onMoveToProject: vi.fn() };
    const merged = mergeThreadRowActions((id) => id.startsWith("chat-"), chat, work);

    expect(merged.canMoveToProject?.("chat-1")).toBe(false);
    expect(merged.canMoveToProject?.("work-1")).toBe(true);
    merged.onMoveToProject?.("work-1", "Brief", "project-a");
    merged.onMoveToProject?.("chat-1", "Chat", undefined);
    expect(work.onMoveToProject).toHaveBeenCalledExactlyOnceWith("work-1", "Brief", "project-a");
  });
});
