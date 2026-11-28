import { requireOptionalNativeModule } from "expo-modules-core";
import { createNativeShareStagingFs, type OctantShareNativeModule } from "./octantShareModule";
import type { ShareStagingFs } from "./shareValidation";

const native = requireOptionalNativeModule<OctantShareNativeModule>("OctantShare");

export const mobileShareStagingFs: ShareStagingFs = createNativeShareStagingFs(native);
