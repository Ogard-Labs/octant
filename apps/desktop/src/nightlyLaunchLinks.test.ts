import { expect, it, vi } from "vitest";
import { createNightlyLaunchLinks } from "./nightlyLaunchLinks";

const thread = "octant-nightly://code/thread/00000000-0000-4000-8000-000000000123";

it("holds a launch link until the client takes it, then hands later links straight on", () => {
  const links = createNightlyLaunchLinks("octant-nightly");
  links.receive(thread);
  const accept = vi.fn();
  links.handOff(accept);
  expect(accept).toHaveBeenCalledExactlyOnceWith(thread);
  links.receive(`${thread}0`);
  expect(accept).toHaveBeenLastCalledWith(`${thread}0`);
  expect(accept).toHaveBeenCalledTimes(2);
});

it("keeps only the newest few links and ignores other apps' schemes", () => {
  const links = createNightlyLaunchLinks("octant-nightly", 2);
  links.receive("octant://code/thread/00000000-0000-4000-8000-000000000123");
  for (const suffix of ["a", "b", "c"]) links.receive(`${thread}${suffix}`);
  const accept = vi.fn();
  links.handOff(accept);
  expect(accept.mock.calls).toEqual([[`${thread}b`], [`${thread}c`]]);
});

it("holds nothing once stopped", () => {
  const links = createNightlyLaunchLinks("octant-nightly");
  links.receive(thread);
  links.stop();
  links.receive(thread);
  const accept = vi.fn();
  links.handOff(accept);
  expect(accept).not.toHaveBeenCalled();
});
