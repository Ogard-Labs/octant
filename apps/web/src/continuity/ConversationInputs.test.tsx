import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeConversationInputReceipt } from "@octant/contracts/conversation-inputs";
import { ConversationInputs } from "./ConversationInputs";
const id = "11111111-1111-4111-8111-111111111111";
const receipt = decodeConversationInputReceipt({
  snapshotId: id,
  purpose: "provider-switch",
  policy: "preserve",
  byteLength: 100,
  digest: "a".repeat(64),
  included: 1,
  omitted: 1,
});
afterEach(() => vi.unstubAllGlobals());
describe("the destination's original input receipt", () => {
  it("reads the exact admitted manifest on demand and distinguishes originals from explicit omissions", async () => {
    const original = {
      source: { mode: "work", threadId: id, attachmentId: id },
      displayName: "Original document.txt",
      mediaType: "text/plain",
      byteLength: 100,
      digest: "a".repeat(64),
    };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        status: "available",
        manifest: {
          version: 1,
          purpose: "provider-switch",
          items: [
            { status: "included", input: original },
            {
              status: "omitted",
              input: {
                ...original,
                source: {
                  ...original.source,
                  attachmentId: "22222222-2222-4222-8222-222222222222",
                },
                displayName: "Screenshot.png",
                mediaType: "image/png",
              },
              reason: "person-excluded",
            },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <ConversationInputs
        mode="work"
        threadId={id}
        admissionId={id}
        receipt={receipt}
        serverUrl="http://127.0.0.1:3100"
        windowCapability="window-token"
      />,
    );
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Original inputs/ }));
    expect(await screen.findByText("Original document.txt")).toBeTruthy();
    expect(screen.getByText(/Screenshot.png/)).toBeTruthy();
    expect(screen.getByText(/Omitted: text-only choice/)).toBeTruthy();
    const url = String(fetch.mock.calls[0]?.[0]);
    expect(url).toContain(`admissionId=${id}`);
    expect(url).toContain(`snapshotId=${id}`);
    expect(url).not.toContain("Original document");
  });
  it("clears an old host's manifest and reports unavailable inputs without replacing them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "unavailable" })),
    );
    const { rerender } = render(
      <ConversationInputs
        mode="work"
        threadId={id}
        admissionId={id}
        receipt={receipt}
        serverUrl="http://127.0.0.1:3100"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Original inputs/ }));
    expect(await screen.findByText(/admitted input manifest is unavailable/)).toBeTruthy();
    rerender(
      <ConversationInputs
        mode="work"
        threadId={id}
        admissionId={id}
        receipt={receipt}
        serverUrl="http://127.0.0.1:3200"
      />,
    );
    await waitFor(() =>
      expect(screen.queryByText(/admitted input manifest is unavailable/)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /Original inputs/ }).getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
