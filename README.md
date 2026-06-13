# Codex 1M

macOS patcher for making Codex Desktop run local threads with a 1M-token context window.

What it does:

- starts the Codex Desktop `app-server` with `model_context_window=1000000`
- sets `model_auto_compact_token_limit=900000`
- writes `~/.codex/codex-1m/model_catalog_1m.json`
- rewrites every model in that catalog to a visible/effective 1M context window
- migrates old local rollout files so reopened threads do not keep stale `258400` context metadata
- removes stale "full context" token markers from old context-window failures
- repacks `app.asar` in place using a temporary file
- updates Electron ASAR integrity in `Info.plist`
- ad-hoc signs the patched app
- force-restarts Codex Desktop and kills every Desktop `app-server` sidecar
- installs the `Codex 1M auto-reapply job` LaunchAgent for app updates

The LaunchAgent is:

```text
~/Library/LaunchAgents/ai.companion.codex-1m.plist
```

with launchd label:

```text
ai.companion.codex-1m
```

Logs go to:

```text
~/Library/Logs/codex-1m/
```

## One-Liners

Apply once and force-restart Codex Desktop:

```bash
curl -fsSL https://raw.githubusercontent.com/companion-inc/codex-1m/main/install.sh | bash -s -- apply
```

Apply now and auto-reapply after app updates:

```bash
curl -fsSL https://raw.githubusercontent.com/companion-inc/codex-1m/main/install.sh | bash -s -- install-agent
```

Check status:

```bash
~/.codex/codex-1m/install.sh status
```

Remove the auto-reapply job:

```bash
~/.codex/codex-1m/install.sh uninstall-agent
```

## Notes

The launch args become:

```bash
codex app-server --analytics-default-enabled \
  -c model_context_window=1000000 \
  -c model_auto_compact_token_limit=900000 \
  -c 'model_catalog_json="/Users/you/.codex/codex-1m/model_catalog_1m.json"'
```

This patches local Codex metadata and UI behavior for all local Desktop threads/models launched through the patched app-server. The model/provider still has to actually accept the requested window.
