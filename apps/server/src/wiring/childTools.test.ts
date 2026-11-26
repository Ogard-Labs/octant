import { describe, expect, it } from "vitest";
import { childRun } from "../agentRun/agentRunChildTools.test-support";
import { promptTools } from "../agentPromptSize/agentPromptSize";
import { wireChildTools } from "./childTools";

/** Thread tools a child run is never offered: they act for the thread, or belong to a context a child is not. */
const NOT_INHERITED = [
  "octant_agents",
  "octant_ask_thread",
  "octant_create_video",
  "octant_linear",
  "octant_narrate",
  "octant_offer_side_task",
  "octant_propose_routine",
  "octant_pull_request",
  "octant_remember_person",
  "octant_report_finished",
  "octant_routines",
  "octant_side_chat_list_files",
  "octant_side_chat_read_file",
  "octant_side_chat_search_files",
  "octant_threads",
  "octant_transcribe",
  "octant_zen",
];

function inheritedNames(): ReadonlyArray<string> {
  const contributors: Array<(input: never) => unknown> = [];
  const asked: string[] = [];
  wireChildTools({
    persistence: { dataDirectory: "/data", connection: {} },
    providerDataDirectory: "/data/providers",
    contributeChildTools: (contributor: (input: never) => unknown) => {
      contributors.push(contributor);
    },
    childToolHost: (_input: unknown, name: string) => {
      asked.push(name);
      return undefined;
    },
  } as never);
  const run = childRun();
  for (const contribute of contributors)
    expect(
      contribute({ run, authority: run.authority, projectRoot: "/child" } as never),
    ).toBeUndefined();
  return asked.sort();
}

describe("the thread tools a child run inherits", () => {
  it("are exactly the ones a child can act with as itself, each gated by the child's own host", () => {
    expect(inheritedNames()).toEqual([
      "octant_android",
      "octant_apple",
      "octant_code",
      "octant_create_image",
      "octant_credential",
      "octant_debug",
      "octant_github",
      "octant_look",
      "octant_memory",
      "octant_terminal",
    ]);
  });

  it("never include one that acts for the thread itself", () => {
    const inherited = new Set(inheritedNames());
    for (const context of ["chat-child", "work-child", "code-child"] as const) {
      const measured = new Set(promptTools(context).map((tool) => tool.name));
      for (const name of NOT_INHERITED) {
        expect(inherited.has(name)).toBe(false);
        expect(measured.has(name)).toBe(false);
      }
    }
  });
});
