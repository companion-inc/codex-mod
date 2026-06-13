#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const appRoot = process.env.CODEX_APP_ROOT || "/Applications/Codex.app";
const resourcesDir = path.join(appRoot, "Contents", "Resources");
const asarPath = path.join(resourcesDir, "app.asar");
const infoPlistPath = path.join(appRoot, "Contents", "Info.plist");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const installDir = process.env.CODEX_1M_HOME || path.join(codexHome, "codex-1m");
const legacyInstallDir = path.join(codexHome, "codex-mod");
const modelsCachePath = path.join(codexHome, "models_cache.json");
const sessionsDir = path.join(codexHome, "sessions");
const archivedSessionsDir = path.join(codexHome, "archived_sessions");
const sessionDirs = [sessionsDir, archivedSessionsDir];
const stateDbPaths = [
  path.join(codexHome, "state_5.sqlite"),
  path.join(codexHome, "sqlite", "state_5.sqlite"),
];
const modelCatalogPath = path.join(installDir, "model_catalog_1m.json");
const legacyModelCatalogPath = path.join(legacyInstallDir, "model_catalog_1m.json");
const sessionMigrationMarkerPath = path.join(installDir, "session-migration-v3.done");
const contextWindowTokens = 1_000_000;
const autoCompactTokenLimit = 900_000;
const modelCatalogOverride = `model_catalog_json=${JSON.stringify(modelCatalogPath)}`;
const patchedArgsList = [
  "app-server",
  "--analytics-default-enabled",
  "-c",
  `model_context_window=${contextWindowTokens}`,
  "-c",
  `model_auto_compact_token_limit=${autoCompactTokenLimit}`,
  "-c",
  modelCatalogOverride,
];
const patchedArgs =
  `args:[${patchedArgsList.map((arg) => `\`${escapeTemplateLiteralArg(arg)}\``).join(",")}]`;
const appServerArgsPattern = /args:\[`app-server`,`--analytics-default-enabled`(?:,`[^`]*`)*\]/g;
const uiTokenLabelHelper =
  "function __codex1mTokenLabel(e){if(e==null||!Number.isFinite(e))return null;let t=Math.max(0,e);if(t>=999500){let e=Math.round(t/100000)/10;return (Number.isInteger(e)?String(e):e.toFixed(1))+`M`}return Math.round(t/1000)+`k`}";
const uiContextUsageFunctionNeedle = "function _m(e){let t=(0,$.c)(30),{contextUsage:n}=e";
const uiContextUsageTooltipNeedle =
  "defaultMessage:`{usedTokens}k / {contextWindow}k tokens used`";
const uiContextUsageTooltipReplacement =
  "defaultMessage:`{usedTokens} / {contextWindow} tokens used`";
const uiContextUsageValuesNeedle =
  "values:{contextWindow:(0,Q.jsx)(Ht,{value:d}),usedTokens:(0,Q.jsx)(Ht,{value:l})}";
const uiContextUsageValuesReplacement =
  "values:{contextWindow:__codex1mTokenLabel(n.contextWindow),usedTokens:__codex1mTokenLabel(n.usedTokens)}";
const patchMarker = modelCatalogOverride;
const blockSize = 4 * 1024 * 1024;
const sqliteBin = process.env.CODEX_1M_SQLITE || "/usr/bin/sqlite3";

function escapeTemplateLiteralArg(value) {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function readAsar(filePath) {
  const buffer = fs.readFileSync(filePath);
  const headerSize = buffer.readUInt32LE(4);
  const jsonLength = buffer.readUInt32LE(12);
  const headerJson = buffer.subarray(16, 16 + jsonLength).toString("utf8");
  return {
    buffer,
    dataOffset: 8 + headerSize,
    header: JSON.parse(headerJson),
  };
}

function walk(node, visitor, currentPath = "") {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const childPath = `${currentPath}/${name}`;
    if (entry.files) {
      walk(entry, visitor, childPath);
    } else {
      visitor(childPath, entry);
    }
  }
}

