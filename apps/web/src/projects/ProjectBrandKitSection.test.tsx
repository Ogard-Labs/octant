import type { ProjectSummary } from "@octant/contracts/projects";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectBrandKitSection } from "./ProjectBrandKitSection";

const project = (brandKit?: Record<string, string>): ProjectSummary =>
  ({
    id: "80000000-0000-4000-8000-000000000001",
    type: "chat",
    name: "Brand",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
    binding: { canonicalRoot: "/tmp/brand" },
    ...(brandKit === undefined ? {} : { brandKit }),
  }) as unknown as ProjectSummary;

describe("ProjectBrandKitSection", () => {
  it("offers no save while the fields hold the saved kit", async () => {
    const onChange = vi.fn(async () => true);
    render(
      <ProjectBrandKitSection
        onChange={onChange}
        project={project({ "color-primary": "#0a7d5a" })}
      />,
    );
    const save = screen.getByRole("button", { name: "Save brand kit" });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Heading font"), "georgia, serif");
    expect(save).toBeEnabled();
    await userEvent.clear(screen.getByLabelText("Heading font"));
    expect(save).toBeDisabled();
  });

  it("follows a kit another window saved instead of keeping the old values", () => {
    const onChange = vi.fn(async () => true);
    const { rerender } = render(
      <ProjectBrandKitSection
        onChange={onChange}
        project={project({ "color-primary": "#0a7d5a" })}
      />,
    );
    rerender(
      <ProjectBrandKitSection
        onChange={onChange}
        project={project({ "color-primary": "#222222" })}
      />,
    );
    expect(screen.getByLabelText("Primary colour")).toHaveValue("#222222");
    expect(screen.getByRole("button", { name: "Save brand kit" })).toBeDisabled();
  });

  it("saves the values typed, leaving out blanks", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProjectBrandKitSection onChange={onChange} project={project()} />);
    await userEvent.type(screen.getByLabelText("Primary colour"), "#0a7d5a");
    await userEvent.type(screen.getByLabelText("Heading font"), "georgia, serif");
    await userEvent.click(screen.getByRole("button", { name: "Save brand kit" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        "color-primary": "#0a7d5a",
        "font-heading": "georgia, serif",
      }),
    );
  });

  it("explains a value the host would refuse and does not offer to save it", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProjectBrandKitSection onChange={onChange} project={project()} />);
    await userEvent.type(screen.getByLabelText("Body font"), "Some Web Font");
    expect(await screen.findByRole("alert")).toHaveTextContent("outside the safe list");
    expect(screen.getByRole("button", { name: "Save brand kit" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps tokens it has no field for when saving, and clears the whole kit on request", async () => {
    const onChange = vi.fn(async () => true);
    render(
      <ProjectBrandKitSection
        onChange={onChange}
        project={project({ "color-primary": "#0a7d5a", "color-accent-2": "#ff8800" })}
      />,
    );
    expect(screen.getByLabelText("Primary colour")).toHaveValue("#0a7d5a");
    await userEvent.clear(screen.getByLabelText("Primary colour"));
    await userEvent.type(screen.getByLabelText("Primary colour"), "#111111");
    await userEvent.click(screen.getByRole("button", { name: "Save brand kit" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        "color-accent-2": "#ff8800",
        "color-primary": "#111111",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({}));
  });
});
