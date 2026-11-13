import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasId } from "@octant/contracts";
import type {
  CanvasNetworkAccessCommand,
  CanvasNetworkAccessResult,
} from "@octant/contracts/canvas-network";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasNetworkPanel } from "./CanvasNetworkPanel";
import { useCanvasNetworkAccess } from "./useCanvasNetworkAccess";

type NetworkClient = Pick<CanvasClient, "networkAccess" | "setNetworkAccess">;

const canvasId = "11111111-1111-4111-8111-111111111111" as CanvasId;

function hostWith(
  initial: boolean,
  answer?: (command: CanvasNetworkAccessCommand) => CanvasNetworkAccessResult,
) {
  let allowed = initial;
  const networkAccess = vi.fn(async () => ({
    kind: "canvas-network-access" as const,
    canvasId,
    allowed,
  }));
  const setNetworkAccess = vi.fn(async (command: CanvasNetworkAccessCommand) => {
    const result = answer?.(command) ?? {
      kind: "canvas-network-access" as const,
      canvasId,
      allowed: command.allowed,
    };
    if (result.kind === "canvas-network-access") allowed = result.allowed;
    return result;
  });
  const client: NetworkClient = { networkAccess, setNetworkAccess };
  return { client, networkAccess, setNetworkAccess };
}

function Harness(props: {
  readonly client: NetworkClient | undefined;
  readonly offered?: boolean;
}) {
  const network = useCanvasNetworkAccess({
    client: props.client,
    canvasId,
    offered: props.offered ?? true,
  });
  return network.allowed === undefined ? (
    <p>No switch</p>
  ) : (
    <CanvasNetworkPanel network={network} />
  );
}

describe("Canvas Allow network", () => {
  it("is off until the person turns it on, and says what turning it on gives away", async () => {
    const user = userEvent.setup();
    const host = hostWith(false);
    render(<Harness client={host.client} />);

    const toggle = await screen.findByRole("switch", { name: "Allow network" });
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText(/can send anything this Canvas holds to any public address/),
    ).toBeVisible();

    await user.click(toggle);
    expect(host.setNetworkAccess).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: "set-canvas-network-access",
      canvasId,
      allowed: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Allow network" })).toBeChecked(),
    );
    expect(screen.getByText(/Run a prototype again/)).toBeVisible();

    await user.click(screen.getByRole("switch", { name: "Allow network" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Allow network" })).not.toBeChecked(),
    );
    expect(host.setNetworkAccess).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowed: false }),
    );
  });

  it("stays off and shows the host's words when the host refuses", async () => {
    const user = userEvent.setup();
    const host = hostWith(false, () => ({
      kind: "canvas-network-access-refused",
      reason: "local-window-required",
      message: "Only a person at this machine can change a Canvas's network.",
    }));
    render(<Harness client={host.client} />);

    await user.click(await screen.findByRole("switch", { name: "Allow network" }));
    expect(
      await screen.findByText("Only a person at this machine can change a Canvas's network."),
    ).toBeVisible();
    expect(screen.getByRole("switch", { name: "Allow network" })).not.toBeChecked();
  });

  it("offers no switch where the host has none, the read fails, or the client is not offered it", async () => {
    const refusedRead = vi.fn(async () => {
      throw new Error("403");
    });
    const { unmount } = render(<Harness client={{ networkAccess: refusedRead }} />);
    await waitFor(() => expect(refusedRead).toHaveBeenCalled());
    expect(screen.getByText("No switch")).toBeVisible();
    unmount();

    const host = hostWith(true);
    render(<Harness client={host.client} offered={false} />);
    expect(screen.getByText("No switch")).toBeVisible();
    expect(host.networkAccess).not.toHaveBeenCalled();
  });

  it("shows a change in every view of the same Canvas, not only the one it was made in", async () => {
    const user = userEvent.setup();
    const host = hostWith(false);
    // The Canvas in the thread and in the sidebar: two views, one switch.
    render(
      <>
        <Harness client={host.client} />
        <Harness client={host.client} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(2));
    const [first, second] = screen.getAllByRole("switch", { name: "Allow network" });
    if (first === undefined || second === undefined) throw new Error("expected two views");
    expect(second).not.toBeChecked();

    await user.click(first);
    await waitFor(() => expect(second).toBeChecked());
    expect(host.setNetworkAccess).toHaveBeenCalledTimes(1);

    await user.click(second);
    await waitFor(() => expect(first).not.toBeChecked());
  });

  it("leaves a view the host gave no switch without one when another view changes it", async () => {
    const user = userEvent.setup();
    const host = hostWith(false);
    const refusedRead = vi.fn(async () => {
      throw new Error("403");
    });
    render(
      <>
        <Harness client={host.client} />
        <Harness client={{ networkAccess: refusedRead }} />
      </>,
    );
    await user.click(await screen.findByRole("switch", { name: "Allow network" }));
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
    await waitFor(() => expect(refusedRead).toHaveBeenCalledTimes(2));
    expect(screen.getByText("No switch")).toBeVisible();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });
});
