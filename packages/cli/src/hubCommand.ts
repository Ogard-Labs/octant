import { HUB_GRANT_ITEMS, type HubGrantItem } from "@octant/contracts";
import { diskEncryptionWarning, type DiskEncryption } from "./diskEncryption";
import {
  failureMessage,
  type LocalControlRequest,
  type LocalControlResponse,
  type OpenedLocalControlSession,
} from "./localControl";
import type { HubBootService, HubBootServicePlan, ServiceCommandRunner } from "./serviceManager";
import { renderTerminalQr } from "./terminalQr";

export type HubCliCommand =
  | { readonly action: "status" }
  | { readonly action: "enable"; readonly installService: boolean }
  | { readonly action: "disable"; readonly removeService: boolean }
  | { readonly action: "join-code"; readonly owner: boolean }
  | {
      readonly action: "join";
      readonly code: string;
      /** Absent: keep the default grant, or ask when a person is at the terminal. */
      readonly items?: ReadonlyArray<HubGrantItem>;
    }
  | { readonly action: "grant"; readonly items?: ReadonlyArray<HubGrantItem> }
  | { readonly action: "leave" }
  | { readonly action: "remove"; readonly member: string };

/** What the hub role asks of the hub itself, as opposed to a computer that joins one. */
const HUB_SIDE_ACTIONS: ReadonlySet<HubCliCommand["action"]> = new Set([
  "enable",
  "disable",
  "join-code",
  "remove",
]);

const JOIN_APPROVAL_WINDOW_MS = 5 * 60_000;

export function resolveHubCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): HubCliCommand | undefined {
  const [action, ...rest] = positional;
  const only = (...allowed: readonly string[]) =>
    Object.keys(flags).every((flag) => allowed.includes(flag));
  switch (action) {
    case "status":
    case "leave":
      if (rest.length !== 0 || !only()) return undefined;
      return { action };
    case "enable":
      if (rest.length !== 0 || !only("install-service") || !isSwitch(flags["install-service"])) {
        return undefined;
      }
      return { action, installService: flags["install-service"] === true };
    case "disable":
      if (rest.length !== 0 || !only("remove-service") || !isSwitch(flags["remove-service"])) {
        return undefined;
      }
      return { action, removeService: flags["remove-service"] === true };
    case "join-code":
      if (rest.length !== 0 || !only("owner") || !isSwitch(flags.owner)) return undefined;
      return { action, owner: flags.owner === true };
    case "join": {
      const [code] = rest;
      if (code === undefined || rest.length !== 1 || !only("items")) return undefined;
      const items = itemsFromFlag(flags.items);
      if (items === "invalid") return undefined;
      return { action, code, ...(items === undefined ? {} : { items }) };
    }
    case "grant": {
      if (rest.length !== 0 || !only("items")) return undefined;
      const items = itemsFromFlag(flags.items);
      if (items === "invalid") return undefined;
      return { action, ...(items === undefined ? {} : { items }) };
    }
    case "remove": {
      const [member] = rest;
      if (member === undefined || rest.length !== 1 || !only()) return undefined;
      return { action, member };
    }
    default:
      return undefined;
  }
}

/** A switch is given bare or not at all; a value after it is a usage error. */
function isSwitch(flag: string | boolean | undefined): boolean {
  return flag === undefined || flag === true;
}

/** `--items roster,status`, or `--items none`; absent means the flag was not given. */
function itemsFromFlag(
  flag: string | boolean | undefined,
): ReadonlyArray<HubGrantItem> | undefined | "invalid" {
  if (flag === undefined) return undefined;
  if (typeof flag !== "string") return "invalid";
  return parseGrantItems(flag) ?? "invalid";
}

function parseGrantItems(text: string): ReadonlyArray<HubGrantItem> | undefined {
  const names = text
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  if (names.length === 1 && names[0] === "none") return [];
  const items: HubGrantItem[] = [];
  for (const name of names) {
    const item = HUB_GRANT_ITEMS.find((candidate) => candidate === name);
    if (item === undefined) return undefined;
    if (!items.includes(item)) items.push(item);
  }
  return items.length === 0 ? undefined : items;
}

