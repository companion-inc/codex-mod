#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const appRoot = process.env.CODEX_APP_ROOT || "/Applications/Codex.app";
const resourcesDir = path.join(appRoot, "Contents", "Resources");
const asarPath = path.join(resourcesDir, "app.asar");
const infoPlistPath = path.join(appRoot, "Contents", "Info.plist");
const targetFile = "/.vite/build/src-fg9h3MDi.js";
const originalArgs = "args:[`app-server`,`--analytics-default-enabled`]";
const patchedArgs =
  "args:[`app-server`,`--analytics-default-enabled`,`-cmodel_context_window=1000000`,`-cmodel_auto_compact_token_limit=900000`]";
const patchMarker = "-cmodel_context_window=1000000";
const patchedArgsPattern =
  /args:\[`app-server`,`--analytics-default-enabled`,`-cmodel_context_window=1000000`,`-cmodel_auto_compact_token_limit=\d+`\]/g;
const blockSize = 4 * 1024 * 1024;

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

function backupOriginal() {
  const version = require("child_process")
    .execFileSync("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", infoPlistPath], {
      encoding: "utf8",
    })
    .trim();
  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(asarPath))
    .digest("hex")
    .slice(0, 12);
  const backupPath = path.join(resourcesDir, `app.asar.codex-1m-backup-v${version}-${hash}`);
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(asarPath, backupPath);
    console.log(`backup: ${backupPath}`);
  } else {
    console.log(`backup exists: ${backupPath}`);
  }
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

function status() {
  const currentAsarHash = asarHash();
  const currentPlistHash = plistAsarHash();
  const desiredPatch = hasPatch();
  const anyContextPatch = hasAnyContextPatch();
  const integrityMatches = currentPlistHash === currentAsarHash;
  const signatureValid = verifyAppQuiet();
  return {
    anyContextPatch,
    desiredPatch,
    integrityMatches,
    signatureValid,
    fullyApplied: desiredPatch && integrityMatches && signatureValid,
    asarHash: currentAsarHash,
    plistAsarHash: currentPlistHash,
  };
}

function printStatus() {
  const current = status();
  console.log(`desired patch: ${current.desiredPatch ? "yes" : "no"}`);
  console.log(`any context patch: ${current.anyContextPatch ? "yes" : "no"}`);
  console.log(`asar integrity matches: ${current.integrityMatches ? "yes" : "no"}`);
  console.log(`codesign valid: ${current.signatureValid ? "yes" : "no"}`);
  console.log(`fully applied: ${current.fullyApplied ? "yes" : "no"}`);
  console.log(`asar sha256: ${current.asarHash}`);
  console.log(`plist asar sha256: ${current.plistAsarHash ?? "missing"}`);
}

function hasPatch() {
  const archive = readAsar(asarPath);
  let found = false;
  walk(archive.header, (filePath, entry) => {
    if (found || filePath !== targetFile || entry.unpacked || entry.offset == null) {
      return;
    }
    const data = archive.buffer.subarray(
      archive.dataOffset + Number(entry.offset),
      archive.dataOffset + Number(entry.offset) + entry.size,
    );
    found = data.toString("utf8").includes(patchedArgs);
  });
  return found;
}

function hasAnyContextPatch() {
  const archive = readAsar(asarPath);
  let found = false;
  walk(archive.header, (filePath, entry) => {
    if (found || filePath !== targetFile || entry.unpacked || entry.offset == null) {
      return;
    }
    const data = archive.buffer.subarray(
      archive.dataOffset + Number(entry.offset),
      archive.dataOffset + Number(entry.offset) + entry.size,
    );
    found = data.toString("utf8").includes(patchMarker);
  });
  return found;
}

