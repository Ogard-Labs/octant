import type { AccessActivityClient } from "@octant/client-runtime/access-activity-client";
import type { AccessActivityEntry } from "@octant/contracts/access-activity";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccessActivityList } from "./AccessActivityList";

const at = "2026-11-22T20:00:00.000Z";
const phone = {
  kind: "device",
  deviceId: "00000000-0000-4000-8000-000000000b02",
  label: "Ada's phone",
} as const;

function client(pages: ReadonlyArray<ReadonlyArray<AccessActivityEntry>>): AccessActivityClient {
  let read = 0;
  return {
    readActivity: vi.fn(async () => ({ entries: pages[Math.min(read++, pages.length - 1)] ?? [] })),
    readNotices: vi.fn(async () => ({ notices: [] })),
    act: vi.fn(async () => ({ status: "done" as const })),
  };
}

describe("access activity", () => {
  it("lists devices added, re-levelled and removed with who did each, and re-reads when the feed moves", async () => {
    const value = client([
      [],
      [
        {
          kind: "removed",
          entryId: "00000000-0000-4000-8000-000000000a03",
          at,
          deviceId: "00000000-0000-4000-8000-000000000b03",
          deviceLabel: "Tablet",
          reason: "revoked",
          actor: phone,
        },
        {
          kind: "relevelled",
          entryId: "00000000-0000-4000-8000-000000000a02",
          at,
          deviceId: "00000000-0000-4000-8000-000000000b03",
          deviceLabel: "Tablet",
          previousLevel: "full",
          accessLevel: "read-only",
          actor: { kind: "local-person" },
        },
        {
          kind: "added",
          entryId: "00000000-0000-4000-8000-000000000a01",
          at,
          deviceId: "00000000-0000-4000-8000-000000000b03",
          deviceLabel: "Tablet",
          accessLevel: "full",
          actor: {
            kind: "agent",
            grantId: "00000000-0000-4000-8000-000000000e01",
            name: "Build bot",
          },
        },
      ],
    ]);
    const { rerender } = render(<AccessActivityList changeRevision={0} client={value} />);
    expect(await screen.findByText("No devices added, removed or re-levelled yet")).toBeTruthy();

    rerender(<AccessActivityList changeRevision={1} client={value} />);
    expect(await screen.findByText("Tablet removed")).toBeTruthy();
    expect(screen.getByText("Tablet changed from Full to Read only")).toBeTruthy();
    expect(screen.getByText("Tablet added at Full")).toBeTruthy();
    expect(screen.getByText(/By Ada's phone/)).toBeTruthy();
    expect(screen.getByText(/By you on this computer/)).toBeTruthy();
    expect(screen.getByText(/By the agent Build bot/)).toBeTruthy();
    await waitFor(() => expect(value.readActivity).toHaveBeenCalledTimes(2));
  });
});
