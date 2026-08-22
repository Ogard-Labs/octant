import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ComposerContextMeter } from "./ComposerContextMeter";
import {
  ComposerContextMeterGate,
  ComposerContextMeterProvider,
  useComposerContextMeterScope,
} from "./composerContextMeterScope";
import { contextFixture } from "./contextFixtures";
import type { ContextControllerStatus } from "./useContextController";
import type { ContextInspectorSnapshot } from "@octant/contracts/context-rpc";

function Harness(props: {
  readonly children?: ReactNode;
  readonly inspect?: () => void;
  readonly snapshot?: ContextInspectorSnapshot;
  readonly status?: ContextControllerStatus;
  readonly subjectKey?: string;
  readonly visible?: boolean;
}) {
  const inspect = props.inspect ?? vi.fn();
  return (
    <ComposerContextMeterProvider
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
  it("shows a circular used-versus-available meter with an accessible text label", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: /Show context usage for Fixture thread/i });
    expect(button).toBeVisible();
    expect(button).toHaveAccessibleName(/104 \/ 1K \(10%\)/);
    expect(button.querySelector(".composer-context-meter__ring")).not.toBeNull();
    expect(button.querySelector(".composer-context-meter__used")).not.toBeNull();
    expect(
      screen.getByText(/Fixture thread\. Last sent 104 \/ 1K \(10%\)\. Provider reported\./),
    ).toBeInTheDocument();
  });

  it("opens the popover from pointer, Enter, and Space without a further inspect call", async () => {
    const inspect = vi.fn();
    const user = userEvent.setup();
    render(<Harness inspect={inspect} />);
    const button = screen.getByRole("button", { name: /Show context usage/i });

    await user.click(button);
    const popover = screen.getByRole("dialog", { name: "Context usage" });
    expect(popover).toHaveTextContent("Used104 · Provider reported");
    expect(popover).toHaveTextContent("Maximum1,000");
    expect(popover).toHaveTextContent("Percentage10%");
    expect(popover).toHaveTextContent("Free space796");
    expect(popover).toHaveTextContent("Current request42");
    expect(popover).toHaveTextContent("Octant tools58 · Estimated");
    expect(popover).toHaveTextContent("Observed overhead4");
    expect(popover).toHaveTextContent("Reserved100");
    expect(popover).toHaveTextContent(/Tools2 loaded· 6 deferred/);
    expect(popover).toHaveTextContent(/MCP0 loaded· 3 deferred/);
    expect(popover).toHaveTextContent("Provider account limits");
    expect(popover).toHaveTextContent("Concurrent turns");
    expect(popover).not.toHaveTextContent("Requests");
    expect(popover).not.toHaveTextContent("Not reported");
    expect(inspect).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Context usage" })).toBeVisible();
    await user.keyboard("{Escape}");

    await user.keyboard(" ");
    expect(screen.getByRole("dialog", { name: "Context usage" })).toBeVisible();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Shortcut" }));
    expect(screen.getByRole("dialog", { name: "Context usage" })).toBeVisible();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("says so when a category is unknown and restores focus after Escape", async () => {
    const user = userEvent.setup();
    render(<Harness snapshot={contextFixture({ unknownTokens: true })} />);
    const button = screen.getByRole("button", { name: /plus unknown/i });
    await user.click(button);
    expect(screen.getByRole("dialog", { name: "Context usage" })).toHaveTextContent(
      "Octant toolsUnknown",
    );
    await user.keyboard("{Escape}");
    expect(button).toHaveFocus();
  });

  it("closes on an outside pointer press", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Show context usage/i }));
    expect(screen.getByRole("dialog", { name: "Context usage" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Unrelated" }));
    expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("dialog", { name: "Context usage" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Switch pane" }));
    expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument();
  });

  it("does not render on a composer the active pane does not own", () => {
    render(<Harness visible={false} />);
    expect(screen.queryByRole("button", { name: /context usage/i })).not.toBeInTheDocument();
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
});
