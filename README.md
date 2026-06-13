# Codex Mod

Small macOS patcher for the Codex Desktop app.

Current mod:

- forces the desktop app-server sidecar to start with global `model_context_window=1000000`
- sets `model_auto_compact_token_limit=900000`
- backs up `app.asar`
- repacks Electron ASAR cleanly
- updates Electron ASAR integrity in `Info.plist`
- ad-hoc signs the app after patching
- can install a LaunchAgent that reapplies after Codex Desktop updates
- cleanly restarts Codex Desktop when stale app-server args are running

The launch args become:

```bash
codex app-server --analytics-default-enabled \
  -cmodel_context_window=1000000 \
  -cmodel_auto_compact_token_limit=900000
```

This is not tied to a single model slug. Codex applies `model_context_window` as a global config override to the selected model at runtime, so every local Codex Desktop thread/model launched through the patched desktop app-server gets the override. The model/provider still has to actually support the requested window.

## One-Liners

Apply once and restart Codex Desktop if needed:

```bash
curl -fsSL https://raw.githubusercontent.com/companion-inc/codex-mod/main/install.sh | bash -s -- apply
```

Apply now, restart Codex Desktop if needed, and auto-reapply after app updates:

```bash
curl -fsSL https://raw.githubusercontent.com/companion-inc/codex-mod/main/install.sh | bash -s -- install-agent
```

Check status:

```bash
~/.codex/codex-mod/install.sh status
```

Restore the newest saved `app.asar` backup:

```bash
~/.codex/codex-mod/install.sh restore
```

Remove the auto-reapply LaunchAgent:

```bash
~/.codex/codex-mod/install.sh uninstall-agent
```

## Notes

Already-running app-server processes keep their old command-line args, so Codex Mod schedules a clean Codex Desktop quit/reopen after applying when stale args are detected.

The auto-reapply agent is idempotent. If the desired patch is already present, ASAR integrity matches, and codesign verifies, it exits without rewriting the app.
