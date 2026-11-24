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
    expect(acted).toEqual([["undo", raised.noticeId]]);
    await userEvent.click(screen.getByRole("button", { name: "Revoke device" }));
    await waitFor(() => expect(acted.at(-1)).toEqual(["revoke", raised.noticeId]));
  });

  it("asks before revoking, and keeping it leaves the device paired", async () => {
    const { value, acted } = client([raised]);
    render(<ChangeNotices client={value} />);
    expect(await screen.findByText(/raised “Fix login”/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Revoke Ada's phone" }));
    expect(screen.getByText("Revoke Ada's phone?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByText("Revoke Ada's phone?")).toBeNull();
    expect(acted).toEqual([]);
    expect(screen.getByRole("button", { name: "Revoke Ada's phone" })).toBeTruthy();
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

  it("from a window, undoes an added key by its notice and revokes the device through this computer's own controls", async () => {
    const keyId = "00000000-0000-4000-8000-000000000a11";
    const added: ChangeNotice = {
      kind: "provider-key-added",
      noticeId: "00000000-0000-4000-8000-000000000c03",
      at: "2026-11-22T20:02:00.000Z",
      actor: raised.actor,
      providerInstanceId: "00000000-0000-4000-8000-000000000f01",
      providerName: "Anthropic",
      keyId,
    };
    const { value, acted } = client([added]);
    const local = {
      undoAccessChangeNotice: vi.fn(async () => undefined),
      revokeDevice: vi.fn(async () => undefined),
      endAgentGrant: vi.fn(async () => undefined),
    };
    render(<ChangeNotices client={value} localActions={local} />);
    expect(await screen.findByText("Ada's phone added a key for Anthropic")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    // The host's own Undo is asked with the notice id alone: no key id, no
    // ordinary removal, and no dismissal — its journal records both.
    await waitFor(() => expect(local.undoAccessChangeNotice).toHaveBeenCalledWith(added.noticeId));
    expect(local.undoAccessChangeNotice).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Revoke Ada's phone" }));
    await userEvent.click(screen.getByRole("button", { name: "Revoke device" }));
    await waitFor(() =>
      expect(local.revokeDevice).toHaveBeenCalledWith(
        raised.actor.kind === "device" ? raised.actor.deviceId : "",
      ),
    );
    // Only the revoke's dismissal goes through the notice routes.
    expect(acted).toEqual([["dismiss", added.noticeId]]);
  });

  it("shows the refusal and leaves the notice when a window's Undo is refused", async () => {
    const added: ChangeNotice = {
      kind: "provider-key-added",
      noticeId: "00000000-0000-4000-8000-000000000c04",
      at: "2026-11-22T20:03:00.000Z",
      actor: raised.actor,
      providerInstanceId: "00000000-0000-4000-8000-000000000f01",
      providerName: "Anthropic",
      keyId: "00000000-0000-4000-8000-000000000a12",
    };
    const { value, acted } = client([added]);
    const local = {
      undoAccessChangeNotice: vi.fn(async () => {
        throw new Error("That notice is gone or was already handled.");
      }),
      revokeDevice: vi.fn(async () => undefined),
      endAgentGrant: vi.fn(async () => undefined),
    };
    render(<ChangeNotices client={value} localActions={local} />);
    expect(await screen.findByText("Ada's phone added a key for Anthropic")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("That notice is gone or was already handled.")).toBeTruthy();
    // The refusal dismissed nothing: no route action ran at all.
    expect(acted).toEqual([]);
  });
});
