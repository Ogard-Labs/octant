import { configure, getConfig } from "@testing-library/react";

/*
 * Opt-in diagnostic, loaded only when OCTANT_TEST_ASYNC_STRESS=1.
 *
 * After every user-event action, Testing Library waits one setTimeout(0)
 * before the test continues. A render scheduled by async work (a queue
 * acknowledgment, a finished upload, a live view that failed) sometimes lands
 * inside that wait and sometimes after it, so a test that reads such state
 * synchronously right after the action passes locally and fails now and then
 * in CI. Skipping the wait makes those reads fail far more often.
 *
 * waitFor and findBy keep the original wrapper: they poll, so they are the
 * correct way to wait for that state and must not be disturbed. They are told
 * apart by their callback, which calls waitFor.
 */
const original = getConfig().asyncWrapper;
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };

configure({
  asyncWrapper: async (callback) => {
    if (String(callback).includes("waitFor(")) return original(callback);
    const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      return await callback();
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  },
});
