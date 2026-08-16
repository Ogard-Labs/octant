import { describe, expect, it } from "vitest";
import {
  emptyThreadContentTaint,
  projectThreadContentTaint,
} from "@octant/domain/untrusted-content-policy";
import {
  ExternalContentTaintProjection,
  applyProvenanceToThreadTaint,
} from "./externalContentTaintProjection";

describe("ExternalContentTaintProjection", () => {
  it("persists external-content-ingested for the thread lifetime across sessions and turns", () => {
    const projection = new ExternalContentTaintProjection();
    const threadId = "11111111-1111-4111-8111-111111111111";

    expect(projection.get(threadId).externalContentIngested).toBe(false);

    projection.recordIngested(threadId, {
      origin: "external-content",
      sourceLabel: "readme-md",
    });
    expect(projection.get(threadId)).toEqual({
      externalContentIngested: true,
      ingestedSources: ["readme-md"],
    });

    projection.noteSessionBoundary(threadId);
    projection.noteTurnBoundary(threadId);
    expect(projection.get(threadId).externalContentIngested).toBe(true);

    projection.recordIngested(threadId, {
      origin: "tool-result",
      sourceLabel: "mcp-web",
    });
    expect(projection.get(threadId).ingestedSources).toEqual(["readme-md", "mcp-web"]);

    // A different thread stays clean.
    expect(projection.get("22222222-2222-4222-8222-222222222222").externalContentIngested).toBe(
      false,
    );
  });

  it("rebuilds from provenance events without clearing on boundaries", () => {
    const rebuilt = applyProvenanceToThreadTaint(emptyThreadContentTaint(), [
      { kind: "content-ingested", provenance: { origin: "user", sourceLabel: "prompt" } },
      {
        kind: "content-ingested",
        provenance: { origin: "tool-result", sourceLabel: "file-read" },
      },
      { kind: "session-boundary" },
      { kind: "turn-boundary" },
    ]);
    expect(rebuilt).toEqual({
      externalContentIngested: true,
      ingestedSources: ["file-read"],
    });

    // Domain fold is the source of truth for rebuilds.
    let folded = emptyThreadContentTaint();
    folded = projectThreadContentTaint(folded, {
      kind: "content-ingested",
      provenance: { origin: "tool-result", sourceLabel: "file-read" },
    });
    folded = projectThreadContentTaint(folded, { kind: "session-boundary" });
    expect(folded).toEqual(rebuilt);
  });
});
