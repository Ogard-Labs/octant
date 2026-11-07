import { app, session } from "electron";
import { randomUUID, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import { mkdirSync } from "node:fs";
import { chmod, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DesktopDownloadHold } from "./browserDownloadHold";

/** A disposable native session, never a production certificate exception. */
async function probe(root: string) {
  app.disableHardwareAcceleration();
  mkdirSync(join(root, "profile"), { mode: 0o700 });
  app.setPath("userData", join(root, "profile"));
  const keyPath = join(root, "fixture-key.pem");
  const certificatePath = join(root, "fixture-certificate.pem");
  execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-subj",
      "/CN=127.0.0.1",
    ],
    { stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root } },
  );
  await chmod(keyPath, 0o600);
  const key = await readFile(keyPath);
  const cert = await readFile(certificatePath);
  const fingerprint = new X509Certificate(cert).fingerprint256;
  const downloads = join(root, "downloads");
  await mkdir(downloads, { mode: 0o700 });
  const hold = new DesktopDownloadHold(downloads);
  const servers: Server[] = [];
  await app.whenReady();
  const native = session.fromPartition(`octant-download-source-${randomUUID()}`);
  const payload = "disposable native report";
  const listen = async (server: Server) => {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw Error("Fixture did not listen.");
    return `https://127.0.0.1:${address.port}`;
  };
  try {
    const destination = await listen(
      createServer({ key, cert }, (_request, response) => {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="report.txt"',
        });
        response.end(payload);
      }),
    );
    const start = await listen(
      createServer({ key, cert }, (_request, response) => {
        response.writeHead(302, {
          location: `${destination}/report?fixture-token=not-a-secret#fragment`,
        });
        response.end();
      }),
    );
    const origins = [start, destination];
    native.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, answer) => {
      let allowed = false;
      try {
        allowed = origins.includes(new URL(request.url).origin);
      } catch {}
      answer({ cancel: !allowed });
    });
    native.setCertificateVerifyProc((request, answer) => {
      let pinned = false;
      try {
        pinned =
          request.hostname === "127.0.0.1" &&
          new X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
      } catch {}
      answer(pinned ? 0 : -2);
    });
    const accepted = new Promise<void>((resolve) =>
      native.once("will-download", (event, item) => {
        hold.accept(event, item);
        resolve();
      }),
    );
    hold.begin();
    native.downloadURL(`${start}/redirect?fixture-token=not-a-secret`);
    await accepted;
    await hold.finish();
    const report = hold.takeReports()[0];
    if (
      report?.state !== "held" ||
      JSON.stringify(report.source?.origins) !== JSON.stringify(origins)
    )
      throw Error("The native redirect source receipt did not match both fixture origins.");
    if (
      JSON.stringify(report).includes("fixture-token") ||
      JSON.stringify(report).includes("/redirect")
    )
      throw Error("Raw URL data entered download metadata.");
    const held = hold.claim(report.downloadId);
    if (held === undefined || (await readFile(held, "utf8")) !== payload)
      throw Error("The receipt was not attached to the completed held bytes.");
    await hold.dispose();
    if ((await readdir(downloads)).length !== 0) throw Error("A held download was retained.");
    return {
      status: "passed",
      source: report.source,
      byteLength: Buffer.byteLength(payload),
      ports: origins.map((origin) => Number(new URL(origin).port)),
    };
  } finally {
    await hold.dispose();
    native.setCertificateVerifyProc(null);
    await native.closeAllConnections();
    await Promise.all(
      servers.map(async (server) => {
        server.closeAllConnections();
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          );
      }),
    );
  }
}
const root = process.argv[2];
if (root === undefined) throw Error("An owned fixture root is required.");
const pending = probe(root);
void pending.catch(() => undefined);
Object.defineProperty(globalThis, "__octantDownloadSourceProbe", { value: pending });
