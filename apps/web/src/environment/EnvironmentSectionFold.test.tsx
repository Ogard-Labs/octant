import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { decodeAgentRunId, decodeAgentRunParentThreadId } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { ComposerContextMeter } from "../context/ComposerContextMeter";
import {
  ComposerContextMeterGate,
  ComposerContextMeterProvider,
  type ComposerContextUsageFallback,
} from "../context/composerContextMeterScope";
import { compactTokenCount } from "../context/contextInspectorModel";
import { EnvironmentCard } from "./EnvironmentGroup";
import { EnvironmentContextSection } from "./EnvironmentContextSection";
import { EnvironmentSubagents } from "./EnvironmentSubagents";
import { EnvironmentFoldScope } from "./environmentSections";

beforeEach(() => {
  globalThis.localStorage.clear();
});

function Strip(props: { readonly windowKey?: string; readonly children: ReactNode }) {
  return (
    <EnvironmentFoldScope mode="code" windowKey={props.windowKey ?? "window-a"}>
      {props.children}
    </EnvironmentFoldScope>
  );
}

function Changes() {
  return (
    <Strip>
      <EnvironmentCard caption="Changes" foldId="changes" summary="+7 −4">
        <button type="button">Commit or push</button>
      </EnvironmentCard>
    </Strip>
  );
}

describe("folding a section of the Environment strip", () => {
  it("folds a section to one row with its summary and takes its rows out of the tab order", async () => {
    const user = userEvent.setup();
    render(<Changes />);
    const title = screen.getByRole("button", { name: "Changes" });
    expect(title).toHaveAttribute("aria-expanded", "true");
    expect(title).toHaveAttribute("aria-controls");
    // Open, the title row says nothing of its own.
    expect(screen.queryByText("+7 −4")).toBeNull();

    await user.click(title);

    expect(title).toHaveAttribute("aria-expanded", "false");
    expect(title).toHaveAccessibleName("Changes");
    expect(title).toHaveAccessibleDescription("+7 −4");
    expect(screen.getByText("+7 −4")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Commit or push" })).toBeNull();
    await user.tab();
    expect(document.body).toHaveFocus();
  });

  it("keeps a section folded after the strip is mounted again in the same window", async () => {
    const user = userEvent.setup();
    const first = render(<Changes />);
    await user.click(screen.getByRole("button", { name: "Changes" }));
    first.unmount();

    render(<Changes />);
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Another window has its own choice.
    render(
      <Strip windowKey="window-b">
        <EnvironmentCard caption="Changes" foldId="changes" summary="Clean">
          <p>Row</p>
        </EnvironmentCard>
      </Strip>,
    );
    expect(screen.getAllByRole("button", { name: "Changes" })[1]).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

describe("a folded Running section", () => {
  it("stays folded when a subagent starts and counts it in its summary", async () => {
    const user = userEvent.setup();
    const running = (client: AgentRunClient) => (
      <Strip>
        <EnvironmentCard caption="Running" foldId="running">
          <EnvironmentSubagents client={client} threadId={String(parentThreadId)} />
        </EnvironmentCard>
      </Strip>
    );
    const view = render(running(summaryClient([])));
    expect(await screen.findByRole("button", { name: "Running" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Running" }));
    expect(await screen.findByText("Nothing running")).toBeVisible();

    view.rerender(running(summaryClient([liveEntry])));

    expect(await screen.findByText("1 running")).toBeVisible();
    expect(screen.getByRole("button", { name: "Running" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("button", { name: /^Subagents/ })).toBeNull();
  });
});

function Context(props: {
  readonly fallback?: ComposerContextUsageFallback;
  readonly children?: ReactNode;
}) {
  return (
    <ComposerContextMeterProvider
      {...(props.fallback === undefined ? {} : { fallback: props.fallback })}
      status="ready"
      subjectKey="code-thread:a"
    >
      <ComposerContextMeterGate enabled>
        <Strip>
          <EnvironmentContextSection />
        </Strip>
        {props.children}
      </ComposerContextMeterGate>
    </ComposerContextMeterProvider>
  );
}

describe("the Context section", () => {
  it("shows the share, the figures and a meter when the provider names a maximum", () => {
    render(<Context fallback={{ limits: [], contextTokens: 68_000, contextWindow: 200_000 }} />);
    expect(screen.getByText("34% used")).toBeVisible();
    expect(screen.getByText("68K / 200K")).toBeVisible();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "34");
  });

  it("shows the used figure and no share or meter when the provider names no maximum", () => {
    render(<Context fallback={{ limits: [], contextTokens: 5_000 }} />);
    expect(screen.getByText("5K used")).toBeVisible();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("says once that nothing is reported, with no meter and no zero, and blames no provider it has not confirmed", async () => {
    const user = userEvent.setup();
    render(<Context fallback={{ limits: [] }} />);
    // The host has not said this provider never reports, so the line does not
    // say so either.
    expect(screen.getByText("No context use reported.")).toBeVisible();
    expect(screen.queryByText(/does not report/)).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByText(/0%/)).toBeNull();
    // Folded, the section has no summary to show.
    await user.click(screen.getByRole("button", { name: "Context" }));
    expect(screen.getByRole("button", { name: "Context" })).not.toHaveAccessibleDescription();
  });

  it("shows the same figure as the composer's context control", () => {
    render(
      <Context fallback={{ limits: [], contextTokens: 68_000, contextWindow: 200_000 }}>
        <ComposerContextMeter />
      </Context>,
    );
    const figure = `${compactTokenCount(68_000)} of ${compactTokenCount(200_000)} (34%)`;
    expect(screen.getByRole("button", { name: (name) => name.includes(figure) })).toBeVisible();
    expect(screen.getByText("34% used")).toBeVisible();
    expect(screen.getByText("68K / 200K")).toBeVisible();
  });
});

const parentThreadId = decodeAgentRunParentThreadId("20000000-0000-4000-8000-000000000001");
const unused = (): Promise<never> => Promise.reject(new Error("unused in this fixture"));
const liveEntry = {
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  runId: decodeAgentRunId("50000000-0000-4000-8000-000000000001"),
  requestId: "40000000-0000-4000-8000-000000000001",
  parentThreadId,
  role: "review" as const,
  task: "Task",
  lifecycleStatus: "running" as const,
  executionKind: "octant-managed" as const,
  usageQuality: "exact" as const,
  resultAcknowledgement: { required: false, acknowledged: false },
  version: 2,
  updatedAt: "2026-08-23T00:00:00Z",
};

function summaryClient(entries: ReadonlyArray<typeof liveEntry>): AgentRunClient {
  return {
    conversation: unused,
    parentSummary: async () => ({ parentThreadId, entries }),
    center: unused,
    acknowledge: unused,
    cancel: unused,
    steer: unused,
    retry: unused,
    resume: unused,
    usageResume: unused,
    snapshotCanvas: unused,
  };
}
