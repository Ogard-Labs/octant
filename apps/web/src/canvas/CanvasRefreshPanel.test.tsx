import type {
  CanvasRefreshReceipt,
  CanvasRefreshRecipeId,
  CanvasRefreshRequest,
  CanvasRefreshRequestId,
  CanvasRefreshResult,
} from "@octant/contracts/canvas-refresh";
import type { CanvasSkillContribution } from "@octant/contracts/canvas-skill";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import {
  CanvasRefreshPanel,
  deriveCanvasRefreshRecipe,
  type CanvasRefreshRequestBase,
} from "./CanvasRefreshPanel";
import { canvasFixture, chatProvenance } from "./test-fixtures";

const canvasId = "11111111-1111-4111-8111-111111111111";
const recipeId = "22222222-2222-4222-8222-222222222222" as CanvasRefreshRecipeId;
const requestId = "99999999-9999-4999-8999-999999999999" as CanvasRefreshRequestId;

const requestBase = {
  canvasId,
  expectedSequence: 3,
  hostId: chatProvenance.hostId,
  mode: chatProvenance.mode,
  workspace: { kind: "chat-virtual", projectId: null },
  originThreadId: chatProvenance.threadId,
  actor: chatProvenance.actor,
  providerInstanceId: chatProvenance.providerInstanceId,
  modelId: chatProvenance.modelId,
  requestedAuthority: {
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: true,
    subagents: false,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  },
} as unknown as CanvasRefreshRequestBase;

const recipe = deriveCanvasRefreshRecipe(canvasFixture, requestBase, () => recipeId)!;

const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const contribution: CanvasSkillContribution = {
  schemaVersion: 1,
  kind: "canvas-skill-contribution",
  qualifiedId:
    `agents-skills-directory:project:review:${digest}` as CanvasSkillContribution["qualifiedId"],
  version: "1.4.0" as CanvasSkillContribution["version"],
  digest: digest as CanvasSkillContribution["digest"],
  sourceKind: "agents-skills-directory",
  supportedSources: ["attachment"],
  layouts: [
    { layoutId: "audit" as never, title: "Audit summary", slots: [{ blockKind: "heading" }] },
  ],
  presentationRules: [],
};

function receipt(outcome: CanvasRefreshReceipt["outcome"]): CanvasRefreshReceipt {
  return {
    schemaVersion: 1,
    kind: "canvas-refresh-receipt",
    requestId,
    recipeId,
    canvasId,
    outcome,
    sources: [{ sourceId: canvasFixture.sourceManifest[0]!.sourceId, status: "ready" }],
    completedAt: "2026-08-02T09:00:00.000Z",
  } as unknown as CanvasRefreshReceipt;
}

function renderPanel(props: {
  readonly onRefresh: (request: never) => Promise<CanvasRefreshResult>;
  readonly onCancel?: (request: never) => Promise<CanvasRefreshResult>;
}) {
  return render(
    <CanvasRefreshPanel
      recipe={recipe}
      requestBase={requestBase}
      newRequestId={() => requestId}
      onRefresh={props.onRefresh as never}
      {...(props.onCancel === undefined ? {} : { onCancel: props.onCancel as never })}
    />,
  );
}

describe("deriveCanvasRefreshRecipe", () => {
  it("carries the canonical source manifest and canvas provenance", () => {
    expect(recipe.sourceManifest).toEqual(canvasFixture.sourceManifest);
    expect(recipe.parameters).toEqual([]);
    expect(recipe.kind).toBe("canvas-refresh-recipe");
    expect(String(recipe.originThreadId)).toBe(String(chatProvenance.threadId));
  });

  it("has no recipe when the canvas carries no refreshable source", () => {
    const sourceless = { ...canvasFixture, sourceManifest: [] } as typeof canvasFixture;
    expect(deriveCanvasRefreshRecipe(sourceless, requestBase, () => recipeId)).toBeUndefined();
  });
});

