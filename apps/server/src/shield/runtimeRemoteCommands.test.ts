import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "@octant/contracts";
import { RuntimeRemoteCommands } from "./runtimeRemoteCommands";

const event = (fields: Record<string, unknown>) => fields as unknown as ProviderRuntimeEvent;

describe("a provider runtime's remote commands", () => {
  it("journals an ssh command the runtime ran with its exit status, and nothing else", () => {
    const record = vi.fn(() => "recorded" as const);
    const commands = new RuntimeRemoteCommands(record);
    commands.observe(
      "t1",
      "p1",
      event({ kind: "tool-start", toolCallId: "a", toolName: "Bash", argument: "ssh web1 uptime" }),
    );
    commands.observe(
      "t1",
      "p1",
      event({ kind: "tool-start", toolCallId: "b", toolName: "Bash", argument: "ls -la" }),
    );
    commands.observe(
      "t1",
      "p1",
      event({ kind: "tool-start", toolCallId: "c", toolName: "Bash", argument: "scp web1:/a ." }),
    );
    commands.observe(
      "t1",
      "p1",
      event({ kind: "tool-failure", toolCallId: "a", message: "Tool failed.", exitCode: 3 }),
    );
    commands.observe(
      "t1",
      "p1",
      event({ kind: "tool-success", toolCallId: "b", summary: "Tool completed." }),
    );
    commands.observe(
      "t1",
      "p1",
      event({ kind: "tool-failure", toolCallId: "c", message: "Tool was declined." }),
    );
    expect(record.mock.calls).toEqual([
      [{ threadId: "t1", projectId: "p1", command: "ssh web1 uptime", status: "ran", exitCode: 3 }],
      [{ threadId: "t1", projectId: "p1", command: "scp web1:/a .", status: "unavailable" }],
    ]);
  });
});
