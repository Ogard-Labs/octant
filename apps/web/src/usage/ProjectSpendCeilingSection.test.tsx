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
    expect(await screen.findByText(/No spend ceiling is set on this Project/i)).toBeVisible();
    await user.type(screen.getByLabelText("Project token spend ceiling"), "50000");
    await user.click(screen.getByRole("button", { name: "Set Project ceiling" }));
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

  it("sets a daily Project agent run time ceiling without a token budget", async () => {
    const user = userEvent.setup();
    const projectId = "00000000-0000-4000-8000-000000000201";
    const ceiling = {
      scope: { kind: "project" as const, projectId },
      window: { kind: "calendar" as const, period: "day" as const, timeZone: "UTC" },
      policy: { runTimeBudgetSeconds: 7_200 },
      version: 1,
      setAt: "2026-09-17T00:00:00.000Z",
      setBy: { kind: "local-user" as const, actorId: "host" },
    };
    const execute = vi.fn(async () => ({ kind: "set" as const, ceiling }));
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        project: ceiling,
        projectRemaining: {
          ceilingRunTimeSeconds: 7_200,
          usedRunTimeSeconds: 2_700,
          remainingRunTimeSeconds: 4_500,
          window: ceiling.window,
          version: 1,
        },
      });
    render(
      <ProjectSpendCeilingSection client={{ snapshot, execute } as never} projectId={projectId} />,
    );
    await screen.findByText(/No spend ceiling is set on this Project/i);
    await user.type(screen.getByLabelText("Project agent run time ceiling in hours"), "2");
    await user.click(screen.getByRole("combobox", { name: "Project ceiling window" }));
    await user.click(await screen.findByRole("option", { name: "Each day" }));
    await user.click(screen.getByRole("button", { name: "Set Project ceiling" }));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "set-spend-ceiling",
        policy: { runTimeBudgetSeconds: 7_200 },
        window: expect.objectContaining({ kind: "calendar", period: "day" }),
      }),
    );
    expect(await screen.findByText("1h 15m of 2h agent run time remaining this day")).toBeVisible();
  });

  it("sets a monthly Project money ceiling in whole cents and says it is checked between turns", async () => {
    const user = userEvent.setup();
    const projectId = "00000000-0000-4000-8000-000000000201";
    const ceiling = {
      scope: { kind: "project" as const, projectId },
      window: { kind: "calendar" as const, period: "month" as const, timeZone: "UTC" },
      policy: { costBudgetUsdCents: 25_40 },
      version: 1,
      setAt: "2026-09-17T00:00:00.000Z",
      setBy: { kind: "local-user" as const, actorId: "host" },
    };
    const execute = vi.fn(async () => ({ kind: "set" as const, ceiling }));
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        project: ceiling,
        projectRemaining: {
          ceilingUsdCents: 25_40,
          usedUsdCents: 10_80,
          remainingUsdCents: 14_60,
          window: ceiling.window,
          version: 1,
        },
      });
    render(
      <ProjectSpendCeilingSection client={{ snapshot, execute } as never} projectId={projectId} />,
    );
    await screen.findByText(/No spend ceiling is set on this Project/i);
    await user.type(screen.getByLabelText("Project money ceiling in US dollars"), "$25.40");
    await user.click(screen.getByRole("button", { name: "Set Project ceiling" }));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "set-spend-ceiling",
        policy: { costBudgetUsdCents: 25_40 },
      }),
    );
    expect(await screen.findByText("$14.60 of $25.40 remaining this month")).toBeVisible();
    expect(screen.getByText(/checked between turns/i)).toBeVisible();
  });

  it.each([
    ["25.405", "use at most two decimals"],
    ["25,40", "Use a dot for cents"],
    ["twenty", "must be an amount"],
  ])("refuses a money budget of %s and sets nothing, saying why", async (dollars, reason) => {
    const user = userEvent.setup();
    const execute = vi.fn();
    const snapshot = vi.fn().mockResolvedValue({});
    render(
      <ProjectSpendCeilingSection
        client={{ snapshot, execute } as never}
        projectId="00000000-0000-4000-8000-000000000201"
      />,
    );
    await screen.findByText(/No spend ceiling is set on this Project/i);
    await user.type(screen.getByLabelText("Project money ceiling in US dollars"), dollars);
    await user.type(screen.getByLabelText("Project turn ceiling"), "10");
    await user.click(screen.getByRole("button", { name: "Set Project ceiling" }));
    expect(execute).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
  });

  it("asks for a budget instead of sending an empty ceiling", async () => {
    const user = userEvent.setup();
    const execute = vi.fn();
    render(
      <ProjectSpendCeilingSection
        client={{ snapshot: vi.fn().mockResolvedValue({}), execute } as never}
        projectId="00000000-0000-4000-8000-000000000201"
      />,
    );
    await screen.findByText(/No spend ceiling is set on this Project/i);
    await user.click(screen.getByRole("button", { name: "Set Project ceiling" }));
    expect(execute).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter at least one budget.");
  });

  it("shows the Project's unpriced money refusal instead of an empty reading", async () => {
    const projectId = "00000000-0000-4000-8000-000000000201";
    const window = { kind: "calendar" as const, period: "month" as const, timeZone: "UTC" };
    const snapshot = vi.fn().mockResolvedValue({
      project: {
        scope: { kind: "project", projectId },
        window,
        policy: { costBudgetUsdCents: 25_00 },
        version: 1,
        setAt: "2026-09-17T00:00:00.000Z",
        setBy: { kind: "local-user", actorId: "host" },
      },
      projectRemaining: { window, version: 1 },
      refusal: {
        kind: "unknown-spend",
        scopeKind: "project",
        scopeId: projectId,
        dimension: "monetary",
        ceilingUsdCents: 25_00,
        recovery: ["raise-ceiling", "clear-ceiling", "open-usage", "pause-work"],
        message:
          "This Project's money ceiling cannot be checked because some of its usage in this window has no price.",
      },
    });
    render(
      <ProjectSpendCeilingSection
        client={{ snapshot, execute: vi.fn() } as never}
        projectId={projectId}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("has no price");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
