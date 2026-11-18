import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type ReviewView = "Unified" | "Side by side" | "Ignore whitespace" | "Ignore edge whitespace";

const role = (name: ReviewView) =>
  name.startsWith("Ignore") ? ("menuitemcheckbox" as const) : ("menuitemradio" as const);

/** Layout and whitespace live in the Review bar's "More review actions" menu. */
export async function chooseReviewView(name: ReviewView) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "More review actions" }));
  await user.click(await screen.findByRole(role(name), { name }));
}

/** Whether the menu row is on, read with the menu open and closed again after. */
export async function reviewViewIsOn(name: ReviewView): Promise<boolean> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "More review actions" }));
  const on =
    (await screen.findByRole(role(name), { name })).getAttribute("aria-checked") === "true";
  await user.keyboard("{Escape}");
  return on;
}

/** The rows the menu offers, read with it open and closed again after. */
export async function reviewMenuRows(): Promise<ReadonlyArray<string>> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "More review actions" }));
  const menu = await screen.findByRole("menu", { name: "More review actions" });
  const rows = [...menu.querySelectorAll('[role^="menuitem"]')].map((row) => row.textContent ?? "");
  await user.keyboard("{Escape}");
  return rows;
}
