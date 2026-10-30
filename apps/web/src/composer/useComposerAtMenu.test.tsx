import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OctantCommandProvider } from "../palette/CommandRegistry";
import type { OctantCommand } from "../palette/commandModel";
import { ComposerSlashTypeahead, useComposerSlashCommands } from "./useComposerSlashCommands";
import { ComposerAtTypeahead, useComposerAtMenu, type AtMenuFiles } from "./useComposerAtMenu";

const COMMANDS: ReadonlyArray<OctantCommand> = [
  {
    id: "skill:review",
    title: "Review",
    group: "Skills",
    detail: "Skill",
    keywords: ["review"],
    action: { kind: "address", reference: "$review" },
  },
  {
    id: "plugin:@docs/search",
    title: "Docs search",
    group: "Plugins",
    detail: "MCP server · Docs",
    keywords: ["mcp"],
    action: { kind: "address", reference: "@docs/search" },
  },
  {
    id: "connector:@notes/server",
    title: "Notes",
    group: "Connectors",
    detail: "Connector",
    keywords: ["connector"],
    action: { kind: "address", reference: "@notes/server" },
  },
  {
    id: "settings:open",
    title: "Open Settings",
    group: "Settings",
    action: { kind: "run", run: () => undefined },
  },
];

function Harness(props: {
  readonly resolve: (reference: string) => Promise<boolean>;
  readonly files?: AtMenuFiles;
}) {
  const [draft, setDraft] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const at = useComposerAtMenu({
    draft,
    onDraftChange: setDraft,
    onResolveExtensionReference: props.resolve,
    textarea: () => textarea.current,
    ...(props.files === undefined ? {} : { files: props.files }),
  });
  const slash = useComposerSlashCommands({
    draft,
    onDraftChange: setDraft,
    textarea: () => textarea.current,
  });
  return (
    <>
      <textarea
        aria-label="Message"
        ref={textarea}
        value={draft}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          at.sync(event.currentTarget.value, event.currentTarget.selectionStart);
          slash.sync(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
        onKeyDown={(event) => {
          at.handleKeyDown(event);
        }}
      />
      <ComposerAtTypeahead controller={at} />
      <ComposerSlashTypeahead controller={slash} />
      <button disabled={at.resolving}>Send</button>
    </>
  );
}

function renderComposer(resolve: (reference: string) => Promise<boolean>, files?: AtMenuFiles) {
  return render(
    <OctantCommandProvider commands={COMMANDS}>
      <Harness resolve={resolve} {...(files === undefined ? {} : { files })} />
    </OctantCommandProvider>,
  );
}

describe("composer @ menu", () => {
  it("lists skills, plugin servers, and connectors, and leaves commands to the slash menu", async () => {
    const user = userEvent.setup();
    renderComposer(vi.fn(async () => true));
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "ReviewSkill",
      "Docs searchMCP server · Docs",
      "NotesConnector",
    ]);
    await user.clear(message);
    await user.type(message, "/");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Open SettingsSettings",
    ]);
  });

  it("keeps typing available and focus in the message while a chosen skill resolves", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<boolean>();
    const resolve = vi.fn((_reference: string) => pending.promise);
    renderComposer(resolve);
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "Use @rev");
    await user.click(screen.getByRole("option", { name: /Review/ }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith("$review");
    expect(message).toHaveFocus();
    expect(message).toHaveValue("Use ");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.keyboard("now");
    expect(message).toHaveValue("Use now");
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("offers nothing for an at sign inside a word or an unmatched query", async () => {
    const user = userEvent.setup();
    renderComposer(vi.fn(async () => true));
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "mail me@rev");
    expect(screen.queryByRole("option")).toBeNull();
    await user.clear(message);
    await user.type(message, "@zzz");
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("lists files beside extensions and names the chosen file through the file picker", async () => {
    const user = userEvent.setup();
    const choose = vi.fn();
    renderComposer(
      vi.fn(async () => true),
      {
        open: true,
        candidates: [{ path: "src/review.ts", kind: "file" }],
        choose,
      },
    );
    await user.type(screen.getByRole("textbox", { name: "Message" }), "@rev");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "ReviewSkill",
      "src/review.tsFile",
    ]);
    await user.click(screen.getByRole("option", { name: /src\/review.ts/ }));
    expect(choose).toHaveBeenCalledExactlyOnceWith({ path: "src/review.ts", kind: "file" });
  });

  it("does not choose a skill while an IME composition is being committed", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn(async () => true);
    renderComposer(resolve);
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@review");
    fireEvent.keyDown(message, { key: "Enter", isComposing: true });
    expect(resolve).not.toHaveBeenCalled();
    expect(message).toHaveValue("@review");
  });
});
