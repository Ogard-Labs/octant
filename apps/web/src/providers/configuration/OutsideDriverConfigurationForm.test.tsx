import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeProviderInstance, type ProviderInstance } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { OutsideDriverConfigurationForm } from "./OutsideDriverConfigurationForm";

const driver = {
  extensionId: "00000000-0000-4000-8000-000000000911",
  packageId: "00000000-0000-4000-8000-000000000912",
  componentId: "provider-driver",
  version: "1.2.0",
  digest: `sha256:${"a".repeat(64)}`,
};

function outside() {
  const instance: ProviderInstance = decodeProviderInstance({
    id: "80000000-0000-4000-8000-000000000011",
    displayName: "Team models",
    driverKind: "outside-harness-endpoint",
    configuration: {
      kind: "outside-harness-endpoint",
      driver,
      baseUrl: "https://models.example.test/v1/",
      key: { header: "authorization", scheme: "Bearer" },
      modelIds: ["model-a", "model-b"],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 3,
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:00:00.000Z",
  });
  if (instance.driverKind !== "outside-harness-endpoint") throw new Error("fixture");
  return instance;
}

type ChangeHandler = ComponentProps<typeof OutsideDriverConfigurationForm>["onChange"];

function changeHandler(result: boolean) {
  return vi.fn<ChangeHandler>(async () => result);
}

function setup(onChange = changeHandler(true)) {
  render(
    <OutsideDriverConfigurationForm
      credentialManagementAvailable
      disabled={false}
      instance={outside()}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe("OutsideDriverConfigurationForm", () => {
  it("opens prefilled with the saved address, key placement, and models", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Edit connection for Team models" }));

    expect(screen.getByLabelText("Address for Team models")).toHaveValue(
      "https://models.example.test/v1/",
    );
    expect(screen.getByLabelText("Model IDs for Team models")).toHaveValue("model-a, model-b");
    expect(screen.getByLabelText("API key for Team models")).toHaveValue("");
    expect(screen.getByText("Leave empty to keep the saved key.")).toBeVisible();
  });

  it("saves new models on the same address without asking for the key again", async () => {
    const user = userEvent.setup();
    const onChange = setup();
    await user.click(screen.getByRole("button", { name: "Edit connection for Team models" }));
    await user.clear(screen.getByLabelText("Model IDs for Team models"));
    await user.type(screen.getByLabelText("Model IDs for Team models"), "model-c model-d");
    await user.click(screen.getByRole("button", { name: "Save connection for Team models" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [instanceId, configuration, credential] = onChange.mock.calls[0] ?? [];
    expect(instanceId).toBe("80000000-0000-4000-8000-000000000011");
    expect(configuration).toMatchObject({
      driver,
      baseUrl: "https://models.example.test/v1/",
      key: { header: "authorization", scheme: "Bearer" },
      modelIds: ["model-c", "model-d"],
    });
    expect(credential?.value).toBe("");
  });

  it("asks for the key again when the address changes and sends it with the change", async () => {
    const user = userEvent.setup();
    const onChange = setup();
    await user.click(screen.getByRole("button", { name: "Edit connection for Team models" }));
    await user.clear(screen.getByLabelText("Address for Team models"));
    await user.type(
      screen.getByLabelText("Address for Team models"),
      "https://other.example.test/v1",
    );

    expect(screen.getByText(/saved key is forgotten/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save connection for Team models" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter the key again/)).toBeVisible();

    await user.type(screen.getByLabelText("API key for Team models"), "sk-new");
    await user.click(screen.getByRole("button", { name: "Save connection for Team models" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [, configuration, credential] = onChange.mock.calls[0] ?? [];
    expect(configuration?.baseUrl).toBe("https://other.example.test/v1");
    expect(credential?.value).toBe("sk-new");
  });

  it("stays open when the host refuses the change, and closes when it accepts", async () => {
    const user = userEvent.setup();
    const onChange = changeHandler(false);
    setup(onChange);
    await user.click(screen.getByRole("button", { name: "Edit connection for Team models" }));
    await user.click(screen.getByRole("button", { name: "Save connection for Team models" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Address for Team models")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Edit connection for Team models" })).toBeVisible();
  });
});