export interface RunHubCliCommandInput {
  readonly command: HubCliCommand;
  readonly session: OpenedLocalControlSession;
  /** `isTTY` decides whether the QR code sets its own colours. */
  readonly stdout: { readonly write: (chunk: string) => unknown; readonly isTTY?: boolean };
  readonly stderr: { readonly write: (chunk: string) => unknown };
  readonly platform: NodeJS.Platform;
  /** Absent where the hub role has no boot service. */
  readonly bootService?: HubBootService;
  /** The ordinary login service, which the boot service replaces while the hub role is on. */
  readonly loginService: {
    readonly install: () => Promise<void>;
    readonly enable: () => Promise<void>;
  };
  /**
   * Runs the one administrator command. Only an explicit flag reaches it, and
   * it must let the person answer the password prompt.
   */
  readonly administrator: ServiceCommandRunner;
  readonly diskEncryption: () => Promise<DiskEncryption>;
  /** Present only when a person is at the terminal. */
  readonly ask?: (question: string) => Promise<string | undefined>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

type Input = RunHubCliCommandInput;

export async function runHubCliCommand(input: Input): Promise<number> {
  const { command } = input;
  if (HUB_SIDE_ACTIONS.has(command.action) && input.platform === "win32") {
    input.stderr.write("The hub role is not available on Windows yet.\n");
    return 1;
  }
  switch (command.action) {
    case "status":
      return await runStatus(input);
    case "enable":
      return await runEnable(input, command.installService);
    case "disable":
      return await runDisable(input, command.removeService);
    case "join-code":
      return await runJoinCode(input, command.owner);
    case "join":
      return await runJoin(input, command.code, command.items);
    case "grant":
      return await runGrant(input, command.items);
    case "leave":
      return await runLeave(input);
    case "remove":
      return await runRemove(input, command.member);
  }
}

async function runStatus(input: Input): Promise<number> {
  const status = await readStatus(input, "Octant refused to read the hub status.");
  if (status === undefined) return 1;
  input.stdout.write(`Hub role ${status.hubEnabled ? "on" : "off"}\n`);
  for (const member of status.members) {
    input.stdout.write(
      `  ${member.memberId}  ${member.role}${member.owner ? " (owner)" : ""}  ${member.name}\n`,
    );
  }
  if (status.link === undefined) {
    input.stdout.write("This computer has not joined a hub.\n");
    return 0;
  }
  input.stdout.write(
    `Joined ${status.link.hubName}${status.link.membership === "removed" ? " (the hub removed this computer)" : ""}\n`,
  );
  writeGrant(input, status.link.grant);
  return 0;
}

async function runEnable(input: Input, installService: boolean): Promise<number> {
  const response = await post(input, "/api/desktop/hub/enable");
  if (!isOk(response, "enabled"))
    return refusal(input, response, "Octant refused to turn on the hub role.");
  input.stdout.write("The hub role is on.\n");

  const warning = diskEncryptionWarning(input.platform, await input.diskEncryption());
  if (warning !== undefined) input.stdout.write(`${warning}\n`);

  const boot = input.bootService;
  if (boot === undefined) return 0;
  if (await boot.installed()) {
    input.stdout.write("This computer already starts the server at boot.\n");
  } else {
    const plan = boot.installPlan();
    if (installService) {
      const failed = await runAdministratorStep(input, plan);
      if (failed) return 1;
      if (plan.userServiceFollowUp === "install-and-enable") {
        await input.loginService.install();
        await input.loginService.enable();
      }
      input.stdout.write("The server now starts at boot, with no one logged in.\n");
    } else {
      input.stdout.write(
        [
          "To start the hub at boot, with no one logged in, run this once. It needs your administrator password:",
          `  ${shellJoin(plan.administratorCommand)}`,
          ...(plan.userServiceFollowUp === "install-and-enable"
            ? ["Then make sure the service is installed: `octant server enable`."]
            : []),
          "Or run `octant hub enable --install-service` and Octant runs that command for you.",
          "",
        ].join("\n"),
      );
    }
  }
  if (input.platform === "darwin") {
    input.stdout.write(
      ["To start again after a power failure, run:", "  sudo pmset -a autorestart 1", ""].join(
        "\n",
      ),
    );
  }
  return 0;
}

async function runDisable(input: Input, removeService: boolean): Promise<number> {
  const response = await post(input, "/api/desktop/hub/disable");
  if (!isOk(response, "disabled"))
    return refusal(input, response, "Octant refused to turn off the hub role.");
  input.stdout.write("The hub role is off.\n");

  const boot = input.bootService;
  if (boot === undefined || !(await boot.installed())) return 0;
  const plan = boot.removalPlan();
  if (removeService) {
    const failed = await runAdministratorStep(input, plan);
    if (failed) return 1;
    if (plan.userServiceFollowUp === "install-and-enable") {
      await input.loginService.install();
      await input.loginService.enable();
    }
    input.stdout.write("The server is back to the ordinary login service.\n");
    return 0;
  }
  input.stdout.write(
    [
      "This computer still starts the server at boot. To go back to the ordinary login service, run this once. It needs your administrator password:",
      `  ${shellJoin(plan.administratorCommand)}`,
      ...(plan.userServiceFollowUp === "install-and-enable"
        ? ["Then run `octant server enable`."]
        : []),
      "Or run `octant hub disable --remove-service` and Octant runs that command for you.",
      "",
    ].join("\n"),
  );
  return 0;
}

/** Runs the administrator command the person asked for; true when it failed. */
async function runAdministratorStep(input: Input, plan: HubBootServicePlan): Promise<boolean> {
  const [program, ...args] = plan.administratorCommand;
  if (program === undefined) return true;
  try {
    await input.administrator.run(program, args);
    return false;
  } catch {
    input.stderr.write(
      `The administrator step did not finish. Nothing else was changed. To run it yourself:\n  ${shellJoin(plan.administratorCommand)}\n`,
    );
    return true;
  }
}

async function runJoinCode(input: Input, owner: boolean): Promise<number> {
  const response = await post(input, "/api/desktop/hub/join-codes", { owner });
  if (!isOk(response, "minted"))
    return refusal(input, response, "Octant refused to make a join code.");
  const code = field(response.body, "code");
  const expiresAt = field(response.body, "expiresAt");
  if (typeof code !== "string" || typeof expiresAt !== "number") {
    input.stderr.write("Octant returned an unusable join code.\n");
    return 1;
  }
  const now = (input.now ?? Date.now)();
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
  input.stdout.write(renderTerminalQr(code, { color: input.stdout.isTTY === true }));
  input.stdout.write(`Join code ${code}\n`);
  input.stdout.write(
    `Expires ${new Date(expiresAt).toISOString()} (in about ${minutes} ${minutes === 1 ? "minute" : "minutes"})\n`,
  );
  input.stdout.write(
    [
      owner
        ? "The computer or phone that joins with this code becomes an owner of this hub."
        : "The code is single-use.",
      "On the other computer, run `octant hub join <code>`, or scan the QR code with the phone app. Compare the short code, then approve on this hub.",
      "",
    ].join("\n"),
  );
  return 0;
}

async function runJoin(
  input: Input,
  code: string,
  chosen: ReadonlyArray<HubGrantItem> | undefined,
): Promise<number> {
  const started = await post(input, "/api/desktop/hub/join", { code });
  if (!isOk(started, "awaiting-approval")) {
    return refusal(input, started, "Octant could not start joining that hub.");
  }
  const hubName = field(started.body, "hubName");
  const fingerprint = field(started.body, "hubKeyFingerprint");
  const comparison = field(started.body, "comparisonCode");
  if (
    typeof hubName !== "string" ||
    typeof fingerprint !== "string" ||
    typeof comparison !== "string"
  ) {
    input.stderr.write("Octant returned an unusable join answer.\n");
    return 1;
  }
  input.stdout.write(
    [
      `Hub ${hubName}`,
      `Key fingerprint ${fingerprint}`,
      `Comparison code ${comparison}`,
      "Approve on the hub only if the comparison code matches. Waiting for approval...",
      "",
    ].join("\n"),
  );

  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + JOIN_APPROVAL_WINDOW_MS;
  let finished = await post(input, "/api/desktop/hub/join/finish");
  while (isOk(finished, "awaiting-approval") && now() < deadline) {
    await sleep(1_000);
    finished = await post(input, "/api/desktop/hub/join/finish");
  }
  if (isOk(finished, "awaiting-approval")) {
    input.stderr.write(
      "The hub did not approve within five minutes. Run `octant hub join` again with a new code.\n",
    );
    return 1;
  }
  if (!isOk(finished, "joined")) return refusal(input, finished, "Joining the hub failed.");

  input.stdout.write(`Joined ${hubName}.\nWhat the hub may do here:\n`);
  const current = grantOf(field(finished.body, "grant"));
  if (current === undefined) {
    input.stderr.write("Octant returned an unusable hub grant.\n");
    return 1;
  }
  writeGrant(input, current);

  const items = chosen ?? (await askForItems(input, current.items));
  if (items === "invalid") {
    input.stderr.write(
      "Those are not hub grant items. The defaults stay. Change them with `octant hub grant --items <list>`.\n",
    );
    return 1;
  }
  if (items === undefined) {
    if (input.ask === undefined) {
      input.stdout.write(
        "The defaults stay. Change them with `octant hub grant --items <list>` (items: " +
          `${HUB_GRANT_ITEMS.join(", ")}; or none).\n`,
      );
    }
    return 0;
  }
  return await applyGrant(input, items, current.actProjects);
}

/** Keeps the defaults on Enter or `y`; otherwise reads the items the person wants. */
async function askForItems(
  input: Input,
  defaults: ReadonlyArray<HubGrantItem>,
): Promise<ReadonlyArray<HubGrantItem> | "invalid" | undefined> {
  if (input.ask === undefined) return undefined;
  const keep = await input.ask("Keep these? [Y/n] ");
  if (keep === undefined || keep.trim() === "" || /^y(es)?$/i.test(keep.trim())) return undefined;
  const answer = await input.ask(
    `Items the hub may use (${HUB_GRANT_ITEMS.join(", ")}; comma-separated, or none) [${defaults.join(",")}]: `,
  );
  if (answer === undefined || answer.trim() === "") return undefined;
  return parseGrantItems(answer) ?? "invalid";
}

async function runGrant(
  input: Input,
  items: ReadonlyArray<HubGrantItem> | undefined,
): Promise<number> {
  const status = await readStatus(input, "Octant refused to read the hub grant.");
  if (status === undefined) return 1;
  if (status.link === undefined) {
    input.stderr.write("This computer has not joined a hub.\n");
    return 1;
  }
  if (items === undefined) {
    writeGrant(input, status.link.grant);
    return 0;
  }
  return await applyGrant(input, items, status.link.grant.actProjects);
}

async function applyGrant(
  input: Input,
  items: ReadonlyArray<HubGrantItem>,
  currentActProjects: ReadonlyArray<string>,
): Promise<number> {
  // Projects may be named only while Act is ticked.
  const actProjects = items.includes("act") ? currentActProjects : [];
  const response = await post(input, "/api/desktop/hub/grant", { items, actProjects });
  if (!isOk(response, "changed")) {
    return refusal(input, response, "Octant refused to change the hub grant.");
  }
  const grant = grantOf(field(response.body, "grant"));
  input.stdout.write("The hub grant is now:\n");
  if (grant !== undefined) writeGrant(input, grant);
  return 0;
}

async function runLeave(input: Input): Promise<number> {
  const response = await post(input, "/api/desktop/hub/leave");
  if (!isOk(response, "left")) return refusal(input, response, "Octant refused to leave the hub.");
  input.stdout.write(
    field(response.body, "hubNotified") === true
      ? "Left the hub. The hub was told and drops this computer from its roster.\n"
      : "Left the hub. The hub could not be reached, so remove this computer from its roster there with `octant hub remove`.\n",
  );
  return 0;
}

async function runRemove(input: Input, member: string): Promise<number> {
  const status = await readStatus(input, "Octant refused to read the hub members.");
  if (status === undefined) return 1;
  const byId = status.members.filter((entry) => entry.memberId === member);
  const matches =
    byId.length > 0
      ? byId
      : status.members.filter((entry) => entry.name.toLowerCase() === member.toLowerCase());
  const [target] = matches;
  if (target === undefined) {
    input.stderr.write(
      `No hub member is called ${member}. List them with \`octant hub status\`.\n`,
    );
    return 1;
  }
  if (matches.length > 1) {
    input.stderr.write(
      `More than one member is called ${member}. Use the member id from \`octant hub status\`.\n`,
    );
    return 1;
  }
  const response = await post(input, "/api/desktop/hub/members/remove", {
    memberId: target.memberId,
  });
  if (!isOk(response, "removed")) {
    return refusal(input, response, "Octant refused to remove that member.");
  }
  input.stdout.write(
    `Removed ${target.name}. Every other member drops what it held for it at the next roster.\n`,
  );
  return 0;
}

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  "hub-role-off": "The hub role is off. Turn it on with `octant hub enable`.",
  "listener-not-running":
    "The remote listener is not running. Turn it on first with `octant listener enable`.",
  "listener-not-private":
    "The remote listener is not on a private network address, so the hub will not use it.",
  "listener-has-no-pin":
    "The remote listener serves a certificate Octant cannot pin, so a join code cannot name it.",
  "pairing-unavailable": "Pairing is not available on this host right now.",
  "not-a-join-code": "That is not a join code.",
  "identity-mismatch": "The hub does not match the code.",
  "member-origin-not-private": "That device's address is not on a private network.",
  "not-approved": "The hub has not approved this device.",
  "already-member": "That device is already a member.",
  "already-joined":
    "This computer already belongs to a hub. Leave it first with `octant hub leave`.",
  "hub-unreachable":
    "Octant could not reach the hub. Check that both computers are on the same private network.",
  "no-join-in-progress": "No join is in progress. Start one with `octant hub join <code>`.",
  "hub-declined": "The hub declined this computer.",
  "hub-refused-join": "The hub refused this computer.",
  "hub-answer-invalid": "The hub's answer did not check out, so nothing was saved.",
  "not-a-member": "That is not a member of this hub.",
  "cannot-remove-the-hub": "The hub cannot remove itself.",
  "not-a-spoke": "This computer has not joined a hub.",
  "hub-revoked": "The hub removed this computer.",
};

