import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkResearchBriefView } from "@octant/client-runtime/work-research-client";
import { WorkResearchPanel } from "./WorkResearchPanel";

function view(overrides: Partial<WorkResearchBriefView> = {}): WorkResearchBriefView {
  return {
    briefId: "brief-1",
    brief: {
      briefId: "brief-1",
      questions: ["What changed in the report?"],
      status: "gathering",
    },
    sources: [],
    revokedSourceIds: [],
    evidence: [],
    claims: [],
    ...overrides,
  } as unknown as WorkResearchBriefView;
}

const freshSource = [
  {
    sourceId: "source-1",
    displayName: "Quarterly notes",
    sourceRef: "quarterly-notes.md",
    availability: "fresh",
  },
] as unknown as WorkResearchBriefView["sources"];

const recordedEvidence = [
  {
    evidenceId: "evidence-1",
    sourceId: "source-1",
    citationAnchor: "anchor-1",
    excerpt: "Revenue grew by nine percent",
  },
] as unknown as WorkResearchBriefView["evidence"];

describe("WorkResearchPanel", () => {
  it("announces an unauthorized surface instead of showing an empty brief list", () => {
    render(<WorkResearchPanel briefs={[]} status="unauthorized" />);

    expect(screen.getByRole("note")).toHaveTextContent(
      "Research is not authorized in this window.",
    );
  });

  it("offers retry only once loading has settled", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <WorkResearchPanel briefs={[]} status="loading" onRetry={onRetry} />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    rerender(<WorkResearchPanel briefs={[]} status="failure" onRetry={onRetry} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("reports an empty Project honestly when ready", () => {
    render(<WorkResearchPanel briefs={[]} status="ready" />);

    expect(screen.getByRole("note")).toHaveTextContent("This Project has no research briefs.");
  });

  it("shows each brief question and its provenance counts", () => {
    render(
      <WorkResearchPanel
        status="ready"
        briefs={[
          view({
            sources: [
              {
                sourceId: "source-1",
                displayName: "Quarterly notes",
                sourceRef: "notes/q3.md",
                availability: "fresh",
              },
            ] as unknown as WorkResearchBriefView["sources"],
          }),
        ]}
      />,
    );

    expect(screen.getByText("What changed in the report?")).toBeVisible();
    expect(screen.getByText("Quarterly notes")).toBeVisible();
    expect(screen.getByText("notes/q3.md")).toBeVisible();
    expect(screen.getByText("1 source · 0 evidence · 0 claims")).toBeVisible();
  });

  it("labels a revoked source as revoked rather than by its stale availability", () => {
    render(
      <WorkResearchPanel
        status="ready"
        briefs={[
          view({
            sources: [
              {
                sourceId: "source-1",
                displayName: "Removed",
                sourceRef: "notes/gone.md",
                availability: "fresh",
              },
            ] as unknown as WorkResearchBriefView["sources"],
            revokedSourceIds: ["source-1"] as unknown as WorkResearchBriefView["revokedSourceIds"],
          }),
        ]}
      />,
    );

    expect(screen.getByText("revoked")).toBeVisible();
  });

  it("marks an unsupported claim in words, not colour alone", () => {
    render(
      <WorkResearchPanel
        status="ready"
        briefs={[
          view({
            claims: [
              { claimId: "claim-1", text: "Revenue grew", citationAnchors: [], unsupported: true },
              {
                claimId: "claim-2",
                text: "Costs fell",
                citationAnchors: ["a#1"],
                unsupported: false,
              },
            ] as unknown as WorkResearchBriefView["claims"],
          }),
        ]}
      />,
    );

    expect(screen.getByText("Unsupported")).toBeVisible();
    expect(screen.getByText("1 citation")).toBeVisible();
  });

  it("proposes a new research brief from the panel and clears the accepted question", async () => {
    const user = userEvent.setup();
    const onCreateBrief = vi.fn().mockResolvedValue({ kind: "accepted" });
    render(<WorkResearchPanel briefs={[]} status="ready" onCreateBrief={onCreateBrief} />);

    const input = screen.getByLabelText("Research question");
    await user.type(input, "What changed last quarter?");
    await user.click(screen.getByRole("button", { name: "New research brief" }));

    expect(onCreateBrief).toHaveBeenCalledWith({ question: "What changed last quarter?" });
    await waitFor(() => {
      expect(input).toHaveValue("");
    });
  });

  it("keeps the question and announces the reason when the host rejects a brief", async () => {
    const user = userEvent.setup();
    const onCreateBrief = vi
      .fn()
      .mockResolvedValue({ kind: "rejected", message: "The host declined the command." });
    render(<WorkResearchPanel briefs={[]} status="ready" onCreateBrief={onCreateBrief} />);

    const input = screen.getByLabelText("Research question");
    await user.type(input, "What changed?");
    await user.click(screen.getByRole("button", { name: "New research brief" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The host declined the command.");
    expect(input).toHaveValue("What changed?");
  });

  it("does not offer the brief form until the surface is ready or without a handler", () => {
    const onCreateBrief = vi.fn();
    const { rerender } = render(
      <WorkResearchPanel briefs={[]} status="loading" onCreateBrief={onCreateBrief} />,
    );
    expect(screen.queryByRole("button", { name: "New research brief" })).toBeNull();

    rerender(<WorkResearchPanel briefs={[]} status="ready" />);
    expect(screen.queryByRole("button", { name: "New research brief" })).toBeNull();
  });

  it("records a claim against an open brief but never against a finalized one", async () => {
    const user = userEvent.setup();
    const onRecordClaim = vi.fn().mockResolvedValue({ kind: "accepted" });
    const { rerender } = render(
      <WorkResearchPanel status="ready" briefs={[view()]} onRecordClaim={onRecordClaim} />,
    );

    await user.type(screen.getByLabelText("New claim"), "Revenue grew");
    await user.click(screen.getByRole("button", { name: "Add claim" }));
    expect(onRecordClaim).toHaveBeenCalledWith({
      briefId: "brief-1",
      text: "Revenue grew",
      citationAnchors: [],
    });

    rerender(
      <WorkResearchPanel
        status="ready"
        briefs={[
          view({
            brief: {
              briefId: "brief-1",
              questions: ["What changed in the report?"],
              status: "finalized",
            } as unknown as WorkResearchBriefView["brief"],
          }),
        ]}
        onRecordClaim={onRecordClaim}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add claim" })).toBeNull();
  });

  it("adds a picked file and its excerpt as a source", async () => {
    const user = userEvent.setup();
    const onAddSource = vi.fn().mockResolvedValue({ kind: "accepted" });
    render(<WorkResearchPanel status="ready" briefs={[view()]} onAddSource={onAddSource} />);

    const file = new File(["hello"], "quarterly-notes.md");
    await user.upload(screen.getByLabelText("Source file (top level of the Project folder)"), file);
    await user.type(screen.getByLabelText("Source excerpt"), "Revenue grew");
    await user.click(screen.getByRole("button", { name: "Add source" }));

    expect(onAddSource).toHaveBeenCalledWith({
      briefId: "brief-1",
      file,
      excerpt: "Revenue grew",
    });
  });

  it("tells the user the source file changed when the host answers stale to evidence", async () => {
    const user = userEvent.setup();
    const onRecordEvidence = vi.fn().mockResolvedValue({
      kind: "rejected",
      message:
        "The source file changed since it was added, so the host refused to record evidence against the version you cited.",
    });
    render(
      <WorkResearchPanel
        status="ready"
        briefs={[view({ sources: freshSource })]}
        onRecordEvidence={onRecordEvidence}
      />,
    );

    await user.type(screen.getByLabelText("Evidence excerpt"), "Revenue grew by nine percent");
    await user.click(screen.getByRole("button", { name: "Record evidence" }));

    expect(onRecordEvidence).toHaveBeenCalledWith({
      briefId: "brief-1",
      sourceId: "source-1",
      excerpt: "Revenue grew by nine percent",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The source file changed since it was added",
    );
  });

  it("offers evidence to cite only for a source the host still reports fresh", () => {
    const onRecordEvidence = vi.fn();
    render(
      <WorkResearchPanel
        status="ready"
        briefs={[
          view({
            sources: freshSource,
            revokedSourceIds: ["source-1"] as unknown as WorkResearchBriefView["revokedSourceIds"],
          }),
        ]}
        onRecordEvidence={onRecordEvidence}
      />,
    );

    expect(screen.queryByRole("button", { name: "Record evidence" })).toBeNull();
  });

  it("cites the evidence the user selected when recording a claim", async () => {
    const user = userEvent.setup();
    const onRecordClaim = vi.fn().mockResolvedValue({ kind: "accepted" });
    render(
      <WorkResearchPanel
        status="ready"
        briefs={[view({ sources: freshSource, evidence: recordedEvidence })]}
        onRecordClaim={onRecordClaim}
      />,
    );

    await user.type(screen.getByLabelText("New claim"), "Revenue grew");
    await user.click(screen.getByLabelText("Revenue grew by nine percent"));
    await user.click(screen.getByRole("button", { name: "Add claim" }));

    expect(onRecordClaim).toHaveBeenCalledWith({
      briefId: "brief-1",
      text: "Revenue grew",
      citationAnchors: ["anchor-1"],
    });
  });

  it("finalizes a brief that has claims and shows the finalized report read-only", async () => {
    const user = userEvent.setup();
    const onFinalizeReport = vi.fn().mockResolvedValue({ kind: "accepted" });
    const claims = [
      {
        claimId: "claim-1",
        text: "Revenue grew",
        citationAnchors: ["anchor-1"],
        unsupported: false,
      },
    ] as unknown as WorkResearchBriefView["claims"];
    const { rerender } = render(
      <WorkResearchPanel
        status="ready"
        briefs={[view({ claims, evidence: recordedEvidence, sources: freshSource })]}
        onFinalizeReport={onFinalizeReport}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Finalize report" }));
    expect(onFinalizeReport).toHaveBeenCalledWith({ briefId: "brief-1" });

    rerender(
      <WorkResearchPanel
        status="ready"
        briefs={[
          view({
            brief: {
              briefId: "brief-1",
              questions: ["What changed in the report?"],
              status: "finalized",
            },
            claims,
            evidence: recordedEvidence,
            sources: freshSource,
            report: { claims, evidence: recordedEvidence },
          } as unknown as Partial<WorkResearchBriefView>),
        ]}
        onFinalizeReport={onFinalizeReport}
      />,
    );

    expect(screen.getByRole("note")).toHaveTextContent(
      "Report finalized with 1 claim and 1 evidence entry. This brief is now read-only.",
    );
    expect(screen.queryByRole("button", { name: "Finalize report" })).toBeNull();
  });

  it("revokes a source the user no longer authorizes", async () => {
    const user = userEvent.setup();
    const onRevokeSource = vi.fn().mockResolvedValue({ kind: "accepted" });
    render(
      <WorkResearchPanel
        status="ready"
        briefs={[view({ sources: freshSource })]}
        onRevokeSource={onRevokeSource}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke Quarterly notes" }));

    expect(onRevokeSource).toHaveBeenCalledWith({ briefId: "brief-1", sourceId: "source-1" });
  });
});
