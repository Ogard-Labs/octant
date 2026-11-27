import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HubAdministrationOperation } from "../shell/hostBridge";
import HubVisitorLinksSection from "./HubVisitorLinksSection";

const NOW = Date.parse("2026-11-27T10:00:00.000Z");

function renderSection(options: { readonly hubOn: boolean; readonly member: boolean }) {
  const calls: Array<{ operation: HubAdministrationOperation; body: unknown }> = [];
  const request = vi.fn(async (operation: HubAdministrationOperation, sent?: unknown) => {
    calls.push({ operation, body: sent });
    return { status: 200, body: { status: "changed", enabled: true } };
  });
  render(
    <HubVisitorLinksSection
      body={{
        hub: { enabled: false, grants: 0, streams: 0 },
        spoke: {
          links: [
            {
              linkId: "L".repeat(22),
              mode: "chat",
              threadId: "abcdef123456",
              scope: "read",
              expiresAt: NOW + 60_000,
              opened: false,
            },
          ],
          comments: [],
          published: false,
        },
      }}
      hubOn={options.hubOn}
      member={options.member}
      now={() => NOW}
      onChanged={vi.fn(async () => undefined)}
      request={request}
    />,
  );
  return { calls };
}

describe("HubVisitorLinksSection", () => {
  it("turns the hub's visitor links on from the hub's window", async () => {
    const user = userEvent.setup();
    const { calls } = renderSection({ hubOn: true, member: false });
    await user.click(screen.getByRole("switch", { name: "Visitor links" }));
    expect(calls).toEqual([{ operation: "visitors", body: { enabled: true } }]);
    expect(
      await screen.findByText(
        "Visitor links are on. A member's link opens only once that member shares a thread.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Visitor links" })).not.toBeInTheDocument();
  });

  it("lists a member's shared threads by kind, and says when the hub has not taken them yet", () => {
    renderSection({ hubOn: false, member: true });
    expect(screen.queryByRole("switch", { name: "Visitor links" })).not.toBeInTheDocument();
    expect(screen.getByText("Chat thread abcdef12")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The hub has not taken the latest links yet; this computer tries again shortly.",
      ),
    ).toBeInTheDocument();
  });
});
