import { createMobileMockScenario, type MobileMockScenario } from "../dev/mobileMockScenario";

/** A fresh sample workspace per visit; no stored host or credential is passed in. */
export function createOfflineMobileDemo(): MobileMockScenario {
  return { ...createMobileMockScenario("full"), label: "Offline demo", offlineDemo: true };
}