/** The server's refusal as a sentence plus its own word for it, so nothing is hidden. */
function refusal(input: Input, response: LocalControlResponse, fallback: string): number {
  const kind = field(response.body, "kind");
  if (field(response.body, "status") === "refused" && typeof kind === "string") {
    input.stderr.write(`${REFUSAL_COPY[kind] ?? "Octant refused."} (${kind})\n`);
  } else {
    input.stderr.write(`${failureMessage(response, fallback)}\n`);
  }
  return 1;
}

function isOk(response: LocalControlResponse, status: string): boolean {
  return response.status === 200 && field(response.body, "status") === status;
}

function post(input: Input, path: string, body?: unknown): Promise<LocalControlResponse> {
  const request: LocalControlRequest =
    body === undefined ? { path, method: "POST" } : { path, method: "POST", body };
  return input.session.send(request);
}

interface HubMemberOutput {
  readonly memberId: string;
  readonly name: string;
  readonly role: string;
  readonly owner: boolean;
}

interface GrantOutput {
  readonly items: ReadonlyArray<HubGrantItem>;
  readonly actProjects: ReadonlyArray<string>;
}

interface HubStatusOutput {
  readonly hubEnabled: boolean;
  readonly members: ReadonlyArray<HubMemberOutput>;
  readonly link?: {
    readonly membership: "member" | "removed";
    readonly hubName: string;
    readonly grant: GrantOutput;
  };
}

