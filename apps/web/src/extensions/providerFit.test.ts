import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { describe, expect, it } from "vitest";
import { providerFit } from "./providerFit";

function pkg(
  modes: ReadonlyArray<"chat" | "work" | "code">,
  providerFamilies: ReadonlyArray<string>,
  components: ReadonlyArray<{ kind: string; capabilities?: ReadonlyArray<string> }>,
): ExtensionSnapshot["packages"][number] {
  return {
    compatibility: { platforms: ["macos"], modes, providerFamilies },
    components: components.map((component, index) => ({
      component: {
        id: `c${index}`,
        kind: component.kind,
        displayName: component.kind,
        declaredCapabilities: component.capabilities ?? [],
      },
      activation: {},
      effectiveState: { kind: "effective" },
    })),
  } as never;
}

describe("where a package works, in words", () => {
  it("says every mode and every provider for a plain skills package", () => {
    expect(
      providerFit(pkg(["chat", "work", "code"], [], [{ kind: "skill-instructions" }])),
    ).toEqual({
      sentence: "Works in Work, Code and Chat with every provider.",
      limits: [],
    });
  });

  it("names the providers a package is limited to, by their labels", () => {
    expect(providerFit(pkg(["code"], ["claude", "codex"], [])).sentence).toBe(
      "Works in Code with Claude and Codex.",
    );
  });

  it("narrows a mode to the parts allowed there and warns about tool-carrying providers", () => {
    const fit = providerFit(
      pkg(
        ["chat", "work", "code"],
        [],
        [{ kind: "skill-instructions" }, { kind: "mcp-server", capabilities: ["filesystem"] }],
      ),
    );
    expect(fit.sentence).toBe("Works in Work and Code with every provider.");
    expect(fit.limits).toEqual([
      "In Chat, its skills only.",
      "A provider that cannot carry Octant's tools refuses a turn that selects its servers.",
    ]);
  });
});
