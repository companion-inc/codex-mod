#!/usr/bin/env bash
set -euo pipefail

REPO="${CODEX_MOD_REPO:-companion-inc/codex-mod}"
REF="${CODEX_MOD_REF:-main}"
RAW_BASE="${CODEX_MOD_RAW_BASE:-}"
INSTALL_DIR="${CODEX_MOD_HOME:-${HOME}/.codex/codex-mod}"
INSTALLER="${INSTALL_DIR}/install.sh"
PATCHER="${INSTALL_DIR}/codex-mod.js"
PLIST="${HOME}/Library/LaunchAgents/com.companion.codex-mod.plist"
OLD_PLIST="${HOME}/Library/LaunchAgents/com.advait.codex-desktop-1m.plist"
LOG_DIR="${HOME}/Library/Logs/codex-mod"
APP_ASAR="/Applications/Codex.app/Contents/Resources/app.asar"
NODE_BIN="${CODEX_MOD_NODE:-$(command -v node)}"

raw_base() {
  if [[ -n "${RAW_BASE}" ]]; then
    printf '%s\n' "${RAW_BASE}"
    return
  fi

  local resolved_ref="${REF}"
  if [[ ! "${REF}" =~ ^[0-9a-f]{40}$ ]]; then
    resolved_ref="$(
      curl -fsSL "https://api.github.com/repos/${REPO}/commits/${REF}" \
        | sed -n 's/^[[:space:]]*"sha": "\([0-9a-f]\{40\}\)",$/\1/p' \
        | head -n 1
    )"
  fi
  if [[ -z "${resolved_ref}" ]]; then
    resolved_ref="${REF}"
  fi
  printf 'https://raw.githubusercontent.com/%s/%s\n' "${REPO}" "${resolved_ref}"
}

usage() {
  cat <<EOF
usage: install.sh [apply|status|restore|install-agent|uninstall-agent]

apply           Install/update Codex Mod, apply the 1M patch, and restart Codex if needed.
status          Show patch, ASAR integrity, and codesign status.
restore         Restore the newest saved app.asar backup.
install-agent   Apply now and install a LaunchAgent to reapply after app updates.
uninstall-agent Remove the LaunchAgent.
EOF
}

install_patcher() {
  mkdir -p "${INSTALL_DIR}"
  local download_base
  local source_dir
  local local_patcher
  local local_installer
  local bash_source
  download_base="$(raw_base)"
  bash_source="${BASH_SOURCE[0]:-}"
  if [[ -n "${bash_source}" ]]; then
    source_dir="$(cd "$(dirname "${bash_source}")" 2>/dev/null && pwd -P || true)"
  else
    source_dir=""
  fi
  local_installer="${source_dir}/install.sh"
  local_patcher="${source_dir}/codex-mod.js"
  if [[ -n "${source_dir}" && -f "${local_installer}" ]]; then
    if [[ "${local_installer}" != "${INSTALLER}" ]]; then
      cp "${local_installer}" "${INSTALLER}"
    fi
  else
    curl -fsSL "${download_base}/install.sh" -o "${INSTALLER}"
  fi
  if [[ -n "${source_dir}" && -f "${local_patcher}" ]]; then
    if [[ "${local_patcher}" != "${PATCHER}" ]]; then
      cp "${local_patcher}" "${PATCHER}"
    fi
  else
    curl -fsSL "${download_base}/codex-mod.js" -o "${PATCHER}"
  fi
  chmod +x "${INSTALLER}" "${PATCHER}"
}

apply_patch() {
  install_patcher
  "${NODE_BIN}" "${PATCHER}" apply-and-restart
}

status_patch() {
  install_patcher
  "${PATCHER}" status
}

restore_patch() {
  install_patcher
  "${PATCHER}" restore
}

install_agent() {
  apply_patch
  mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"
  launchctl unload "${OLD_PLIST}" >/dev/null 2>&1 || true
  rm -f "${OLD_PLIST}"
  cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.companion.codex-mod</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PATCHER}</string>
    <string>apply-and-restart</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>1800</integer>
  <key>WatchPaths</key>
  <array>
    <string>${APP_ASAR}</string>
  </array>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/launchagent.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/launchagent.err.log</string>
</dict>
</plist>
EOF
  launchctl unload "${PLIST}" >/dev/null 2>&1 || true
  launchctl load "${PLIST}"
  echo "installed LaunchAgent: ${PLIST}"
}

uninstall_agent() {
  launchctl unload "${PLIST}" >/dev/null 2>&1 || true
  launchctl unload "${OLD_PLIST}" >/dev/null 2>&1 || true
  rm -f "${PLIST}"
  rm -f "${OLD_PLIST}"
  echo "removed LaunchAgent: ${PLIST}"
}

command="${1:-apply}"
case "${command}" in
  apply)
    apply_patch
    ;;
  status)
    status_patch
    ;;
  restore)
    restore_patch
    ;;
  install-agent|auto)
    install_agent
    ;;
  uninstall-agent)
    uninstall_agent
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
