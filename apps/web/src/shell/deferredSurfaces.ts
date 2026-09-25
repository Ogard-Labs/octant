import { lazy } from "react";

const UsageWorkspace = lazy(() =>
  import("../usage/UsageWorkspace").then((module) => ({ default: module.UsageWorkspace })),
);
// Surfaces most sessions never open stay out of the first bundle: pairing a
// remote device and Zen.
const RemotePairingView = lazy(() =>
  import("../remote/RemotePairingView").then((module) => ({ default: module.RemotePairingView })),
);
const ZenSurface = lazy(() =>
  import("../zen/ZenSurface").then((module) => ({ default: module.ZenSurface })),
);
const ZenCanvasCard = lazy(() =>
  import("../zen/ZenCanvasCard").then((module) => ({ default: module.ZenCanvasCard })),
);
const ZenResearchDock = lazy(() =>
  import("../zen/ZenResearchDock").then((module) => ({ default: module.ZenResearchDock })),
);
const ZenTerminalCard = lazy(() =>
  import("../zen/ZenTerminalCard").then((module) => ({ default: module.ZenTerminalCard })),
);
const ZenProjectResearchDock = lazy(() =>
  import("../zen/ZenProjectResearchDock").then((module) => ({
    default: module.ZenProjectResearchDock,
  })),
);
const ZenProjectTerminalCard = lazy(() =>
  import("../zen/ZenProjectTerminalCard").then((module) => ({
    default: module.ZenProjectTerminalCard,
  })),
);

export {
  RemotePairingView,
  UsageWorkspace,
  ZenCanvasCard,
  ZenProjectResearchDock,
  ZenProjectTerminalCard,
  ZenResearchDock,
  ZenSurface,
  ZenTerminalCard,
};
