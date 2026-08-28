#!/usr/bin/env bash
# Bring up a live session bus and unlocked Secret Service for headless ADE hosts.
#
# Intended as the Cloud Agent environment `start` command (or an equivalent
# host boot hook). Always probes the live bus; never treats a snapshotted
# DBUS_SESSION_BUS_ADDRESS as proof that Secret Service is available.
#
# On hosts without systemd --user (typical ADE containers), falls back to
# dbus-launch. Points the Secret Service `default` alias at the session
# collection so secret-tool does not block on a GUI unlock prompt.
set -euo pipefail

export PATH="${HOME}/.bun/bin:${HOME}/.local/bin:/usr/bin:/bin:${PATH}"

CONFIG_DIR="${HOME}/.config/octant-host"
SESSION_ENV="${CONFIG_DIR}/session.env"
PROBE_TIMEOUT_SEC="${OCTANT_SECRET_SERVICE_PROBE_TIMEOUT_SEC:-5}"
READY_ATTEMPTS="${OCTANT_SECRET_SERVICE_READY_ATTEMPTS:-50}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'octant ade: missing required command %s (run scripts/ade/install-linux-host-deps.sh)\n' "$1" >&2
    exit 1
  fi
}

require_command busctl
require_command dbus-launch
require_command gnome-keyring-daemon
require_command secret-tool
require_command timeout

bus_is_live() {
  [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]] \
    && busctl --user --no-pager status org.freedesktop.DBus >/dev/null 2>&1
}

secrets_is_live() {
  busctl --user --no-pager status org.freedesktop.secrets >/dev/null 2>&1
}

# Drop inherited or snapshotted addresses that do not answer.
if ! bus_is_live; then
  unset DBUS_SESSION_BUS_ADDRESS || true
  unset GNOME_KEYRING_CONTROL || true
  if [[ -S "/run/user/$(id -u)/bus" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
  fi
  if ! bus_is_live; then
    unset DBUS_SESSION_BUS_ADDRESS || true
    eval "$(dbus-launch --sh-syntax)"
  fi
fi

if ! bus_is_live; then
  printf 'octant ade: failed to obtain a live D-Bus session bus\n' >&2
  exit 1
fi

if ! secrets_is_live; then
  eval "$(gnome-keyring-daemon --start --components=secrets --daemonize)"
fi

attempt=0
while ! secrets_is_live; do
  attempt=$((attempt + 1))
  if [[ "${attempt}" -ge "${READY_ATTEMPTS}" ]]; then
    printf 'octant ade: Secret Service did not appear on the session bus\n' >&2
    exit 1
  fi
  sleep 0.1
done

# Headless hosts have no login keyring prompt. Alias default → session so
# secret-tool store/lookup returns instead of blocking on a GUI unlock.
busctl --user call org.freedesktop.secrets /org/freedesktop/secrets \
  org.freedesktop.Secret.Service SetAlias so default \
  /org/freedesktop/secrets/collection/session >/dev/null

mkdir -p "${CONFIG_DIR}"
{
  printf "export DBUS_SESSION_BUS_ADDRESS='%s'\n" "${DBUS_SESSION_BUS_ADDRESS}"
  if [[ -n "${GNOME_KEYRING_CONTROL:-}" ]]; then
    printf "export GNOME_KEYRING_CONTROL='%s'\n" "${GNOME_KEYRING_CONTROL}"
  fi
} > "${SESSION_ENV}"

# Prove store/read without a GUI before declaring the session ready.
probe_key="ade-boot-probe"
probe_value="ade-boot-probe-ok"
if ! printf '%s' "${probe_value}" | timeout "${PROBE_TIMEOUT_SEC}" \
  secret-tool store --label=octant-ade-boot-probe service octant key "${probe_key}"; then
  printf 'octant ade: secret-tool store blocked or failed (is a GUI unlock prompt pending?)\n' >&2
  exit 1
fi

got="$(timeout "${PROBE_TIMEOUT_SEC}" secret-tool lookup service octant key "${probe_key}" || true)"
timeout "${PROBE_TIMEOUT_SEC}" secret-tool clear service octant key "${probe_key}" >/dev/null 2>&1 || true
if [[ "${got}" != "${probe_value}" ]]; then
  printf 'octant ade: secret-tool lookup did not round-trip the probe secret\n' >&2
  exit 1
fi

printf 'octant ade: Secret Service session ready\n'
