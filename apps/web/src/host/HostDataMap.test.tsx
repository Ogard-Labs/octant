import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { localHostDisplayName } from "@octant/client-runtime";
import type { HostDataMap } from "@octant/contracts/host-data-map";
import { HostDataMapView } from "./HostDataMap";

const populated: HostDataMap = {
  host: {
    hostId: "host-1",
    displayName: localHostDisplayName(),
    kind: "desktop",
    serviceMode: "desktop",
    journal: {
      kind: "known",
      path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
    },
    projections: {
      kind: "known",
      path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
    },
    artifacts: [
      {
        name: "Apple toolchain artifacts",
        location: {
          kind: "known",
          path: "/Users/ada/Library/Application Support/Octant/artifacts",
        },
      },
    ],
    caches: [
      {
        name: "Chat scratch",
        location: { kind: "known", path: "/Users/ada/Library/Application Support/Octant/scratch" },
      },
    ],
    credentials: {
      kind: "known",
      backend: "keychain",
      entries: [
        { service: "app.octant.provider-credentials" },
        { service: "app.octant.host-identity.v1" },
      ],
    },
    outbound: [
      {
        kind: "known",
        category: "provider-calls",
        leavesMachine: true,
        purpose: "Requests you send to a configured provider leave this machine.",
      },
      {
        kind: "known",
        category: "update-checks",
        leavesMachine: true,
        purpose: "Signed update checks send version, platform, and architecture.",
      },
      {
        kind: "known",
        category: "marketplace-fetches",
        leavesMachine: true,
        purpose: "Skill search talks to skills.sh and npm when you search the marketplace.",
      },
    ],
  },
  projects: {
    kind: "known",
    projects: [
      {
        projectId: "11111111-1111-4111-8111-111111111111" as never,
        name: "Notes",
        type: "chat",
        journal: {
          kind: "known",
          path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
        },
        projections: {
          kind: "known",
          path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
        },
        artifacts: [
          {
            name: "Canvas and library artifacts",
            location: {
              kind: "known",
              path: "/Users/ada/Library/Application Support/Octant/octant.sqlite3",
            },
          },
        ],
        caches: [{ name: "Thread attachments and scratch", location: { kind: "unknown" } }],
        credentials: {
          kind: "known",
          backend: "keychain",
          entries: [{ service: "app.octant.provider-credentials" }],
        },
      },
    ],
  },
  related: [
    { kind: "thread-retention", settings: { section: "host", setting: "thread-retention" } },
    {
      kind: "thread-export",
      guidance: "Export a thread from that thread's menu. This map does not export or purge.",
    },
  ],
};

describe("HostDataMapView", () => {
  it("renders a populated host and Project map", () => {
    render(<HostDataMapView report={populated} />);

    expect(screen.getByText("Data map")).toBeInTheDocument();
    expect(screen.getByText(localHostDisplayName())).toBeInTheDocument();
    expect(screen.getByText("Desktop app")).toBeInTheDocument();
    expect(
      screen.getAllByText("/Users/ada/Library/Application Support/Octant/octant.sqlite3").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/app\.octant\.provider-credentials/).length).toBeGreaterThan(0);
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("Provider calls")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Thread retention and purge" })).toHaveAttribute(
      "href",
      "#settings-thread-retention",
    );
    expect(screen.getByText(/Export a thread from that thread's menu/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /purge/i })).not.toBeInTheDocument();
  });

  it("renders unknown rather than guessing missing categories", () => {
    const unknown: HostDataMap = {
      host: {
        hostId: "host-1",
        displayName: localHostDisplayName(),
        kind: "headless",
        serviceMode: "service",
        journal: { kind: "unknown" },
        projections: { kind: "unknown" },
        artifacts: [{ name: "Apple toolchain artifacts", location: { kind: "unknown" } }],
        caches: [{ name: "Chat scratch", location: { kind: "unknown" } }],
        credentials: { kind: "unknown" },
        outbound: [{ kind: "unknown", category: "update-checks" }],
      },
      projects: { kind: "unknown" },
      related: [],
    };
    render(<HostDataMapView report={unknown} />);

    expect(screen.getAllByText("unknown").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\/Users\//)).not.toBeInTheDocument();
    expect(screen.queryByText("This Mac")).not.toBeInTheDocument();
  });

  it("names a headless host as headless and does not offer desktop-only guesses", () => {
    const headless: HostDataMap = {
      host: {
        hostId: "host-1",
        displayName: localHostDisplayName(),
        kind: "headless",
        serviceMode: "web",
        journal: { kind: "known", path: "/var/lib/octant/octant.sqlite3" },
        projections: { kind: "known", path: "/var/lib/octant/octant.sqlite3" },
        artifacts: [],
        caches: [],
        credentials: { kind: "unknown" },
        outbound: [
          {
            kind: "known",
            category: "update-checks",
            leavesMachine: false,
            purpose: "This headless host does not check for desktop app updates.",
          },
        ],
      },
      projects: { kind: "known", projects: [] },
      related: [],
    };
    render(<HostDataMapView report={headless} />);

    expect(screen.getByText("Headless host")).toBeInTheDocument();
    expect(screen.getByText(localHostDisplayName())).toBeInTheDocument();
    expect(screen.getByText(/Does not leave this machine/)).toBeInTheDocument();
    expect(screen.getByText("No Projects on this host.")).toBeInTheDocument();
    expect(screen.queryByText("Keychain")).not.toBeInTheDocument();
  });
});
