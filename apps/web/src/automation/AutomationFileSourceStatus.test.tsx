import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { AutomationFileSourceSummary } from "@octant/contracts";
import { createAutomationClient } from "@octant/client-runtime";
import { AutomationFileSourceStatus } from "./AutomationFileSourceStatus";
import {
  useAutomationCenterController,
  type AutomationCenterController,
} from "./useAutomationCenterController";
import { automationDefinitionFixture, automationSummaryFixture } from "./automationTestFixtures";

const definition = automationDefinitionFixture({
  trigger: {
    kind: "file-arrival",
    directory: "Inbox",
    includeExtensions: ["txt"],
    excludeDirectories: [],
    settleSeconds: 2,
    automaticStartLimit: 8,
  },
  nextDueAt: null,
});
const held = Schema.decodeUnknownSync(AutomationFileSourceSummary)({
  phase: "held",
  observationRevision: 1,
  remainingStarts: 7,
  coverageGap: false,
  heldFiles: ["invoice.txt"],
  heldDigest: "b".repeat(64),
  reviewDigest: "b".repeat(64),
  sourceIdentity: "a".repeat(64),
});
afterEach(() => {
  vi.useRealTimers();
});

describe("file input status and person review", () => {
  it("does not infer a ready watcher from saved setup", () => {
    render(
      <AutomationFileSourceStatus
        automation={definition}
        source={{ ...held, phase: "arming", heldFiles: [] }}
        execute={async () => ({ kind: "automation-resumed", automation: definition })}
        refresh={() => undefined}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Arming");
    expect(screen.queryByRole("button", { name: "Review and re-arm" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check input status" })).toBeEnabled();
  });
  it("shows the held names and finite allowance before an exact explicit choice, with keyboard close", async () => {
    const execute = vi.fn<AutomationCenterController["execute"]>(async () => ({
      kind: "automation-resumed",
      automation: definition,
    }));
    render(
      <AutomationFileSourceStatus
        automation={definition}
        source={held}
        execute={execute}
        refresh={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Review and re-arm" }));
    const dialog = screen.getByRole("dialog", { name: "Review file input" });
    expect(dialog).toHaveTextContent("invoice.txt");
    expect(dialog).toHaveTextContent("new allowance of 8 automatic runs");
    await waitFor(() => expect(screen.getByRole("button", { name: "Close review" })).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(execute).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Review and re-arm" }));
    await userEvent.click(screen.getByRole("button", { name: "Skip these changes and re-arm" }));
    expect(execute).toHaveBeenCalledWith(
      {
        kind: "rearm-file-automation",
        automationId: definition.id,
        expectedVersion: definition.version,
        sourceIdentity: held.sourceIdentity,
        observationRevision: 1,
        batchDigest: held.reviewDigest,
        disposition: "skip",
      },
      "Input skipped and routine re-armed.",
    );
  });
  it("does not reuse a displayed choice after the host observation changes", async () => {
    const execute = vi.fn<AutomationCenterController["execute"]>(async () => ({
      kind: "automation-resumed",
      automation: definition,
    }));
    const refresh = vi.fn();
    const view = render(
      <AutomationFileSourceStatus
        automation={definition}
        source={held}
        execute={execute}
        refresh={refresh}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Review and re-arm" }));
    view.rerender(
      <AutomationFileSourceStatus
        automation={definition}
        source={{ ...held, observationRevision: 2, reviewDigest: "c".repeat(64) }}
        execute={execute}
        refresh={refresh}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("input review changed");
    expect(screen.queryByRole("button", { name: "Run once and re-arm" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh details and history" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
  it("uses the actual client deadline for an uncooperative lost Skip reply and ignores a late success", async () => {
    let release: ((response: Response) => void) | undefined;
    let mutations = 0;
    const fetchPort = new Proxy(globalThis.fetch, {
      apply: (_target, _receiver, args) => {
        const path = new URL(String(args[0])).pathname;
        if (path.endsWith("/commands")) {
          mutations += 1;
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        const payload = path.endsWith("/list")
          ? {
              kind: "automation-list",
              items: [
                automationSummaryFixture({
                  trigger: definition.trigger,
                  nextDueAt: null,
                  fileSource: held,
                }),
              ],
            }
          : { kind: "automation-detail", automation: definition, runs: [], fileSource: held };
        return Promise.resolve(new Response(JSON.stringify(payload)));
      },
    });
    const client = createAutomationClient({
      baseUrl: "http://127.0.0.1:4310",
      fetch: fetchPort,
      windowCapability: "fixture-capability",
    });
    function ActualControl() {
      const controller = useAutomationCenterController({ client });
      const select = controller.select;
      useEffect(() => select(definition.id, { fileSourceReview: true }), [select]);
      return controller.detail.status === "ready" ? (
        <AutomationFileSourceStatus
          automation={controller.detail.automation}
          source={controller.detail.fileSource}
          execute={controller.execute}
          refresh={controller.retryDetail}
        />
      ) : (
        <p>Reading input status</p>
      );
    }
    render(<ActualControl />);
    await userEvent.click(await screen.findByRole("button", { name: "Review and re-arm" }));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Skip these changes and re-arm" }));
    expect(screen.getByRole("button", { name: "Run once and re-arm" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("has not confirmed");
    expect(screen.getByRole("dialog")).toHaveTextContent("invoice.txt");
    expect(screen.getByRole("button", { name: "Refresh details and history" })).toBeEnabled();
    expect(mutations).toBe(1);
    await act(async () => {
      release?.(
        new Response(JSON.stringify({ kind: "automation-resumed", automation: definition })),
      );
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("has not confirmed");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mutations).toBe(1);
  });
});
