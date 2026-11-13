import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ContextClient } from "@octant/client-runtime/context-client";
import {
  decodeContextSubjectRef,
  decodeTaskAccessSnapshot,
  type TaskAccessSnapshot,
} from "@octant/contracts";
import { ThreadGuardrailLevel } from "./GuardrailLevelIndicator";
import { TaskAccessContext } from "./TaskAccessDetails";

const subject = decodeContextSubjectRef({
  aggregateType: "code-thread",
  aggregateId: "82000000-0000-4000-8000-000000000002",
});
const otherSubject = decodeContextSubjectRef({
  aggregateType: "work-thread",
  aggregateId: "82000000-0000-4000-8000-000000000003",
});
function facts(extra: Partial<TaskAccessSnapshot> = {}) {
  return decodeTaskAccessSnapshot({
    kind: "task-access",
    standing: "active",
    subject,
    observedAt: "2026-11-02T21:00:00.000Z",
    selectedMode: "full-access",
    effectiveMode: "plan",
    effectiveContext: "running-turn-or-session",
    ceiling: "plan",
    default: { status: "known", mode: "full-access", scope: "project", matchesSelected: true },
    reviewer: { kind: "person", availability: "not-applicable" },
    runtime: {
      accountId: "82000000-0000-4000-8000-000000000010",
      accountName: "Task account",
      modelId: "main-model",
      enabled: true,
      readiness: "ready",
      capabilities: [
        { id: "nativeWebResearch", support: "unsupported" },
        { id: "forceStop", support: "unavailable" },
      ],
    },
    outsideContent: { read: true, effect: "gates" },
    limitations: [],
    ...extra,
  });
}
function client(read: NonNullable<ContextClient["taskAccess"]>, local = true) {
  return { taskAccess: read, externalContentAvailable: local } as ContextClient;
}
function header(
  reader: ContextClient,
  extra: {
    readonly version?: number;
    readonly activity?: string;
    readonly subject?: typeof subject;
    readonly onOpenProviders?: () => void;
  } = {},
) {
  return (
    <TaskAccessContext
      value={{
        client: reader,
        subject: extra.subject ?? subject,
        ...(extra.onOpenProviders === undefined ? {} : { onOpenProviders: extra.onOpenProviders }),
      }}
    >
      <ThreadGuardrailLevel
        surface="code"
        mode="full-access"
        autoSupported
        projectId="82000000-0000-4000-8000-000000000020"
        factsVersion={extra.version ?? 1}
        {...(extra.activity === undefined ? {} : { factsActivity: extra.activity })}
      />
    </TaskAccessContext>
  );
}