function integrityFor(data) {
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += blockSize) {
    blocks.push(
      crypto
        .createHash("sha256")
        .update(data.subarray(offset, offset + blockSize))
        .digest("hex"),
    );
  }
  return {
    algorithm: "SHA256",
    hash: crypto.createHash("sha256").update(data).digest("hex"),
    blockSize,
    blocks,
  };
}

function makeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const paddingLength = (4 - ((4 + json.length) % 4)) % 4;
  const headerPayloadSize = 4 + json.length + paddingLength;
  const headerSize = 4 + headerPayloadSize;
  const out = Buffer.alloc(16 + json.length + paddingLength);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerSize, 4);
  out.writeUInt32LE(headerPayloadSize, 8);
  out.writeUInt32LE(json.length, 12);
  json.copy(out, 16);
  return out;
}

function removeStaleCopies() {
  for (const staleDir of [
    path.join(installDir, "app-asar-backups"),
    path.join(installDir, "app-asar-restore-points"),
    path.join(installDir, "session-backups"),
    path.join(installDir, "session-restore-points"),
  ]) {
    fs.rmSync(staleDir, { recursive: true, force: true });
  }

  for (const name of fs.readdirSync(resourcesDir)) {
    if (!name.startsWith("app.asar.codex-1m-backup-")) {
      continue;
    }
    fs.rmSync(path.join(resourcesDir, name), { force: true });
    console.log(`removed stale in-bundle app.asar copy: ${name}`);
  }
}

function isPackedJsFile(filePath, entry) {
  return !entry.unpacked && entry.offset != null && filePath.endsWith(".js");
}

function asarHash() {
  return crypto.createHash("sha256").update(fs.readFileSync(asarPath)).digest("hex");
}

function plistAsarHash() {
  try {
    return require("child_process")
      .execFileSync(
        "/usr/libexec/PlistBuddy",
        ["-c", "Print :ElectronAsarIntegrity:Resources/app.asar:hash", infoPlistPath],
        { encoding: "utf8" },
      )
      .trim();
  } catch {
    return null;
  }
}

