import { decodeProviderInstanceId, type ProviderInstance } from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OctantHostBridge } from "../shell/hostBridge";
import { ProviderApiKeyEditor, acceptsApiKeyPool } from "./ProviderApiKeyEditor";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000301");
const WORK = { id: "7d444840-9dc0-11d1-b245-5ffdce74fad2", label: "Work" };
const PERSONAL = { id: "8e555951-0ad1-22e2-c356-6ffdce74fad3", label: "Personal" };

function bridgeWith(keys: ReadonlyArray<{ readonly id: string; readonly label: string }>) {
  const listed = [...keys];
  const host = {
    listProviderApiKeys: vi.fn(async () => [...listed]),
    addProviderApiKey: vi.fn(async (_id: string, _secret: string, label?: string) => ({
      id: "9f666062-1bf2-33f3-d467-7ffdce74fad4",
      label: label ?? "Key 3",
    })),
    renameProviderApiKey: vi.fn(async () => undefined),
    replaceProviderApiKey: vi.fn(async () => undefined),
    removeProviderApiKey: vi.fn(async () => undefined),
  };
  return host;
}

function renderEditor(bridge: Partial<OctantHostBridge>, onChanged = vi.fn()) {
  const host = bridge as unknown as OctantHostBridge;
  render(
    <ProviderApiKeyEditor
      bridge={host}
      displayName="Team gateway"
      instanceId={instanceId}
      onChanged={onChanged}
    />,
  );
  return { onChanged };
}

