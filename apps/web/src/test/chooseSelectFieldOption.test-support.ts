import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export async function chooseSelectFieldOption(
  user: UserEvent,
  combobox: HTMLElement,
  optionName: string | RegExp,
): Promise<void> {
  await user.click(combobox);
  await user.click(await screen.findByRole("option", { name: optionName }));
}
