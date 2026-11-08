import { app, BrowserWindow, WebContentsView, session } from "electron";
import { generateKeyPairSync, randomUUID, X509Certificate } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeAgentRun,
  decodeBrowserContextId,
  decodeBrowserThreadId,
  decodeToolActionAuthority,
  decodeWindowId,
  type BrowserContextPolicy,
  type StoredBrowserProfile,
} from "@octant/contracts";
import {
  browserProfilePartition,
  storedBrowserProfileOfPartitionFolder,
  defaultAgentRunAuthorityCeilingForMode,
} from "@octant/domain";
import { BrowserSessionGrants } from "../apps/server/src/browser/browserSessionGrants";
import {
  BrowserDelegatedChildren,
  currentManagedChildBrowserTarget,
} from "../apps/server/src/browser/browserDelegatedChildren";
import { DesktopBrowserRuntime } from "../apps/server/src/browser/desktopBrowserRuntime";
import {
  createBrowserSurfaceHost,
  type BrowserSurfaceViewPort,
  type BrowserSurfaceShellWindowPort,
} from "../apps/desktop/src/browserSurfaceHost";
import { createBrowserProfileStore } from "../apps/desktop/src/browserProfileStore";
import { startBrowserRuntimeBroker } from "../apps/desktop/src/browserRuntimeBroker";
import {
  certificatePem,
  encodeListenerCertificate,
} from "../apps/server/src/remote/listenerCertificateDer";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw Error("Supply the isolated native fixture directories.");
  return value;
}
const root = required("OCTANT_CHILD_QA_ROOT");
const output = required("OCTANT_QA_OUTPUT");
if (process.platform !== "darwin") throw Error("The native fixture requires isolated macOS.");
app.setPath("userData", join(root, "user-data"));
app.on("window-all-closed", () => {});
const checks: string[] = [];
function check(ok: boolean, name: string) {
  if (!ok) throw Error(`Native child check failed: ${name}`);
  checks.push(name);
}
async function until(predicate: () => boolean, name: string) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  check(predicate(), name);
}
function tls() {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const at = Math.floor(Date.now() / 1000) * 1000;
  return {
    key: String(keys.privateKey.export({ format: "pem", type: "pkcs8" })),
    cert: certificatePem(
      encodeListenerCertificate({
        ...keys,
        hostname: "127.0.0.1",
        notBefore: new Date(at - 1000),
        notAfter: new Date(at + 300_000),
      }),
    ),
  };
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("No owned HTTPS fixture port.");
  return `https://127.0.0.1:${address.port}`;
}
async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}

