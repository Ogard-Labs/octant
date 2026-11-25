import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  ThreadSecretAnswer,
  ThreadSecretCommandResult,
  ThreadSecretRequestCard as Card,
} from "@octant/contracts/thread-secrets";
import { ThreadSecretCard } from "./ThreadSecretCard";

const ID = "00000000-0000-4000-8000-000000000001";
const REMEMBERED = "00000000-0000-4000-8000-000000000002";
const card: Card = {
  id: ID,
  threadId: "thread",
  name: "DEPLOY_TOKEN",
  label: "Deploy token",
  kind: "token",
  reason: "Publish the preview build.",
  delivery: "file",
  fields: [{ name: "DEPLOY_TOKEN", label: "Deploy token", secret: true }],
  lifetimes: ["this-command", "this-turn", "1-hour", "24-hours", "until-archived", "remember"],
  defaultLifetime: "24-hours",
  sources: ["pasted"],
  remembered: [],
  state: "pending",
};
const fields: Card = {
  ...card,
  name: "SERVICE",
  label: "Service sign-in",
  fields: [
    { name: "EMAIL", label: "Email", placeholder: "you@example.com", secret: false },
    { name: "PASSWORD", label: "Password", secret: true },
  ],
};

const setup = (
  over: Partial<Card> | Card = {},
  answer: (value: ThreadSecretAnswer) => Promise<ThreadSecretCommandResult> = async () => ({
    status: "accepted",
  }),
) => {
  const user = userEvent.setup();
  const send = vi.fn(answer);
  const view = render(<ThreadSecretCard card={{ ...card, ...over }} answer={send} />);
  return { user, send, view };
};
const input = (label = "Deploy token") => screen.getByLabelText(label, { selector: "input" });
const save = () => screen.getByRole("button", { name: "Save securely" });