function verifyAppQuiet() {
  try {
    require("child_process").execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", appRoot],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function readSourceModelCatalog() {
  if (fs.existsSync(modelsCachePath)) {
    return JSON.parse(fs.readFileSync(modelsCachePath, "utf8"));
  }

  const codexBin = path.join(resourcesDir, "codex");
  const output = require("child_process").execFileSync(codexBin, ["debug", "models"], {
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function sourceModelsFromCatalog(catalog) {
  const models = Array.isArray(catalog) ? catalog : catalog?.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("source model catalog does not contain any models");
  }
  return models;
}

function modelWithOneMillionContext(model) {
  return {
    ...model,
    context_window: contextWindowTokens,
    max_context_window: contextWindowTokens,
    auto_compact_token_limit: autoCompactTokenLimit,
    effective_context_window_percent: 100,
  };
}

function writeModelCatalog() {
  fs.mkdirSync(installDir, { recursive: true });
  const sourceCatalog = readSourceModelCatalog();
  const models = sourceModelsFromCatalog(sourceCatalog).map(modelWithOneMillionContext);
  fs.writeFileSync(modelCatalogPath, `${JSON.stringify({ models }, null, 2)}\n`);
  writeLegacyModelCatalogCompatibility();
  console.log(
    `model catalog: ${modelCatalogPath} (${models.length} model(s), ${contextWindowTokens} context)`,
  );
}

function writeLegacyModelCatalogCompatibility() {
  try {
    if (fs.existsSync(legacyInstallDir) && !fs.statSync(legacyInstallDir).isDirectory()) {
      fs.rmSync(legacyInstallDir, { force: true });
    }
    fs.mkdirSync(legacyInstallDir, { recursive: true });
    fs.rmSync(legacyModelCatalogPath, { force: true });
    fs.symlinkSync(path.relative(legacyInstallDir, modelCatalogPath), legacyModelCatalogPath);
  } catch (error) {
    fs.mkdirSync(legacyInstallDir, { recursive: true });
    fs.copyFileSync(modelCatalogPath, legacyModelCatalogPath);
    console.log(`legacy model catalog compatibility copied after symlink failed: ${error.message}`);
  }
}

function modelCatalogIsCurrent() {
  try {
    const catalog = JSON.parse(fs.readFileSync(modelCatalogPath, "utf8"));
    const models = sourceModelsFromCatalog(catalog);
    return models.every(
      (model) =>
        model.context_window === contextWindowTokens &&
        model.max_context_window === contextWindowTokens &&
        model.auto_compact_token_limit === autoCompactTokenLimit &&
        model.effective_context_window_percent === 100,
    );
  } catch {
    return false;
  }
}

function walkFiles(root, visitor) {
  if (!fs.existsSync(root)) {
    return;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, visitor);
    } else if (entry.isFile()) {
      visitor(entryPath);
    }
  }
}

function threadIdFromRolloutPath(filePath) {
  const match = path.basename(filePath).match(
    /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/,
  );
  return match ? match[1] : null;
}

function isFullContextSyntheticTokenInfo(info) {
  const total = info?.total_token_usage;
  const last = info?.last_token_usage;
  const contextWindow = info?.model_context_window;
  if (!total || !last || !Number.isFinite(contextWindow)) {
    return false;
  }

  return (
    total.total_tokens === contextWindow &&
    total.input_tokens === 0 &&
    total.cached_input_tokens === 0 &&
    total.output_tokens === 0 &&
    total.reasoning_output_tokens === 0 &&
    last.input_tokens === 0 &&
    last.cached_input_tokens === 0 &&
    last.output_tokens === 0 &&
    last.reasoning_output_tokens === 0
  );
}

function rewriteSessionLine(line) {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    return { line, changed: false, dropped: false };
  }

  const payload = item?.payload;
  if (item?.type !== "event_msg" || !payload) {
    return { line, changed: false, dropped: false };
  }

  if (payload.type === "task_started") {
    if (payload.model_context_window !== contextWindowTokens) {
      payload.model_context_window = contextWindowTokens;
      return { line: JSON.stringify(item), changed: true, dropped: false };
    }
    return { line, changed: false, dropped: false };
  }

  if (payload.type === "token_count" && payload.info) {
    if (isFullContextSyntheticTokenInfo(payload.info)) {
      return { line: "", changed: true, dropped: true };
    }
    let changed = false;
    if (payload.info.model_context_window !== contextWindowTokens) {
      payload.info.model_context_window = contextWindowTokens;
      changed = true;
    }
    if (changed) {
      return { line: JSON.stringify(item), changed: true, dropped: false };
    }
  }

  return { line, changed: false, dropped: false };
}

function migrateSessionRolloutFile(filePath) {
  if (!filePath.endsWith(".jsonl")) {
    return { changed: false, droppedFullMarkers: 0, threadId: null, lastTokenTotal: null };
  }

  const threadId = threadIdFromRolloutPath(filePath);
  const original = fs.readFileSync(filePath, "utf8");
  const hasTrailingNewline = original.endsWith("\n");
  const lines = original.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }

  let changed = false;
  let droppedFullMarkers = 0;
  let lastTokenTotal = null;
  const nextLines = [];
  for (const line of lines) {
    if (line.trim() === "") {
      nextLines.push(line);
      continue;
    }
    const rewritten = rewriteSessionLine(line);
    if (rewritten.changed) {
      changed = true;
    }
    if (rewritten.dropped) {
      droppedFullMarkers += 1;
      continue;
    }
    nextLines.push(rewritten.line);
    try {
      const item = JSON.parse(rewritten.line);
      const info = item?.payload?.type === "token_count" ? item.payload.info : null;
      const totalTokens = info?.total_token_usage?.total_tokens;
      if (Number.isFinite(totalTokens)) {
        lastTokenTotal = Math.max(0, Math.trunc(totalTokens));
      }
    } catch {
      // Ignore malformed historical lines; Codex ignores them during replay too.
    }
  }

  if (!changed) {
    return { changed: false, droppedFullMarkers: 0, threadId, lastTokenTotal };
  }

  const next = `${nextLines.join("\n")}${hasTrailingNewline ? "\n" : ""}`;
  const tempPath = `${filePath}.codex-1m-tmp-${process.pid}`;
  fs.writeFileSync(tempPath, next);
  fs.renameSync(tempPath, filePath);
  return { changed: true, droppedFullMarkers, threadId, lastTokenTotal };
}