describe("CanvasRefreshPanel", () => {
  it("sends the recipe and renders skill provenance for an accepted refresh", async () => {
    const onRefresh = vi.fn(
      async (): Promise<CanvasRefreshResult> => ({
        kind: "accepted",
        receipt: receipt("ready"),
        contribution,
      }),
    );
    renderPanel({ onRefresh });

    fireEvent.click(screen.getByRole("button", { name: /Refresh canvas/i }));

    await waitFor(() => {
      expect(screen.getByTestId("canvas-refresh-status")).toHaveTextContent("Canvas refreshed.");
    });
    expect(onRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "canvas-refresh", requestId, recipe }),
    );
    expect(screen.getByTestId("canvas-skill-provenance")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-skill-provenance-version")).toHaveTextContent("1.4.0");
  });

  it("renders no provenance when an accepted refresh carried no skill", async () => {
    const onRefresh = vi.fn(
      async (): Promise<CanvasRefreshResult> => ({ kind: "accepted", receipt: receipt("ready") }),
    );
    renderPanel({ onRefresh });

    fireEvent.click(screen.getByRole("button", { name: /Refresh canvas/i }));

    await waitFor(() => {
      expect(screen.getByTestId("canvas-refresh-status")).toHaveTextContent("Canvas refreshed.");
    });
    expect(screen.queryByTestId("canvas-skill-provenance")).toBeNull();
  });

  it("shows safe mapped copy for a denial and never the server message", async () => {
    const onRefresh = vi.fn(
      async (): Promise<CanvasRefreshResult> => ({
        kind: "denied",
        denialCode: "unauthorized",
        message: "Canvas refresh is not authorized in this workspace.",
      }),
    );
    renderPanel({ onRefresh });

    fireEvent.click(screen.getByRole("button", { name: /Refresh canvas/i }));

    const status = await screen.findByRole("alert");
    expect(status).toHaveTextContent("Refreshing this canvas is not authorized here.");
    expect(screen.queryByText(/not authorized in this workspace/i)).toBeNull();
    expect(screen.queryByTestId("canvas-skill-provenance")).toBeNull();
  });

  it("reports a partial refresh in words, not colour alone", async () => {
    const onRefresh = vi.fn(
      async (): Promise<CanvasRefreshResult> => ({
        kind: "accepted",
        receipt: receipt("partial"),
      }),
    );
    renderPanel({ onRefresh });

    fireEvent.click(screen.getByRole("button", { name: /Refresh canvas/i }));

    await waitFor(() => {
      expect(screen.getByTestId("canvas-refresh-status")).toHaveTextContent(
        "Some sources could not be refreshed.",
      );
    });
  });

  it("cancels an in-flight refresh against the same request and recipe", async () => {
    let settle: ((result: CanvasRefreshResult) => void) | undefined;
    const onRefresh = vi.fn(
      () =>
        new Promise<CanvasRefreshResult>((resolve) => {
          settle = resolve;
        }),
    );
    const onCancel = vi.fn(
      async (): Promise<CanvasRefreshResult> => ({
        kind: "accepted",
        receipt: receipt("cancelled"),
      }),
    );
    renderPanel({ onRefresh, onCancel });

    fireEvent.click(screen.getByRole("button", { name: /Refresh canvas/i }));
    const cancel = await screen.findByRole("button", { name: /Cancel refresh/i });
    fireEvent.click(cancel);

    await waitFor(() => {
      expect(screen.getByTestId("canvas-refresh-status")).toHaveTextContent("Refresh cancelled.");
    });
    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "canvas-refresh-cancel", requestId, recipeId, canvasId }),
    );

    // A late resolution of the superseded refresh must not clobber the
    // cancelled state the user was already shown.
    settle?.({ kind: "accepted", receipt: receipt("ready"), contribution });
    await Promise.resolve();
    expect(screen.getByTestId("canvas-refresh-status")).toHaveTextContent("Refresh cancelled.");
    expect(screen.queryByTestId("canvas-skill-provenance")).toBeNull();
  });

  it("shows the refreshed state when the cancel loses the race to a ready receipt", async () => {
    const onRefresh = vi.fn(() => new Promise<CanvasRefreshResult>(() => {}));
    // The authoritative cancel receipt says the refresh already completed: a
    // new version exists, so the panel must not claim "Refresh cancelled."
    const onCancel = vi.fn(
      async (): Promise<CanvasRefreshResult> => ({
        kind: "accepted",
        receipt: receipt("ready"),
        contribution,
      }),
    );
    renderPanel({ onRefresh, onCancel });

    fireEvent.click(screen.getByRole("button", { name: /Refresh canvas/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel refresh/i }));

    await waitFor(() => {
      expect(screen.getByTestId("canvas-refresh-status")).toHaveTextContent("Canvas refreshed.");
    });
    expect(screen.getByTestId("canvas-skill-provenance")).toBeInTheDocument();
  });

  it("reports a denied cancel honestly instead of claiming a cancellation", async () => {
    const onRefresh = vi.fn(() => new Promise<CanvasRefreshResult>(() => {}));
    const onCancel = vi.fn(
      async (): Promise<CanvasRefreshResult> => ({
        kind: "denied",
        denialCode: "unauthorized",
        message: "Cancellation is not authorized in this workspace.",
      }),
    );
    renderPanel({ onRefresh, onCancel });

    fireEvent.click(screen.getByRole("button", { name: /Refresh canvas/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel refresh/i }));

    const status = await screen.findByRole("alert");
    expect(status).toHaveTextContent("Refreshing this canvas is not authorized here.");
    expect(screen.queryByText(/Refresh cancelled/i)).toBeNull();
  });

  it("says the cancellation outcome is unknown when the cancel itself fails", async () => {
    const onRefresh = vi.fn(() => new Promise<CanvasRefreshResult>(() => {}));
    const onCancel = vi.fn(async (): Promise<CanvasRefreshResult> => {
      throw new Error("transport lost");
    });
    renderPanel({ onRefresh, onCancel });

    fireEvent.click(screen.getByRole("button", { name: /Refresh canvas/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Cancel refresh/i }));

    const status = await screen.findByRole("alert");
    expect(status).toHaveTextContent("The cancellation could not be confirmed.");
    expect(screen.queryByText(/Refresh cancelled/i)).toBeNull();
  });

  it("offers no skill choice when the host published none", () => {
    const onRefresh = vi.fn(
      async (): Promise<CanvasRefreshResult> => ({ kind: "accepted", receipt: receipt("ready") }),
    );
    renderPanel({ onRefresh });
    expect(screen.queryByTestId("canvas-refresh-skill")).toBeNull();
  });

  it("names the skill the user chose from the host's published options", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn(
      async (): Promise<CanvasRefreshResult> => ({
        kind: "accepted",
        receipt: receipt("ready"),
        contribution,
      }),
    );
    render(
      <CanvasRefreshPanel
        recipe={recipe}
        requestBase={requestBase}
        newRequestId={() => requestId}
        onRefresh={onRefresh as never}
        skillOptions={[{ skill: { qualifiedId: contribution.qualifiedId }, displayName: "Review" }]}
      />,
    );

    // Default is no skill: a refresh must not silently acquire a contribution
    // the user never selected.
    const skill = screen.getByTestId("canvas-refresh-skill");
    expect(skill).toHaveTextContent("No skill");

    await chooseSelectFieldOption(user, skill, "Review");
    fireEvent.click(screen.getByRole("button", { name: /Refresh canvas/i }));

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
    const [request] = onRefresh.mock.calls[0] as unknown as [CanvasRefreshRequest];
    expect(request.recipe.skill).toEqual({ qualifiedId: contribution.qualifiedId });
    // The recipe keeps its identity, so an in-flight cancellation still matches.
    expect(request.recipe.recipeId).toBe(recipeId);
  });

  it("offers no cancel control when the host cannot cancel a refresh", async () => {
    const onRefresh = vi.fn(() => new Promise<CanvasRefreshResult>(() => {}));
    renderPanel({ onRefresh });

    fireEvent.click(screen.getByRole("button", { name: /Refresh canvas/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Refresh canvas/i })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });
    expect(screen.queryByRole("button", { name: /Cancel refresh/i })).toBeNull();
  });
});
