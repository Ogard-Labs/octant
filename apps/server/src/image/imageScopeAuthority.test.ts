import { describe, expect, it } from "vitest";
import { chatImageScopeAllowedForWindow } from "./imageScopeAuthority";

const projectId = "a1000000-0000-4000-8000-000000000001";
const otherProjectId = "a1000000-0000-4000-8000-000000000002";

const admitsOnly =
  (shown: string | null) =>
  (id: string | null): boolean =>
    String(id) === String(shown);

describe("chatImageScopeAllowedForWindow", () => {
  it("allows a living Chat thread that belongs to the window's Chat Project", () => {
    expect(
      chatImageScopeAllowedForWindow({
        chatAdmits: admitsOnly(projectId),
        thread: { projectId, lifecycle: "active" },
      }),
    ).toBe(true);
  });

  it("allows an unscoped Chat thread only when the window Chat context is unscoped", () => {
    expect(
      chatImageScopeAllowedForWindow({
        chatAdmits: admitsOnly(null),
        thread: { lifecycle: "active" },
      }),
    ).toBe(true);
  });

  it("refuses a Chat thread from another Project", () => {
    expect(
      chatImageScopeAllowedForWindow({
        chatAdmits: admitsOnly(projectId),
        thread: { projectId: otherProjectId, lifecycle: "active" },
      }),
    ).toBe(false);
  });

  it("refuses a deleted Chat thread even on the matching Project", () => {
    expect(
      chatImageScopeAllowedForWindow({
        chatAdmits: admitsOnly(projectId),
        thread: { projectId, lifecycle: "deleted" },
      }),
    ).toBe(false);
  });

  it("refuses when the window has no Chat workspace context", () => {
    expect(
      chatImageScopeAllowedForWindow({
        chatAdmits: undefined,
        thread: { projectId, lifecycle: "active" },
      }),
    ).toBe(false);
  });
});
