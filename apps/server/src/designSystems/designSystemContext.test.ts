import { describe, expect, it, vi } from "vitest";
import { designSystemTurnContext } from "./designSystemContext";

const document = {
  folder: "/p",
  path: "DESIGN.md",
  text: "# Acme",
  revision: "r1",
  reading: {
    name: "Acme",
    frontMatter: "absent" as const,
    tokens: [],
    brand: {},
    ignoredKeys: [],
    sections: [],
    body: "# Acme",
  },
};

describe("a turn's design system context", () => {
  it("gives a turn nothing at all when the person turned design systems off", async () => {
    const primary = vi.fn(async () => ({
      document: undefined,
      others: [{ folder: "/p", path: "apps/site/DESIGN.md" }],
    }));
    expect(
      await designSystemTurnContext(
        { primary },
        { main: "/p", extra: [], projectName: "Acme", choice: { kind: "none" } },
      ),
    ).toBeUndefined();
    expect(primary).not.toHaveBeenCalled();
  });

  it("names the other design systems when the Project follows one", async () => {
    const context = await designSystemTurnContext(
      {
        primary: async () => ({
          document,
          others: [{ folder: "/p", path: "apps/site/DESIGN.md" }],
        }),
      },
      { main: "/p", extra: [], projectName: "Acme" },
    );
    expect(context?.instructions).toContain("apps/site/DESIGN.md");
    expect(context?.system?.text).toContain("# Acme");
  });
});
