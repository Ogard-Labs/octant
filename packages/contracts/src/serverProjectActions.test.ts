import { expect, it } from "vitest";
import {
  decodeServerProjectsCommand,
  decodeServerProjectActionsReplacedPayload,
} from "./serverProjects";
import { decodeProjectTerminalCommand, decodeProjectTerminalResult } from "./projectTerminals";

const projectId = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
it("accepts a versioned server action save and refuses executable or remote-principal additions", () => {
  const command = {
    kind: "set-server-project-actions",
    projectId,
    expectedVersion: 2,
    actions: [{ id: actionId, name: "Test", command: "npm test", directory: "." }],
  };
  expect(decodeServerProjectsCommand(command)).toEqual(command);
  expect(() => decodeServerProjectsCommand({ ...command, shell: "unreviewed" })).toThrow();
  const payload = {
    projectId,
    actions: command.actions,
    actionsVersion: 3,
    principal: { kind: "local-window" },
  };
  expect(decodeServerProjectActionsReplacedPayload(payload)).toEqual(payload);
  expect(() =>
    decodeServerProjectActionsReplacedPayload({ ...payload, principal: { kind: "remote-device" } }),
  ).toThrow();
});

it("requires a valid reviewed placement digest and reports the lack of remote confinement explicitly", () => {
  const command = {
    kind: "start-action",
    projectId,
    actionId,
    terminalId: projectId,
    columns: 80,
    rows: 24,
    placementRevision: `sha256:${"a".repeat(64)}`,
  };
  expect(decodeProjectTerminalCommand(command)).toEqual(command);
  expect(() =>
    decodeProjectTerminalCommand({ ...command, placementRevision: "arbitrary" }),
  ).toThrow();
  const receipt = {
    kind: "project-action-preview",
    projectId,
    projectVersion: 2,
    action: {
      actionId,
      name: "Test",
      folder: "/srv/app",
      server: {
        serverId: projectId,
        alias: "web-1",
        user: "deploy",
        profile: "operate",
        placementRevision: command.placementRevision,
        confinement: "none",
      },
    },
  };
  expect(decodeProjectTerminalResult(receipt)).toEqual(receipt);
  expect(() =>
    decodeProjectTerminalResult({
      ...receipt,
      action: { ...receipt.action, server: { ...receipt.action.server, confinement: "sandboxed" } },
    }),
  ).toThrow();
});
