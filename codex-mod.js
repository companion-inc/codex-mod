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
  const current = status();
  if (current.fullyApplied) {
    console.log("already fully applied");
    process.exit(0);
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
} else if (command === "restore") {
  restore();
} else if (command === "status") {
  printStatus();
} else {
  console.error("usage: codex-mod.js [apply|restore|status]");
  process.exit(2);
}
