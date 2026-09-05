import { decodePreviewHostId } from "@octant/contracts/previews";
import { decodeProjectId } from "@octant/contracts/projects";
import { describe, expect, it } from "vitest";
import { WorkFilePreviewRefs } from "./workFilePreviewRefs";

const projectA = decodeProjectId("00000000-0000-4000-8000-0000000009c1");
const projectB = decodeProjectId("00000000-0000-4000-8000-0000000009c2");

function refs(maxRefsPerProject?: number) {
  let next = 0;
  return new WorkFilePreviewRefs({
    hostId: decodePreviewHostId("00000000-0000-4000-8000-0000000009f1"),
    uuid: () => {
      next += 1;
      return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
    },
    ...(maxRefsPerProject === undefined ? {} : { maxRefsPerProject }),
  });
}

describe("WorkFilePreviewRefs", () => {
  it("gives one path one token, so reopening a file selects the tab it already has", () => {
    const registry = refs();

    const first = registry.mint(projectA, "summary.md");
    const second = registry.mint(projectA, "summary.md");

    expect(second).toEqual(first);
    expect(registry.resolve(projectA, first.opaqueRef)).toBe("summary.md");
  });

  it("refuses a token minted for another Project rather than resolving it", () => {
    const registry = refs();

    const target = registry.mint(projectA, "summary.md");

    // The Project is part of the lookup, so a token cannot be replayed against
    // another Project's folder even by a caller that holds it.
    expect(registry.resolve(projectB, target.opaqueRef)).toBeUndefined();
  });

  it("resolves nothing for a token this host never minted", () => {
    expect(refs().resolve(projectA, "not-a-ref" as never)).toBeUndefined();
  });

  it("forgets the oldest path rather than growing without bound", () => {
    const registry = refs(2);

    const oldest = registry.mint(projectA, "a.txt");
    registry.mint(projectA, "b.txt");
    registry.mint(projectA, "c.txt");

    // Forgetting is safe: the next listing mints the path another token.
    expect(registry.resolve(projectA, oldest.opaqueRef)).toBeUndefined();
    expect(registry.mint(projectA, "a.txt")).not.toEqual(oldest);
  });

  it("keeps each Project's paths in its own budget", () => {
    const registry = refs(1);

    const inA = registry.mint(projectA, "a.txt");
    const inB = registry.mint(projectB, "b.txt");

    expect(registry.resolve(projectA, inA.opaqueRef)).toBe("a.txt");
    expect(registry.resolve(projectB, inB.opaqueRef)).toBe("b.txt");
  });
});
