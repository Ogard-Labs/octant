import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ContextEntryId } from "@octant/contracts/context";
import { ComposerContextMeter } from "./ComposerContextMeter";
import {
  ComposerContextMeterGate,
  ComposerContextMeterProvider,
  useComposerContextMeterScope,
  type ComposerContextUsageFallback,
} from "./composerContextMeterScope";
import { contextFixture } from "./contextFixtures";
import type { ContextControllerStatus } from "./useContextController";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";

function Harness(props: {
  readonly children?: ReactNode;
  readonly inspect?: () => void;
  readonly onRebuild?: () => void;
  readonly onSetExcluded?: (entryId: ContextEntryId, excluded: boolean) => void;
  readonly onSetPinned?: (entryId: ContextEntryId, pinned: boolean) => void;
  readonly snapshot?: ContextInspectorSnapshot;
  readonly status?: ContextControllerStatus;
  readonly subjectKey?: string;
  readonly visible?: boolean;
}) {
  const inspect = props.inspect ?? vi.fn();
  return (
    <ComposerContextMeterProvider
      {...(props.onRebuild === undefined ? {} : { onRebuild: props.onRebuild })}
      {...(props.onSetExcluded === undefined ? {} : { onSetExcluded: props.onSetExcluded })}
      {...(props.onSetPinned === undefined ? {} : { onSetPinned: props.onSetPinned })}
      snapshot={props.snapshot ?? contextFixture()}
      status={props.status ?? "ready"}
      subjectKey={props.subjectKey ?? "chat-thread:a"}
    >
      <ComposerContextMeterGate enabled={props.visible ?? true}>
        <div>
          <ComposerContextMeter />
          <ShortcutTrigger />
          <button onClick={inspect} type="button">
            Unrelated
          </button>
          {props.children}
        </div>
      </ComposerContextMeterGate>
    </ComposerContextMeterProvider>
  );
}

function ShortcutTrigger() {
  const { requestOpen } = useComposerContextMeterScope();
  return (
    <button onClick={requestOpen} type="button">
      Shortcut
    </button>
  );
}