async function readStatus(input: Input, fallback: string): Promise<HubStatusOutput | undefined> {
  const response = await input.session.send({ path: "/api/desktop/hub/status", method: "GET" });
  if (response.status !== 200) {
    input.stderr.write(`${failureMessage(response, fallback)}\n`);
    return undefined;
  }
  const hub = field(response.body, "hub");
  const spoke = field(response.body, "spoke");
  const enabled = field(hub, "enabled");
  if (typeof enabled !== "boolean") {
    input.stderr.write("Octant returned an unusable hub status.\n");
    return undefined;
  }
  const rosterMembers = field(field(field(hub, "roster"), "roster"), "members");
  const members: HubMemberOutput[] = [];
  for (const entry of Array.isArray(rosterMembers) ? rosterMembers : []) {
    const memberId = field(entry, "memberId");
    const name = field(entry, "name");
    const role = field(entry, "role");
    if (typeof memberId === "string" && typeof name === "string" && typeof role === "string") {
      members.push({ memberId, name, role, owner: field(entry, "owner") === true });
    }
  }
  const membership = field(spoke, "membership");
  const hubName = field(field(spoke, "hub"), "name");
  const grant = grantOf(field(spoke, "grant"));
  if (
    (membership === "member" || membership === "removed") &&
    typeof hubName === "string" &&
    grant !== undefined
  ) {
    return { hubEnabled: enabled, members, link: { membership, hubName, grant } };
  }
  return { hubEnabled: enabled, members };
}

function grantOf(value: unknown): GrantOutput | undefined {
  const rawItems = field(value, "items");
  const rawProjects = field(value, "actProjects");
  if (!Array.isArray(rawItems) || !Array.isArray(rawProjects)) return undefined;
  const items = HUB_GRANT_ITEMS.filter((item) => rawItems.includes(item));
  const actProjects = rawProjects.filter(
    (project): project is string => typeof project === "string",
  );
  return { items, actProjects };
}

function writeGrant(input: Input, grant: GrantOutput): void {
  for (const item of HUB_GRANT_ITEMS) {
    input.stdout.write(`  [${grant.items.includes(item) ? "x" : " "}] ${item}\n`);
  }
  if (grant.items.includes("owners")) {
    input.stdout.write(
      "Owners is on: the owner devices of this hub may act here with a window's powers after a fresh unlock.\n",
    );
  }
}

/** The command as a person would type it into a shell. */
function shellJoin(argv: readonly string[]): string {
  return argv
    .map((argument) =>
      /^[A-Za-z0-9_./:@%+=,-]+$/.test(argument)
        ? argument
        : `'${argument.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}