function migrateSessionRollouts(options = {}) {
  const threadIds = options.threadIds || null;
  let scanned = 0;
  let changed = 0;
  let droppedFullMarkers = 0;
  const tokenTotalsByThread = new Map();

  for (const sessionDir of sessionDirs) {
    walkFiles(sessionDir, (filePath) => {
      if (!filePath.endsWith(".jsonl")) {
        return;
      }
      const threadId = threadIdFromRolloutPath(filePath);
      if (threadIds && (!threadId || !threadIds.has(threadId))) {
        return;
      }
      scanned += 1;
      const result = migrateSessionRolloutFile(filePath);
      if (result.changed) {
        changed += 1;
        droppedFullMarkers += result.droppedFullMarkers;
      }
      if (result.threadId && Number.isFinite(result.lastTokenTotal)) {
        tokenTotalsByThread.set(result.threadId, result.lastTokenTotal);
      }
    });
  }

  if (changed === 0) {
    console.log(`session rollout migration: ${scanned} file(s) scanned, nothing to update`);
  } else {
    console.log(
      `session rollout migration: ${changed}/${scanned} file(s) updated, ${droppedFullMarkers} full-context marker(s) removed`,
    );
  }

  return tokenTotalsByThread;
}

function fullSessionMigrationDone() {
  return fs.existsSync(sessionMigrationMarkerPath);
}