function patchAsar() {
  const archive = readAsar(asarPath);
  let replacements = 0;
  const packed = new Map();

  walk(archive.header, (filePath, entry) => {
    if (entry.unpacked || entry.offset == null) {
      return;
    }

    let data = archive.buffer.subarray(
      archive.dataOffset + Number(entry.offset),
      archive.dataOffset + Number(entry.offset) + entry.size,
    );

    if (filePath === targetFile) {
      let source = data.toString("utf8");
      if (source.includes(patchedArgs)) {
        console.log("already patched");
      } else {
        replacements = (source.match(patchedArgsPattern) || []).length;
        if (replacements > 0) {
          source = source.replace(patchedArgsPattern, patchedArgs);
          data = Buffer.from(source, "utf8");
        } else {
          replacements = source.split(originalArgs).length - 1;
          source = source.split(originalArgs).join(patchedArgs);
          data = Buffer.from(source, "utf8");
        }
        if (replacements === 0) {
          throw new Error(`patch target not found in ${targetFile}`);
        }
      }
    }

    packed.set(filePath, data);
  });

  if (replacements > 0) {
    console.log(`patched launch arg sites: ${replacements}`);
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
  childProcess.execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appRoot], {
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
  const staleProcesses = processes.filter((processInfo) => !processInfo.command.includes(patchMarker));
  const codexWasRunning = codexDesktopIsRunning() || processes.length > 0;

  if (!codexWasRunning) {
    console.log("Codex Desktop is not running; patched args will apply next launch");
    return;
  }

  const stalePids = staleProcesses.map((processInfo) => processInfo.pid).filter(Number.isFinite);
  if (stalePids.length > 0) {
    console.log(`Codex Desktop has stale app-server pid(s): ${stalePids.join(", ")}`);
  }

  const killStaleServers = stalePids.length > 0 ? `kill -9 ${stalePids.join(" ")} >/dev/null 2>&1 || true` : ":";
  const restartScript = [
    "pkill -9 -f '^/Applications/Codex\\.app/Contents/MacOS/Codex$' >/dev/null 2>&1 || true",
    "pkill -9 -f '^/Applications/Codex\\.app/Contents/Frameworks/.*/Helpers/Codex ' >/dev/null 2>&1 || true",
    "pkill -9 -f '^/Applications/Codex\\.app/Contents/Frameworks/.*/Helpers/browser_crashpad_handler ' >/dev/null 2>&1 || true",
    "pkill -9 -f '^/Applications/Codex\\.app/Contents/Resources/native/bare-modifier-monitor ' >/dev/null 2>&1 || true",
    killStaleServers,
    "sleep 1",
    `open ${JSON.stringify(appRoot)}`,
  ].join("; ");
  childProcess.spawn("/bin/sh", ["-c", restartScript], {
    detached: true,
    stdio: "ignore",
  }).unref();
  console.log("Codex Desktop force restart scheduled");
}

function applyPatch() {
  const current = status();
  if (current.fullyApplied) {
    console.log("already fully applied");
    return;
  }
  let newHash = current.asarHash;
  if (current.desiredPatch) {
    console.log("backup skipped: app.asar is already patched");
  } else if (current.anyContextPatch) {
    console.log("backup skipped: app.asar already has a context patch");
    newHash = patchAsar();
  } else {
    backupOriginal();
    newHash = patchAsar();
  }
  updateAsarIntegrity(newHash);
  signAndVerifyApp();
}

function restore() {
  const backups = fs
    .readdirSync(resourcesDir)
    .filter((name) => name.startsWith("app.asar.codex-1m-backup-"))
    .sort();
  if (backups.length === 0) {
    throw new Error("no backup found");
  }
  const backupPath = path.join(resourcesDir, backups[backups.length - 1]);
  fs.copyFileSync(backupPath, asarPath);
  const restoredHash = asarHash();
  updateAsarIntegrity(restoredHash);
  signAndVerifyApp();
  console.log(`restored: ${backupPath}`);
  console.log(`asar sha256: ${restoredHash}`);
}

const command = process.argv[2] || "apply";
if (command === "apply") {
  applyPatch();
} else if (command === "apply-and-restart") {
  applyPatch();
  restartCodexDesktop();
} else if (command === "restore") {
  restore();
} else if (command === "status") {
  printStatus();
} else {
  console.error("usage: codex-mod.js [apply|apply-and-restart|restore|status]");
  process.exit(2);
}
