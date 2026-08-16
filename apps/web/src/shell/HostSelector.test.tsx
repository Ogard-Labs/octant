import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HostSelector } from "./HostSelector";
import { decodeHostId, LOCAL_HOST_ID } from "@octant/contracts/host";

const STUDIO = decodeHostId("11111111-1111-4111-8111-111111111111");
const LAPTOP = decodeHostId("22222222-2222-4222-8222-222222222222");

const localHealthy = {
  hostId: LOCAL_HOST_ID,
  displayName: "This Mac",
  health: "healthy" as const,
  capabilities: ["chat", "work", "code"],
};

const studioHealthy = {
  hostId: STUDIO,
  displayName: "Studio",
  health: "healthy" as const,
  capabilities: ["chat", "work", "code"],
};

const laptopStale = {
  hostId: LAPTOP,
  displayName: "Laptop",
  health: "stale" as const,
  capabilities: ["chat", "work", "code"],
};

describe("HostSelector", () => {
  it("renders the default This Mac host with a neutral dot when hosts are not loaded", () => {
    render(<HostSelector />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("This Mac")).toBeInTheDocument();
    const dot = document.querySelector(".host-selector__dot");
    expect(dot).not.toHaveClass("host-selector__dot--healthy");
  });

  it("renders a healthy dot when the host list confirms health", () => {
    render(<HostSelector hosts={[localHealthy]} />);
    const dot = document.querySelector(".host-selector__dot");
    expect(dot).toHaveClass("host-selector__dot--healthy");
  });

  it("collapses to a non-interactive status when only one host is available", () => {
    render(<HostSelector hosts={[localHealthy]} />);
    expect(screen.getByRole("status", { name: "Host: This Mac · Connected" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: /destination host/i })).not.toBeInTheDocument();
  });

  it("renders a fixed Project host without offering alternate selection", () => {
    render(
      <HostSelector
        fixedHostId={LOCAL_HOST_ID}
        hosts={[localHealthy, studioHealthy]}
        selectedHostId={LOCAL_HOST_ID}
      />,
    );
    expect(screen.getByRole("status", { name: "Host: This Mac · Connected" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: /destination host/i })).not.toBeInTheDocument();
  });

  it("renders an unhealthy host without the healthy dot class", () => {
    render(
      <HostSelector
        hosts={[
          {
            hostId: LOCAL_HOST_ID,
            displayName: "This Mac",
            health: "unavailable",
            capabilities: ["chat"],
          },
        ]}
      />,
    );
    const dot = document.querySelector(".host-selector__dot");
    expect(dot).toHaveClass("host-selector__dot--disconnected");
    expect(screen.getByText("Host unavailable")).toBeInTheDocument();
  });

  it("renders a stale host with a warning dot class", () => {
    render(
      <HostSelector
        hosts={[
          {
            hostId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
            displayName: "This Mac",
            health: "stale",
            capabilities: ["chat", "work", "code"],
          },
        ]}
      />,
    );
    const dot = document.querySelector(".host-selector__dot");
    expect(dot).toHaveClass("host-selector__dot--stale");
    expect(screen.getByText("Stale connection")).toBeInTheDocument();
  });

  it("uses a single reported host when the local host id is not present", () => {
    render(
      <HostSelector
        hosts={[
          {
            hostId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
            displayName: "Remote Mac",
            health: "healthy",
            capabilities: ["chat", "work", "code"],
          },
        ]}
      />,
    );
    expect(screen.getByText("Remote Mac")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows an interactive destination-host choice when multiple hosts are available", () => {
    const onSelectHost = vi.fn();
    render(
      <HostSelector
        hosts={[localHealthy, studioHealthy, laptopStale]}
        lastSelectedHealthyHostId={STUDIO}
        onSelectHost={onSelectHost}
        viewScope={{ kind: "all-hosts" }}
      />,
    );

    const combobox = screen.getByRole("combobox", { name: /destination host/i });
    expect(combobox).toBeVisible();
    expect(combobox).toHaveValue(String(STUDIO));

    const options = within(combobox).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[2]).toBeDisabled();
    expect(options[2]).toHaveTextContent(/Laptop/);
    expect(options[2]).toHaveTextContent(/Stale connection/);

    fireEvent.change(combobox, { target: { value: String(LOCAL_HOST_ID) } });
    expect(onSelectHost).toHaveBeenCalledWith(LOCAL_HOST_ID);
  });

  it("preselects the filtered host and keeps the selector changeable until create", () => {
    const onSelectHost = vi.fn();
    render(
      <HostSelector
        hosts={[localHealthy, studioHealthy]}
        onSelectHost={onSelectHost}
        viewScope={{ kind: "host-filter", hostId: STUDIO }}
      />,
    );
    const combobox = screen.getByRole("combobox", { name: /destination host/i });
    expect(combobox).toHaveValue(String(STUDIO));
    fireEvent.change(combobox, { target: { value: String(LOCAL_HOST_ID) } });
    expect(onSelectHost).toHaveBeenCalledWith(LOCAL_HOST_ID);
  });

  it("writes the selected host id onto the create surface for command envelopes", () => {
    render(
      <HostSelector
        hosts={[localHealthy, studioHealthy]}
        selectedHostId={STUDIO}
        viewScope={{ kind: "all-hosts" }}
      />,
    );
    expect(screen.getByTestId("host-selector")).toHaveAttribute("data-host-id", String(STUDIO));
  });
});
