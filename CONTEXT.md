# Octant domain language

Octant separates the device a person controls from the host that owns their
work, and the isolated places where that work executes. These terms follow the
codebase (`HostId`, `@octant/host-runtime`, `HostSelector`); a few older
comments and messages still say "Machine" for a host.

## Control and ownership

**Device**:
A phone, browser, laptop, or desktop app used to control one host. Device
type, renderer mode, and development tooling use the canonical host and
authoritative store by default; an explicitly named isolated data directory is
the documented exception.
_Avoid_: Host, environment

**Host**:
A computer with one canonical Octant identity and authoritative store that owns
Projects, threads, credentials, and execution for every connected Device.
_Avoid_: Device, environment, Machine (in new code and copy)

**Client context**:
A Device-local presentation context such as its active panes, layout, focus,
and unsaved drafts. It never owns or partitions Projects, threads, or history.
_Avoid_: Host, Project

**This Mac**:
The label for the local desktop host running the current Octant app.
_Avoid_: Local device

**Remote host**:
Another paired host.
_Avoid_: Remote device

**Station**:
A persistent headless Linux host. Not built: the isolation tracer names it, but
no Station is provisioned or shown in navigation.
_Avoid_: Cloud, server container, orb

## Places work lives

**Default folder**:
The one host-wide folder Octant uses for anything nobody gave a home: the
default Projects of Work and Code, and mirrored artifact files.
_Avoid_: Octant folder, home, scratch, projectless folder

**Default Project**:
The Work or Code Project the host provisions under the default folder so a
thread can start without a chosen Project. An ordinary Project in every other
respect.
_Avoid_: Rootless thread, unfiled thread, projectless thread, quick task

**Plain folder**:
A Code checkout that is the bound folder itself, with no Git repository behind
it and therefore no revision. Allowed only when the Git requirement is off.
_Avoid_: Unborn checkout, detached folder, non-repo worktree

**Project status**:
The `STATUS.md` at the top of a Work Project folder that opted into a status
file: where the work stands, with dated follow-ups and deadlines. The agent
keeps it; Octant reads it into every task and backfills only what changed. Off
by default and never offered for the default folder.
_Avoid_: Memory, summary, changelog, Project brief

**Resume brief**:
The instruction a Work task opens with when the Project status is stale or a
date is near: take stock, ask what happened, update the status, then proceed.
_Avoid_: Reminder, digest, catch-up

## Thread execution

**Environment**:
The thread's current execution context and status summary.
_Avoid_: Host, Station

**Execution capsule**:
A protected coding environment owned by one Code thread or one writing child
AgentRun. Not built into threads: a tracer service exists
(`apps/server/src/executionCapsule/`), but no thread runs in one yet.
_Avoid_: Worktree, session, environment

**Disposable Desktop**:
A temporary interactive desktop leased by one thread for graphical testing and
shared agent or user control. Not built.
_Avoid_: Station, execution capsule
