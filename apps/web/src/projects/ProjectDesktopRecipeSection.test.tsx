import type { DesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import {
  decodeDesktopPaneAnswer,
  decodeDesktopRecipe,
  type DesktopRecipe,
} from "@octant/contracts/desktop-lease";
import { decodeProjectSummary, type ProjectSummary } from "@octant/contracts/projects";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectDesktopRecipeSection } from "./ProjectDesktopRecipeSection";

type CodeProjectSummary = Extract<ProjectSummary, { readonly type: "code" }>;

function project(desktopRecipe?: DesktopRecipe): CodeProjectSummary {
  const summary = decodeProjectSummary({
    id: "80000000-0000-4000-8000-000000000001",
    type: "code",
    name: "Desktop app",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 3,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    binding: { canonicalRoot: "/repositories/desktop-app" },
    bindingRevisionId: "80000000-0000-4000-8000-000000000002",
    codeAccessPersistence: "current-session",
    ...(desktopRecipe === undefined ? {} : { desktopRecipe }),
  });
  if (summary.type !== "code") throw new Error("Expected a Code Project.");
  return summary;
}

const hostLocal = {
  providerId: "host-local",
  displayName: "This host",
  locality: "host-local",
  billed: false,
} as const;

/** A provider run by a local daemon that holds the person's sign-in, with its placements. */
const spaces = {
  providerId: "spaces.example",
  displayName: "Spaces",
  locality: "host-local",
  billed: false,
  daemon: true,
  placements: [
    {
      placementId: "this-machine",
      displayName: "This machine",
      locality: "host-local",
      billed: false,
    },
    {
      placementId: "other-machine",
      displayName: "Your other machine",
      locality: "cloud",
      billed: false,
    },
  ],
} as const;

function client(providers: ReadonlyArray<object>) {
  const request = vi.fn<DesktopPaneClient["request"]>(async () =>
    decodeDesktopPaneAnswer({ status: "recipe-providers", providers }),
  );
  return { request };
}

const savedRecipe = decodeDesktopRecipe({
  providerId: "cloud-desktop",
  screen: { width: 1280, height: 800 },
  network: "none",
  leaseMinutes: 30,
  maximumLeaseMinutes: 240,
  idleMinutes: 15,
});

describe("ProjectDesktopRecipeSection", () => {
  it("sets a recipe on a provider the host offers, with the screen chosen and no network", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    const offered = client([hostLocal]);
    render(
      <ProjectDesktopRecipeSection client={offered} onChange={onChange} project={project()} />,
    );

    expect(offered.request).toHaveBeenCalledWith({ kind: "recipe-providers" }, expect.anything());
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Desktop provider" })).toHaveTextContent(
        "This host",
      ),
    );
    await user.click(screen.getByRole("combobox", { name: "Desktop screen size" }));
    await user.click(await screen.findByRole("option", { name: "1920 × 1080" }));
    await user.click(screen.getByRole("button", { name: "Set recipe" }));

    expect(onChange).toHaveBeenCalledWith({
      providerId: "host-local",
      screen: { width: 1920, height: 1080 },
      network: "none",
      leaseMinutes: 30,
      maximumLeaseMinutes: 240,
      idleMinutes: 15,
    });
  });

  it("shows a saved provider the host no longer offers without letting it be saved, and removes the recipe after asking", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    render(
      <ProjectDesktopRecipeSection
        client={client([hostLocal])}
        onChange={onChange}
        project={project(savedRecipe)}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Desktop provider" })).toHaveTextContent(
        "cloud-desktop (not available on this host)",
      ),
    );
    expect(screen.getByRole("button", { name: "Save recipe" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Remove recipe" }));
    expect(onChange).not.toHaveBeenCalled();
    // The confirmation's own button; the dialog hides the section behind it.
    await user.click(await screen.findByRole("button", { name: "Remove recipe" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  });

  it("offers a provider's placements and saves the one chosen, with no key, starting from its first", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => true);
    render(
      <ProjectDesktopRecipeSection
        client={client([hostLocal, spaces])}
        onChange={onChange}
        project={project()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Desktop provider" })).toHaveTextContent(
        "This host",
      ),
    );
    // A provider that offers no placements asks for none.
    expect(screen.queryByRole("combobox", { name: "Where the desktop runs" })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Desktop provider" }));
    await user.click(await screen.findByRole("option", { name: "Spaces" }));
    expect(screen.getByRole("combobox", { name: "Where the desktop runs" })).toHaveTextContent(
      "This machine",
    );
    await user.click(screen.getByRole("combobox", { name: "Where the desktop runs" }));
    await user.click(await screen.findByRole("option", { name: "Your other machine" }));
    await user.click(screen.getByRole("button", { name: "Set recipe" }));

    expect(onChange).toHaveBeenCalledWith({
      providerId: "spaces.example",
      placementId: "other-machine",
      screen: { width: 1280, height: 800 },
      network: "none",
      leaseMinutes: 30,
      maximumLeaseMinutes: 240,
      idleMinutes: 15,
    });
  });

  it("keeps a saved placement the host no longer offers from being saved again", async () => {
    const user = userEvent.setup();
    render(
      <ProjectDesktopRecipeSection
        client={client([spaces])}
        onChange={vi.fn(async () => true)}
        project={project(
          decodeDesktopRecipe({
            ...savedRecipe,
            providerId: "spaces.example",
            placementId: "own-cloud",
            screen: { width: 1024, height: 768 },
          }),
        )}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Where the desktop runs" })).toHaveTextContent(
        "own-cloud (not available on this host)",
      ),
    );
    await user.click(screen.getByRole("combobox", { name: "Desktop screen size" }));
    await user.click(await screen.findByRole("option", { name: "1920 × 1080" }));
    expect(screen.getByRole("button", { name: "Save recipe" })).toBeDisabled();
  });

  it("offers nothing to set when the host offers no provider", async () => {
    render(
      <ProjectDesktopRecipeSection
        client={client([])}
        onChange={vi.fn(async () => true)}
        project={project()}
      />,
    );
    expect(await screen.findByText(/No desktop provider is ready on this host/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set recipe" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Desktop provider" })).toBeNull();
  });
});