function writeSessionMigrationMarker() {
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(sessionMigrationMarkerPath, `${new Date().toISOString()}\n`);
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sqliteBackupPath(dbPath) {
  const backupDir = path.join(installDir, "state-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(backupDir, `${path.basename(dbPath)}.${stamp}.bak`);
}

function backupSqliteDatabase(dbPath) {
  const backupPath = sqliteBackupPath(dbPath);
  require("child_process").execFileSync(sqliteBin, [dbPath, `.backup ${backupPath}`], {
    stdio: "ignore",
  });
  return backupPath;
}

function updateStateDatabaseTokenMetadata(tokenTotalsByThread) {
  const entries = [...tokenTotalsByThread.entries()].filter(
    ([threadId, total]) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(threadId) &&
      Number.isFinite(total) &&
      total >= 0,
  );

  if (entries.length === 0) {
    console.log("state DB token metadata: no rollout token totals found");
    return;
  }

  for (const dbPath of stateDbPaths) {
    if (!fs.existsSync(dbPath)) {
      continue;
    }

    const backupPath = backupSqliteDatabase(dbPath);
    const sql = [
      "PRAGMA busy_timeout=5000;",
      "BEGIN IMMEDIATE;",
      "CREATE TEMP TABLE codex_1m_thread_tokens(id TEXT PRIMARY KEY, tokens INTEGER NOT NULL);",
    ];
    for (const [threadId, total] of entries) {
      sql.push(
        `INSERT OR REPLACE INTO codex_1m_thread_tokens(id, tokens) VALUES (${sqlString(threadId)}, ${Math.trunc(total)});`,
      );
    }
    sql.push(
      [
        "UPDATE threads",
        "SET tokens_used = (SELECT tokens FROM codex_1m_thread_tokens WHERE id = threads.id)",
        "WHERE id IN (SELECT id FROM codex_1m_thread_tokens)",
        "  AND tokens_used != (SELECT tokens FROM codex_1m_thread_tokens WHERE id = threads.id);",
        "SELECT changes();",
        "DROP TABLE codex_1m_thread_tokens;",
        "COMMIT;",
      ].join("\n"),
    );

    const output = require("child_process").execFileSync(sqliteBin, [dbPath], {
      input: `${sql.join("\n")}\n`,
      encoding: "utf8",
    });
    const changedRows = output
      .trim()
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter(Number.isFinite)
      .at(-1);
    console.log(
      `state DB token metadata: ${dbPath} (${changedRows ?? 0} row(s) updated, backup ${backupPath})`,
    );
  }
}

function status() {
  const currentAsarHash = asarHash();
  const currentPlistHash = plistAsarHash();
  const desiredPatch = hasPatch();
  const anyContextPatch = hasAnyContextPatch();
  const modelCatalogCurrent = modelCatalogIsCurrent();
  const integrityMatches = currentPlistHash === currentAsarHash;
  const signatureValid = verifyAppQuiet();
  return {
    anyContextPatch,
    desiredPatch,
    integrityMatches,
    modelCatalogCurrent,
    signatureValid,
    fullyApplied: desiredPatch && modelCatalogCurrent && integrityMatches && signatureValid,
    asarHash: currentAsarHash,
    plistAsarHash: currentPlistHash,
  };
}

function printStatus() {
  const current = status();
  console.log(`desired patch: ${current.desiredPatch ? "yes" : "no"}`);
  console.log(`any context patch: ${current.anyContextPatch ? "yes" : "no"}`);
  console.log(`1m model catalog: ${current.modelCatalogCurrent ? "yes" : "no"}`);
  console.log(`asar integrity matches: ${current.integrityMatches ? "yes" : "no"}`);
  console.log(`codesign valid: ${current.signatureValid ? "yes" : "no"}`);
  console.log(`fully applied: ${current.fullyApplied ? "yes" : "no"}`);
  console.log(`model catalog path: ${modelCatalogPath}`);
  console.log(`asar sha256: ${current.asarHash}`);
  console.log(`plist asar sha256: ${current.plistAsarHash ?? "missing"}`);
}

function hasPatch() {
  const archive = readAsar(asarPath);
  let foundLaunchPatch = false;
  let foundUiPatch = false;
  walk(archive.header, (filePath, entry) => {
    if ((foundLaunchPatch && foundUiPatch) || !isPackedJsFile(filePath, entry)) {
      return;
    }
    const data = archive.buffer.subarray(
      archive.dataOffset + Number(entry.offset),
      archive.dataOffset + Number(entry.offset) + entry.size,
    );
    const source = data.toString("utf8");
    foundLaunchPatch = foundLaunchPatch || source.includes(patchedArgs);
    foundUiPatch = foundUiPatch || sourceHasUiContextUsagePatch(source);
  });
  return foundLaunchPatch && foundUiPatch;
}

function hasAnyContextPatch() {
  const archive = readAsar(asarPath);
  let found = false;
  walk(archive.header, (filePath, entry) => {
    if (found || !isPackedJsFile(filePath, entry)) {
      return;
    }
    const data = archive.buffer.subarray(
      archive.dataOffset + Number(entry.offset),
      archive.dataOffset + Number(entry.offset) + entry.size,
    );
    const source = data.toString("utf8");
    found =
      source.includes(patchMarker) ||
      source.includes("__codex1mTokenLabel") ||
      source.includes("model_catalog_json=") ||
      source.includes("model_context_window=1000000");
  });
  return found;
}

function sourceHasUiContextUsagePatch(source) {
  return (
    source.includes("__codex1mTokenLabel") &&
    source.includes(uiContextUsageTooltipReplacement) &&
    source.includes(uiContextUsageValuesReplacement)
  );
}

function patchUiContextUsageSource(source) {
  if (!source.includes("composer.contextWindowUsageTooltip")) {
    return { source, changed: false, found: false };
  }

  let changed = false;
  if (!source.includes("__codex1mTokenLabel")) {
    if (!source.includes(uiContextUsageFunctionNeedle)) {
      return { source, changed: false, found: false };
    }
    source = source.replace(
      uiContextUsageFunctionNeedle,
      `${uiTokenLabelHelper}${uiContextUsageFunctionNeedle}`,
    );
    changed = true;
  }
  if (source.includes(uiContextUsageTooltipNeedle)) {
    source = source.replace(uiContextUsageTooltipNeedle, uiContextUsageTooltipReplacement);
    changed = true;
  }
  if (source.includes(uiContextUsageValuesNeedle)) {
    source = source.replace(uiContextUsageValuesNeedle, uiContextUsageValuesReplacement);
    changed = true;
  }

  return { source, changed, found: sourceHasUiContextUsagePatch(source) };
}

function patchAsar() {
  const archive = readAsar(asarPath);
  let replacements = 0;
  let uiReplacements = 0;
  const patchedFiles = [];
  const packed = new Map();
  let foundLaunchPatch = false;
  let foundUiPatch = false;

  walk(archive.header, (filePath, entry) => {
    if (entry.unpacked || entry.offset == null) {
      return;
    }

    let data = archive.buffer.subarray(
      archive.dataOffset + Number(entry.offset),
      archive.dataOffset + Number(entry.offset) + entry.size,
    );

    if (isPackedJsFile(filePath, entry)) {
      let source = data.toString("utf8");
      if (source.includes(patchedArgs)) {
        foundLaunchPatch = true;
        patchedFiles.push(filePath);
      } else {
        const fileReplacements = (source.match(appServerArgsPattern) || []).length;
        source = source.replace(appServerArgsPattern, patchedArgs);
        if (fileReplacements > 0) {
          foundLaunchPatch = true;
          replacements += fileReplacements;
          patchedFiles.push(filePath);
        }
      }

      const uiPatch = patchUiContextUsageSource(source);
      if (uiPatch.found) {
        foundUiPatch = true;
      }
      if (uiPatch.changed) {
        uiReplacements += 1;
        patchedFiles.push(filePath);
        source = uiPatch.source;
      }
      if (source !== data.toString("utf8")) {
        data = Buffer.from(source, "utf8");
      }
    }

    packed.set(filePath, data);
  });

  if (replacements > 0) {
    console.log(`patched launch arg sites: ${replacements} in ${[...new Set(patchedFiles)].join(", ")}`);
  }
  if (uiReplacements > 0) {
    console.log(`patched context usage tooltip sites: ${uiReplacements}`);
  }
  if (!foundLaunchPatch) {
    throw new Error("app-server launch patch target not found in any packed desktop JS file");
  }
  if (!foundUiPatch) {
    throw new Error("context usage tooltip patch target not found in any packed desktop JS file");
  }

  let offset = 0;
  const dataBuffers = [];
  walk(archive.header, (filePath, entry) => {
    if (entry.unpacked || entry.offset == null) {
      return;
    }
    const data = packed.get(filePath);
    entry.size = data.length;
    entry.offset = String(offset);
    entry.integrity = integrityFor(data);
    dataBuffers.push(data);
    offset += data.length;
  });

  const newHeader = makeHeader(archive.header);
  const newAsar = Buffer.concat([newHeader, ...dataBuffers]);
  const tempPath = `${asarPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, newAsar);
  fs.renameSync(tempPath, asarPath);
  const newHash = crypto.createHash("sha256").update(newAsar).digest("hex");
  console.log(`asar sha256: ${newHash}`);
  return newHash;
}

function updateAsarIntegrity(hash) {
  require("child_process").execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`, infoPlistPath],
    { stdio: "inherit" },
  );
}

