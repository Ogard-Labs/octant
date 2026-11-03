import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeThread,
  decodeProject,
  decodeWindowId,
  decodeWorkThread,
  LOCAL_HOST_ID,
} from "@octant/contracts";
import { contextKeyForProject, defaultWindowWorkspace } from "@octant/domain";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import { startOctantServer } from "../server";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import * as browser from "./browser";
import * as code from "./codeRuntime";
import * as work from "./work";

it("composes the real persisted Code and hydrated Work feedback owner through server factories", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octant-feedback-composition-"));
  const windowId = decodeWindowId(randomUUID());
  const now = "2026-11-03T10:00:00.000Z";
  const observed: {
    browser?: browser.BrowserWiring["resolveFeedbackThread"];
    code?: browser.BrowserWiring["resolveFeedbackThread"];
    work?: browser.BrowserWiring["resolveFeedbackThread"];
    windows?: WindowAuthorityStore;
  } = {};
  const wireBrowser = browser.wireBrowser;
  const wireCode = code.wireCodeRuntime;
  const wireWork = work.wireWork;
  const spies = [
    vi.spyOn(browser, "wireBrowser").mockImplementation((deps) =>
      wireBrowser(deps).pipe(
        Effect.tap((ports) =>
          Effect.sync(() => {
            observed.browser = ports.resolveFeedbackThread;
            observed.windows = deps.windowAuthorityStore;
            deps.windowAuthorityStore.register({
              windowId,
              capability: "A".repeat(43),
              now: Date.now(),
            });
          }),
        ),
      ),
    ),
    vi.spyOn(code, "wireCodeRuntime").mockImplementation((deps) => {
      observed.code = deps.resolveFeedbackThread;
      return wireCode(deps);
    }),
    vi.spyOn(work, "wireWork").mockImplementation((deps) => {
      observed.work = deps.resolveFeedbackThread;
      return wireWork(deps);
    }),
  ];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const append = (
            aggregateType: string,
            aggregateId: string,
            eventName: string,
            payload: unknown,
          ) =>
            persistence.journal.append({
              aggregate: { aggregateType, aggregateId },
              expectedVersion: 0,
              events: [
                {
                  eventId: randomUUID(),
                  eventName,
                  eventVersion: 1,
                  correlationId: randomUUID(),
                  actor: { kind: "local-user", actorId: windowId },
                  occurredAt: now,
                  payload,
                },
              ],
            });
          const tasks = (["work", "code"] as const).map((mode) => {
            const root = join(directory, mode);
            mkdirSync(root);
            const project = decodeProject({
              id: randomUUID(),
              type: mode,
              name: mode,
              lifecycle: "active",
              pinned: false,
              rank: "0/1",
              version: 1,
              createdAt: now,
              updatedAt: now,
              binding: { canonicalRoot: root },
              bindingHistory: [
                {
                  revisionId: randomUUID(),
                  revision: 1,
                  currentBinding: { canonicalRoot: root },
                  actor: { kind: "local-user", actorId: windowId },
                  changedAt: now,
                },
              ],
              ...(mode === "code" ? { codeAccessPersistence: "current-session" } : {}),
            });
            const common = {
              id: randomUUID(),
              projectId: project.id,
              bindingRevisionId: project.bindingHistory.at(-1)?.revisionId,
              title: mode,
              lifecycle: "active",
              providerInstanceId: randomUUID(),
              modelId: "model",
              version: 1,
              createdAt: now,
              updatedAt: now,
            };
            const thread =
              mode === "work"
                ? decodeWorkThread(common)
                : decodeCodeThread({
                    ...common,
                    repositoryId: `repo_${"a".repeat(64)}`,
                    checkoutId: randomUUID(),
                    executionPolicy: "approval-gated",
                    permissionPersistence: "current-session",
                    deliveryTarget: {
                      branchIntent: "feature/task",
                      remoteName: "origin",
                      proposedBaseRepository: "org/repo",
                      proposedBaseBranch: "main",
                      outcomeKind: "opened-pr",
                      confirmedAt: now,
                    },
                  });
            append("project", project.id, "project.created@1", { project });
            append(`${mode}-thread`, thread.id, `${mode}.thread-created@1`, {
              kind: "thread-created",
              thread,
            });
            return { mode, project, thread, root };
          });
          const workspace = defaultWindowWorkspace(windowId);
          append("window-workspace", windowId, "workspace.layout-replaced", {
            workspace: {
              ...workspace,
              version: 1,
              contextByMode: {
                ...workspace.contextByMode,
                ...Object.fromEntries(
                  tasks.map(({ mode, project, root }) => [
                    mode,
                    contextKeyForProject(mode, LOCAL_HOST_ID, project.id, root),
                  ]),
                ),
              },
            },
          });
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            serve: () =>
              // No socket, Browser or provider is launched.
              ({ url: new URL("http://127.0.0.1:13773"), stop: () => undefined }),
          });
          expect(observed.code).toBe(observed.browser);
          expect(observed.work).toBe(observed.browser);
          if (observed.browser === undefined) throw Error("Browser owner was not composed");
          const resolve = observed.browser;
          const scopes = tasks.map(({ mode, thread }) => {
            const scope = resolve(windowId, thread.id);
            expect(scope?.mode).toBe(mode);
            expect(scope?.current()).toBe(true);
            expect(resolve(decodeWindowId(randomUUID()), thread.id)).toBeUndefined();
            return scope;
          });
          observed.windows?.revoke(windowId);
          for (const scope of scopes) expect(scope?.current()).toBe(false);
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      ),
    );
  } finally {
    for (const spy of spies) spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
    expect(existsSync(directory)).toBe(false);
  }
});