describe("the secret card", () => {
  it("shows the title, the reason, one masked input beside the primary action, and Decline", () => {
    setup();
    expect(screen.getByText("Deploy token")).toBeInTheDocument();
    expect(screen.getByText("Publish the preview build.")).toBeInTheDocument();
    expect(input()).toHaveAttribute("type", "password");
    expect(save()).toBeDisabled();
    const row = input().closest(".thread-secret-card__row");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("button", { name: "Save securely" })).toBe(save());
    expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("saves from the keyboard once, exactly as typed, for the chosen time", async () => {
    const { user, send } = setup();
    await user.type(input(), "  two words  {Enter}");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({
      id: ID,
      action: "save",
      lifetime: "24-hours",
      fields: [{ name: "DEPLOY_TOKEN", source: "pasted", value: "  two words  " }],
    });
    expect(input()).toHaveValue("");
  });

  it("sends a value of several lines exactly as pasted, and shows none of it", async () => {
    const { user, send } = setup();
    const key = "-----BEGIN KEY-----\r\nabc def\r\n-----END KEY-----\r\n";
    await user.click(input());
    await user.paste(key);
    expect(input()).toHaveValue("3 lines pasted");
    expect(input()).toHaveAttribute("readonly");
    expect(document.body.innerHTML).not.toContain("abc def");
    await user.click(save());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: [{ name: "DEPLOY_TOKEN", source: "pasted", value: key }],
      }),
    );
  });

  it("starts over when pasted lines are cleared", async () => {
    const { user } = setup();
    await user.click(input());
    await user.paste("one\ntwo");
    await user.click(screen.getByRole("button", { name: "Clear Deploy token" }));
    expect(input()).toHaveValue("");
    expect(input()).not.toHaveAttribute("readonly");
    expect(save()).toBeDisabled();
  });

  it.each([
    ["three\nfour\n", "three\nfour\n"],
    ["single-value\n", "single-value"],
  ])(
    "replaces pasted lines with what is pasted next, and nothing of their count (%j)",
    async (next, value) => {
      const { user, send } = setup();
      await user.click(input());
      await user.paste("one\ntwo");
      await user.click(input());
      await user.paste(next);
      await user.click(save());
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          fields: [{ name: "DEPLOY_TOKEN", source: "pasted", value }],
        }),
      );
    },
  );

  it("takes one line pasted with its line break as that line", async () => {
    const { user } = setup();
    await user.click(input());
    await user.paste("token-value\n");
    expect(input()).not.toHaveAttribute("readonly");
  });

  it("does not cut a value that is too long", async () => {
    const { user } = setup();
    await user.click(input());
    await user.paste("x".repeat(4097));
    expect(input()).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("longer than 4,096 characters");
  });

  it("does not take blank text for an answer", async () => {
    const { user, send } = setup();
    await user.type(input(), "   {Enter}");
    expect(save()).toBeDisabled();
    expect(send).not.toHaveBeenCalled();
  });

  it("lets the person see what they typed, and hides it again when it is sent", async () => {
    const { user } = setup();
    await user.type(input(), "dummy-token");
    const show = screen.getByRole("button", { name: "Show Deploy token" });
    await user.click(show);
    expect(input()).toHaveAttribute("type", "text");
    await user.click(save());
    expect(input()).toHaveAttribute("type", "password");
  });

  it("declines without sending what was typed", async () => {
    const { user, send } = setup();
    await user.type(input(), "private-token");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(send).toHaveBeenCalledWith({ id: ID, action: "decline" });
  });

  it("says who can read it and for how long, in Octant's words, and keeps up with the choice", async () => {
    const { user, send } = setup();
    expect(
      screen.getByText("Token kept out of chat. Commands in this thread can read it for 24 hours."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Keep for" }));
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual([
      "This command",
      "This turn",
      "1 hour",
      "24 hours",
      "Until archived",
      "Remember",
    ]);
    await user.click(await screen.findByRole("option", { name: "This turn" }));
    expect(
      screen.getByText(
        "Token kept out of chat. Commands in this thread can read it until this turn ends.",
      ),
    ).toBeInTheDocument();
    await user.type(input(), "dummy-token{Enter}");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ lifetime: "this-turn" }));
  });

  it("says no command reads a handle", () => {
    setup({ delivery: "handle" });
    expect(
      screen.getByText("Token kept out of chat. Only an Octant tool can use it, for 24 hours."),
    ).toBeInTheDocument();
  });

  it("starts on the lifetime the host chose and offers only the host's", async () => {
    const { user } = setup({
      lifetimes: ["this-command", "this-turn"],
      defaultLifetime: "this-turn",
    });
    expect(screen.getByRole("combobox", { name: "Keep for" })).toHaveTextContent("This turn");
    await user.click(screen.getByRole("combobox", { name: "Keep for" }));
    expect(await screen.findAllByRole("option")).toHaveLength(2);
  });

  it("warns about an account password in Octant's words", () => {
    setup({
      kind: "account-password",
      lifetimes: ["this-command", "this-turn", "24-hours"],
    });
    expect(
      screen.getByText(/unlocks this whole computer, not only what the agent asked for/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/type it into a system dialog yourself/i)).toBeInTheDocument();
    expect(screen.getByText(/^Account password kept out of chat/)).toBeInTheDocument();
  });

  it("says when a value is too plain to hide if a command prints it", async () => {
    const { user } = setup();
    await user.type(input(), "hunter");
    expect(screen.getByText(/too short to hide/i)).toBeInTheDocument();
    await user.type(input(), "2-and-much-longer");
    expect(screen.queryByText(/too short to hide/i)).not.toBeInTheDocument();
  });

  it("opens the setup page the card carries, and shows where it goes", () => {
    setup({ url: "https://xn--pple-43d.com/settings/tokens" });
    const link = screen.getByRole("link", { name: "Open xn--pple-43d.com" });
    expect(link).toHaveAttribute("href", "https://xn--pple-43d.com/settings/tokens");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("https://xn--pple-43d.com/settings/tokens")).toBeInTheDocument();
  });

  it("keeps password managers and autofill off the field", () => {
    setup();
    expect(input()).toHaveAttribute("autocomplete", "off");
    expect(input()).toHaveAttribute("data-1p-ignore");
    expect(input()).toHaveAttribute("spellcheck", "false");
  });

  it("focuses the first empty input when the card is clicked, and nothing when text is selected", async () => {
    const { user } = setup(fields);
    await user.type(input("Email"), "person@example.com");
    await user.click(screen.getByText("Publish the preview build."));
    expect(input("Password")).toHaveFocus();
  });
});

