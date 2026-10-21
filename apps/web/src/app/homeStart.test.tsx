import { render, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { codeShellBootstrap, settingsPastFirstRun } from "../App.test-fixtures";
import { COMPUTERS_CARD_ID } from "../home/ComputersCard";
import { useHomeStart, type HomeStartInput } from "./homeStart";

const settings = settingsPastFirstRun();
const workspace = codeShellBootstrap().workspace;
const emptyMap = new Map<string, never>();
const none: ReadonlyArray<never> = [];
const codeOnly: HomeStartInput["workingNowModes"] = ["code"];
const noPullRequests: HomeStartInput["githubPullRequestCapability"] = { readable: false };
const noActions = {} as never;
const stubClient = {} as never;
const hostResourceClient = { read: async () => ({ status: "refused" as const }) } as never;
const loadHomePullRequests = (async () => undefined) as never;

/** Every input but the computers held constant, so only they can move the model. */
function input(computerSnapshots: HomeStartInput["computerSnapshots"]): HomeStartInput {
  return {
    actions: noActions,
    activeMode: "code",
    activePaneId: undefined,
    agentRunClient: undefined as never,
    browserAutomationClient: undefined,
    chatClient: stubClient,
    codeCheckouts: none,
    codeClient: stubClient,
    codeThreads: none,
    computerSnapshots,
    feedRevision: 0,
    githubPullRequestCapability: noPullRequests,
    hostFederationTransports: undefined,
    hostResourceClient,
    isDesktop: false,
    loadHomePullRequests,
    needsYouThreadProviders: emptyMap,
    now: 0,
    openRunningServiceLive: undefined,
    pendingRequestClient: undefined,
    remoteRunningServicesClient: undefined,
    runningServicesClient: undefined,
    runningServicesRemoteHost: undefined,
    serverUrl: "http://127.0.0.1:13773",
    settings,
    workingNowBoardFacts: emptyMap,
    workingNowHost: undefined,
    workingNowModes: codeOnly,
    workingNowProjectNames: emptyMap,
    workingNowProviders: emptyMap,
    workingNowThreads: none,
    workRequestClient: undefined as never,
    workTurnClient: stubClient,
    workspace,
  };
}

const devbox = {
  hostId: "10000000-0000-4000-8000-000000000042",
  kind: "remote",
  displayName: "Devbox",
  origin: "https://devbox.example",
  // Connected but not readable, so the card lists it without asking it for load.
  state: "unauthorized",
  health: "unauthorized",
  actions: {},
} as never;

describe("the start screen model", () => {
  it("keeps its identity across renders that change nothing", () => {
    const { result, rerender } = renderHook(
      ({ snapshots }: { readonly snapshots: HomeStartInput["computerSnapshots"] }) =>
        useHomeStart(input(snapshots)),
      { initialProps: { snapshots: none } },
    );
    const first = result.current;
    expect(first).toBeDefined();
    rerender({ snapshots: none });
    expect(result.current).toBe(first);
  });

  it("re-derives the Computers card when a paired computer joins, with no other input changing", () => {
    const { result, rerender } = renderHook(
      ({ snapshots }: { readonly snapshots: HomeStartInput["computerSnapshots"] }) =>
        useHomeStart(input(snapshots)),
      { initialProps: { snapshots: [] as HomeStartInput["computerSnapshots"] } },
    );
    const before = result.current;
    const computersBefore = before?.cards?.find((card) => card.id === COMPUTERS_CARD_ID);
    if (computersBefore === undefined) throw new Error("The start screen has no Computers card.");
    // This computer alone, with nothing running on it, is a quiet card.
    expect(renderHook(() => computersBefore.useContent()).result.current).toMatchObject({
      status: "ready",
      count: 0,
    });

    rerender({ snapshots: [devbox] });
    expect(result.current).not.toBe(before);
    const computersAfter = result.current?.cards?.find((card) => card.id === COMPUTERS_CARD_ID);
    if (computersAfter === undefined) throw new Error("The start screen lost its Computers card.");
    const content = renderHook(() => computersAfter.useContent()).result.current;
    if (content.status !== "ready") throw new Error("The Computers card did not settle.");
    expect(content.count).toBe(1);
    const { getByText } = render(<>{content.body}</>);
    expect(getByText("Devbox")).toBeInTheDocument();
  });
});
