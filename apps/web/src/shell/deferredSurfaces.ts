import { lazy } from "react";

const UsageWorkspace = lazy(() =>
  import("../usage/UsageWorkspace").then((module) => ({ default: module.UsageWorkspace })),
);
// Surfaces most sessions never open stay out of the first bundle: pairing a
// remote device and Zen.
const RemotePairingView = lazy(() =>
  import("../remote/RemotePairingView").then((module) => ({ default: module.RemotePairingView })),
);
// Host notices load after the window first renders.
const LazyHostNoticeToasts = lazy(() =>
  import("../host/HostNoticeToasts").then((module) => ({ default: module.HostNoticeToasts })),
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

// Opened only from a coordinator's Change… action, in a draft or a running thread.
const CoordinatorBoundsDialog = lazy(() =>
  import("../projects/CoordinatorBoundsDialog").then((module) => ({
    default: module.CoordinatorBoundsDialog,
  })),
);

// Opening another computer's to-do carries that computer's whole remote
// workspace (Canvas, math, Markdown), so it loads only when a to-do opens there.
const RemoteTodoDraft = lazy(() =>
  import("../todos/RemoteTodoDraft").then((module) => ({ default: module.RemoteTodoDraft })),
);

const ProjectCreateDialog = lazy(() =>
  import("../projects/ProjectCreateDialog").then((module) => ({
    default: module.ProjectCreateDialog,
  })),
);

export {
  CoordinatorBoundsDialog,
  ProjectCreateDialog,
  LazyHostNoticeToasts,
  RemotePairingView,
  RemoteTodoDraft,
  UsageWorkspace,
  ZenCanvasCard,
  ZenProjectResearchDock,
  ZenProjectTerminalCard,
  ZenResearchDock,
  ZenSurface,
  ZenTerminalCard,
};