async function main() {
  await app.whenReady();
  await mkdir(join(root, "home"), { recursive: true });
  const good = tls();
  const other = tls();
  const pinned = new X509Certificate(good.cert).raw;
  let held: ServerResponse | undefined;
  let deniedRequests = 0;
  const service = createServer(good, (request, response) => {
    if (request.url === "/slow") {
      held = response;
      return;
    }
    const account = request.headers.cookie?.includes("octant_fixture_account=child-fixture")
      ? "child-fixture"
      : request.headers.cookie?.includes("octant_fixture_account=parent-fixture")
        ? "parent-fixture"
        : "signed-out";
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(
      `<!doctype html><title>Owned account</title><h1>Hello ${account}</h1><p>Native account fixture</p>`,
    );
  });
  const denied = createServer(other, (_request, response) => {
    deniedRequests++;
    response.end("unapproved fixture");
  });
  const origin = await listen(service);
  const deniedOrigin = await listen(denied);
  const windowId = decodeWindowId(randomUUID());
  const window = new BrowserWindow({
    width: 900,
    height: 700,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL(
    "data:text/html,<title>Owned native Browser fixture</title><p>Native owner</p>",
  );
  const views = new Map<BrowserSurfaceViewPort, WebContentsView>();
  const nativeContexts = new Map<string, Electron.WebContents>();
  const ownedContents = new Set<Electron.WebContents>();
  let creates = 0;
  let nativeActions = 0;
  const sessions = new Set<Electron.Session>();
  function nativeSession(partition: string) {
    const native = session.fromPartition(partition);
    if (!sessions.has(native)) {
      sessions.add(native);
      native.setCertificateVerifyProc((request, answer) => {
        let matches = false;
        try {
          matches = new X509Certificate(request.certificate.data).raw.equals(pinned);
        } catch {
          /* No fixture trust. */
        }
        answer(request.hostname === "127.0.0.1" && matches ? 0 : -2);
      });
    }
    return native;
  }
  const host = createBrowserSurfaceHost({
    isOwnerWindowAvailable: (id) =>
      id === String(windowId) && !window.isDestroyed() && window.isVisible(),
    createView: (options) => {
      const profile = storedBrowserProfileOfPartitionFolder(
        options.partition.replace(/^persist:/, ""),
      );
      if (profile?.kind === "account" && !store.hasAccountProfile(profile.profileId))
        throw Error("The native account profile is not registered.");
      nativeSession(options.partition);
      const view = new WebContentsView({
        webPreferences: { ...options.webPreferences, partition: options.partition },
      });
      const port = view as BrowserSurfaceViewPort;
      views.set(port, view);
      ownedContents.add(view.webContents);
      return port;
    },
  });
  const store = createBrowserProfileStore({
    partitionsDirectory: join(app.getPath("userData"), "Partitions"),
    sessionFor: nativeSession,
    closeProfilePages: (profile) => host.closeProfileContexts(profile),
  });
  const broker = await startBrowserRuntimeBroker(host, store);
  const shell: BrowserSurfaceShellWindowPort = {
    contentView: {
      addChildView: (port) => {
        const view = views.get(port);
        if (view === undefined) throw Error("Unknown native view.");
        window.contentView.addChildView(view);
      },
      removeChildView: (port) => {
        const view = views.get(port);
        if (view !== undefined && !window.isDestroyed()) window.contentView.removeChildView(view);
      },
    },
    isDestroyed: () => window.isDestroyed(),
    isVisible: () => window.isVisible(),
    webContents: { send: () => {} },
  };
  class PresentedRuntime extends DesktopBrowserRuntime {
    override async createContext(...args: Parameters<DesktopBrowserRuntime["createContext"]>) {
      const result = await super.createContext(...args);
      creates++;
      host.attach(args[0], args[3], shell, { x: 0, y: 60, width: 900, height: 600 });
      const newest = [...views.values()].at(-1);
      if (newest !== undefined) nativeContexts.set(String(args[0]), newest.webContents);
      return result;
    }
    override async act(...args: Parameters<DesktopBrowserRuntime["act"]>) {
      nativeActions++;
      return super.act(...args);
    }
  }
  const runtime = new PresentedRuntime({ brokerUrl: broker.url, token: broker.token });
  const created = await store.createAccount("Owned child fixture");
  if (created.status !== "created") throw Error("The actual profile registry refused the fixture.");
  const childProfile = created.profile;
  async function signIn(profile: StoredBrowserProfile, value: string) {
    await nativeSession(browserProfilePartition(profile, "")).cookies.set({
      url: origin,
      name: "octant_fixture_account",
      value,
      httpOnly: true,
      secure: true,
      path: "/",
      sameSite: "strict",
    });
  }
  await signIn({ kind: "personal" }, "parent-fixture");
  await signIn(childProfile, "child-fixture");
  const parentId = decodeBrowserContextId(randomUUID());
  const parentThread = decodeBrowserThreadId(randomUUID());
  const policy: BrowserContextPolicy = {
    profileMode: "isolated",
    profile: { kind: "personal" },
    allowedOrigins: [origin, deniedOrigin],
    credentialFieldProtection: true,
    maxConcurrentTabs: 4,
    sessionTimeoutMs: 120_000,
  };
  const signal = AbortSignal.timeout(90_000);
  let children: BrowserDelegatedChildren | undefined;
  let grants: BrowserSessionGrants | undefined;
  let tools: ReturnType<BrowserDelegatedChildren["tools"]> | undefined;
  try {
    await runtime.createContext(parentId, policy, signal, { windowId, threadId: parentThread });
    let refusedCertificate = false;
    try {
      await runtime.act(parentId, { kind: "navigate", target: deniedOrigin }, signal);
    } catch {
      refusedCertificate = true;
    }
    check(
      refusedCertificate && deniedRequests === 0,
      "the profile-scoped exact leaf pin refuses a different certificate on the same loopback host",
    );
    await runtime.act(parentId, { kind: "navigate", target: origin }, signal);
    check(
      (await runtime.act(parentId, { kind: "extract-text" }, signal)).extractedText?.includes(
        "parent-fixture",
      ) === true,
      "the actual parent native profile is signed into its own synthetic account",
    );
    const parentAuthority = decodeToolActionAuthority({
      hostId: randomUUID(),
      mode: "work",
      projectId: randomUUID(),
      providerInstanceId: randomUUID(),
      extension: { kind: "core" },
    });
    const childProvider = randomUUID();
    const run = decodeAgentRun({
      id: randomUUID(),
      requestId: randomUUID(),
      parentThreadId: randomUUID(),
      depth: 0,
      role: "implementation",
      task: "Read owned account",
      creationPosture: "automatic",
      executionKind: "octant-managed",
      lifecycleStatus: "running",
      authority: defaultAgentRunAuthorityCeilingForMode("work"),
      routingReceipt: {
        executionResolution: {
          providerInstanceId: childProvider,
          modelId: "owned-model",
          hostId: "local",
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
          effectivePermissions: {
            filesystem: true,
            shell: false,
            git: false,
            network: false,
            tools: true,
            subagents: true,
          },
          source: "project-default",
          fallbackChain: ["project-default"],
          downgradeReasons: [],
        },
        selectedExecutionKind: "octant-managed",
        attemptedExecutionKind: "octant-managed",
        selectedProviderInstanceId: childProvider,
        selectedModelId: "owned-model",
        fallbackCandidates: [],
        capabilityDegradations: [],
        contextSnapshotId: randomUUID(),
        effectiveAuthorityDigest: "owned-native-child",
        usageQuality: "unavailable",
        hostId: "local",
        mode: "work",
      },
      workspaceReceipt: {
        kind: "work-root",
        mode: "work",
        projectId: String(parentAuthority.projectId),
        bindingRevisionId: randomUUID(),
        canonicalRoot: root,
      },
      resultAcknowledgement: { required: false, acknowledged: false },
      version: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const resolved = currentManagedChildBrowserTarget(run, {
      canReview: () => true,
      resolveParent: () => parentAuthority,
      supportsTools: () => true,
    });
    if (resolved === undefined) throw Error("The real Work child target refused.");
    const target = resolved.target;
    let current: typeof target | undefined = target;
    let revision = "one";
    const events: string[] = [];
    grants = new BrowserSessionGrants({
      now: Date.now,
      uuid: randomUUID,
      isLocalWindow: (id) => String(id) === String(windowId) && !window.isDestroyed(),
      canReview: (id) => String(id) === String(windowId) && !window.isDestroyed(),
      targets: () => (current === undefined ? [] : [{ target: current, revision }]),
      current: () => (current === undefined ? undefined : { target: current, revision }),
      profileLabel: async () => "Owned child fixture",
      record: (event) => {
        events.push(event.kind);
      },
      onRevoked: (id) => {
        void children?.revoke(id);
      },
    });
    children = new BrowserDelegatedChildren({
      runtime,
      grants,
      now: Date.now,
      uuid: randomUUID,
      recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
    });
    tools = children.tools({ target, executionPolicy: "approval-gated", current: () => current });
    const call = {
      name: "octant_browser",
      inputJson: JSON.stringify({
        operation: "navigate",
        url: origin,
        include: ["text"],
        profile: `account:${String(childProfile.profileId)}`,
      }),
    };
    const before = creates;
    check(
      (await tools.execute(call)).isError === true && creates === before,
      "the child creates no native page without its exact permission",
    );
    check(
      (
        await tools.execute({
          name: call.name,
          inputJson: JSON.stringify({ operation: "navigate", url: origin }),
        })
      ).isError === true && creates === before,
      "omitting a profile neither borrows the parent nor falls back to Private",
    );
    const reviewCommand = {
      kind: "review" as const,
      grantee: target.grantee,
      profile: childProfile,
      origins: [origin],
      durationMinutes: 15 as const,
    };
    check(
      (await grants.execute(decodeWindowId(randomUUID()), reviewCommand)).kind ===
        "browser-session-refused",
      "an unrelated nonlocal window cannot review the child permission",
    );
    const review = await grants.execute(windowId, reviewCommand);
    if (review.kind !== "browser-session-review") throw Error("The local child review refused.");
    check(creates === before, "review alone starts no native context");
    const allowed = await grants.execute(windowId, { kind: "grant", reviewId: review.reviewId });
    if (allowed.kind !== "browser-session-granted") throw Error("The reviewed permission refused.");
    check(creates === before, "grant alone starts no child execution");
    const answer = await tools.execute(call);
    await writeFile(
      join(output, "first-child-answer.json"),
      JSON.stringify({ answer, creates, nativeActions }),
    );
    check(
      answer.isError !== true &&
        JSON.stringify(answer).includes("child-fixture") &&
        !JSON.stringify(answer).includes("parent-fixture"),
      "the explicit child retry reads its selected real native account, separately from the parent",
    );
    check(
      creates === before + 1 && run.authority.network === false,
      "a distinct child context leaves Work's ambient network ceiling unchanged",
    );
    const childEntry = [...nativeContexts.entries()].find(([id]) => id !== String(parentId));
    if (childEntry === undefined) throw Error("No native child view was created.");
    check(
      !childEntry[1].isDestroyed() && !nativeContexts.get(String(parentId))?.isDestroyed(),
      "both actual native views are alive independently",
    );
    await writeFile(join(output, "native-child.png"), (await window.capturePage()).toPNG());
    const actionsBefore = nativeActions;
    check(
      (
        await tools.execute({
          name: call.name,
          inputJson: JSON.stringify({ operation: "navigate", url: deniedOrigin }),
        })
      ).isError === true &&
        nativeActions === actionsBefore &&
        deniedRequests === 0,
      "an off-origin child navigation is refused before native dispatch",
    );
    for (const operation of [
      { operation: "upload", selector: "#owned-file", files: ["owned-fixture.txt"] },
      { operation: "download-save", downloadId: "d1" },
      { operation: "sign-in" },
      { operation: "run-script", source: "document.title", expectedObservationRevision: 1 },
    ]) {
      const refused = await tools.execute({
        name: call.name,
        inputJson: JSON.stringify(operation),
      });
      const reason =
        operation.operation === "upload" || operation.operation === "download-save"
          ? "transfer-needs-separate-permission"
          : "browser-operation-needs-a-local-person";
      check(
        refused.isError === true &&
          nativeActions === actionsBefore &&
          JSON.stringify(refused).includes(reason),
        "separate transfer, sign-in and script authority is not inherited",
      );
    }
    const pending = tools.execute({
      name: call.name,
      inputJson: JSON.stringify({ operation: "navigate", url: `${origin}/slow` }),
    });
    await until(
      () => held !== undefined,
      "the actual child navigation reaches the held HTTPS fixture",
    );
    await grants.execute(windowId, { kind: "revoke", grantId: allowed.grant.grantId });
    const revoked = await pending;
    check(
      revoked.isError === true && !JSON.stringify(revoked).includes("child-fixture"),
      "revocation during a real native request withholds the entire observation",
    );
    await until(
      () => childEntry[1].isDestroyed(),
      "revocation closes the actual child native page",
    );
    check(
      !nativeContexts.get(String(parentId))?.isDestroyed(),
      "child revocation leaves the actual parent page alive",
    );
    check(
      (await tools.execute(call)).isError === true,
      "a revoked child cannot silently reopen another context",
    );
    revision = "changed";
    current = undefined;
    await tools.close?.();
    await children.close();
    grants.close();
    check(
      events.includes("granted") && events.includes("revoked"),
      "the real grant policy emits grant and revoke evidence",
    );
    check(
      (await runtime.act(parentId, { kind: "extract-text" }, signal)).extractedText?.includes(
        "parent-fixture",
      ) === true,
      "the original parent still reads its unchanged account after child cleanup",
    );
    await runtime.closeContext(parentId);
    await until(
      () => [...ownedContents].every((contents) => contents.isDestroyed()),
      "every owned native view is destroyed",
    );
  } finally {
    held?.destroy();
    await tools?.close?.();
    await children?.close();
    grants?.close();
    await broker.close();
    if (!window.isDestroyed()) window.destroy();
    await closeServer(service);
    await closeServer(denied);
  }
  console.log(
    JSON.stringify({
      check: "browser-managed-child-native",
      status: "passed",
      runtime: process.versions,
      source: "c0af367e35911cca367bec197bdc771a94fa1a03",
      actualElectronViews: true,
      actualBrokerAndStores: true,
      syntheticSignedInProfiles: true,
      packagedManagedAgentAcceptance: "not-run",
      normalSettingsReviewAcceptance: "not-run",
      persistedTaintAcceptance: "not-run",
      cleanup: "owned views, owner window and HTTPS/broker listeners closed",
      checks,
    }),
  );
}
let closing = false;
const deadline = setTimeout(() => app.exit(1), 120_000);
const lostOwner = () => {
  if (!closing) app.exit(1);
};
process.stdin.resume();
process.stdin.once("end", lostOwner);
process.once("SIGTERM", lostOwner);
process.once("SIGINT", lostOwner);
void main()
  .then(() => {
    closing = true;
    clearTimeout(deadline);
    app.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Native fixture failed.");
    closing = true;
    clearTimeout(deadline);
    app.exit(1);
  });
