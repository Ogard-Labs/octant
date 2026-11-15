import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PickerGroup } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { ThreadAccountControl } from "./ThreadAccountControl";

const work = "84000000-0000-4000-8000-0000000000b1" as never;
const personal = "84000000-0000-4000-8000-0000000000b2" as never;

function account(id: string, displayName: string): PickerGroup {
  return {
    instance: { id, displayName, driverKind: "claude", enabled: true },
    readiness: "ready",
    sections: [{ models: [{ model: { id: "model-a" } }] }],
  } as never;
}

const groups = [account(work, "Work"), account(personal, "Personal")];

describe("choosing a thread's account from its info panel", () => {
  it("sets the usage-limit hand-off to the account the person picks", async () => {
    const user = userEvent.setup();
    const onUsageLimitHandoffChange = vi.fn(async () => undefined);
    render(
      <ThreadAccountControl
        groups={groups}
        modelId={"model-a" as never}
        onUsageLimitHandoffChange={onUsageLimitHandoffChange}
        providerInstanceId={work}
        usageLimitHandoff={undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "This thread's account" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Hand off to Personal" }));
    expect(onUsageLimitHandoffChange).toHaveBeenCalledWith(personal);
  });

  it("offers Move to account and moves the thread to the account picked", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn(async () => undefined);
    render(
      <ThreadAccountControl
        groups={groups}
        modelId={"model-a" as never}
        onMove={onMove}
        onUsageLimitHandoffChange={vi.fn(async () => undefined)}
        providerInstanceId={work}
        usageLimitHandoff={undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "This thread's account" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move to account…" }));
    await user.click(await screen.findByRole("button", { name: "Personal" }));
    expect(onMove).toHaveBeenCalledWith(personal);
  });

  it("says when the last usage limit could not hand off, and why", () => {
    render(
      <ThreadAccountControl
        groups={groups}
        modelId={"model-a" as never}
        onUsageLimitHandoffChange={vi.fn(async () => undefined)}
        providerInstanceId={work}
        usageLimitHandoff={{
          providerInstanceId: personal,
          last: {
            kind: "stopped",
            stopId: "turn-1",
            fromProviderInstanceId: work,
            toProviderInstanceId: personal,
            at: "2026-11-15T10:00:00.000Z" as never,
            detail: "Personal is turned off.",
          },
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Work hit its usage limit; did not hand off to Personal. Personal is turned off.",
    );
  });
});
