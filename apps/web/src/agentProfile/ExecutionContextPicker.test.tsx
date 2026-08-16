import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionContextPicker } from "./ExecutionContextPicker";
import type { ExecutionContextPickerEntry } from "@octant/contracts/agent-profile";

const entries: ExecutionContextPickerEntry[] = [
  {
    providerInstanceId:
      "00000000-0000-0000-0000-000000000003" as ExecutionContextPickerEntry["providerInstanceId"],
    providerDisplayName: "OpenAI",
    modelId: "gpt-4o" as ExecutionContextPickerEntry["modelId"],
    modelDisplayName: "GPT-4o",
    hostId: "local" as ExecutionContextPickerEntry["hostId"],
    hostLabel: "This Mac",
    executionPolicy: "approval-gated",
    effectivePermissions: {
      filesystem: true,
      shell: true,
      git: true,
      network: false,
      tools: true,
      subagents: false,
    },
  },
  {
    providerInstanceId:
      "00000000-0000-0000-0000-000000000003" as ExecutionContextPickerEntry["providerInstanceId"],
    providerDisplayName: "OpenAI",
    modelId: "gpt-4o" as ExecutionContextPickerEntry["modelId"],
    modelDisplayName: "GPT-4o",
    profileId: "00000000-0000-0000-0000-000000000001" as ExecutionContextPickerEntry["profileId"],
    profileDisplayName: "Code Reviewer",
    hostId: "local" as ExecutionContextPickerEntry["hostId"],
    hostLabel: "This Mac",
    executionPolicy: "plan",
    effectivePermissions: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: false,
      subagents: false,
    },
  },
];

describe("ExecutionContextPicker", () => {
  it("renders entries with provider, model, and permissions", () => {
    const html = renderToStaticMarkup(
      <ExecutionContextPicker entries={entries} onSelect={() => {}} />,
    );
    expect(html).toContain("OpenAI");
    expect(html).toContain("GPT-4o");
    expect(html).toContain("This Mac");
    expect(html).toContain("Approval");
    expect(html).toContain("FS");
  });

  it("renders profile name when present", () => {
    const html = renderToStaticMarkup(
      <ExecutionContextPicker entries={entries} onSelect={() => {}} />,
    );
    expect(html).toContain("Code Reviewer");
    expect(html).toContain("Plan");
    expect(html).toContain("Read-only");
  });

  it("renders empty state when no entries", () => {
    const html = renderToStaticMarkup(<ExecutionContextPicker entries={[]} onSelect={() => {}} />);
    expect(html).toContain("No providers available");
  });

  it("renders disabled state", () => {
    const html = renderToStaticMarkup(
      <ExecutionContextPicker entries={entries} onSelect={() => {}} disabled />,
    );
    expect(html).toContain("disabled");
  });

  it("renders unavailable reason", () => {
    const withUnavailable = [
      {
        ...entries[0],
        unavailableReason: "Profile exceeds Project authority.",
      } as ExecutionContextPickerEntry,
    ];
    const html = renderToStaticMarkup(
      <ExecutionContextPicker entries={withUnavailable} onSelect={() => {}} />,
    );
    expect(html).toContain("Profile exceeds Project authority.");
    expect(html).toContain("aria-disabled");
  });
});
