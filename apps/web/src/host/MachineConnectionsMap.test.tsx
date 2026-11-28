import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MachineConnectionMapInput } from "@octant/domain";
import type { HubAdministrationBridge, HubAdministrationOperation } from "../shell/hostBridge";
import { MachineConnectionsMap } from "./MachineConnectionsMap";

const FIXTURE: MachineConnectionMapInput = {
  local: {
    hostId: "local",
    displayName: "Mac mini",
    role: "hub",
    listenerOrigin: "https://100.101.102.103:8443",
    hubMemberId: "member-hub",
  },
  registry: [
    {
      hostId: "member-lan",
      displayName: "Office Mac",
      origin: "https://192.168.1.40:8443",
      state: "ready",
    },
    {
      hostId: "member-studio",
      displayName: "Studio",
      origin: "https://100.101.102.105:8443",
      through: "hub",
      state: "ready",
    },
    {
      hostId: "member-offline",
      displayName: "Travel Laptop",
      origin: "https://travel.tailnet.ts.net:13774",
      through: "hub",
      state: "stale",
    },
  ],
  roster: [
    {
      memberId: "member-hub",
      name: "Mac mini",
      role: "hub",
      addresses: ["100.101.102.103"],
      port: 8443,
    },
    {
      memberId: "member-studio",
      name: "Studio",
      role: "spoke",
      addresses: ["100.101.102.105"],
      port: 8443,
    },
    {
      memberId: "member-offline",
      name: "Travel Laptop",
      role: "spoke",
      addresses: ["travel.tailnet.ts.net"],
      port: 13774,
    },
    {
      memberId: "member-held",
      name: "Mini PC",
      role: "spoke",
      addresses: ["100.101.102.106"],
      port: 8443,
    },
    {
      memberId: "member-unconfirmed",
      name: "Guest Box",
      role: "spoke",
      addresses: ["192.168.1.99"],
      port: 8443,
      accepted: false,
    },
  ],
  heldMemberIds: ["member-unconfirmed"],
  unconfirmedByMemberIds: ["member-held"],
};

function hubBridge() {
  const calls: Array<{ readonly operation: HubAdministrationOperation; readonly body: unknown }> =
    [];
  const hub: HubAdministrationBridge = {
    hubAdministrationRequest: vi.fn(
      async (operation: HubAdministrationOperation, body?: unknown) => {
        calls.push({ operation, body });
        if (operation === "join-code") {
          return {
            status: 200,
            body: {
              status: "minted",
              code: "octant-join-map-123",
              expiresAt: Date.now() + 300_000,
            },
          };
        }
        return { status: 200, body: {} };
      },
    ),
  };
  return { hub, calls };
}

