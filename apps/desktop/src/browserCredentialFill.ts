import { randomUUID } from "node:crypto";
import type { BrowserProfile } from "@octant/contracts";
import type { BrowserSurfaceOwner, BrowserSurfaceViewPort } from "./browserSurfaceHost";

export interface CredentialFillPage {
  readonly identity: object;
  readonly generation: number;
  readonly owner: BrowserSurfaceOwner;
  readonly profile: BrowserProfile;
  readonly view: BrowserSurfaceViewPort;
}
export type NativeCredentialFillPlan =
  | {
      readonly status: "prepared";
      readonly planId: string;
      readonly usernameLabel: string;
      readonly passwordLabel: string;
      readonly submissionOrigin: string;
      readonly expiresAt: string;
    }
  | {
      readonly status: "refused";
      readonly reason: "stale" | "unavailable" | "authentication-required";
    };
export type NativeCredentialFillReceipt = {
  readonly status: "filled" | "authentication-required" | "cancelled" | "failed";
  readonly effect: "none" | "possible" | "completed";
};
interface Plan {
  readonly contextId: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly page: CredentialFillPage;
  readonly origin: string;
  readonly submissionOrigin: string;
  readonly expires: number;
  state: "prepared" | "reserved" | "committing";
}

/** Native one-shot form identity and observation exclusion. Values never leave this process. */
export class BrowserCredentialFill {
  readonly #plans = new Map<string, Plan>();
  readonly #filled = new Map<string, Plan>();
  readonly #reservations = new Map<string, Plan>();
  readonly #submissions = new Map<
    string,
    {
      readonly plan: Plan;
      phase: "validating" | "started" | "finished";
      cancelled: boolean;
      result: NativeCredentialFillReceipt | undefined;
    }
  >();
  readonly #held = new Map<object, string>();
  readonly #epochs = new WeakMap<object, number>();
  readonly #page: (contextId: string, owner: BrowserSurfaceOwner) => CredentialFillPage | undefined;
  readonly #execute: (view: BrowserSurfaceViewPort, code: string) => Promise<unknown>;
  constructor(options: {
    readonly page: (
      contextId: string,
      owner: BrowserSurfaceOwner,
    ) => CredentialFillPage | undefined;
    readonly execute: (view: BrowserSurfaceViewPort, code: string) => Promise<unknown>;
  }) {
    this.#page = options.page;
    this.#execute = options.execute;
  }
  observation(identity: object): () => void {
    const epoch = this.#epochs.get(identity) ?? 0;
    const check = () => {
      if (this.#held.has(identity) || (this.#epochs.get(identity) ?? 0) !== epoch)
        throw new Error("Browser credential fill holds observations.");
    };
    check();
    return check;
  }
  async prepare(
    contextId: string,
    owner: BrowserSurfaceOwner,
    origin: string,
  ): Promise<NativeCredentialFillPlan> {
    const page = this.#page(contextId, owner);
    if (
      page === undefined ||
      this.#plans.size + this.#filled.size >= 32 ||
      this.#submissions.size >= 64 ||
      this.#reservations.size >= 32 ||
      !exactOrigin(page, origin)
    )
      return refused("stale");
    const check = this.observation(page.identity);
    const planId = randomUUID();
    try {
      const result = await this.#execute(page.view, formCode("prepare", planId, origin));
      check();
      if (
        !record(result) ||
        result.status !== "prepared" ||
        typeof result.usernameLabel !== "string" ||
        typeof result.passwordLabel !== "string" ||
        typeof result.submissionOrigin !== "string"
      )
        return refused("authentication-required");
      if (this.#page(contextId, owner)?.identity !== page.identity || !exactOrigin(page, origin))
        return refused("stale");
      const expires = Date.now() + 180_000;
      const timer = setTimeout(() => this.#drop(planId), Math.max(0, expires - Date.now()));
      timer.unref();
      this.#plans.set(planId, {
        contextId,
        timer,
        page,
        origin,
        submissionOrigin: result.submissionOrigin,
        expires,
        state: "prepared",
      });
      return {
        status: "prepared",
        planId,
        usernameLabel: result.usernameLabel.slice(0, 128),
        passwordLabel: result.passwordLabel.slice(0, 128),
        submissionOrigin: result.submissionOrigin,
        expiresAt: new Date(expires).toISOString(),
      };
    } catch {
      return refused("unavailable");
    }
  }
  async reserve(
    contextId: string,
    owner: BrowserSurfaceOwner,
    planId: string,
    websiteOrigins: ReadonlyArray<string>,
  ): Promise<{ readonly status: "reserved" | "refused" }> {
    const plan = this.#valid(contextId, owner, planId);
    if (
      plan === undefined ||
      !websiteOrigins.includes(plan.origin) ||
      !websiteOrigins.includes(plan.submissionOrigin) ||
      plan.state !== "prepared" ||
      this.#held.has(plan.page.identity)
    )
      return { status: "refused" };
    plan.state = "reserved";
    this.#reservations.set(planId, plan);
    this.#held.set(plan.page.identity, planId);
    this.#epochs.set(plan.page.identity, (this.#epochs.get(plan.page.identity) ?? 0) + 1);
    if (!(await this.valid(contextId, owner, planId))) {
      this.cancel(contextId, owner, planId);
      return { status: "refused" };
    }
    return { status: "reserved" };
  }
  async valid(contextId: string, owner: BrowserSurfaceOwner, planId: string): Promise<boolean> {
    const plan = this.#valid(contextId, owner, planId);
    if (plan === undefined) return false;
    try {
      const result = await this.#execute(plan.page.view, formCode("validate", planId, plan.origin));
      return (
        this.#valid(contextId, owner, planId) === plan &&
        record(result) &&
        result.status === "valid"
      );
    } catch {
      return false;
    }
  }
  async commit(
    contextId: string,
    owner: BrowserSurfaceOwner,
    planId: string,
    values: { readonly username: string; readonly password: string },
    canCommit: () => boolean = () => true,
    onCommitStart?: () => void,
  ): Promise<NativeCredentialFillReceipt> {
    const plan = this.#valid(contextId, owner, planId);
    if (
      plan === undefined ||
      plan.state !== "reserved" ||
      !(await this.valid(contextId, owner, planId))
    ) {
      const reserved = this.#reservations.get(planId);
      if (
        reserved !== undefined &&
        reserved.contextId === contextId &&
        reserved.page.owner.windowId === owner.windowId &&
        String(reserved.page.owner.threadId) === String(owner.threadId) &&
        reserved.state === "committing"
      )
        return { status: "cancelled", effect: "possible" };
      if (plan !== undefined && this.#filled.get(planId) === plan)
        return { status: "filled", effect: "completed" };
      this.cancel(contextId, owner, planId);
      return { status: "cancelled", effect: "none" };
    }
    if (this.#valid(contextId, owner, planId) !== plan || !canCommit()) {
      this.cancel(contextId, owner, planId);
      return { status: "cancelled", effect: "none" };
    }
    // This is commit start: the plan cannot be replayed or cancelled as unstarted from here.
    plan.state = "committing";
    onCommitStart?.();
    this.#plans.delete(planId);
    clearTimeout(plan.timer);
    try {
      const result = await this.#execute(
        plan.page.view,
        formCode("fill", planId, plan.origin, values),
      );
      if (record(result) && result.status === "filled") {
        const timer = setTimeout(() => this.#drop(planId), 180_000);
        timer.unref();
        this.#filled.set(planId, { ...plan, timer, expires: Date.now() + 180_000 });
        return { status: "filled", effect: "completed" };
      }
      return { status: "authentication-required", effect: "none" };
    } catch {
      return { status: "failed", effect: "possible" };
    } finally {
      this.#reservations.delete(planId);
      if (this.#held.get(plan.page.identity) === planId) this.#held.delete(plan.page.identity);
      if (!this.#filled.has(planId) && !plan.page.view.webContents.isDestroyed())
        void this.#execute(plan.page.view, formCode("cancel", planId, plan.origin)).catch(
          () => undefined,
        );
    }
  }
  async submit(
    contextId: string,
    owner: BrowserSurfaceOwner,
    planId: string,
    deadline: number,
    admitOrigins: (origins: ReadonlyArray<string>, view: BrowserSurfaceViewPort) => void,
  ): Promise<NativeCredentialFillReceipt> {
    const previous = this.#submissions.get(planId);
    if (
      previous !== undefined &&
      (previous.plan.contextId !== contextId ||
        previous.plan.page.owner.windowId !== owner.windowId ||
        String(previous.plan.page.owner.threadId) !== String(owner.threadId))
    )
      return { status: "cancelled", effect: "none" };
    if (previous !== undefined)
      return (
        previous.result ?? {
          status: "cancelled",
          effect: previous.phase === "started" ? "possible" : "none",
        }
      );
    const plan = this.#valid(contextId, owner, planId);
    if (
      plan === undefined ||
      !Number.isFinite(deadline) ||
      Date.now() >= deadline ||
      this.#filled.get(planId) !== plan ||
      this.#held.has(plan.page.identity)
    )
      return { status: "cancelled", effect: "none" };
    const attempt = {
      plan,
      phase: "validating" as "validating" | "started" | "finished",
      cancelled: false,
      result: undefined as NativeCredentialFillReceipt | undefined,
    };
    this.#submissions.set(planId, attempt);
    this.#held.set(plan.page.identity, planId);
    this.#epochs.set(plan.page.identity, (this.#epochs.get(plan.page.identity) ?? 0) + 1);
    let result: NativeCredentialFillReceipt = { status: "cancelled", effect: "none" };
    try {
      if (
        !(await this.valid(contextId, owner, planId)) ||
        Date.now() >= deadline ||
        attempt.cancelled ||
        this.#valid(contextId, owner, planId) !== plan ||
        this.#filled.get(planId) !== plan
      )
        return result;
      // Final owner/form validation completed. Consume this submit once, before any effect awaits.
      this.#filled.delete(planId);
      clearTimeout(plan.timer);
      attempt.phase = "started";
      admitOrigins([plan.origin, plan.submissionOrigin], plan.page.view);
      const submitted = await this.#execute(
        plan.page.view,
        formCode("submit", planId, plan.origin),
      );
      result =
        record(submitted) && submitted.status === "submitted"
          ? { status: "authentication-required", effect: "completed" }
          : { status: "cancelled", effect: "none" };
      return result;
    } catch {
      result = { status: "failed", effect: attempt.phase === "started" ? "possible" : "none" };
      return result;
    } finally {
      attempt.phase = "finished";
      attempt.result = result;
      const timer = setTimeout(() => {
        if (this.#submissions.get(planId) === attempt) this.#submissions.delete(planId);
      }, 30_000);
      timer.unref();
      this.#drop(planId, true);
      if (this.#held.get(plan.page.identity) === planId) this.#held.delete(plan.page.identity);
      if (!plan.page.view.webContents.isDestroyed())
        void this.#execute(plan.page.view, formCode("cancel", planId, plan.origin)).catch(
          () => undefined,
        );
    }
  }
  cancel(
    contextId: string,
    owner: BrowserSurfaceOwner,
    planId: string,
  ): NativeCredentialFillReceipt {
    const submission = this.#submissions.get(planId);
    if (
      submission !== undefined &&
      submission.plan.contextId === contextId &&
      submission.plan.page.owner.windowId === owner.windowId &&
      String(submission.plan.page.owner.threadId) === String(owner.threadId)
    ) {
      if (submission.phase === "finished")
        return submission.result ?? { status: "cancelled", effect: "possible" };
      submission.cancelled = true;
      if (submission.phase === "validating") this.#drop(planId, true);
      return { status: "cancelled", effect: submission.phase === "started" ? "possible" : "none" };
    }
    const plan =
      this.#plans.get(planId) ?? this.#filled.get(planId) ?? this.#reservations.get(planId);
    if (
      plan === undefined ||
      plan.contextId !== contextId ||
      plan.page.owner.windowId !== owner.windowId ||
      String(plan.page.owner.threadId) !== String(owner.threadId)
    )
      return { status: "cancelled", effect: "none" };
    if (plan.state === "committing" && this.#reservations.has(planId))
      return { status: "cancelled", effect: "possible" };
    const completed = this.#filled.has(planId);
    this.#drop(planId, false, true);
    return { status: "cancelled", effect: completed ? "completed" : "none" };
  }
  forget(identity: object): void {
    for (const [id, plan] of [...this.#plans, ...this.#filled, ...this.#reservations])
      if (plan.page.identity === identity) this.#drop(id, false, true);
  }
  #drop(planId: string, preserveHold = false, releaseReservation = false): void {
    const plan =
      this.#plans.get(planId) ?? this.#filled.get(planId) ?? this.#reservations.get(planId);
    if (plan === undefined) return;
    this.#plans.delete(planId);
    this.#filled.delete(planId);
    clearTimeout(plan.timer);
    if (releaseReservation) this.#reservations.delete(planId);
    const submission = this.#submissions.get(planId);
    const submitting = submission !== undefined && submission.phase !== "finished";
    if (
      !preserveHold &&
      !submitting &&
      !this.#reservations.has(planId) &&
      this.#held.get(plan.page.identity) === planId
    )
      this.#held.delete(plan.page.identity);
    if (!plan.page.view.webContents.isDestroyed())
      void this.#execute(plan.page.view, formCode("cancel", planId, plan.origin)).catch(
        () => undefined,
      );
  }

  #valid(contextId: string, owner: BrowserSurfaceOwner, planId: string): Plan | undefined {
    const plan = this.#plans.get(planId) ?? this.#filled.get(planId);
    if (
      plan === undefined ||
      plan.contextId !== contextId ||
      plan.page.owner.windowId !== owner.windowId ||
      String(plan.page.owner.threadId) !== String(owner.threadId)
    )
      return undefined;
    const page = this.#page(contextId, owner);
    if (
      page === undefined ||
      page.identity !== plan.page.identity ||
      page.view !== plan.page.view ||
      page.generation !== plan.page.generation ||
      JSON.stringify(page.profile) !== JSON.stringify(plan.page.profile) ||
      Date.now() >= plan.expires ||
      !exactOrigin(page, plan.origin)
    ) {
      this.#drop(planId);
      return undefined;
    }
    return plan;
  }
}
function refused(
  reason: "stale" | "unavailable" | "authentication-required",
): NativeCredentialFillPlan {
  return { status: "refused", reason };
}
function exactOrigin(page: CredentialFillPage, origin: string): boolean {
  try {
    const expected = new URL(origin);
    return (
      expected.protocol === "https:" &&
      expected.origin === origin &&
      new URL(page.view.webContents.getURL()).origin === origin &&
      !page.view.webContents.isDestroyed()
    );
  } catch {
    return false;
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formCode(
  operation: "prepare" | "validate" | "fill" | "cancel" | "submit",
  planId: string,
  origin: string,
  values?: { readonly username: string; readonly password: string },
): string {
  return `(${nativeLoginForm.toString()})(${JSON.stringify({ operation, planId, origin, ...(values === undefined ? {} : { values }) })})`;
}
/** Runs in the existing isolated world. The page gets input events, never this plan map. */
function nativeLoginForm(request: {
  readonly operation: string;
  readonly planId: string;
  readonly origin: string;
  readonly values?: { readonly username: string; readonly password: string };
}): object {
  type Saved = {
    readonly document: Document;
    readonly username: HTMLInputElement;
    readonly password: HTMLInputElement;
    readonly form: HTMLFormElement;
    readonly submissionOrigin: string;
    readonly action: string;
    readonly usernameSemantics: string;
    readonly passwordSemantics: string;
    filled: boolean;
  };
  const scope = globalThis as typeof globalThis & { octantLoginPlans?: Map<string, Saved> };
  const plans = (scope.octantLoginPlans ??= new Map());
  const refused = { status: "refused" };
  if (location.origin !== request.origin || location.protocol !== "https:") return refused;
  if (request.operation === "cancel") {
    plans.delete(request.planId);
    return { status: "cancelled" };
  }
  const visible = (input: HTMLInputElement) =>
    !input.disabled && !input.readOnly && input.getClientRects().length > 0;
  const usernameAllowed = (input: HTMLInputElement) =>
    visible(input) &&
    ["text", "email"].includes(input.type) &&
    (input.autocomplete === "username" ||
      input.type === "email" ||
      /(?:user|email|login)/i.test(input.name));
  const passwordAllowed = (input: HTMLInputElement) =>
    visible(input) &&
    input.type === "password" &&
    ["", "current-password", "off"].includes(input.autocomplete);
  const semantics = (input: HTMLInputElement) =>
    JSON.stringify([
      input.type,
      input.name,
      input.id,
      input.autocomplete,
      input.labels?.[0]?.textContent ?? input.getAttribute("aria-label"),
    ]);
  if (request.operation === "prepare") {
    if (plans.size >= 32) return refused;
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(
      (input) => input instanceof HTMLInputElement && visible(input),
    );
    const password = passwords[0];
    if (
      passwords.length !== 1 ||
      !(password instanceof HTMLInputElement) ||
      !passwordAllowed(password) ||
      password.form === null
    )
      return refused;
    const users = [...password.form.querySelectorAll("input")].filter(
      (input) => input !== password && usernameAllowed(input),
    );
    const username = users[0];
    if (users.length !== 1 || !(username instanceof HTMLInputElement)) return refused;
    const action = new URL(password.form.action, location.href);
    if (
      password.form.method !== "post" ||
      !["", "_self"].includes(password.form.target) ||
      action.protocol !== "https:" ||
      action.username !== "" ||
      action.password !== ""
    )
      return refused;
    plans.set(request.planId, {
      document,
      username,
      password,
      form: password.form,
      submissionOrigin: action.origin,
      action: password.form.action,
      usernameSemantics: semantics(username),
      passwordSemantics: semantics(password),
      filled: false,
    });
    const label = (input: HTMLInputElement) =>
      (
        input.labels?.[0]?.textContent ??
        input.getAttribute("aria-label") ??
        input.name ??
        input.type
      ).slice(0, 128);
    return {
      status: "prepared",
      usernameLabel: label(username),
      passwordLabel: label(password),
      submissionOrigin: action.origin,
    };
  }
  const saved = plans.get(request.planId);
  if (
    saved === undefined ||
    saved.document !== document ||
    !saved.username.isConnected ||
    !saved.password.isConnected ||
    saved.username.form !== saved.form ||
    saved.password.form !== saved.form ||
    !usernameAllowed(saved.username) ||
    !passwordAllowed(saved.password) ||
    semantics(saved.username) !== saved.usernameSemantics ||
    semantics(saved.password) !== saved.passwordSemantics ||
    saved.form.action !== saved.action ||
    saved.form.method !== "post" ||
    !["", "_self"].includes(saved.form.target) ||
    new URL(saved.form.action, location.href).origin !== saved.submissionOrigin
  )
    return refused;
  if (request.operation === "validate") return { status: "valid" };
  if (request.operation === "submit") {
    if (!saved.filled) return refused;
    plans.delete(request.planId);
    saved.form.requestSubmit();
    return { status: "submitted" };
  }
  if (saved.filled) return refused;
  if (request.operation !== "fill" || request.values === undefined) return refused;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) return refused;
  try {
    setter.call(saved.username, request.values.username);
    setter.call(saved.password, request.values.password);
    for (const input of [saved.username, saved.password]) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    saved.filled = true;
    return { status: "filled" };
  } catch {
    for (const input of [saved.username, saved.password])
      if (input.isConnected && input.form === saved.form) setter.call(input, "");
    throw new Error("The selected login form could not be filled.");
  }
}
