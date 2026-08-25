# Octant domain language

Octant separates the device a person controls from, the machine that owns
their work, and the isolated places where that work executes.

## Control and ownership

**Device**:
A phone, browser, laptop, or desktop app used to control Octant work.
_Avoid_: Host, environment

**Machine**:
A computer that owns Octant threads, data, credentials, and execution.
_Avoid_: Device, environment

**This Mac**:
The local desktop Machine running the current Octant app.
_Avoid_: Local device

**Remote Mac**:
Another paired macOS Machine.
_Avoid_: Remote device

**Station**:
A persistent headless Linux Machine.
_Avoid_: Cloud, server container, orb

## Thread execution

**Environment**:
The thread's current execution context and status summary.
_Avoid_: Machine, Station

**Execution capsule**:
A protected coding environment owned by one Code thread or one writing child
AgentRun.
_Avoid_: Worktree, session, environment

**Disposable Desktop**:
A temporary interactive desktop leased by one thread for graphical testing and
shared agent or user control.
_Avoid_: Station, execution capsule