describe("a secret card with several fields", () => {
  it("stacks labelled inputs, shows a plain one as typed, and moves the primary action down", async () => {
    const { user, send } = setup(fields);
    expect(input("Email")).toHaveAttribute("type", "text");
    expect(input("Email")).toHaveAttribute("placeholder", "you@example.com");
    expect(input("Password")).toHaveAttribute("type", "password");
    expect(screen.queryByRole("button", { name: "Show Email" })).not.toBeInTheDocument();
    expect(save().closest(".thread-secret-card__footer")).not.toBeNull();
    await user.type(input("Email"), "person@example.com");
    expect(save()).toBeDisabled();
    await user.type(input("Password"), "s3cret-Value{Enter}");
    expect(send).toHaveBeenCalledWith({
      id: ID,
      action: "save",
      lifetime: "24-hours",
      fields: [
        { name: "EMAIL", source: "pasted", value: "person@example.com" },
        { name: "PASSWORD", source: "pasted", value: "s3cret-Value" },
      ],
    });
  });

  it("takes each field from its own source", async () => {
    const { user, send } = setup({ ...fields, sources: ["pasted", "onepassword"] });
    await user.type(input("Email"), "person@example.com");
    await user.click(screen.getByRole("combobox", { name: "Source for Password" }));
    await user.click(await screen.findByRole("option", { name: "1Password" }));
    await user.type(input("Password"), "op://Private/Service/password{Enter}");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: [
          { name: "EMAIL", source: "pasted", value: "person@example.com" },
          {
            name: "PASSWORD",
            source: "onepassword",
            store: "onepassword",
            reference: "op://Private/Service/password",
            freshEachUse: false,
          },
        ],
      }),
    );
  });
});

describe("another source", () => {
  const sources = ["pasted", "onepassword", "remembered"] as const;
  const remembered = [{ id: REMEMBERED, name: "DEPLOY_TOKEN", source: "pasted" as const }];
  const choose = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(screen.getByRole("combobox", { name: "Source for Deploy token" }));
    await user.click(await screen.findByRole("option", { name }));
  };

  it("is not shown when typing is the only one", () => {
    setup();
    expect(screen.queryByRole("combobox", { name: /Source for/ })).not.toBeInTheDocument();
  });

  it("is a 1Password reference, read again at each use when the person asks", async () => {
    const { user, send } = setup({ sources });
    await user.type(input(), "discarded-token");
    await choose(user, "1Password");
    expect(input()).toHaveValue("");
    expect(input()).toHaveAttribute("type", "text");
    expect(input()).toHaveAttribute("placeholder", "op://vault/item/field");
    await user.type(input(), "op://Private/Deploy/credential");
    await user.click(screen.getByRole("checkbox", { name: /read it again at each use/i }));
    await user.click(save());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: [
          {
            name: "DEPLOY_TOKEN",
            source: "onepassword",
            store: "onepassword",
            reference: "op://Private/Deploy/credential",
            freshEachUse: true,
          },
        ],
      }),
    );
    expect(JSON.stringify(send.mock.calls)).not.toContain("discarded-token");
  });

  it("refuses text that is not a reference, before anything is sent", async () => {
    const { user, send } = setup({ sources });
    await choose(user, "1Password");
    await user.type(input(), "private-token{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(/op:\/\//);
    expect(screen.getByRole("alert")).not.toHaveTextContent("private-token");
    expect(send).not.toHaveBeenCalled();
  });

  it("is one Octant remembers, only when the person picks it", async () => {
    const { user, send } = setup({ sources, remembered });
    expect(save()).toBeDisabled();
    await choose(user, "Remembered");
    expect(screen.queryByLabelText("Deploy token", { selector: "input" })).not.toBeInTheDocument();
    await user.click(save());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: [{ name: "DEPLOY_TOKEN", source: "remembered", rememberedId: REMEMBERED }],
      }),
    );
  });
});

describe("how a secret card ends", () => {
  it("gives the typed value back when the host refuses, and says why", async () => {
    const { user, send } = setup({}, async () => ({
      status: "refused",
      failure: "refused-by-strict",
    }));
    await user.type(input(), "private-token{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Strict/);
    expect(input()).toHaveValue("private-token");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not resend, keep or show a value when the outcome is not known", async () => {
    const { user, send } = setup({}, async () => {
      throw new Error("private-token");
    });
    await user.type(input(), "private-token{Enter}");
    expect(await screen.findByRole("alert")).not.toHaveTextContent("private-token");
    expect(input()).toHaveValue("");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("shows why the host left it open", () => {
    setup({ failure: "locked" });
    expect(screen.getByRole("alert")).toHaveTextContent(/unlock 1Password/i);
  });

  it("cannot be sent twice while it is being saved", async () => {
    let finish: (value: ThreadSecretCommandResult) => void = () => undefined;
    const { user, send } = setup({}, () => new Promise((resolve) => (finish = resolve)));
    await user.type(input(), "private-token{Enter}");
    expect(input()).toBeDisabled();
    expect(save()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decline" })).toBeDisabled();
    finish({ status: "accepted" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["saved", "Deploy token · Saved securely"],
    ["declined", "Deploy token · Declined"],
  ] as const)("becomes one quiet row when it is %s", (state, text) => {
    setup({ state });
    expect(screen.getByRole("status")).toHaveTextContent(text);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
