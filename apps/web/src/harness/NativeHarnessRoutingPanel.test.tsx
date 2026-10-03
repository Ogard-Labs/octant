import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  const providers = [
    {
      instanceId: "endpoint-1",
      label: "Local endpoint",
      models: [
        { id: "model-a", label: "Model A" },
        { id: "model-b", label: "Model B" },
      ],
    },
  ];

  it("leaves a new model choice empty and unsaved until the person picks one", async () => {
    const user = userEvent.setup();
    const updateRouting = vi.fn();
    render(
      <NativeHarnessRoutingPanel
        client={{ routing: vi.fn(async () => savedJobs), updateRouting }}
        hostId={hostId}
        providers={providers}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Choose a model for Planning" }));

    expect(screen.getByRole("combobox", { name: "Planning, model 1 provider" })).toHaveTextContent(
      "Choose a provider",
    );
    expect(screen.getByRole("combobox", { name: "Planning, model 1" })).toHaveTextContent(
      "Choose a model",
    );
    expect(screen.getByRole("button", { name: "Save slots" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save slots" }));
    expect(updateRouting).not.toHaveBeenCalled();
  });

  it("saves the provider and model the person picked, not the provider's first model", async () => {
    const user = userEvent.setup();
    const updateRouting = vi.fn(async () => ({
      kind: "routing-settings" as const,
      settings: savedJobs,
    }));
    render(
      <NativeHarnessRoutingPanel
        client={{ routing: vi.fn(async () => savedJobs), updateRouting }}
        hostId={hostId}
        providers={providers}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Choose a model for Planning" }));
    await user.click(screen.getByRole("combobox", { name: "Planning, model 1 provider" }));
    await user.click(await screen.findByRole("option", { name: "Local endpoint" }));
    expect(screen.getByRole("combobox", { name: "Planning, model 1" })).toHaveTextContent(
      "Choose a model",
    );
    expect(screen.getByRole("button", { name: "Save slots" })).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "Planning, model 1" }));
    await user.click(await screen.findByRole("option", { name: "Model B" }));
    await user.click(screen.getByRole("button", { name: "Save slots" }));

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: {
        slots: [
          {
            id: "plan",
            candidates: [{ hostId, providerInstanceId: "endpoint-1", modelId: "model-b" }],
          },
        ],
        jobSlots: savedJobs.configuration.jobSlots,
      },
      expectedVersion: savedJobs.version,
    });
  });
  it("keeps a slot and its saved settings while its only model is being changed", async () => {
    const user = userEvent.setup();
    const lead = { hostId, providerInstanceId: "endpoint-1", modelId: "model-a" };
    const promotion = { hostId, providerInstanceId: "endpoint-1", modelId: "model-b" };
    const custom: NativeHarnessRoutingSettings = {
      ...settings,
      configuration: {
        slots: [
          {
            id: "review-pass" as never,
            candidates: [lead as never],
            overflowPromotion: promotion as never,
          },
        ],
        jobSlots: [],
      },
    };
    const updateRouting = vi.fn(async () => ({
      kind: "routing-settings" as const,
      settings: custom,
    }));
    render(
      <NativeHarnessRoutingPanel
        client={{ routing: vi.fn(async () => custom), updateRouting }}
        hostId={hostId}
        providers={[
          ...providers,
          {
            instanceId: "endpoint-2",
            label: "Second endpoint",
            models: [{ id: "model-c", label: "Model C" }],
          },
        ]}
      />,
    );

    await user.click(
      await screen.findByRole("combobox", { name: "review-pass, model 1 provider" }),
    );
    await user.click(await screen.findByRole("option", { name: "Second endpoint" }));
    expect(screen.getByRole("combobox", { name: "review-pass, model 1" })).toHaveTextContent(
      "Choose a model",
    );

    await user.click(screen.getByRole("combobox", { name: "review-pass, model 1" }));
    await user.click(await screen.findByRole("option", { name: "Model C" }));
    await user.click(screen.getByRole("button", { name: "Save slots" }));

    expect(updateRouting).toHaveBeenCalledWith({
      configuration: {
        slots: [
          {
            id: "review-pass",
            candidates: [{ hostId, providerInstanceId: "endpoint-2", modelId: "model-c" }],
            overflowPromotion: promotion,
          },
        ],
        jobSlots: [],
      },
      expectedVersion: custom.version,
    });
  });
});