describe("MachineConnectionsMap", () => {
  it("shows LAN, Tailscale, hub-introduced, waiting confirmation, unconfirmed, offline, and unmeasured peer labels", () => {
    render(<MachineConnectionsMap fixture={FIXTURE} />);

    const diagram = screen.getByRole("region", { name: "Computer connections diagram" });
    expect(within(diagram).getByLabelText("Mac mini map node")).toHaveTextContent(
      "Listener · Tailscale",
    );
    expect(within(diagram).getByLabelText("Office Mac map node")).toHaveTextContent(
      "Paired by you · LAN",
    );
    expect(within(diagram).getByLabelText("Office Mac map node")).toHaveTextContent("Connected");
    expect(within(diagram).getByLabelText("Studio map node")).toHaveTextContent(
      "Introduced by the hub · Tailscale",
    );
    expect(within(diagram).getByLabelText("Mini PC map node")).toHaveTextContent(
      "Waiting for that computer to confirm you",
    );
    expect(within(diagram).getByLabelText("Guest Box map node")).toHaveTextContent(
      "Unconfirmed member",
    );
    expect(within(diagram).getByLabelText("Travel Laptop map node")).toHaveTextContent(
      "Not connected",
    );

    const list = screen.getByRole("list", { name: "Connections list" });
    expect(list).toHaveTextContent("Both in the hub (from roster; not a measured connection)");
  });

  it("starts direct pairing when dragging this computer onto a hub-introduced member", async () => {
    const user = userEvent.setup();
    const onStartDirectPairing = vi.fn();
    render(<MachineConnectionsMap fixture={FIXTURE} onStartDirectPairing={onStartDirectPairing} />);

    const localNode = screen.getByLabelText("Mac mini map node");
    const studioNode = screen.getByLabelText("Studio map node");
    fireEvent.dragStart(localNode);
    fireEvent.dragOver(studioNode);
    fireEvent.drop(studioNode);

    const planRegion = screen.getByRole("region", { name: "Planned computer links" });
    expect(planRegion).toHaveTextContent("Mac mini ↔ Studio");
    await user.click(within(planRegion).getByRole("button", { name: "Pair with Studio" }));
    expect(onStartDirectPairing).toHaveBeenCalledWith(
      expect.objectContaining({ id: "member-studio", displayName: "Studio" }),
    );
  });

  it("starts the existing hub join-code flow when dragging this hub onto a paired computer outside the hub", async () => {
    const user = userEvent.setup();
    const { hub, calls } = hubBridge();
    render(<MachineConnectionsMap fixture={FIXTURE} hub={hub} />);

    const localNode = screen.getByLabelText("Mac mini map node");
    const lanNode = screen.getByLabelText("Office Mac map node");
    fireEvent.dragStart(localNode);
    fireEvent.dragOver(lanNode);
    fireEvent.drop(lanNode);

    const planRegion = screen.getByRole("region", { name: "Planned computer links" });
    await user.click(
      within(planRegion).getByRole("button", { name: "Make hub join code for Office Mac" }),
    );
    expect(await within(planRegion).findByLabelText("Hub join code")).toHaveTextContent(
      "octant-join-map-123",
    );
    expect(calls).toEqual([{ operation: "join-code", body: { owner: false } }]);
  });

  it("never starts a remote join when dragging between two other computers", () => {
    const { hub, calls } = hubBridge();
    const onStartDirectPairing = vi.fn();
    render(
      <MachineConnectionsMap
        fixture={FIXTURE}
        hub={hub}
        onStartDirectPairing={onStartDirectPairing}
      />,
    );

    const studioNode = screen.getByLabelText("Studio map node");
    const lanNode = screen.getByLabelText("Office Mac map node");
    fireEvent.dragStart(studioNode);
    fireEvent.dragOver(lanNode);
    fireEvent.drop(lanNode);

    const planRegion = screen.getByRole("region", { name: "Planned computer links" });
    expect(planRegion).toHaveTextContent("Only a computer itself joins a hub or pairs directly.");
    expect(within(planRegion).queryByRole("button")).toBeNull();
    expect(calls).toEqual([]);
    expect(onStartDirectPairing).not.toHaveBeenCalled();
  });

  it("lists per-pair flows for multi-selected machines and offers a keyboard-accessible list equivalent", async () => {
    const user = userEvent.setup();
    render(<MachineConnectionsMap fixture={FIXTURE} />);

    await user.click(screen.getByRole("checkbox", { name: "Select Mac mini" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Studio" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Office Mac" }));
    await user.click(screen.getByRole("button", { name: "Link selected (3)" }));

    const planRegion = screen.getByRole("region", { name: "Planned computer links" });
    expect(planRegion).toHaveTextContent("Mac mini ↔ Office Mac");
    expect(planRegion).toHaveTextContent("Mac mini ↔ Studio");
    expect(planRegion).toHaveTextContent("Studio ↔ Office Mac");

    // Keyboard list equivalent reaches the same linking panel without dragging.
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("region", { name: "Planned computer links" })).toBeNull();

    const list = screen.getByRole("list", { name: "Connections list" });
    await user.click(within(list).getByRole("button", { name: "Link Mac mini with Studio" }));
    expect(screen.getByRole("region", { name: "Planned computer links" })).toHaveTextContent(
      "Pair Mac mini directly with Studio",
    );
  });

  it("does not mark the hub as an unconfirmed peer on a spoke and reloads when hubRevision changes", async () => {
    let statusCalls = 0;
    const hub = {
      hubAdministrationRequest: async (operation: string) => {
        if (operation !== "status") return { status: 404, body: {} };
        statusCalls += 1;
        return {
          status: 200,
          body: {
            hub: { enabled: false },
            spoke: {
              membership: "member",
              acceptedMemberIds: ["member-peer-1"],
              heldMembers: [],
              roster: {
                roster: {
                  members: [
                    {
                      memberId: "member-hub",
                      name: "Main Hub",
                      role: "hub",
                      addresses: ["100.64.0.1"],
                      port: 49152,
                    },
                    {
                      memberId: "member-spoke",
                      name: "This Laptop",
                      role: "spoke",
                      addresses: ["100.64.0.2"],
                      port: 49152,
                    },
                    {
                      memberId: "member-peer-2",
                      name: "Unconfirmed Peer",
                      role: "spoke",
                      addresses: ["100.64.0.3"],
                      port: 49152,
                    },
                  ],
                },
              },
            },
          },
        };
      },
    };

    const { rerender } = render(
      <MachineConnectionsMap
        hub={hub}
        hubRevision={0}
        listenerStatus={{
          enabled: true,
          state: "ready",
          hostname: "100.64.0.2",
          port: 49152,
          origin: "https://100.64.0.2:49152",
          certificateSource: "self-made",
          exposureClass: "tailscale",
          certificateFingerprint: null,
          certificateReady: true,
          tlsPin: null,
        }}
      />,
    );
    const list = screen.getByRole("list", { name: "Connections list" });
    await vi.waitFor(() => {
      const hubItem = within(list)
        .getAllByRole("listitem")
        .find((item) => item.textContent?.includes("Main Hub"));
      expect(hubItem).toBeDefined();
      expect(hubItem).not.toHaveTextContent("Unconfirmed member");
      const peerItem = within(list)
        .getAllByRole("listitem")
        .find((item) => item.textContent?.includes("Unconfirmed Peer"));
      expect(peerItem).toHaveTextContent("Unconfirmed member");
    });
    expect(statusCalls).toBe(1);

    rerender(
      <MachineConnectionsMap
        hub={hub}
        hubRevision={1}
        listenerStatus={{
          enabled: true,
          state: "ready",
          hostname: "100.64.0.2",
          port: 49152,
          origin: "https://100.64.0.2:49152",
          certificateSource: "self-made",
          exposureClass: "tailscale",
          certificateFingerprint: null,
          certificateReady: true,
          tlsPin: null,
        }}
      />,
    );
    await vi.waitFor(() => expect(statusCalls).toBe(2));
  });
});
