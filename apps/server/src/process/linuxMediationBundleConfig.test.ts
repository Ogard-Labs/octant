import { expect, it } from "vitest";
import configs, { MEDIATION_STANDALONE_RUNTIME_PATTERN } from "../../tsdown.config";

it("builds each relocatable mediation entry as its own dependency-complete file", () => {
  expect(Array.isArray(configs)).toBe(true);
  for (const name of ["linuxMediationWorker", "linuxMediationSupervisor"] as const) {
    const config = Array.isArray(configs)
      ? configs.find((candidate) =>
          Object.prototype.hasOwnProperty.call(candidate.entry ?? {}, name),
        )
      : undefined;
    expect(config).toMatchObject({
      clean: false,
      deps: { alwaysBundle: [MEDIATION_STANDALONE_RUNTIME_PATTERN], onlyBundle: false },
      entry: { [name]: expect.stringMatching(/\.ts$/) },
    });
    expect(Object.keys(config?.entry ?? {})).toEqual([name]);
  }
});
