import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectSpendCeilingSection } from "./ProjectSpendCeilingSection";

describe("ProjectSpendCeilingSection", () => {
  it("sets a monthly Project token ceiling", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => ({
      kind: "set" as const,
      ceiling: {
        scope: { kind: "project" as const, projectId: "00000000-0000-4000-8000-000000000201" },
        window: { kind: "calendar" as const, period: "month" as const, timeZone: "UTC" },
        policy: { tokenBudget: 50_000 },
        version: 1,
        setAt: "2026-09-17T00:00:00.000Z",
        setBy: { kind: "local-user" as const, actorId: "host" },
      },
    }));
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        projectRemaining: {
          ceilingTokens: 50_000,
          committedTokens: 0,
          reservedTokens: 0,
          remainingTokens: 50_000,
          window: { kind: "calendar", period: "month", timeZone: "UTC" },
          version: 1,
        },
        project: {
          scope: { kind: "project", projectId: "00000000-0000-4000-8000-000000000201" },
          window: { kind: "calendar", period: "month", timeZone: "UTC" },
          policy: { tokenBudget: 50_000 },
          version: 1,
          setAt: "2026-09-17T00:00:00.000Z",
          setBy: { kind: "local-user", actorId: "host" },
        },
      });
    render(
      <ProjectSpendCeilingSection
        client={{ snapshot, execute } as never}
        projectId="00000000-0000-4000-8000-000000000201"
      />,
    );
    expect(await screen.findByText(/No token ceiling is set on this Project/i)).toBeVisible();
    await user.type(screen.getByLabelText("Project token spend ceiling"), "50000");
    await user.click(screen.getByRole("button", { name: "Set Project token ceiling" }));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "set-spend-ceiling",
        scope: { kind: "project", projectId: "00000000-0000-4000-8000-000000000201" },
        policy: { tokenBudget: 50_000 },
        window: expect.objectContaining({ kind: "calendar", period: "month" }),
      }),
    );
    expect(await screen.findByText(/50,000 of 50,000 tokens remaining this month/i)).toBeVisible();
  });
});
