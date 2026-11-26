import { expect, it, vi } from "vitest";
import { couldNotLoad } from "../shell/windowNotice";
import { threadRestRowActions } from "./threadRestRowActions";

// The chunk that sends a change could not be fetched, as after a deploy.
vi.mock("./threadRestRun", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

it("says a sidebar change could not load, where thread notices appear", async () => {
  const setThreadExportNotice = vi.fn();
  const actions = threadRestRowActions({
    threadRestRow: () => ({ title: "Plan" }),
    setThreadExportNotice,
  } as never);
  actions.code.onCompleteThread?.("00000000-0000-4000-8000-0000000000c1");
  await vi.waitFor(() =>
    expect(setThreadExportNotice).toHaveBeenCalledWith(couldNotLoad("this change to the thread")),
  );
});
