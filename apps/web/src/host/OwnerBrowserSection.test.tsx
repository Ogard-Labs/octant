import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { OwnerBrowserClient, OwnerBrowserClientResult } from "@octant/client-runtime";
import { decodeOwnerBrowserResponse } from "@octant/contracts/owner-browser";
import { OwnerBrowserSection } from "./OwnerBrowserSection";

const target = {
  hostMemberId: "a7880000-0000-4000-8000-000000000001",
  threadId: "a7880000-0000-4000-8000-000000000002",
  contextId: "a7880000-0000-4000-8000-000000000003",
  targetVersion: "a".repeat(64),
  documentRevision: 1,
  origin: "https://fixture.invalid",
  profile: "private",
};
const id = "a7880000-0000-4000-8000-000000000004";
const control = {
  id,
  target,
  controllerName: "Synthetic owner phone",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  nextSequence: 1,
};
const targets = decodeOwnerBrowserResponse({
  status: "targets",
  targets: [{ target, threadTitle: "Synthetic Code page" }],
});
const controlled = decodeOwnerBrowserResponse({ status: "controlled", control });
const frame = decodeOwnerBrowserResponse({
  status: "frame",
  control: { ...control, nextSequence: 2 },
  frame: {
    sequence: 1,
    documentRevision: 1,
    width: 1,
    height: 1,
    dataUrl: "data:image/jpeg;base64,AA==",
  },
});

describe("owner Browser controls", () => {
  it("offers only selected existing pages, clears private text after input and explicitly hands back", async () => {
    const commands: string[] = [];
    const client: OwnerBrowserClient = {
      browser: async (command) => {
        commands.push(command.kind);
        return command.kind === "targets"
          ? targets
          : command.kind === "take-over"
            ? controlled
            : command.kind === "frame"
              ? frame
              : command.kind === "hand-back"
                ? { status: "released" }
                : { status: "input", effect: "completed", nextSequence: 3 };
      },
    };
    const user = userEvent.setup();
    render(<OwnerBrowserSection client={client} hostName="Synthetic Mac" />);
    await user.click(screen.getByRole("button", { name: "List open pages" }));
    await user.click(
      await screen.findByRole("button", { name: /Unlock and take over Synthetic Code page/ }),
    );
    expect(
      await screen.findByRole("img", { name: /Current person-only Browser frame/ }),
    ).toBeVisible();
    await user.type(screen.getByLabelText("Text to type into the page"), "synthetic-private-text");
    await user.click(screen.getByRole("button", { name: "Type text" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Text to type into the page")).toHaveValue(""),
    );
    await user.click(screen.getByRole("button", { name: "Hand back to the agent" }));
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    expect(commands).toContain("input");
    expect(commands.at(-1)).toBe("hand-back");
  });

  it("discards a delayed frame when the authenticated owner client changes", async () => {
    const delayed = Promise.withResolvers<OwnerBrowserClientResult>();
    const started = Promise.withResolvers<void>();
    const client: OwnerBrowserClient = {
      browser: async (command) =>
        command.kind === "targets"
          ? targets
          : command.kind === "take-over"
            ? controlled
            : (started.resolve(), delayed.promise),
    };
    const user = userEvent.setup();
    const view = render(<OwnerBrowserSection client={client} hostName="First Mac" />);
    await user.click(screen.getByRole("button", { name: "List open pages" }));
    await user.click(await screen.findByRole("button", { name: /Unlock and take over/ }));
    await started.promise;
    view.rerender(
      <OwnerBrowserSection
        client={{ browser: async () => ({ status: "refused", reason: "unauthorized" }) }}
        hostName="Second Mac"
      />,
    );
    delayed.resolve(frame);
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
    expect(screen.queryByText("Synthetic Code page")).toBeNull();
  });
});
