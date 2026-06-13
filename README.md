# Codex Mod

Small macOS patcher for the Codex Desktop app.

Current mod:

- forces the desktop app-server sidecar to start with `model_context_window=1000000`
- sets `model_auto_compact_token_limit=900000`
- backs up `app.asar`
- repacks Electron ASAR cleanly
- updates Electron ASAR integrity in `Info.plist`
- ad-hoc signs the app after patching
- can install a LaunchAgent that reapplies after Codex Desktop updates

The launch args become:

```bash
codex app-server --analytics-default-enabled \
  -cmodel_context_window=1000000 \
  -cmodel_auto_compact_token_limit=900000
```

## One-Liners

Apply once:

```bash
curl -fsSL https://raw.githubusercontent.com/companion-inc/codex-mod/main/install.sh | bash -s -- apply
```

Apply now and auto-reapply after app updates:

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

Codex Desktop needs to be restarted after patching. Already-running app-server processes keep their old command-line args.

The auto-reapply agent is idempotent. If the desired patch is already present, ASAR integrity matches, and codesign verifies, it exits without rewriting the app.
