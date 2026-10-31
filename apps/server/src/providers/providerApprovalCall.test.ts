import { describe, expect, it } from "vitest";
import { providerApprovalCall } from "./providerApprovalCall";

describe("the pending call a reviewer judges", () => {
  it("keeps only the fields a reviewer judges and redacts credentials in them", () => {
    const call = providerApprovalCall({
      tool: "Bash",
      arguments: {
        command: "deploy --token=fixture-must-not-cross --region north",
        cwd: "/Users/dev/app",
        output: "command output must-not-cross",
        account: "account must-not-cross",
        transcriptPath: "/private/transcript-must-not-cross.jsonl",
        content: "written content must-not-cross",
      },
    });
    expect(call?.tool).toBe("Bash");
    expect(call?.input).toContain("deploy --");
    expect(call?.input).toContain("[redacted]");
    expect(call?.input).toContain('"cwd":"/Users/dev/app"');
    expect(JSON.stringify(call)).not.toContain("must-not-cross");
  });

  it("keeps a location's path inside a judged field", () => {
    const call = providerApprovalCall({
      tool: "edit",
      arguments: { locations: [{ path: "/Users/dev/app/a.ts", line: 3 }] },
    });
    expect(JSON.parse(call?.input ?? "{}")).toEqual({
      locations: [{ path: "/Users/dev/app/a.ts", line: 3 }],
    });
  });

  it("names the tool alone when nothing judged was given, and nothing for a nameless tool", () => {
    expect(providerApprovalCall({ tool: "mystery", arguments: { output: "x" } })).toEqual({
      tool: "mystery",
    });
    expect(providerApprovalCall({ tool: "  " })).toBeUndefined();
  });

  it("cuts a large argument to the bound", () => {
    const call = providerApprovalCall({ tool: "Bash", arguments: { command: "x".repeat(20_000) } });
    expect(call?.input?.length).toBe(8_192);
  });
});