describe("server-reported task access details", () => {
  it("focuses its inline report and returns keyboard focus after Escape", async () => {
    const user = userEvent.setup();
    render(header(client(async () => facts())));
    const trigger = screen.getByRole("button", { name: "Access details" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const panel = await screen.findByRole("region", { name: "Task access details" });
    expect(panel).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Task access details" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("uses the host's running Plan ceiling and qualifies the selected default instead of claiming Full access", async () => {
    render(header(client(async () => facts())));
    expect(await screen.findByText("Plan", { selector: ".guardrail-level__mode" })).toBeVisible();
    expect(screen.getByText("Matches this Project’s default")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Access details" }));
    expect(await screen.findByRole("region", { name: "Task access details" })).toHaveTextContent(
      "Current turn/session limit",
    );
    expect(await screen.findByText(/Task account · main-model/)).toBeVisible();
    expect(screen.getByText("Runtime web research: unsupported by this runtime")).toBeVisible();
    expect(screen.getByText("Force Stop: temporarily unavailable")).toBeVisible();
    expect(screen.queryByRole("button", { name: /full access/i })).toBeNull();
  });
  it("says a Full access thread's Octant tools are mixed with tools Octant did not supply", async () => {
    const mixed = facts();
    render(
      header(
        client(async () =>
          decodeTaskAccessSnapshot({
            ...mixed,
            runtime: {
              ...mixed.runtime,
              capabilities: [{ id: "appManagedTools", support: "mixed" }],
            },
          }),
        ),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Access details" }));
    expect(
      await screen.findByText("Octant-managed tools: mixed with tools Octant did not supply"),
    ).toBeVisible();
  });
  it("keeps the chosen unavailable reviewer account and routes the real remedy to existing provider settings", async () => {
    const open = vi.fn();
    render(
      header(
        client(async () =>
          facts({
            reviewer: {
              kind: "octant-shield",
              accountId: "82000000-0000-4000-8000-000000000011" as never,
              accountName: "Chosen Judge",
              modelId: "judge-model" as never,
              availability: "unavailable",
            },
            limitations: [
              {
                kind: "needs-approval",
                message: "The chosen reviewer is unavailable; it asks you.",
                recovery: "provider-settings",
              },
            ],
          }),
        ),
        { onOpenProviders: open },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Access details" }));
    expect(await screen.findByText("Chosen Judge")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open provider settings" }));
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("drops an old client's delayed account facts after switching task/client and aborts its read", async () => {
    const first = Promise.withResolvers<TaskAccessSnapshot>();
    let oldSignal: AbortSignal | undefined;
    const old = client((_subject, signal) => {
      oldSignal = signal;
      return first.promise;
    });
    const current = client(async () =>
      facts({
        subject: otherSubject,
        runtime: { ...facts().runtime, accountName: "Current account" },
      }),
    );
    const mounted = render(header(old));
    mounted.rerender(header(current, { subject: otherSubject }));
    expect(oldSignal?.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Access details" }));
    expect(await screen.findByText(/Current account · main-model/)).toBeVisible();
    await act(async () =>
      first.resolve(facts({ runtime: { ...facts().runtime, accountName: "OLD PRIVATE ACCOUNT" } })),
    );
    expect(screen.queryByText(/OLD PRIVATE ACCOUNT/)).toBeNull();
  });
  it("invalidates old facts when the same task version changes before accepting its new report", async () => {
    const next = Promise.withResolvers<TaskAccessSnapshot>();
    let changed = false;
    const reader = client(async () => (changed ? next.promise : facts()));
    const mounted = render(header(reader));
    await screen.findByText("Plan", { selector: ".guardrail-level__mode" });
    fireEvent.click(screen.getByRole("button", { name: "Access details" }));
    await screen.findByText(/Task account · main-model/);
    changed = true;
    mounted.rerender(header(reader, { version: 2 }));
    expect(
      screen.getByText("Selected Full access", { selector: ".guardrail-level__mode" }),
    ).toBeVisible();
    expect(screen.queryByText(/Task account · main-model/)).toBeNull();
    await act(async () =>
      next.resolve(
        facts({
          effectiveMode: "ask-first",
          ceiling: "ask-first",
          runtime: { ...facts().runtime, accountName: "Changed account" },
        }),
      ),
    );
    expect(await screen.findByText(/Changed account · main-model/)).toBeVisible();
    expect(
      await screen.findByText("Ask first", { selector: ".guardrail-level__mode" }),
    ).toBeVisible();
  });
  it("re-reads a turn's new ceiling on activity transition even when the saved thread version did not change", async () => {
    let running = false;
    const reader = client(async () =>
      facts({
        effectiveMode: running ? "plan" : "full-access",
        ceiling: running ? "plan" : undefined,
        effectiveContext: running ? "running-turn-or-session" : "thread",
      }),
    );
    const mounted = render(header(reader, { activity: "idle" }));
    await screen.findByText("Full access", { selector: ".guardrail-level__mode" });
    running = true;
    mounted.rerender(header(reader, { activity: "operation:running" }));
    expect(await screen.findByText("Plan", { selector: ".guardrail-level__mode" })).toBeVisible();
    running = false;
    mounted.rerender(header(reader, { activity: "idle" }));
    expect(screen.queryByText("Plan", { selector: ".guardrail-level__mode" })).toBeNull();
    expect(
      await screen.findByText("Full access", { selector: ".guardrail-level__mode" }),
    ).toBeVisible();
  });
  it("shows unknown on a failed refresh and never retains the previous account report", async () => {
    let down = false;
    render(
      header(
        client(async () => {
          if (down) throw new Error("private transport detail");
          return facts();
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Access details" }));
    await screen.findByText(/Task account · main-model/);
    down = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh access report" }));
    expect(await screen.findByText(/host has not reported current task access/)).toBeVisible();
    expect(screen.queryByText(/Task account · main-model/)).toBeNull();
    expect(screen.queryByText(/private transport detail/)).toBeNull();
    expect(
      screen.getByText("Selected Full access", { selector: ".guardrail-level__mode" }),
    ).toBeVisible();
  });
  it("preserves remote facts but offers host-owner recovery instead of a local settings right", async () => {
    const open = vi.fn();
    render(
      header(
        client(
          async () =>
            facts({
              limitations: [
                {
                  kind: "disabled",
                  message: "The selected account is turned off.",
                  recovery: "provider-settings",
                },
              ],
            }),
          false,
        ),
        { onOpenProviders: open },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Access details" }));
    expect(await screen.findByText("Ask the host owner to make this change.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open provider settings" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