function signAndVerifyApp() {
  const childProcess = require("child_process");
  childProcess.execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", appRoot], {
    stdio: "inherit",
  });
  childProcess.execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appRoot],
    { stdio: "inherit" },
  );
}

function desktopAppServerProcesses() {
  const childProcess = require("child_process");
  const output = childProcess.execFileSync("/bin/ps", ["axo", "pid=,command="], {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean)
    .filter(
      (processInfo) =>
        processInfo.command.includes(path.join(resourcesDir, "codex")) &&
        processInfo.command.includes(" app-server ") &&
        !processInfo.command.includes(" --listen stdio://"),
    );
}

function desktopAppServerNeedsRestartForDesiredArgs() {
  return desktopAppServerProcesses().some(
    (processInfo) =>
      !processInfo.command.includes(`model_context_window=${contextWindowTokens}`) ||
      !processInfo.command.includes(`model_auto_compact_token_limit=${autoCompactTokenLimit}`) ||
      !processInfo.command.includes(modelCatalogPath),
  );
}

function codexDesktopIsRunning() {
  try {
    require("child_process").execFileSync("/usr/bin/pgrep", ["-x", "Codex"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function restartCodexDesktop() {
  const childProcess = require("child_process");
  const processes = desktopAppServerProcesses();
  const codexWasRunning = codexDesktopIsRunning() || processes.length > 0;

  if (!codexWasRunning) {
    console.log("Codex Desktop is not running; patched args will apply next launch");
    return;
  }

  const appServerPids = processes.map((processInfo) => processInfo.pid).filter(Number.isFinite);
  if (appServerPids.length > 0) {
    console.log(`Codex Desktop app-server pid(s) will be force-killed: ${appServerPids.join(", ")}`);
  }

  const killAppServers =
    appServerPids.length > 0 ? `kill -9 ${appServerPids.join(" ")} >/dev/null 2>&1 || true` : ":";
  const restartScript = [
    "sleep 2",
    "pkill -9 -f '^/Applications/Codex\\.app/Contents/MacOS/Codex$' >/dev/null 2>&1 || true",
    "pkill -9 -f '^/Applications/Codex\\.app/Contents/Frameworks/.*/Helpers/Codex ' >/dev/null 2>&1 || true",
    "pkill -9 -f '^/Applications/Codex\\.app/Contents/Frameworks/.*/Helpers/browser_crashpad_handler ' >/dev/null 2>&1 || true",
    "pkill -9 -f '^/Applications/Codex\\.app/Contents/Resources/native/bare-modifier-monitor ' >/dev/null 2>&1 || true",
    killAppServers,
    `${shellSingleQuote(process.execPath)} ${shellSingleQuote(__filename)} repair-state >/dev/null 2>&1 || true`,
    "sleep 1",
    `open ${shellSingleQuote(appRoot)}`,
  ].join("; ");
  childProcess.spawn("/bin/sh", ["-c", restartScript], {
    detached: true,
    stdio: "ignore",
  }).unref();
  console.log("Codex Desktop force restart scheduled");
}

function applyPatch() {
  writeModelCatalog();
  const current = status();
  if (!fullSessionMigrationDone()) {
    const tokenTotalsByThread = migrateSessionRollouts();
    updateStateDatabaseTokenMetadata(tokenTotalsByThread);
    writeSessionMigrationMarker();
  } else {
    console.log("session rollout migration: already completed for this version");
  }
  removeStaleCopies();
  if (current.fullyApplied) {
    console.log("already fully applied");
    return { restartRecommended: false };
  }
  let newHash = current.asarHash;
  if (current.desiredPatch) {
    console.log("app.asar is already patched");
  } else if (current.anyContextPatch) {
    console.log("app.asar already has a context patch; upgrading it");
    newHash = patchAsar();
  } else {
    newHash = patchAsar();
  }
  removeStaleCopies();
  updateAsarIntegrity(newHash);
  signAndVerifyApp();
  return { restartRecommended: true };
}

function repairStateOnly() {
  writeModelCatalog();
  if (!fullSessionMigrationDone()) {
    const tokenTotalsByThread = migrateSessionRollouts();
    updateStateDatabaseTokenMetadata(tokenTotalsByThread);
    writeSessionMigrationMarker();
  } else {
    console.log("session rollout migration: already completed for this version");
  }
}

const command = process.argv[2] || "apply";
if (command === "apply") {
  applyPatch();
} else if (command === "apply-and-restart") {
  applyPatch();
  restartCodexDesktop();
} else if (command === "apply-auto") {
  const result = applyPatch();
  if (result.restartRecommended || desktopAppServerNeedsRestartForDesiredArgs()) {
    restartCodexDesktop();
  } else {
    console.log("Codex Desktop restart not needed");
  }
} else if (command === "repair-state") {
  repairStateOnly();
} else if (command === "status") {
  printStatus();
} else {
  console.error("usage: codex-1m.js [apply|apply-and-restart|apply-auto|repair-state|status]");
  process.exit(2);
}
