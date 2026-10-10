import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrivateListenerSetting } from "./privateListenerSetting";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-listener-setting-"));
  directories.push(directory);
  return directory;
}

const CONFIG = {
  hostname: "station.example.ts.net",
  port: 8455,
  origin: "https://station.example.ts.net:8455",
  tls: { cert: "certificate pem", key: "private key pem" },
};

describe("remembered private listener setting", () => {
  it("reads back the listener it remembered, readable only by the host's user", () => {
    const directory = dataDirectory();
    const setting = createPrivateListenerSetting(directory);
    expect(setting.load()).toBeUndefined();
    setting.save(CONFIG);
    expect(createPrivateListenerSetting(directory).load()).toEqual(CONFIG);
    const mode = statSync(join(directory, "remote", "private-listener-setting.json")).mode;
    expect(mode & 0o077).toBe(0);
  });

  it("forgets the listener once cleared", () => {
    const setting = createPrivateListenerSetting(dataDirectory());
    setting.save(CONFIG);
    setting.clear();
    expect(setting.load()).toBeUndefined();
    setting.clear();
  });

  it("leaves the listener off when the remembered setting is unreadable", () => {
    const directory = dataDirectory();
    mkdirSync(join(directory, "remote"));
    const path = join(directory, "remote", "private-listener-setting.json");
    writeFileSync(path, "{not json");
    expect(createPrivateListenerSetting(directory).load()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ hostname: "station.example.ts.net", port: "8455" }));
    expect(createPrivateListenerSetting(directory).load()).toBeUndefined();
  });
});
