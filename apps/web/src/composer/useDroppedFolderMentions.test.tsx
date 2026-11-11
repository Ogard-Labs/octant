import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeWorkThreadId } from "@octant/contracts";
import {
  droppedFolders,
  insertFolderReferences,
  useDroppedFolderMentions,
} from "./useDroppedFolderMentions";

const file = new File([], "日本語 folder", { type: "" });
const bridge = { getDroppedFilePath: () => "/project/日本語 folder" };
function transfer() {
  return {
    items: [
      { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: true }) },
    ],
    getData: () => "",
  } as never;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dropped folder references", () => {
  it("inserts editable paths at the caret while keeping text, Unicode, and duplicate references", () => {
    const result = insertFolderReferences("before after", 7, [
      "/project/日本語 folder",
      "/project/日本語 folder",
    ]);
    expect(result.draft).toBe("before @/project/日本語 folder/ after");
    expect(insertFolderReferences(result.draft, 0, ["/project/日本語 folder"]).draft).toBe(
      result.draft,
    );
    expect(insertFolderReferences("x", 1, ["/project"]).draft).toBe("x @/project/ ");
    expect(insertFolderReferences("@/project/child/ ", 16, ["/project"]).draft).toContain(
      "@/project/child/ @/project/ ",
    );
  });
  it("extracts only bridge-proven native paths and does not treat a folder as an attachment", () => {
    expect(droppedFolders(transfer(), bridge)).toEqual({
      recognized: true,
      paths: ["/project/日本語 folder"],
      ordinaryFiles: [],
    });
    expect(droppedFolders(transfer(), undefined)).toEqual({
      recognized: true,
      paths: [],
      ordinaryFiles: [],
    });
  });
  it("keeps mixed native image files separate from folder references", () => {
    const image = new File(["png"], "picture.png", { type: "image/png" });
    const dropped = droppedFolders(
      {
        items: [
          { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: true }) },
          {
            kind: "file",
            getAsFile: () => image,
            webkitGetAsEntry: () => ({ isDirectory: false }),
          },
        ],
        getData: () => "file:///project/picture.png",
      } as never,
      bridge,
    );
    expect(dropped.paths).toEqual(["/project/日本語 folder"]);
    expect(dropped.ordinaryFiles).toEqual([image]);
  });
  it("refuses foreign file URLs and leaves ordinary web URLs alone", () => {
    const urls = (value: string) => ({ items: [], getData: () => value }) as never;
    expect(droppedFolders(urls("file://foreign/project"), bridge).paths).toEqual([]);
    expect(droppedFolders(urls("https://example.test/"), bridge).recognized).toBe(false);
    expect(
      droppedFolders(urls("file:///project/%E6%97%A5%E6%9C%AC%E8%AA%9E%20folder"), bridge).paths,
    ).toEqual(["/project/日本語 folder"]);
  });
  it("uses the latest draft during the host check and preserves existing attachments", async () => {
    let respond: ((response: Response) => void) | undefined;
    const fetch = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const files = vi.fn();
    // The injected bridge is intentionally absent in browser clients; this fixture supplies the desktop extraction port.
    function Harness() {
      const [draft, setDraft] = useState("before after");
      const textarea = useRef<HTMLTextAreaElement>(null);
      const drops = useDroppedFolderMentions({
        scope: {
          mode: "work",
          threadId: decodeWorkThreadId("00000000-0000-4000-8000-000000000001"),
        },
        draft,
        onDraftChange: setDraft,
        textarea: () => textarea.current,
        serverUrl: "http://127.0.0.1:3200",
        windowCapability: "fixture",
        hostBridge: bridge,
        onFiles: files,
      });
      return (
        <>
          {drops.notice?.text}
          <textarea
            aria-label="draft"
            ref={textarea}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onDrop={drops.onDrop}
          />
        </>
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText("draft");
    fireEvent.drop(input, { dataTransfer: transfer() });
    fireEvent.change(input, { target: { value: "new text" } });
    respond?.(
      Response.json({
        kind: "folder-mentions-inspected",
        requestId: JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).requestId,
        folders: [{ path: "/project/日本語 folder", hostId: "local" }],
        unavailable: [],
      }),
    );
    await waitFor(() => expect(input).toHaveValue("new text @/project/日本語 folder/ "));
    expect(files).not.toHaveBeenCalled();
    expect(screen.getByText(/contents were not read/)).toBeVisible();
  });
});
