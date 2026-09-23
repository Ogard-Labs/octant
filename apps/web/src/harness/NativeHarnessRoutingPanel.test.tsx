import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NativeHarnessRoutingSettings } from "@octant/contracts";
import { NativeHarnessRoutingPanel } from "./NativeHarnessRoutingPanel";

const settings: NativeHarnessRoutingSettings = {
  configuration: { slots: [], jobSlots: [] },
  version: 1 as never,
  updatedAt: "2026-09-05T12:00:00.000Z" as never,
};

describe("NativeHarnessRoutingPanel", () => {
  it("explains how to connect a provider instead of showing empty model slots", async () => {
    const onOpenProviders = vi.fn();
    render(
      <NativeHarnessRoutingPanel
        client={{
          routing: vi.fn(async () => settings),
          updateRouting: vi.fn(),
        }}
        hostId="00000000-0000-0000-0000-000000000001"
        onOpenProviders={onOpenProviders}
        providers={[]}
      />,
    );

    await waitFor(() => expect(screen.getByText("No direct-endpoint provider yet")).toBeVisible());
    expect(screen.getByText("Model slots")).toBeVisible();
    expect(screen.queryByText("Jobs")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save slots" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Open Providers & Models" }).click();
    expect(onOpenProviders).toHaveBeenCalledOnce();
  });
});
