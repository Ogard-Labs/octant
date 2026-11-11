import {
  CANVAS_DESIGN_SYSTEM_SCHEMA_VERSION,
  decodeCanvasDefinition,
  decodeCanvasId,
} from "@octant/contracts/canvas";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasDesignSystemPanel } from "./CanvasDesignSystemPanel";
import { CanvasDocument } from "./CanvasDocument";
import { canvasFixture } from "./test-fixtures";

const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
const acme = {
  name: "Acme",
  source: "DESIGN.md",
  brand: { "color-primary": "#1a73e8", "color-chart-2": "#0b8043" },
};

function client(overrides: Record<string, unknown> = {}) {
  return {
    listDesignSystems: vi.fn(async () => ({
      systems: [
        { folder: "/p", path: "DESIGN.md", name: "Acme", tokenCount: 2, primary: true },
        { folder: "/p", path: "apps/site/DESIGN.md", name: "Site", tokenCount: 1, primary: false },
      ],
      truncated: false,
    })),
    applyDesignSystem: vi.fn(async () => ({
      kind: "accepted" as const,
      canvasId,
      versionId: "33333333-3333-4333-8333-333333333333" as never,
      sequence: 2,
    })),
    ...overrides,
  };
}

describe("a Canvas's design system", () => {
  it("draws its typed blocks in the design system's colours", () => {
    const definition = decodeCanvasDefinition({
      ...canvasFixture,
      schemaVersion: CANVAS_DESIGN_SYSTEM_SCHEMA_VERSION,
      designSystem: acme,
    });
    render(<CanvasDocument definition={definition} />);
    const article = screen.getByRole("article");
    expect(article.style.getPropertyValue("--oct-series-1")).toBe("#1a73e8");
    expect(article.style.getPropertyValue("--oct-series-2")).toBe("#0b8043");
    expect(article.style.getPropertyValue("--oct-accent")).toBe("#1a73e8");
    expect(article).toHaveAttribute("data-design-system", "Acme");
  });

  it("keeps the workspace colours when the Canvas follows none", () => {
    render(<CanvasDocument definition={decodeCanvasDefinition(canvasFixture)} />);
    expect(screen.getByRole("article").style.getPropertyValue("--oct-series-1")).toBe("");
  });

  it("switches to another of the Project's design systems and back to none", async () => {
    const fake = client();
    const onApplied = vi.fn(async () => undefined);
    render(
      <CanvasDesignSystemPanel
        canvasId={canvasId}
        client={fake}
        current={acme}
        expectedSequence={1}
        onApplied={onApplied}
      />,
    );
    const applied = await screen.findByRole("button", { name: "Acme" });
    expect(applied).toHaveAttribute("aria-pressed", "true");
    // The applied one can be chosen again, which is how an edit to the file reaches the Canvas.
    expect(applied).toBeEnabled();
    await userEvent.click(applied);
    await waitFor(() =>
      expect(fake.applyDesignSystem).toHaveBeenLastCalledWith(
        expect.objectContaining({ designSystem: { folder: "/p", path: "DESIGN.md" } }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("latest of Acme");
    onApplied.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Site" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(fake.applyDesignSystem).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "canvas-design-system-apply",
        canvasId,
        expectedSequence: 1,
        designSystem: { folder: "/p", path: "apps/site/DESIGN.md" },
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("now follows Site");
    await userEvent.click(screen.getByRole("button", { name: "Use no design system" }));
    await waitFor(() =>
      expect(fake.applyDesignSystem).toHaveBeenLastCalledWith(
        expect.objectContaining({ designSystem: null }),
      ),
    );
  });

  it("says why a switch was refused and reloads a stale head", async () => {
    const onApplied = vi.fn(async () => undefined);
    const fake = client({
      applyDesignSystem: vi.fn(async () => ({
        kind: "denied" as const,
        denialCode: "stale-version" as const,
        message: "Canvas design system switch targets a stale Canvas sequence.",
      })),
    });
    render(
      <CanvasDesignSystemPanel
        canvasId={canvasId}
        client={fake}
        current={undefined}
        expectedSequence={1}
        onApplied={onApplied}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Site" }));
    expect(await screen.findByRole("status")).toHaveTextContent("stale");
    expect(onApplied).toHaveBeenCalledOnce();
  });
});
