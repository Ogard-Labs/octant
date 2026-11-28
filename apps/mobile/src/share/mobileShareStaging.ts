import { createUnavailableShareStagingFs } from "./octantShareModule";
import type { ShareStagingFs } from "./shareValidation";

/** Web builds have no OS share extension or staging folder. */
export const mobileShareStagingFs: ShareStagingFs = createUnavailableShareStagingFs();
