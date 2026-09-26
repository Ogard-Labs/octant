#!/usr/bin/env bash
# Idempotent package and shell-hook setup for a headless Linux ADE host.
# Safe to run from Cloud Agent install. Does not start D-Bus or Secret Service;
# that belongs in start-secret-service-session.sh on every boot.
set -euo pipefail

export PATH="${HOME}/.bun/bin:${HOME}/.local/bin:${PATH}"
mkdir -p "${HOME}/.local/bin" "${HOME}/.config/octant-host"

need_apt=0
for cmd in bwrap secret-tool gnome-keyring-daemon dbus-launch zsh; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    need_apt=1
    break
  fi
done

if [[ "${need_apt}" -eq 1 ]]; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bubblewrap \
    libsecret-tools \
    gnome-keyring \
    dbus-x11 \
    dbus-user-session \
    zsh
fi

# `git worktree list --porcelain -z` needs Git 2.36; Ubuntu 22.04 ships 2.34,
# so stock hosts must take git from the git-core PPA.
git_version_ok() {
  local version major minor
  version=$(git --version 2>/dev/null) || return 1
  version=${version#git version }
  major=${version%%.*}
  minor=${version#*.}
  minor=${minor%%.*}
  [[ "${major}" =~ ^[0-9]+$ && "${minor}" =~ ^[0-9]+$ ]] || return 1
  (( major > 2 || (major == 2 && minor >= 36) ))
}

if ! git_version_ok && command -v apt-get >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    software-properties-common
  sudo add-apt-repository -y ppa:git-core/ppa
  sudo DEBIAN_FRONTEND=noninteractive apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git
fi

if ! git_version_ok; then
  echo "git >= 2.36 is required (found $(git --version 2>/dev/null || echo 'git not installed'))" >&2
  exit 1
fi

# Shell hooks load the live session address written by the start script.
# A snapshotted socket path is never trusted: bashrc clears it when the bus is dead.
cat > "${HOME}/.config/octant-host/bashrc.sh" << 'EOF'
export PATH="${HOME}/.bun/bin:${HOME}/.local/bin:${PATH}"
if [[ -f "${HOME}/.config/octant-host/session.env" ]]; then
  # shellcheck disable=SC1091
  . "${HOME}/.config/octant-host/session.env"
  if ! busctl --user --no-pager status org.freedesktop.DBus >/dev/null 2>&1; then
    unset DBUS_SESSION_BUS_ADDRESS
    unset GNOME_KEYRING_CONTROL
  fi
fi
EOF

append_once() {
  local file=$1
  local line=$2
  if [[ ! -f "${file}" ]] || ! grep -Fqx "${line}" "${file}"; then
    printf '%s\n' "${line}" >> "${file}"
  fi
}

append_once "${HOME}/.bashrc" \
  '[ -f "${HOME}/.config/octant-host/bashrc.sh" ] && . "${HOME}/.config/octant-host/bashrc.sh"'
append_once "${HOME}/.profile" \
  '[ -f "${HOME}/.config/octant-host/bashrc.sh" ] && . "${HOME}/.config/octant-host/bashrc.sh"'
