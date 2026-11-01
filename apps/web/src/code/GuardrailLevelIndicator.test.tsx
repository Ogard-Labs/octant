import { decodeProjectSummary } from "@octant/contracts/projects";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  GuardrailDefaultsContext,
  guardrailDefaultsOf,
  ThreadGuardrailLevel,
} from "./GuardrailLevelIndicator";

const PROJECT = "80000000-0000-4000-8000-000000000001";

function workProject(extra: object = {}) {
  return decodeProjectSummary({
    id: PROJECT,
    type: "work",
    name: "Notes",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
    binding: { canonicalRoot: "/notes" },
    bindingRevisionId: "80000000-0000-4000-8000-000000000002",
    ...extra,
  });
}

afterEach(cleanup);

function renderLevel(
  mode: "auto" | "ask-first" | "full-access",
  defaults: ReturnType<typeof guardrailDefaultsOf> | undefined,
) {
  render(
    <GuardrailDefaultsContext.Provider value={defaults}>
      <ThreadGuardrailLevel mode={mode} projectId={PROJECT} surface="work" />
    </GuardrailDefaultsContext.Provider>,
  );
}

describe("thread guardrail level", () => {
  it("names the level and says it comes from the Project when the Project sets it", () => {
    renderLevel(
      "auto",
      guardrailDefaultsOf({
        codeSettings: { defaultExecutionPolicy: "approval-gated" },
        workSettings: { defaultAccess: "ask-first" },
        projects: [workProject({ defaultPermissionMode: "auto" })],
      }),
    );
    expect(screen.getByText("Auto")).toBeVisible();
    expect(screen.getByText(/set by this Project/)).toBeVisible();
  });

  it("says the level is the person's default when no Project sets one", () => {
    renderLevel(
      "auto",
      guardrailDefaultsOf({
        codeSettings: { defaultExecutionPolicy: "approval-gated" },
        workSettings: { defaultAccess: "auto" },
        projects: [workProject()],
      }),
    );
    expect(screen.getByText(/set by your default/)).toBeVisible();
  });

  it("says the thread set its own level when it differs from the defaults", () => {
    renderLevel(
      "full-access",
      guardrailDefaultsOf({
        codeSettings: { defaultExecutionPolicy: "approval-gated" },
        workSettings: { defaultAccess: "ask-first" },
        projects: [workProject()],
      }),
    );
    expect(screen.getByText("Full access")).toBeVisible();
    expect(screen.getByText(/set by this thread/)).toBeVisible();
  });

  it("names only the level where the defaults are unknown", () => {
    renderLevel("ask-first", undefined);
    expect(screen.getByText("Ask first")).toBeVisible();
    expect(screen.queryByText(/set by/)).toBeNull();
  });
});