describe("ComposerContextMeter", () => {
  it.each([undefined, 0])(
    "distinguishes absent usage from a reported zero (%s)",
    async (tokens) => {
      const user = userEvent.setup();
      render(
        <ComposerContextMeterProvider
          fallback={{
            ...(tokens === undefined ? {} : { inputTokens: tokens, outputTokens: tokens }),
            limits: [{ window: "five_hour", status: "warning", utilization: 0.91 }],
          }}
          status="not-planned"
          subjectKey="code-thread:unused"
        >
          <ComposerContextMeterGate enabled>
            <ComposerContextMeter />
          </ComposerContextMeterGate>
        </ComposerContextMeterProvider>,
      );
      await user.click(
        screen.getByRole("button", {
          name:
            tokens === undefined ? /Usage not reported/ : /Provider reported 0 input and 0 output/,
        }),
      );
      const popover = screen.getByRole("dialog", { name: "Provider usage" });
      expect(popover).toHaveTextContent("5-hour limit91%");
      if (tokens === undefined) {
        expect(popover).toHaveTextContent("No usage has been reported for this thread.");
        expect(within(popover).getAllByText("Not reported").length).toBeGreaterThan(0);
      } else {
        expect(popover).not.toHaveTextContent("No usage has been reported for this thread.");
        expect(within(popover).getAllByText("0")).toHaveLength(2);
      }
    },
  );

  it("shows a circular used-versus-available meter with an accessible text label", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: /Show context usage for Fixture thread/i });
    expect(button).toBeVisible();
    expect(button).toHaveAccessibleName(/104 \/ 1K \(10%\)/);
    expect(button).toHaveAccessibleName(/Next turn: Healthy/);
    expect(button.querySelector(".composer-context-meter__ring")).not.toBeNull();
    // The arc is measured on a path length of 100, so its dash is the share.
    expect(button.querySelector(".composer-context-meter__used")).toHaveAttribute(
      "stroke-dasharray",
      "10.4 100",
    );
    expect(document.querySelector(".composer-context-meter")).not.toHaveAttribute("data-fill");
    expect(
      screen.getByText(/Fixture thread\. Last sent 104 \/ 1K \(10%\)\. Provider reported\./),
    ).toBeInTheDocument();
  });

  it("shows the fill without a fraction, share, or full ring when no window was named", async () => {
    const fixture = contextFixture();
    if (fixture.latestUsage === undefined) throw new Error("Fixture has no usage");
    const user = userEvent.setup();
    render(
      <Harness
        snapshot={{
          ...fixture,
          modelLimits: {
            ...fixture.modelLimits,
            contextWindow: 4_096,
            source: "conservative-fallback",
            confidence: "low",
          },
          latestUsage: { ...fixture.latestUsage, actualInputTokens: 34_300, contextTokens: 34_300 },
        }}
      />,
    );
    const button = screen.getByRole("button", { name: /Show context usage/i });
    expect(button).toHaveAccessibleName(/34\.3K used, context window maximum unavailable/);
    expect(button).not.toHaveAccessibleName(/4\.1K|%\)/);
    // An empty ring says nothing about a window; a red one would say it is full.
    expect(button.querySelector(".composer-context-meter__used")).toBeNull();
    expect(document.querySelector(".composer-context-meter")).not.toHaveAttribute("data-fill");

    await user.click(button);
    const popover = screen.getByRole("dialog", { name: "Context used" });
    expect(popover).toHaveTextContent("Context used34.3K");
    expect(popover).toHaveTextContent("no share of a window to show");
    expect(popover).not.toHaveTextContent("4.1K");
    expect(within(popover).queryByRole("meter", { name: /Context window/ })).toBeNull();
  });

  it("opens the popover from pointer, Enter, and Space without a further inspect call", async () => {
    const inspect = vi.fn();
    const user = userEvent.setup();
    render(<Harness inspect={inspect} />);
    const button = screen.getByRole("button", { name: /Show context usage/i });

    await user.click(button);
    const popover = screen.getByRole("dialog", { name: "Context window" });
    // Used, maximum and percentage are the heading, and free space is one of the
    // meter's own segments. Repeating all four as a separate list above the
    // meter said the same numbers twice before the reader reached the picture.
    expect(popover).toHaveTextContent("Context window104 / 1K (10%)");
    expect(
      within(popover).getByRole("meter", { name: /Context window composition/ }),
    ).toHaveAttribute("aria-valuenow", "10");
    expect(popover).toHaveTextContent("Provider account limits");
    expect(popover).toHaveTextContent("Concurrent turns");
    expect(popover).toHaveTextContent("Requests");
    expect(popover).toHaveTextContent("Tokens");
    expect(popover).toHaveTextContent("Unavailable");
    expect(popover).toHaveTextContent("Quota");
    expect(popover).toHaveTextContent("Unknown");
    expect(inspect).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Context window" })).not.toBeInTheDocument();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Context window" })).toBeVisible();
    await user.keyboard("{Escape}");

    await user.keyboard(" ");
    expect(screen.getByRole("dialog", { name: "Context window" })).toBeVisible();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Shortcut" }));
    expect(screen.getByRole("dialog", { name: "Context window" })).toBeVisible();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("says so when a category is unknown and restores focus after Escape", async () => {
    const user = userEvent.setup();
    render(<Harness snapshot={contextFixture({ unknownTokens: true })} />);
    const button = screen.getByRole("button", { name: /plus unknown/i });
    await user.click(button);
    await user.click(screen.getByRole("button", { name: "Context breakdown" }));
    expect(screen.getByRole("dialog", { name: "Context window" })).toHaveTextContent(
      "Octant toolsUnknown",
    );
    expect(screen.getByRole("dialog", { name: "Context window" })).toHaveTextContent(
      "Free spaceUnknown",
    );
    await user.keyboard("{Escape}");
    expect(button).toHaveFocus();
  });

  it("keeps rate limits and reset windows explicit", async () => {
    const user = userEvent.setup();
    render(<Harness snapshot={contextFixture({ health: "rate-limited" })} />);
    await user.click(screen.getByRole("button", { name: /Show context usage/i }));
    const popover = screen.getByRole("dialog", { name: "Context window" });
    expect(popover).toHaveTextContent("Quota");
    expect(popover).toHaveTextContent("Unknown");
    expect(popover).toHaveTextContent("Retry");
    expect(popover).toHaveTextContent("Rate limited until");
    expect(popover).toHaveTextContent("Resets");
  });

  it("closes on an outside pointer press", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Show context usage/i }));
    expect(screen.getByRole("dialog", { name: "Context window" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Unrelated" }));
    expect(screen.queryByRole("dialog", { name: "Context window" })).not.toBeInTheDocument();
  });

  it("closes a popover that belonged to the previous pane when the subject changes", async () => {
    const user = userEvent.setup();
    function Switching() {
      const [subjectKey, setSubjectKey] = useState("chat-thread:a");
      return (
        <Harness subjectKey={subjectKey}>
          <button onClick={() => setSubjectKey("chat-thread:b")} type="button">
            Switch pane
          </button>
        </Harness>
      );
    }
    render(<Switching />);
    await user.click(screen.getByRole("button", { name: /Show context usage/i }));
    expect(screen.getByRole("dialog", { name: "Context window" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Switch pane" }));
    expect(screen.queryByRole("dialog", { name: "Context window" })).not.toBeInTheDocument();
  });

  it("does not render on a composer the active pane does not own", () => {
    render(<Harness visible={false} />);
    expect(screen.queryByRole("button", { name: /context usage/i })).not.toBeInTheDocument();
  });

  it("opens the context inspector from the usage popover so pin, exclude, and rebuild stay reachable", async () => {
    const user = userEvent.setup();
    const onRebuild = vi.fn();
    const onSetExcluded = vi.fn();
    const onSetPinned = vi.fn();
    render(
      <Harness onRebuild={onRebuild} onSetExcluded={onSetExcluded} onSetPinned={onSetPinned} />,
    );
    await user.click(screen.getByRole("button", { name: /Show context usage/i }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    expect(screen.queryByRole("dialog", { name: "Context window" })).not.toBeInTheDocument();
    const inspector = await screen.findByRole("dialog", { name: "Context inspector" });
    expect(inspector).toBeVisible();
    await user.click(
      within(inspector).getByRole("button", { name: "Pin Repository search next turn" }),
    );
    expect(onSetPinned).toHaveBeenCalledWith("50000000-0000-4000-8000-000000000002", true);
    await user.click(
      within(inspector).getByRole("button", { name: "Exclude Repository search next turn" }),
    );
    expect(onSetExcluded).toHaveBeenCalledWith("50000000-0000-4000-8000-000000000002", true);
    await user.click(within(inspector).getByRole("button", { name: "Rebuild context plan" }));
    expect(onRebuild).toHaveBeenCalledOnce();
  });

  it("closes the context inspector when the subject changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness subjectKey="chat-thread:a" />);
    await user.click(screen.getByRole("button", { name: /Show context usage/i }));
    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    expect(await screen.findByRole("dialog", { name: "Context inspector" })).toBeVisible();
    rerender(<Harness subjectKey="chat-thread:b" />);
    expect(screen.queryByRole("dialog", { name: "Context inspector" })).not.toBeInTheDocument();
  });

  it("names an unplanned thread instead of inventing usage", async () => {
    const user = userEvent.setup();
    render(
      <ComposerContextMeterProvider status="not-planned" subjectKey="chat-thread:a">
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );
    const button = screen.getByRole("button", { name: /No context plan yet/i });
    await user.click(button);
    expect(screen.getByRole("dialog", { name: "Context usage" })).toHaveTextContent(
      "No context plan yet.",
    );
  });

  it("fills the ring from the window the provider itself reported when no context plan exists", async () => {
    const user = userEvent.setup();
    render(
      <ComposerContextMeterProvider
        fallback={{
          inputTokens: 25_500,
          outputTokens: 38,
          contextWindow: 200_000,
          contextTokens: 50_000,
          limits: [],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    const button = screen.getByRole("button", { name: /Context window 50K of 200K \(25%\)/i });
    await user.click(button);
    const popover = screen.getByRole("dialog", { name: "Context window" });
    expect(popover).toHaveTextContent("Context window50K / 200K (25%)");
    expect(within(popover).getByRole("meter", { name: /Context window used/ })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    // Provenance is detail: it waits in the breakdown, while the trigger's
    // accessible name always carries it.
    expect(popover).not.toHaveTextContent("Reported by the provider with its last turn.");
    await user.click(within(popover).getByRole("button", { name: "Context breakdown" }));
    expect(popover).toHaveTextContent("Reported by the provider with its last turn.");
  });

  it("says how much room is left before the runtime compacts the session by itself", async () => {
    const user = userEvent.setup();
    render(
      <ComposerContextMeterProvider
        fallback={{
          inputTokens: 25_500,
          outputTokens: 38,
          contextWindow: 200_000,
          contextTokens: 120_000,
          autoCompactThreshold: 167_000,
          limits: [],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Context window 120K of 200K/i }));
    const popover = screen.getByRole("dialog", { name: "Context window" });
    expect(popover).toHaveTextContent("47K until auto-compact");
  });

  describe("a provider-run thread's breakdown", () => {
    async function openBreakdown(fallback: ComposerContextUsageFallback) {
      const user = userEvent.setup();
      render(
        <ComposerContextMeterProvider
          fallback={fallback}
          status="not-planned"
          subjectKey="code-thread:a"
        >
          <ComposerContextMeterGate enabled>
            <ComposerContextMeter />
          </ComposerContextMeterGate>
        </ComposerContextMeterProvider>,
      );
      await user.click(screen.getByRole("button", { name: /Context window/i }));
      const popover = screen.getByRole("dialog", { name: "Context window" });
      await user.click(within(popover).getByRole("button", { name: "Context breakdown" }));
      return popover;
    }

    function rowOf(popover: HTMLElement, label: string) {
      const row = within(popover).getByRole("row", { name: new RegExp(`^${label}`) });
      return row;
    }

    it("lists what the runtime reported, with coloured parts and a neutral Free space and Reserved", async () => {
      const popover = await openBreakdown({
        contextWindow: 1_000_000,
        contextTokens: 38_000,
        limits: [],
        contextBreakdown: {
          parts: [
            { kind: "system-prompt", tokens: 142, accuracy: "provider-reported" },
            { kind: "system-tools", tokens: 17_946, accuracy: "provider-reported" },
            { kind: "memory-files", tokens: 16_270, accuracy: "provider-reported", count: 4 },
            { kind: "messages", tokens: 10, accuracy: "provider-reported" },
            { kind: "reserved", tokens: 33_000, accuracy: "provider-reported" },
          ],
          deferred: [{ kind: "mcp-tools", count: 30 }],
        },
      });

      for (const label of ["System prompt", "System tools", "Memory files", "Messages"]) {
        expect(rowOf(popover, label)).toHaveAttribute("data-tone");
      }
      expect(rowOf(popover, "Other \\(provider\\)")).toHaveAttribute("data-tone");
      expect(rowOf(popover, "Reserved")).not.toHaveAttribute("data-tone");
      expect(rowOf(popover, "Free space")).not.toHaveAttribute("data-tone");
      expect(rowOf(popover, "System tools")).toHaveTextContent("17.9K");
      expect(popover).toHaveTextContent("Reported by the provider with its last turn.");
      expect(popover).not.toHaveTextContent("Estimated");
      // Counts sit in the harness breakdown's row style; deferred tools are
      // counted and take no share.
      expect(popover).toHaveTextContent("Memory files4 loaded");
      expect(popover).toHaveTextContent("MCP30 deferred");
      expect(
        within(popover)
          .getAllByRole("row")
          .map((row) => row.textContent)
          .join(" "),
      ).not.toContain("deferred");
      // Each painted segment is a part; free space is the unpainted track.
      const meter = within(popover).getByRole("meter");
      expect(meter.querySelectorAll("[data-kind='free']")).toHaveLength(0);
      // Four reported parts and the remainder carry a tone; reserved room does not.
      expect(meter.querySelectorAll("[data-tone]")).toHaveLength(5);
      expect(meter.querySelector("[data-kind='reserved']")).not.toHaveAttribute("data-tone");
    });

    it("marks what Octant counted as an estimate, says how, and keeps the rest as Other (provider)", async () => {
      const popover = await openBreakdown({
        contextWindow: 200_000,
        contextTokens: 20_000,
        limits: [],
        contextBreakdown: {
          parts: [
            { kind: "octant-tools", tokens: 1_200, accuracy: "conservative-heuristic", count: 9 },
          ],
        },
      });

      const tools = rowOf(popover, "Octant tools");
      expect(tools).toHaveTextContent("Estimated");
      expect(within(tools).getByText("Estimated")).toHaveAttribute(
        "title",
        "Conservative estimate",
      );
      expect(rowOf(popover, "Other \\(provider\\)")).toHaveTextContent("Estimated");
      expect(rowOf(popover, "Other \\(provider\\)")).toHaveTextContent("18.8K");
      expect(popover).toHaveTextContent(
        "Parts marked Estimated are Octant's own count (conservative estimate). The provider reported the total, and Other (provider) is the rest of it.",
      );
      expect(popover).not.toHaveTextContent("Reported by the provider with its last turn.");
      expect(popover).toHaveTextContent("Tools9 loaded");
    });

    it("raises the ring and the figure to what the parts add up to when they outrun the occupancy", async () => {
      render(
        <ComposerContextMeterProvider
          fallback={{
            contextWindow: 100_000,
            contextTokens: 4_800,
            limits: [],
            contextBreakdown: {
              parts: [{ kind: "messages", tokens: 5_000, accuracy: "provider-reported" }],
            },
          }}
          status="not-planned"
          subjectKey="code-thread:a"
        >
          <ComposerContextMeterGate enabled>
            <ComposerContextMeter />
          </ComposerContextMeterGate>
        </ComposerContextMeterProvider>,
      );

      const button = screen.getByRole("button", { name: /Context window 5K of 100K \(5%\)/i });
      expect(button.querySelector(".composer-context-meter__used")).toHaveAttribute(
        "stroke-dasharray",
        "5 100",
      );
    });

    it("keeps the single Used segment for a runtime that reports no parts", async () => {
      const popover = await openBreakdown({
        contextWindow: 200_000,
        contextTokens: 12_000,
        limits: [],
      });

      expect(rowOf(popover, "Used")).toHaveAttribute("data-tone", "1");
      expect(rowOf(popover, "Free space")).not.toHaveAttribute("data-tone");
    });
  });

  it("says the session is at the compaction point rather than a negative room", async () => {
    const user = userEvent.setup();
    render(
      <ComposerContextMeterProvider
        fallback={{
          contextWindow: 200_000,
          contextTokens: 170_000,
          autoCompactThreshold: 167_000,
          limits: [],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Context window 170K of 200K/i }));
    expect(screen.getByRole("dialog", { name: "Context window" })).toHaveTextContent(
      "At the auto-compact threshold",
    );
  });

  it("shows no compaction line when the provider reported no threshold", async () => {
    const user = userEvent.setup();
    render(
      <ComposerContextMeterProvider
        fallback={{ contextWindow: 200_000, contextTokens: 120_000, limits: [] }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    await user.click(screen.getByRole("button", { name: /Context window 120K of 200K/i }));
    expect(screen.getByRole("dialog", { name: "Context window" })).not.toHaveTextContent(
      /auto-compact/i,
    );
  });

  it("fills the ring from the model's declared limit when the provider reported occupancy without a window", async () => {
    const user = userEvent.setup();
    render(
      <ComposerContextMeterProvider
        fallback={{
          inputTokens: 25_500,
          outputTokens: 38,
          modelContextWindow: 400_000,
          contextTokens: 100_000,
          limits: [],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    const button = screen.getByRole("button", {
      name: /Context window 100K of 400K \(25%\)/i,
    });
    await user.click(button);
    const popover = screen.getByRole("dialog", { name: "Context window" });
    expect(popover).toHaveTextContent("context limit declared for the selected model");
  });

  it("fills the ring from the fullest account limit when no window is known at all", async () => {
    render(
      <ComposerContextMeterProvider
        fallback={{
          inputTokens: 25_500,
          outputTokens: 38,
          limits: [
            {
              window: "five_hour",
              status: "warning",
              utilization: 0.91,
              resetsAt: "2026-08-24T01:00:00.000Z" as never,
            },
          ],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    // The label names the figure so a screen reader is not told the ring is a
    // context share when it is the account's quota.
    screen.getByRole("button", { name: /ring shows 91% of the 5-hour limit used/i });
    const used = document.querySelector(".composer-context-meter__used");
    expect(used).not.toBeNull();
  });

  it("keeps provider usage and account limits useful when no context plan exists", async () => {
    const user = userEvent.setup();
    render(
      <ComposerContextMeterProvider
        fallback={{
          inputTokens: 25_500,
          outputTokens: 38,
          limits: [
            {
              window: "five_hour",
              status: "warning",
              utilization: 0.91,
              resetsAt: "2026-08-24T01:00:00.000Z" as never,
            },
          ],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    const button = screen.getByRole("button", {
      name: /Provider reported 25\.5K input and 38 output/i,
    });
    await user.click(button);
    const popover = screen.getByRole("dialog", { name: "Provider usage" });
    expect(popover).toHaveTextContent("Provider usage");
    expect(popover).toHaveTextContent("Input25,500");
    expect(popover).toHaveTextContent("Output38");
    // The panel must not imply a share of a window when the provider never
    // reported one; it says so in words rather than as an "Unavailable" row.
    expect(popover).toHaveTextContent(/not a context-window maximum/);
    expect(popover).not.toHaveTextContent("Context maximum");
    expect(popover).toHaveTextContent("Provider account limits");
    expect(popover).toHaveTextContent(/5-hour limitResets now91%/);
  });

  it("moves the ring to its new share instead of snapping between renders", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/context/context.css"), "utf8");

    // The ring is the only place a reader watches the window fill, and a value
    // that jumps reads as a redraw rather than as consumption.
    expect(styles).toMatch(/\.composer-context-meter__used \{[^}]*transition:\s*stroke-dasharray/);
    // Motion is a preference, not a fact about the data.
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.composer-context-meter__used \{\s*transition: none;/,
    );
  });

  it("ranks provider windows with a bar rather than percentages to compare in the head", async () => {
    const user = userEvent.setup();
    render(
      <ComposerContextMeterProvider
        fallback={{
          inputTokens: 25_500,
          outputTokens: 38,
          limits: [
            {
              window: "five_hour",
              status: "warning",
              utilization: 0.91,
              resetsAt: "2026-08-24T01:00:00.000Z" as never,
            },
          ],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: /Provider reported 25\.5K input and 38 output/i }),
    );
    const meter = screen.getByRole("meter", { name: "5-hour limit used" });
    expect(meter).toHaveAttribute("aria-valuetext", "91% used, running low");
    expect((meter.firstElementChild as HTMLElement).style.width).toBe("91%");
    // Near its cap is a fact on the row, not only the warning ink on the bar.
    expect(meter.closest(".context-window-popover__limit")).toHaveAttribute("data-level", "near");
  });

  it("marks the ring with a red dot when a provider limit runs low or is spent", () => {
    render(
      <ComposerContextMeterProvider
        fallback={{
          inputTokens: 25_500,
          limits: [
            {
              window: "five_hour",
              status: "exhausted",
              utilization: 1,
              resetsAt: "2026-08-24T01:00:00.000Z" as never,
            },
          ],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    // The status line that used to spell the limit out moved into the meter's
    // panel, so the at-a-glance warning is a dot on the ring itself.
    const alert = document.querySelector(".composer-context-meter__alert");
    expect(alert).not.toBeNull();
    expect(
      document.querySelector(".composer-context-meter")?.getAttribute("data-limit-alert"),
    ).toBe("exhausted");
    expect(
      screen.getByRole("button", { name: /A provider limit is exhausted\.?$/i }),
    ).toBeVisible();
  });

  it("turns the ring's dot from warning red to exhausted red as a limit spends out", () => {
    const { rerender } = render(
      <ComposerContextMeterProvider
        fallback={{
          limits: [{ window: "seven_day", status: "warning", utilization: 0.87 }],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    expect(
      document.querySelector(".composer-context-meter")?.getAttribute("data-limit-alert"),
    ).toBe("warning");
    screen.getByRole("button", { name: /A provider limit is running low\.?$/i });

    rerender(
      <ComposerContextMeterProvider
        fallback={{
          limits: [{ window: "seven_day", status: "exhausted", utilization: 1 }],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    expect(
      document.querySelector(".composer-context-meter")?.getAttribute("data-limit-alert"),
    ).toBe("exhausted");
  });

  it("marks the ring as exhausted when the context snapshot's service quota is spent", () => {
    const base = contextFixture();
    const snapshot = {
      ...base,
      serviceLimits: { ...base.serviceLimits, quota: "exhausted" as never },
    };
    render(<Harness snapshot={snapshot} />);

    expect(
      document.querySelector(".composer-context-meter")?.getAttribute("data-limit-alert"),
    ).toBe("exhausted");
    expect(screen.getByRole("button", { name: /A provider limit is exhausted.?$/i })).toBeVisible();
  });

  it("draws no alert dot while every provider limit is allowed", () => {
    render(
      <ComposerContextMeterProvider
        fallback={{
          limits: [{ window: "seven_day", status: "allowed", utilization: 0.12 }],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );

    expect(document.querySelector(".composer-context-meter__alert")).toBeNull();
  });

  it("folds the breakdown until asked and then lists every attributed category with its share", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Show context usage/i }));
    const popover = screen.getByRole("dialog", { name: "Context window" });
    const toggle = within(popover).getByRole("button", { name: "Context breakdown" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The chevron carries no visible label, so a pointer user needs the
    // native tooltip the design system requires on every icon-only button.
    expect(toggle).toHaveAttribute("title", "Context breakdown");
    expect(within(popover).queryByRole("table")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const rows = within(within(popover).getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Current request424%",
      "Octant toolsEstimated586%",
      "Observed overhead40.4%",
      "Reserved10010%",
      "Free space79680%",
    ]);
    expect(popover).toHaveTextContent("Last sent · model-a · Provider reported");
    expect(popover).toHaveTextContent(/Tools2 loaded · 6 deferred/);
    expect(popover).toHaveTextContent(/MCP0 loaded · 3 deferred/);
  });

  it("breaks a provider-reported window into only what the provider reported", async () => {
    const user = userEvent.setup();
    render(
      <ComposerContextMeterProvider
        fallback={{
          inputTokens: 25_500,
          outputTokens: 38,
          contextWindow: 200_000,
          contextTokens: 50_000,
          limits: [],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Context window 50K of 200K/i }));
    const popover = screen.getByRole("dialog", { name: "Context window" });
    await user.click(within(popover).getByRole("button", { name: "Context breakdown" }));
    // The thread's input and output are sums over turns, not parts of the
    // window's occupancy, so they are not categories of it.
    const rows = within(within(popover).getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual(["Used50K25%", "Free space150K75%"]);
    expect(within(popover).getByLabelText("This thread")).toHaveTextContent("Input25,500Output38");
  });

  it("turns the ring to the warning ink once most of the window is used", () => {
    render(
      <ComposerContextMeterProvider
        fallback={{ contextWindow: 200_000, contextTokens: 170_000, limits: [] }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );
    expect(document.querySelector(".composer-context-meter")).toHaveAttribute("data-fill", "high");
    expect(document.querySelector(".composer-context-meter__used")).toHaveAttribute(
      "stroke-dasharray",
      "85 100",
    );
  });

  it("names provider windows by their length and says when they reset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-23T22:42:00.000Z"));
    try {
      const user = userEvent.setup();
      render(
        <ComposerContextMeterProvider
          fallback={{
            limits: [
              {
                window: "plan-a:primary_5h",
                status: "allowed",
                utilization: 0.4,
                resetsAt: "2026-08-24T01:00:00.000Z" as never,
              },
              {
                window: "plan-b:secondary_7d",
                status: "exhausted",
                utilization: 1,
              },
            ],
          }}
          status="not-planned"
          subjectKey="code-thread:a"
        >
          <ComposerContextMeterGate enabled>
            <ComposerContextMeter />
          </ComposerContextMeterGate>
        </ComposerContextMeterProvider>,
      );
      await user.click(screen.getByRole("button", { name: /Show context usage/i }));
      const popover = screen.getByRole("dialog", { name: "Provider usage" });
      // Two scopes are present, so each window keeps the provider's scope name.
      expect(popover).toHaveTextContent("5-hour limitplan-aResets in 2 hr 18 min40%");
      // Spent is a status, not a figure, so a reader relying on the visible
      // text alone (not the row's warning ink) still sees the provider's word.
      expect(popover).toHaveTextContent("7-day limitplan-b100% · Spent");
      expect(popover).not.toHaveTextContent("primary");
      expect(screen.getByRole("meter", { name: "7-day limit used" })).toHaveAttribute(
        "aria-valuetext",
        "100% used, spent",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a provider's running-low status visible next to its measured share", async () => {
    const user = userEvent.setup();
    render(
      <ComposerContextMeterProvider
        fallback={{
          limits: [{ window: "five_hour", status: "warning", utilization: 0.91 }],
        }}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Show context usage/i }));
    const popover = screen.getByRole("dialog", { name: "Provider usage" });
    // The provider reports both a percentage and a "running low" status; the
    // percentage must not push the status word off the row.
    expect(popover).toHaveTextContent("5-hour limit91% · Low");
  });

  it("opens the usage surface from a provider-reported panel and closes the panel", async () => {
    const user = userEvent.setup();
    const onOpenUsage = vi.fn();
    render(
      <ComposerContextMeterProvider
        fallback={{ contextWindow: 200_000, contextTokens: 50_000, limits: [] }}
        onOpenUsage={onOpenUsage}
        status="not-planned"
        subjectKey="code-thread:a"
      >
        <ComposerContextMeterGate enabled>
          <ComposerContextMeter />
        </ComposerContextMeterGate>
      </ComposerContextMeterProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Show context usage/i }));
    await user.click(screen.getByRole("button", { name: "View usage" }));
    expect(onOpenUsage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Context window" })).not.toBeInTheDocument();
  });
});
