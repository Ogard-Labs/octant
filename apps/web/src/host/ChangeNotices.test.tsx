import type { AccessActivityClient } from "@octant/client-runtime/access-activity-client";
import type { ChangeNotice } from "@octant/contracts/access-activity";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChangeNotices } from "./ChangeNotices";

const raised: ChangeNotice = {
  kind: "thread-level-raised",
  noticeId: "00000000-0000-4000-8000-000000000c01",
  at: "2026-11-22T20:00:00.000Z",
  actor: { kind: "device", deviceId: "00000000-0000-4000-8000-000000000b02", label: "Ada's phone" },
  surface: "code",
  threadId: "00000000-0000-4000-8000-000000000d01",
  threadTitle: "Fix login",
  from: "ask-first",
  to: "full-access",
};

const replaced: ChangeNotice = {
  kind: "provider-key-replaced",
  noticeId: "00000000-0000-4000-8000-000000000c02",
  at: "2026-11-22T20:01:00.000Z",
  actor: { kind: "agent", grantId: "00000000-0000-4000-8000-000000000e01", name: "Build bot" },
  providerInstanceId: "00000000-0000-4000-8000-000000000f01",
  providerName: "Anthropic",
};

function client(notices: ReadonlyArray<ChangeNotice>) {
  const acted: Array<readonly [string, string]> = [];
  const value: AccessActivityClient = {
    readActivity: vi.fn(async () => ({ entries: [] })),
    readNotices: vi.fn(async () => ({ notices })),
    act: vi.fn(async (action: "dismiss" | "undo" | "revoke", noticeId: string) => {
      acted.push([action, noticeId]);
      return action === "undo"
        ? {
            status: "refused" as const,
            message: "This thread's level changed again since, so Undo would not put it back.",
          }
        : { status: "done" as const };
    }),
  };
  return { value, acted };
}

describe("change notices", () => {
  it("names who raised a thread, offers Undo and revoking that device, and says why Undo was refused", async () => {
    const { value, acted } = client([raised]);
    render(<ChangeNotices client={value} />);
    expect(
      await screen.findByText("Ada's phone raised “Fix login” from Ask first to Full access"),
    ).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(acted).toEqual([["undo", raised.noticeId]]);
    expect((await screen.findByRole("alert")).textContent).toContain("changed again since");

    await userEvent.click(screen.getByRole("button", { name: "Revoke Ada's phone" }));
    await waitFor(() => expect(acted.at(-1)).toEqual(["revoke", raised.noticeId]));
  });

  it("offers no Undo for a replaced key and says the earlier key is not kept", async () => {
    const { value } = client([replaced]);
    render(<ChangeNotices client={value} />);
    expect(
      await screen.findByText("The agent Build bot replaced the key for Anthropic"),
    ).toBeTruthy();
    expect(screen.getByText(/No Undo: the earlier key is not kept/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("button", { name: "End Build bot's access" })).toBeTruthy();
  });
});
