import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProviderInstanceId, ProviderObservedState } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { autoReviewFor } from "./autoReview";
import { CodeSettingsView } from "./CodeSettingsView";
import { PermissionModePicker } from "./PermissionModePicker";

const id = (value: string) => value as ProviderInstanceId;
const instance = (value: string, driverKind: string, enabled = true) =>
  ({ id: id(value), driverKind, enabled, displayName: value }) as never;
const observed = (entries: ReadonlyArray<[string, "supported" | "unsupported"]>) =>
  new Map(
    entries.map(([key, harnessAutoReview]) => [
      id(key),
      { capabilities: { harnessAutoReview } } as unknown as ProviderObservedState,
    ]),
  );

describe("who answers a thread's prompts at Auto, as the picker shows it", () => {
  const instances = [
    instance("claude", "claude"),
    instance("opencode", "opencode"),
    instance("vibe", "mistral-vibe"),
    instance("off", "opencode", false),
    instance("omp", "oh-my-pi"),
  ];
  const observedByInstance = observed([["claude", "supported"]]);
  const review = (providerInstanceId: string, chosen?: "provider" | "octant-shield") =>
    autoReviewFor({
      providerInstanceId: id(providerInstanceId),
      instances,
      observedByInstance,
      chosen,
    });

  it("keeps a key provider's own reviewer by default and uses Octant Shield elsewhere", () => {
    expect(review("claude")).toEqual({ status: "reviewer", reviewer: "provider" });
    expect(review("opencode")).toEqual({ status: "reviewer", reviewer: "octant-shield" });
    expect(review("vibe")).toEqual({ status: "reviewer", reviewer: "octant-shield" });
    expect(review("claude", "octant-shield")).toEqual({
      status: "reviewer",
      reviewer: "octant-shield",
    });
  });

  it("says why Auto asks first where no reviewer can run", () => {
    expect(review("off")).toMatchObject({ status: "none" });
    expect(review("omp")).toMatchObject({ status: "none" });
  });

  it("offers Auto on a runtime with no reviewer of its own, in Octant Shield's name", async () => {
    const user = userEvent.setup();
    render(
      <PermissionModePicker
        autoReview={{ status: "reviewer", reviewer: "octant-shield" }}
        autoSupported={false}
        onChange={() => undefined}
        value="auto"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Mode" });
    expect(trigger).toHaveTextContent("Auto");
    expect(trigger).toHaveAttribute(
      "title",
      "Octant Shield approves each action and asks you when unsure.",
    );
    await user.click(trigger);
    expect(
      await screen.findByRole("menuitemradio", { name: /Auto · Recommended/ }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("lists Auto unavailable with the reason when no reviewer can run", async () => {
    const user = userEvent.setup();
    render(
      <PermissionModePicker
        autoReview={{
          status: "none",
          reason: "No Octant Shield model can run for this thread, so it asks first.",
        }}
        autoSupported={false}
        onChange={() => undefined}
        value="auto"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Mode" });
    expect(trigger).toHaveTextContent("Ask first");
    await user.click(trigger);
    expect(
      await screen.findByText("No Octant Shield model can run for this thread, so it asks first."),
    ).toBeVisible();
  });
});

describe("Settings › Access reviewer and Shield model", () => {
  const settings = {
    defaultExecutionPolicy: "approval-gated",
    defaultPermissionPersistence: "current-session",
    version: 1,
    updatedAt: "2026-10-31T12:00:00.000Z",
  } as const;

  it("saves the Auto reviewer the moment it is chosen", async () => {
    const update = vi.fn(async () => true);
    render(<CodeSettingsView onUpdate={update} settings={settings as never} />);
    const field = screen.getByRole("combobox", { name: "Auto reviewer" });
    expect(field).toHaveTextContent("Provider's own");
    await chooseSelectFieldOption(userEvent.setup(), field, "Octant Shield");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ autoReviewer: "octant-shield" }));
  });

  it("offers each enabled provider's models for Shield and returns to the thread's own", async () => {
    const update = vi.fn(async () => true);
    const chosen = {
      providerInstanceId: id("00000000-0000-4000-8000-0000000000a1"),
      modelId: "local-small" as never,
    };
    render(
      <CodeSettingsView
        onUpdate={update}
        providerSnapshot={
          {
            instances: [
              { id: chosen.providerInstanceId, displayName: "Local", enabled: true },
              {
                id: id("00000000-0000-4000-8000-0000000000a2"),
                displayName: "Off",
                enabled: false,
              },
            ],
            catalogs: [
              {
                instanceId: chosen.providerInstanceId,
                models: [{ id: chosen.modelId, displayName: "Local small" }],
              },
            ],
          } as never
        }
        settings={{ ...settings, shieldModel: chosen } as never}
      />,
    );
    const field = screen.getByRole("combobox", { name: "Shield model" });
    expect(field).toHaveTextContent("Local · Local small");
    await chooseSelectFieldOption(
      userEvent.setup(),
      field,
      "Each thread's provider, smallest model",
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ shieldModel: null }));
  });
});
