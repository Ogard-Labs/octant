import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TurnActivityRows } from "./TurnActivityRows";

const url = "https://claude.ai/artifact/abc123";

function rows(published: Record<string, unknown>) {
  return {
    rows: [
      {
        kind: "tool" as const,
        id: "tool-1",
        toolName: "Artifact",
        state: "completed" as const,
        published: { url, title: "Report", ...published },
      },
    ],
    reasoning: "",
  } as never;
}

describe("a published page in the thread", () => {
  it("draws the static snapshot in a sandboxed frame beside the link, labelled as a snapshot", () => {
    render(
      <TurnActivityRows
        activity={rows({ snapshot: { format: "html", content: "<h1>Quarterly report</h1>" } })}
        running={false}
        settled
      />,
    );
    expect(screen.getByRole("link", { name: /Report/ })).toHaveAttribute("href", url);
    const snapshot = screen.getByRole("region", { name: "Snapshot of Report" });
    expect(snapshot).toHaveTextContent(/later edits on claude\.ai are not shown/);
    const frame = snapshot.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame?.getAttribute("srcdoc") ?? "").toContain("Quarterly report");
  });

  it("holds a page's script until the person presses Run, and runs it only through the host", async () => {
    const start = vi.fn(async () => ({ kind: "refused" as const, reason: "Not now." }));
    const runtime = vi.fn(() => ({
      start,
      contained: false,
      drawnIn: "frame" as const,
      runsOnOpen: false,
    }));
    render(
      <TurnActivityRows
        activity={rows({
          snapshot: {
            format: "html",
            content: '<button onclick="add()">Add</button><script>function add() {}</script>',
          },
        })}
        publishedSnapshotRuntime={runtime}
        running={false}
        settled
      />,
    );
    expect(runtime).toHaveBeenCalledWith("tool-1");
    const snapshot = screen.getByRole("region", { name: "Snapshot of Report" });
    expect(snapshot.querySelector("iframe")).toBeNull();
    expect(start).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(start).toHaveBeenCalledOnce();
  });

  it("reads a Markdown snapshot as Markdown", () => {
    render(
      <TurnActivityRows
        activity={rows({ snapshot: { format: "markdown", content: "# Notes\n\nShipped." } })}
        running={false}
        settled
      />,
    );
    expect(screen.getByRole("heading", { name: "Notes" })).toBeVisible();
  });

  it("shows only the link for a page with no snapshot", () => {
    render(<TurnActivityRows activity={rows({})} running={false} settled />);
    expect(screen.getByRole("link", { name: /Report/ })).toBeVisible();
    expect(screen.queryByRole("region", { name: /Snapshot/ })).toBeNull();
  });
});
