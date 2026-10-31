import type {
  BrowserExtensionSummary,
  BrowserExtensionsCommand,
  BrowserExtensionsResult,
} from "@octant/contracts/browser-extensions";
import type { BrowserProfilesResult } from "@octant/contracts/browser-profiles";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserExtensionsSection } from "./BrowserExtensionsSection";

const projectId = "40000000-0000-4000-8000-000000000001" as never;
const profiles: BrowserProfilesResult = {
  kind: "browser-profiles",
  profiles: [
    { profile: { kind: "personal" }, label: "Personal", sizeBytes: 0 },
    { profile: { kind: "project", projectId }, label: "Research", sizeBytes: 3 },
  ],
};

function extension(overrides: Partial<BrowserExtensionSummary> = {}): BrowserExtensionSummary {
  return {
    id: "a".repeat(32) as never,
    name: "Reading tool",
    version: "1.0.0",
    contentHash: "b".repeat(64),
    access: { permissions: ["storage"], hostPatterns: ["https://example.com/*"] },
    hasPopup: true,
    hasOptionsPage: false,
    enabledIn: [],
    needsConfirmation: [],
    ...overrides,
  };
}

function client(
  state: { extensions: ReadonlyArray<BrowserExtensionSummary> },
  respond?: (command: BrowserExtensionsCommand) => BrowserExtensionsResult | undefined,
) {
  const manageExtensions = vi.fn(async (command: BrowserExtensionsCommand) => {
    const answered = respond?.(command);
    if (answered !== undefined) return answered;
    return { kind: "browser-extensions", extensions: state.extensions } as BrowserExtensionsResult;
  });
  const manageProfiles = vi.fn(async () => profiles);
  return { manageExtensions, manageProfiles };
}

describe("BrowserExtensionsSection", () => {
  it("lists each installed extension and says it is off everywhere until the person turns it on", async () => {
    render(<BrowserExtensionsSection client={client({ extensions: [extension()] })} />);

    expect(await screen.findByText("Reading tool · 1.0.0")).toBeInTheDocument();
    expect(screen.getByText("Off everywhere.")).toBeInTheDocument();
  });

  it("enables only after the dialog states, in plain words, what the extension can read and change", async () => {
    const user = userEvent.setup();
    const api = client({ extensions: [extension()] });
    render(<BrowserExtensionsSection client={api} />);
    await screen.findByText("Reading tool · 1.0.0");

    await user.click(screen.getByRole("button", { name: "Enable Reading tool" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Enable Reading tool in Personal?")).toBeInTheDocument();
    expect(within(dialog).getByText("Read and change https://example.com/*")).toBeInTheDocument();
    expect(api.manageExtensions).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "Enable" }));

    await waitFor(() =>
      expect(api.manageExtensions).toHaveBeenCalledWith({
        kind: "enable",
        extensionId: "a".repeat(32),
        profile: { kind: "personal" },
        contentHash: "b".repeat(64),
      }),
    );
    expect(await screen.findByText("Turned Reading tool on in Personal.")).toBeInTheDocument();
  });

  it("offers only the profiles the extension is not already on, and turns it off per profile", async () => {
    const user = userEvent.setup();
    const api = client({ extensions: [extension({ enabledIn: [{ kind: "personal" }] })] });
    render(<BrowserExtensionsSection client={api} />);
    await screen.findByText("On in Personal.");

    await user.click(screen.getByRole("button", { name: "Turn Reading tool off in Personal" }));

    await waitFor(() =>
      expect(api.manageExtensions).toHaveBeenCalledWith({
        kind: "disable",
        extensionId: "a".repeat(32),
        profile: { kind: "personal" },
      }),
    );
  });

  it("asks again, naming only what is new, when an update asks for more", async () => {
    const user = userEvent.setup();
    const api = client({
      extensions: [
        extension({
          enabledIn: [],
          needsConfirmation: [{ kind: "personal" }],
          addedAccess: { permissions: ["cookies"], hostPatterns: [] },
        }),
      ],
    });
    render(<BrowserExtensionsSection client={api} />);
    expect(
      await screen.findByText(/An update asks for more, so it is off in Personal/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Enable Reading tool" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/asks for more than the version you allowed/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/example\.com/)).not.toBeInTheDocument();
  });

  it("removes an extension only after the person confirms", async () => {
    const user = userEvent.setup();
    const api = client({ extensions: [extension()] });
    render(<BrowserExtensionsSection client={api} />);
    await screen.findByText("Reading tool · 1.0.0");

    await user.click(screen.getByRole("button", { name: "Remove Reading tool" }));
    expect(api.manageExtensions).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(api.manageExtensions).toHaveBeenCalledWith({
        kind: "remove",
        extensionId: "a".repeat(32),
      }),
    );
  });

  it("installs the folder the native picker returned, by its receipt alone", async () => {
    const user = userEvent.setup();
    const api = client({ extensions: [] });
    const pickExtensionFolder = vi.fn(async () => ({
      receiptId: "receipt-1",
      displayName: "reading-tool",
    }));
    render(<BrowserExtensionsSection client={api} pickExtensionFolder={pickExtensionFolder} />);
    await screen.findByText("No extensions installed.");

    await user.click(screen.getByRole("button", { name: "Install extension…" }));

    await waitFor(() =>
      expect(api.manageExtensions).toHaveBeenCalledWith({
        kind: "install",
        receiptId: "receipt-1",
      }),
    );
    expect(
      await screen.findByText(
        "Installed reading-tool. It is off until you enable it in a profile.",
      ),
    ).toBeInTheDocument();
  });

  it("reports a refusal in the host's words rather than claiming success", async () => {
    const user = userEvent.setup();
    const api = client({ extensions: [] }, (command) =>
      command.kind === "install"
        ? {
            kind: "browser-extension-refused",
            reason: "extension-unsupported",
            message: "Only Manifest V3 extensions can be installed.",
          }
        : undefined,
    );
    render(
      <BrowserExtensionsSection
        client={api}
        pickExtensionFolder={async () => ({ receiptId: "r", displayName: "old" })}
      />,
    );
    await screen.findByText("No extensions installed.");

    await user.click(screen.getByRole("button", { name: "Install extension…" }));

    expect(
      await screen.findByText("Only Manifest V3 extensions can be installed."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Installed/)).not.toBeInTheDocument();
  });

  it("says why extensions are unavailable instead of listing nothing", async () => {
    const api = client({ extensions: [] }, () => ({
      kind: "browser-extension-refused",
      reason: "extension-not-local",
      message: "Extensions are managed from a window on this computer.",
    }));
    render(<BrowserExtensionsSection client={api} />);

    expect(
      await screen.findByText("Extensions are managed from a window on this computer."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install extension/ })).not.toBeInTheDocument();
  });
});
