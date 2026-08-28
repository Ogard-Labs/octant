import { describe, expect, it } from "vitest";
import { chatImageScopeAllowedForWindow } from "./imageScopeAuthority";

const projectId = "a1000000-0000-4000-8000-000000000001";
const otherProjectId = "a1000000-0000-4000-8000-000000000002";

describe("chatImageScopeAllowedForWindow", () => {
  it("allows a living Chat thread that belongs to the window's Chat Project", () => {
    expect(
      chatImageScopeAllowedForWindow({
        chatContext: { mode: "chat", projectId },
        thread: { projectId, lifecycle: "active" },
      }),
    ).toBe(true);
  });

  it("allows an unscoped Chat thread only when the window Chat context is unscoped", () => {
    expect(
      chatImageScopeAllowedForWindow({
        chatContext: { mode: "chat", projectId: null },
        thread: { lifecycle: "active" },
      }),
    ).toBe(true);
  });

  it("refuses a Chat thread from another Project", () => {
    expect(
      chatImageScopeAllowedForWindow({
        chatContext: { mode: "chat", projectId },
        thread: { projectId: otherProjectId, lifecycle: "active" },
      }),
    ).toBe(false);
  });

  it("refuses a deleted Chat thread even on the matching Project", () => {
    expect(
      chatImageScopeAllowedForWindow({
        chatContext: { mode: "chat", projectId },
        thread: { projectId, lifecycle: "deleted" },
      }),
    ).toBe(false);
  });

  it("refuses when the window has no Chat workspace context", () => {
    expect(
      chatImageScopeAllowedForWindow({
        chatContext: undefined,
        thread: { projectId, lifecycle: "active" },
      }),
    ).toBe(false);
  });
});
