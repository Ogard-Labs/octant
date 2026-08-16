import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_HOST_ID, decodeHostId } from "@octant/contracts/host";
import type {
  FederatedHostLifecycleSnapshot,
  HostFederationLifecycle,
} from "@octant/client-runtime/host-federation-lifecycle";
import {
  FederatedHostsLifecyclePanel,
  FederatedHostsLifecycleStrip,
} from "./FederatedHostsLifecyclePanel";

const LOCAL: FederatedHostLifecycleSnapshot = {
  hostId: LOCAL_HOST_ID,
  kind: "local",
  displayName: "This Mac",
  state: "ready",
  health: "healthy",
  actions: { canReconnect: false, canRevoke: false, canRemove: false },
};

const LAPTOP: FederatedHostLifecycleSnapshot = {
  hostId: decodeHostId("11111111-1111-4111-8111-111111111111"),
  kind: "remote",
  displayName: "Laptop",
  state: "unauthorized",
  health: "unauthorized",
  reasonCode: "expired",
  expiry: { expired: true },
  actions: { canReconnect: false, canRevoke: false, canRemove: true },
};

const OFFICE: FederatedHostLifecycleSnapshot = {
  hostId: decodeHostId("22222222-2222-4222-8222-222222222222"),
  kind: "remote",
  displayName: "Office",
  state: "stale",
  health: "stale",
  actions: { canReconnect: true, canRevoke: false, canRemove: true },
  replayCursor: "cursor-42",
};

function createLifecycle(
  initial: ReadonlyArray<FederatedHostLifecycleSnapshot>,
): HostFederationLifecycle & {
  readonly setSnapshots: (next: ReadonlyArray<FederatedHostLifecycleSnapshot>) => void;
} {
  let snapshots = [...initial];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    setSnapshots(next) {
      snapshots = [...next];
      emit();
    },
    sync: vi.fn(async () => undefined),
    observeTransportChange: vi.fn(),
    list: () => snapshots,
    get: (hostId) => snapshots.find((entry) => entry.hostId === hostId),
    reconnect: vi.fn(async (hostId) => ({
      ok: true,
      hostId: hostId as typeof OFFICE.hostId,
      replayCursor: "cursor-42",
    })),
    revoke: vi.fn(async (hostId) => ({
      ok: true,
      hostId: hostId as typeof LAPTOP.hostId,
      localCredentialRemoved: true,
    })),
    removeLocal: vi.fn(async (hostId) => ({
      ok: true,
      hostId: hostId as typeof LAPTOP.hostId,
      localCredentialRemoved: true,
    })),
    mutationDecision: vi.fn(() => ({
      allowed: false,
      queued: false as const,
      reason: "Host is not ready.",
    })),
    toHostIdentities: () => [],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

describe("FederatedHostsLifecyclePanel", () => {
  it("renders per-host states with expiry guidance and isolated actions", async () => {
    const lifecycle = createLifecycle([LOCAL, LAPTOP, OFFICE]);
    render(<FederatedHostsLifecyclePanel lifecycle={lifecycle} />);

    expect(await screen.findByRole("heading", { name: "Federated hosts" })).toBeInTheDocument();
    expect(screen.getByText("This Mac")).toBeInTheDocument();
    expect(screen.getByText(/Ready/)).toBeInTheDocument();
    expect(screen.getByText(/Session expired/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => {
      expect(lifecycle.reconnect).toHaveBeenCalledWith(OFFICE.hostId);
    });
    expect(await screen.findByText(/resuming from cursor-42/i)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    await waitFor(() => {
      expect(lifecycle.removeLocal).toHaveBeenCalledWith(LAPTOP.hostId);
    });
  });

  it("shows revoke only when the snapshot allows it", async () => {
    const readyRemote: FederatedHostLifecycleSnapshot = {
      ...OFFICE,
      state: "ready",
      health: "healthy",
      actions: { canReconnect: false, canRevoke: true, canRemove: true },
    };
    const lifecycle = createLifecycle([LOCAL, readyRemote]);
    render(<FederatedHostsLifecyclePanel lifecycle={lifecycle} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => {
      expect(lifecycle.revoke).toHaveBeenCalledWith(readyRemote.hostId);
    });
  });
});

describe("FederatedHostsLifecycleStrip", () => {
  it("renders attention only for non-ready remote hosts", () => {
    const lifecycle = createLifecycle([LOCAL, LAPTOP, OFFICE]);
    render(<FederatedHostsLifecycleStrip lifecycle={lifecycle} />);
    expect(screen.getByLabelText("Federated host attention")).toHaveTextContent(
      /Laptop: Unauthorized/,
    );
    expect(screen.getByLabelText("Federated host attention")).toHaveTextContent(/Office: Stale/);
    expect(screen.getByLabelText("Federated host attention")).not.toHaveTextContent("This Mac");
  });

  it("hides when every remote host is ready", () => {
    const lifecycle = createLifecycle([
      LOCAL,
      {
        ...OFFICE,
        state: "ready",
        health: "healthy",
        actions: { ...OFFICE.actions, canReconnect: false },
      },
    ]);
    const { container } = render(<FederatedHostsLifecycleStrip lifecycle={lifecycle} />);
    expect(container).toBeEmptyDOMElement();
  });
});