describe("ProviderApiKeyEditor", () => {
  it("lists the keys in the order they are tried, with labels and no secrets", async () => {
    const host = bridgeWith([WORK, PERSONAL]);
    renderEditor(host);

    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Work"),
      expect.stringContaining("Personal"),
    ]);
    expect(items[0]).toHaveTextContent("Tried first");
    expect(items[1]).not.toHaveTextContent("Tried first");
    expect(document.body.textContent).not.toContain("sk-");
  });

  it("adds a labelled key and clears the secret field", async () => {
    const user = userEvent.setup();
    const host = bridgeWith([WORK]);
    const { onChanged } = renderEditor(host);
    await screen.findByText("Work");

    await user.type(screen.getByLabelText("Label for the new API key"), "Team");
    const secret = screen.getByLabelText("New API key");
    await user.type(secret, "sk-team-0000");
    await user.click(screen.getByRole("button", { name: "Add key" }));

    await waitFor(() =>
      expect(host.addProviderApiKey).toHaveBeenCalledWith(instanceId, "sk-team-0000", "Team"),
    );
    await waitFor(() => expect(secret).toHaveValue(""));
    expect(onChanged).toHaveBeenLastCalledWith("stored");
  });

  it("adds a key without a label when the label is left empty", async () => {
    const user = userEvent.setup();
    const host = bridgeWith([]);
    renderEditor(host);
    await screen.findByRole("form", { name: /Add an API key/ });

    await user.type(screen.getByLabelText("New API key"), "sk-first-0000");
    await user.click(screen.getByRole("button", { name: "Add key" }));

    await waitFor(() =>
      expect(host.addProviderApiKey).toHaveBeenCalledWith(instanceId, "sk-first-0000", undefined),
    );
  });

  it("sends nothing when the new key is empty", async () => {
    const user = userEvent.setup();
    const host = bridgeWith([WORK]);
    renderEditor(host);
    await screen.findByText("Work");

    await user.click(screen.getByRole("button", { name: "Add key" }));

    expect(await screen.findByText("Enter an API key first.")).toBeInTheDocument();
    expect(host.addProviderApiKey).not.toHaveBeenCalled();
  });

  it("shows the host's refusal for a duplicate label and keeps the typed key", async () => {
    const user = userEvent.setup();
    const host = bridgeWith([WORK]);
    host.addProviderApiKey.mockRejectedValueOnce(
      new Error("Two keys for this provider cannot have the same label."),
    );
    renderEditor(host);
    await screen.findByText("Work");

    await user.type(screen.getByLabelText("Label for the new API key"), "work");
    const secret = screen.getByLabelText("New API key");
    await user.type(secret, "sk-team-0000");
    await user.click(screen.getByRole("button", { name: "Add key" }));

    expect(
      await screen.findByText("Two keys for this provider cannot have the same label."),
    ).toBeInTheDocument();
    expect(secret).toHaveValue("sk-team-0000");
  });

  it("renames a key without touching its secret", async () => {
    const user = userEvent.setup();
    const host = bridgeWith([WORK]);
    renderEditor(host);
    await screen.findByText("Work");

    await user.click(screen.getByRole("button", { name: "Rename Work" }));
    const input = screen.getByLabelText("New label for Work");
    await user.clear(input);
    await user.type(input, "Client");
    await user.click(screen.getByRole("button", { name: "Save label" }));

    await waitFor(() =>
      expect(host.renameProviderApiKey).toHaveBeenCalledWith(instanceId, WORK.id, "Client"),
    );
  });

  it("replaces a key's secret after asking for it", async () => {
    const user = userEvent.setup();
    const host = bridgeWith([WORK]);
    renderEditor(host);
    await screen.findByText("Work");

    await user.click(screen.getByRole("button", { name: "Replace the key for Work" }));
    await user.type(screen.getByLabelText("New API key for Work"), "sk-rotated-2222");
    await user.click(screen.getByRole("button", { name: "Replace key" }));

    await waitFor(() =>
      expect(host.replaceProviderApiKey).toHaveBeenCalledWith(
        instanceId,
        WORK.id,
        "sk-rotated-2222",
      ),
    );
  });

  it("removes a key only after a second confirmation", async () => {
    const user = userEvent.setup();
    const host = bridgeWith([WORK, PERSONAL]);
    renderEditor(host);
    await screen.findByText("Work");

    await user.click(screen.getByRole("button", { name: "Remove Work" }));
    expect(host.removeProviderApiKey).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove Work" }));

    await waitFor(() =>
      expect(host.removeProviderApiKey).toHaveBeenCalledWith(instanceId, WORK.id),
    );
  });

  it("reports the instance as missing once its last key is removed", async () => {
    const user = userEvent.setup();
    const host = bridgeWith([WORK]);
    host.listProviderApiKeys.mockResolvedValueOnce([WORK]).mockResolvedValue([]);
    const { onChanged } = renderEditor(host);
    await screen.findByText("Work");

    await user.click(screen.getByRole("button", { name: "Remove Work" }));
    await user.click(screen.getByRole("button", { name: "Remove Work" }));

    await waitFor(() => expect(onChanged).toHaveBeenLastCalledWith("missing"));
  });

  it("explains that keys are managed in the host app when no bridge is present", () => {
    render(
      <ProviderApiKeyEditor
        bridge={undefined}
        displayName="Team gateway"
        instanceId={instanceId}
      />,
    );
    expect(screen.getByText(/Manage API keys in the Octant host app/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add key" })).not.toBeInTheDocument();
  });
});

describe("acceptsApiKeyPool", () => {
  function instance(configuration: Record<string, unknown>): ProviderInstance {
    return { configuration } as unknown as ProviderInstance;
  }

  it("accepts an instance that stores a plain API key", () => {
    expect(
      acceptsApiKeyPool(instance({ kind: "anthropic-compatible-http", authentication: "api-key" })),
    ).toBe(true);
    expect(
      acceptsApiKeyPool(instance({ kind: "openai-compatible-http", authentication: "bearer" })),
    ).toBe(true);
  });

  it("refuses an instance whose stored value is a sign-in grant", () => {
    expect(
      acceptsApiKeyPool(
        instance({
          kind: "anthropic-compatible-http",
          authentication: "bearer",
          oauthDescriptorId: "anthropic-console",
        }),
      ),
    ).toBe(false);
  });

  it("refuses an instance that uses no credential", () => {
    expect(
      acceptsApiKeyPool(instance({ kind: "openai-compatible-http", authentication: "none" })),
    ).toBe(false);
  });
});
