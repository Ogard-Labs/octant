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

  it("keeps saved routing visible when its providers are unavailable", async () => {
    render(
      <NativeHarnessRoutingPanel
        client={{
          routing: vi.fn(async () => ({
            ...settings,
            configuration: {
              slots: [
                {
                  id: "default" as never,
                  candidates: [
                    {
                      hostId: "00000000-0000-0000-0000-000000000001" as never,
                      providerInstanceId: "missing-provider" as never,
                      modelId: "missing-model" as never,
                    },
                  ],
                },
              ],
              jobSlots: [],
            },
          })),
          updateRouting: vi.fn(),
        }}
        hostId="00000000-0000-0000-0000-000000000001"
        providers={[]}
      />,
    );

    await waitFor(() => expect(screen.getByText("Jobs")).toBeVisible());
    expect(screen.queryByText("No direct-endpoint provider yet")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Main model, model 1 provider" })).toBeVisible();
    expect(screen.getByText("missing-model")).toBeVisible();
  });
});

describe("NativeHarnessRoutingPanel slot rows", () => {
  const hostId = "00000000-0000-0000-0000-000000000001";
  const savedJobs: NativeHarnessRoutingSettings = {
    ...settings,
    configuration: {
      slots: [],
      jobSlots: [{ job: "planner" as never, slotId: "plan" as never }],
    },
  };

  it("names each slot by what it does and sends an unset one to Providers when nothing can fill it", async () => {
    const onOpenProviders = vi.fn();
    render(
      <NativeHarnessRoutingPanel
        client={{ routing: vi.fn(async () => savedJobs), updateRouting: vi.fn() }}
        hostId={hostId}
        onOpenProviders={onOpenProviders}
        providers={[]}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Main model setting" })).toBeVisible(),
    );
    expect(screen.getByRole("group", { name: "Quick jobs setting" })).toBeVisible();
    expect(screen.queryByText("smol")).not.toBeInTheDocument();
    const connect = screen.getAllByRole("button", { name: "Connect a provider" });
    expect(connect).toHaveLength(7);
    await connect[0]?.click();
    expect(onOpenProviders).toHaveBeenCalledOnce();
  });

  it("assigns the first available model when an unset slot is filled", async () => {
    render(
      <NativeHarnessRoutingPanel
        client={{ routing: vi.fn(async () => savedJobs), updateRouting: vi.fn() }}
        hostId={hostId}
        providers={[
          {
            instanceId: "endpoint-1",
            label: "Local endpoint",
            models: [{ id: "model-a", label: "Model A" }],
          },
        ]}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Planning setting" })).toBeVisible(),
    );
    await screen.getByRole("button", { name: "Choose a model for Planning" }).click();
    expect(
      await screen.findByRole("combobox", { name: "Planning, model 1 provider" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add a fallback model for Planning" })).toBeVisible();
  });
});
