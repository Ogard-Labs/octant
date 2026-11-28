import { describe, expect, it } from "vitest";
import {
  buildMachineConnectionMap,
  classifyMachineConnectionPath,
  formatDirectConnectionEdgeLabel,
  planMachinePairLink,
  planSelectedMachinesLinks,
  type MachineConnectionMapInput,
} from "./machineConnectionMap";

describe("classifyMachineConnectionPath", () => {
  it("classifies private LAN origins and addresses as lan", () => {
    expect(classifyMachineConnectionPath("https://192.168.1.20:8443")).toBe("lan");
    expect(classifyMachineConnectionPath("https://10.0.0.15:13774")).toBe("lan");
    expect(classifyMachineConnectionPath("https://172.16.0.4:8443")).toBe("lan");
    expect(classifyMachineConnectionPath("https://[fe80::1]:8443")).toBe("lan");
    expect(classifyMachineConnectionPath("192.168.1.20")).toBe("lan");
  });

  it("classifies Tailscale IPv4, IPv6, and ts.net origins as tailscale", () => {
    expect(classifyMachineConnectionPath("https://100.101.102.103:8443")).toBe("tailscale");
    expect(classifyMachineConnectionPath("https://studio.tailnet.ts.net:13774")).toBe("tailscale");
    expect(classifyMachineConnectionPath("https://[fd7a:115c:a1e0::7033:4105]:8443")).toBe(
      "tailscale",
    );
    expect(classifyMachineConnectionPath("mac.tailnet.ts.net")).toBe("tailscale");
  });

  it("classifies loopback, public, empty, and malformed inputs as unknown", () => {
    expect(classifyMachineConnectionPath("https://127.0.0.1:8443")).toBe("unknown");
    expect(classifyMachineConnectionPath("https://8.8.8.8:8443")).toBe("unknown");
    expect(classifyMachineConnectionPath("https://example.com")).toBe("unknown");
    expect(classifyMachineConnectionPath("not a url://bad")).toBe("unknown");
    expect(classifyMachineConnectionPath("")).toBe("unknown");
    expect(classifyMachineConnectionPath(undefined)).toBe("unknown");
  });
});

