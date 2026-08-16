import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CanvasSkillContribution } from "@octant/contracts/canvas-skill";
import { CanvasSkillProvenance } from "./CanvasSkillProvenance";

const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const contribution: CanvasSkillContribution = {
  schemaVersion: 1,
  kind: "canvas-skill-contribution",
  qualifiedId:
    `agents-skills-directory:project:review:${digest}` as CanvasSkillContribution["qualifiedId"],
  version: "1.4.0" as CanvasSkillContribution["version"],
  digest: digest as CanvasSkillContribution["digest"],
  sourceKind: "agents-skills-directory",
  supportedSources: ["artifact", "thread"],
  layouts: [
    { layoutId: "audit" as never, title: "Audit summary", slots: [{ blockKind: "heading" }] },
  ],
  presentationRules: [
    { ruleId: "emph" as never, kind: "emphasis", target: "status", directive: "danger-first" },
  ],
};

describe("CanvasSkillProvenance", () => {
  it("surfaces the skill identity, version, source kind, and supported sources", () => {
    render(<CanvasSkillProvenance contribution={contribution} />);
    expect(screen.getByTestId("canvas-skill-provenance-id")).toHaveTextContent(
      "agents-skills-directory:project:review",
    );
    expect(screen.getByTestId("canvas-skill-provenance-version")).toHaveTextContent("1.4.0");
    expect(screen.getByTestId("canvas-skill-provenance-source-kind")).toHaveTextContent(
      "agents-skills-directory",
    );
    const supported = screen.getByTestId("canvas-skill-provenance-supported-sources");
    expect(supported).toHaveTextContent("artifact");
    expect(supported).toHaveTextContent("thread");
    expect(screen.getByTestId("canvas-skill-provenance-layouts")).toHaveTextContent(
      "Audit summary",
    );
  });

  it("states that the contribution grants no authority and renders no actions", () => {
    render(<CanvasSkillProvenance contribution={contribution} />);
    expect(screen.getByTestId("canvas-skill-provenance-note")).toHaveTextContent(
      "grants no authority",
    );
    // Provenance is inert: it exposes no interactive controls that could imply
    // a skill can act or be granted authority from this surface.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders an unversioned contribution without inventing a version", () => {
    const { version: _version, ...unversioned } = contribution;
    render(<CanvasSkillProvenance contribution={unversioned as CanvasSkillContribution} />);
    expect(screen.getByTestId("canvas-skill-provenance-version")).toHaveTextContent("unversioned");
  });
});
