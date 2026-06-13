#!/usr/bin/env bash
set -euo pipefail

REPO="${CODEX_1M_REPO:-companion-inc/codex-1m}"
REF="${CODEX_1M_REF:-main}"
RAW_BASE="${CODEX_1M_RAW_BASE:-}"
INSTALL_DIR="${CODEX_1M_HOME:-${HOME}/.codex/codex-1m}"
INSTALLER="${INSTALL_DIR}/install.sh"
PATCHER="${INSTALL_DIR}/codex-1m.js"
PLIST="${HOME}/Library/LaunchAgents/ai.companion.codex-1m.plist"
OLD_PLISTS=(
  "${HOME}/Library/LaunchAgents/com.companion.codex-1m.plist"
  "${HOME}/Library/LaunchAgents/com.companion.codex-mod.plist"
  "${HOME}/Library/LaunchAgents/com.advait.codex-desktop-1m.plist"
)
LOG_DIR="${HOME}/Library/Logs/codex-1m"
APP_ASAR="/Applications/Codex.app/Contents/Resources/app.asar"
NODE_BIN="${CODEX_1M_NODE:-$(command -v node)}"

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
usage: install.sh [apply|status|install-agent|uninstall-agent]

apply           Install/update Codex 1M, apply the 1M patch, and restart Codex if needed.
status          Show patch, ASAR integrity, and codesign status.
install-agent   Apply now and install a LaunchAgent to reapply after app updates.
uninstall-agent Remove the LaunchAgent.
EOF
}

install_patcher() {
  mkdir -p "${INSTALL_DIR}"
  local download_base=""
  local source_dir
  local local_patcher
  local local_installer
  local bash_source
  bash_source="${BASH_SOURCE[0]:-}"
  if [[ -n "${bash_source}" ]]; then
    source_dir="$(cd "$(dirname "${bash_source}")" 2>/dev/null && pwd -P || true)"
  else
    source_dir=""
  fi
  local_installer="${source_dir}/install.sh"
  local_patcher="${source_dir}/codex-1m.js"
  if [[ -n "${source_dir}" && -f "${local_installer}" ]]; then
    if [[ "${local_installer}" != "${INSTALLER}" ]]; then
      cp "${local_installer}" "${INSTALLER}"
    fi
  else
    download_base="${download_base:-$(raw_base)}"
    curl -fsSL "${download_base}/install.sh" -o "${INSTALLER}"
  fi
  if [[ -n "${source_dir}" && -f "${local_patcher}" ]]; then
    if [[ "${local_patcher}" != "${PATCHER}" ]]; then
      cp "${local_patcher}" "${PATCHER}"
    fi
  else
    download_base="${download_base:-$(raw_base)}"
    curl -fsSL "${download_base}/codex-1m.js" -o "${PATCHER}"
  fi
  chmod +x "${INSTALLER}" "${PATCHER}"
}

cleanup_old_installs() {
  for old_plist in "${OLD_PLISTS[@]}"; do
    launchctl unload "${old_plist}" >/dev/null 2>&1 || true
    rm -f "${old_plist}"
  done
}

apply_patch() {
  install_patcher
  cleanup_old_installs
  "${NODE_BIN}" "${PATCHER}" apply-auto
}

status_patch() {
  install_patcher
  "${PATCHER}" status
}

install_agent() {
  apply_patch
  mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"
  cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.companion.codex-1m</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PATCHER}</string>
    <string>apply-auto</string>
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
  echo "installed Codex 1M auto-reapply job: ${PLIST}"
}

uninstall_agent() {
  launchctl unload "${PLIST}" >/dev/null 2>&1 || true
  cleanup_old_installs
  rm -f "${PLIST}"
  echo "removed Codex 1M auto-reapply job: ${PLIST}"
}

command="${1:-apply}"
case "${command}" in
  apply)
    apply_patch
    ;;
  status)
    status_patch
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
