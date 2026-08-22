import type { LocalServerListener, LocalServerListenerId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { countGroupedLocalServerListeners, groupLocalServerListeners } from "./localServerGroups";

function listener(overrides: Partial<LocalServerListener> = {}): LocalServerListener {
  return {
    listenerId: "lsn_0123456789abcdef0123456789abcdef" as LocalServerListenerId,
    port: 5173,
    url: "http://127.0.0.1:5173/",
    processName: "node",
    framework: "vite",
    workingDirectory: "/Users/example/code/octant",
    workspaceLabel: "octant",
    attribution: "current-checkout",
    startSource: "octant",
    bindScope: "loopback",
    health: "listening",
    openAvailable: true,
    stop: { status: "available", confirmationRequired: false },
    ...overrides,
  } as LocalServerListener;
}

describe("grouping local server listeners", () => {
  it("groups duplicate loopback sockets for one process and port", () => {
    const ipv4 = listener();
    const ipv6 = listener({
      listenerId: "lsn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as LocalServerListenerId,
      url: "http://[::1]:5173/" as LocalServerListener["url"],
      bindScope: "loopback",
    });
    const groups = groupLocalServerListeners([ipv4, ipv6]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.listeners).toEqual([ipv4, ipv6]);
    expect(groups[0]?.primary).toBe(ipv4);
    expect(groups[0]?.port).toBe(5173);
  });

  it("keeps different ports and processes as separate groups", () => {
    const vite = listener();
    const otherPort = listener({
      listenerId: "lsn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as LocalServerListenerId,
      port: 3000 as LocalServerListener["port"],
      url: "http://127.0.0.1:3000/" as LocalServerListener["url"],
    });
    const python = listener({
      listenerId: "lsn_cccccccccccccccccccccccccccccccc" as LocalServerListenerId,
      processName: "python",
      framework: undefined,
    });
    expect(groupLocalServerListeners([vite, otherPort, python])).toHaveLength(3);
  });

  it("does not merge a leftover with the current checkout on the same port", () => {
    const current = listener();
    const leftover = listener({
      listenerId: "lsn_dddddddddddddddddddddddddddddddd" as LocalServerListenerId,
      attribution: "other",
      startSource: "vscode",
    });
    const groups = groupLocalServerListeners([current, leftover]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.primary.attribution).toBe("current-checkout");
    expect(groups[1]?.primary.attribution).toBe("other");
  });

  it("counts a dual-stack process once for the compact summary", () => {
    const ipv4 = listener();
    const ipv6 = listener({
      listenerId: "lsn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as LocalServerListenerId,
      url: "http://[::1]:5173/" as LocalServerListener["url"],
    });
    const leftover = listener({
      listenerId: "lsn_dddddddddddddddddddddddddddddddd" as LocalServerListenerId,
      attribution: "other",
      port: 3000 as LocalServerListener["port"],
      url: "http://127.0.0.1:3000/" as LocalServerListener["url"],
    });
    expect(
      countGroupedLocalServerListeners({ currentCheckout: [ipv4, ipv6], other: [leftover] }),
    ).toBe(2);
  });

  it("prefers a usable Open target as the group's primary listener", () => {
    const silent = listener({
      listenerId: "lsn_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as LocalServerListenerId,
      openAvailable: false,
      health: "unresponsive",
    });
    const answering = listener({
      listenerId: "lsn_ffffffffffffffffffffffffffffffff" as LocalServerListenerId,
      url: "http://[::1]:5173/" as LocalServerListener["url"],
    });
    expect(groupLocalServerListeners([silent, answering])[0]?.primary).toBe(answering);
  });
});