describe("buildMachineConnectionMap", () => {
  const baseInput: MachineConnectionMapInput = {
    local: {
      hostId: "local",
      displayName: "Laptop",
      role: "spoke",
      listenerOrigin: "https://100.101.102.104:8443",
      hubMemberId: "member-laptop",
      windowGuestMemberId: "member-laptop-window",
    },
    registry: [
      {
        hostId: "member-office",
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
        hostId: "member-hub",
        displayName: "Mac mini",
        origin: "https://mac-mini.tailnet.ts.net:13774",
        through: "hub",
        role: "hub",
        state: "stale",
      },
    ],
    roster: [
      {
        memberId: "member-laptop",
        name: "Laptop",
        role: "spoke",
        addresses: ["100.101.102.104"],
        port: 8443,
      },
      {
        memberId: "member-laptop-window",
        name: "Laptop window",
        role: "guest",
        addresses: [],
      },
      {
        memberId: "member-hub",
        name: "Mac mini",
        role: "hub",
        addresses: ["mac-mini.tailnet.ts.net"],
        port: 13774,
      },
      {
        memberId: "member-studio",
        name: "Studio",
        role: "spoke",
        addresses: ["100.101.102.105"],
        port: 8443,
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
        name: "Unknown box",
        role: "spoke",
        addresses: ["192.168.1.99"],
        port: 8443,
        accepted: false,
      },
    ],
    heldMemberIds: ["member-unconfirmed"],
    unconfirmedByMemberIds: ["member-held"],
  };

  it("separates transport path from trust reason and never treats the hub as a transport path", () => {
    const map = buildMachineConnectionMap(baseInput);
    const directEdges = map.edges.filter((edge) => edge.kind === "direct");

    expect(directEdges.find((edge) => edge.toId === "member-office")).toMatchObject({
      path: "lan",
      trust: "paired",
      label: "Paired by you · LAN",
      status: "connected",
      measured: true,
    });
    expect(directEdges.find((edge) => edge.toId === "member-studio")).toMatchObject({
      path: "tailscale",
      trust: "hub-introduced",
      label: "Introduced by the hub · Tailscale",
      status: "connected",
      measured: true,
    });
    expect(directEdges.find((edge) => edge.toId === "member-hub")).toMatchObject({
      path: "tailscale",
      trust: "hub-introduced",
      label: "Introduced by the hub · Tailscale",
      status: "offline",
      statusLabel: "Not connected",
    });
    expect(formatDirectConnectionEdgeLabel("hub-introduced", "unknown")).toBe(
      "Introduced by the hub",
    );
  });

  it("shows a member refusing confirmation as waiting and a locally held member as unconfirmed", () => {
    const map = buildMachineConnectionMap(baseInput);

    expect(map.nodes.find((node) => node.id === "member-held")).toMatchObject({
      status: "waiting-confirmation",
      statusLabel: "Waiting for that computer to confirm you",
    });
    expect(map.nodes.find((node) => node.id === "member-unconfirmed")).toMatchObject({
      status: "unconfirmed-here",
      statusLabel: "Unconfirmed member",
    });
  });

  it("draws edges between two other hub members strictly as both in the hub and unmeasured", () => {
    const map = buildMachineConnectionMap(baseInput);
    const peerEdges = map.edges.filter((edge) => edge.kind === "hub-roster");

    expect(peerEdges.length).toBeGreaterThan(0);
    expect(
      peerEdges.every((edge) => edge.label === "Both in the hub" && edge.measured === false),
    ).toBe(true);
    expect(
      peerEdges.some(
        (edge) =>
          (edge.fromId === "member-hub" && edge.toId === "member-studio") ||
          (edge.fromId === "member-studio" && edge.toId === "member-hub"),
      ),
    ).toBe(true);
    // A directly paired computer outside the hub has no hub-roster edge to hub members.
    expect(
      peerEdges.some((edge) => edge.fromId === "member-office" || edge.toId === "member-office"),
    ).toBe(false);
  });

  it("excludes this computer's own hub member and window guest from remote nodes", () => {
    const map = buildMachineConnectionMap(baseInput);
    expect(map.nodes.filter((node) => node.kind === "this-computer")).toHaveLength(1);
    expect(map.nodes.find((node) => node.id === "member-laptop")).toBeUndefined();
    expect(map.nodes.find((node) => node.id === "member-laptop-window")).toBeUndefined();
  });
});

describe("planMachinePairLink and planSelectedMachinesLinks", () => {
  it("starts direct pairing or hub join only when one end is this computer, never remote join between two other computers", () => {
    const map = buildMachineConnectionMap({
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
          memberId: "member-laptop",
          name: "Laptop",
          role: "spoke",
          addresses: ["100.101.102.104"],
          port: 8443,
        },
      ],
    });

    const local = map.nodes.find((node) => node.id === "local");
    const lan = map.nodes.find((node) => node.id === "member-lan");
    const studio = map.nodes.find((node) => node.id === "member-studio");
    const laptop = map.nodes.find((node) => node.id === "member-laptop");
    if (!local || !lan || !studio || !laptop) throw new Error("Missing test nodes.");

    expect(planMachinePairLink(local, studio)).toMatchObject({
      kind: "pair-directly",
      action: "pair-directly",
      targetNodeId: "member-studio",
    });
    expect(planMachinePairLink(local, lan)).toMatchObject({
      kind: "join-hub",
      action: "join-hub",
      targetNodeId: "member-lan",
    });
    expect(planMachinePairLink(studio, laptop)).toMatchObject({
      kind: "both-in-hub",
      action: "none",
    });
    expect(planMachinePairLink(lan, studio)).toMatchObject({
      kind: "pair-on-other-computer",
      action: "none",
    });

    const multi = planSelectedMachinesLinks(map.nodes, ["local", "member-studio", "member-laptop"]);
    expect(multi.map((plan) => [plan.fromId, plan.toId, plan.action])).toEqual([
      ["local", "member-studio", "pair-directly"],
      ["local", "member-laptop", "pair-directly"],
      ["member-studio", "member-laptop", "none"],
    ]);
  });
});
