#!/usr/bin/env node
// Verify the vendored contracts/ tree matches wmsfo-api at the pinned commit.
//
// Pattern taken from santa: fetch the tarball at CONTRACTS_SHA, extract it to a
// temp directory (`tar -x -C <cwd>` with relative paths so an archive laid down
// somewhere else compares the same), then walk both trees and compare file
// contents with line endings normalized to LF. GITHUB_TOKEN is used when
// present to raise the rate limit and reach private repositories.
//
// A fetch failure is a failure: exit 1 with the HTTP status (or the network
// error). Skipping the strict comparison on a 404 would let CI pass on a wrong
// owner or a deleted commit; the check has to be enforced everywhere it runs.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_OWNER = "benjaminfkile";
const REPO_NAME = "wmsfo-api";
const SUBTREE = "contracts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const localContracts = join(repoRoot, "contracts");
const shaFile = join(repoRoot, "CONTRACTS_SHA");

function die(msg, code = 1) {
  process.stderr.write(`check-contracts: ${msg}\n`);
  process.exit(code);
}

function readSha() {
  let raw;
  try {
    raw = readFileSync(shaFile, "utf8");
  } catch {
    die(`missing CONTRACTS_SHA at ${shaFile}`);
  }
  const sha = raw.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) die(`CONTRACTS_SHA is not a 40-char hex commit`);
  return sha;
}

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile()) out.push(p);
    }
  }
  out.sort();
  return out;
}

function normalize(buf) {
  // Line-ending normalized comparison: CRLF and lone CR become LF, and a
  // trailing newline is required so a file that lost its final newline in one
  // tree does not spuriously match.
  let s = buf.toString("utf8");
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return Buffer.from(s, "utf8");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchTarball(sha) {
  const url = `https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/${sha}`;
  const headers = { "User-Agent": "beacon-library-contracts-check" };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    return { ok: false, reason: `network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status} fetching ${url}` };
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, buf };
}

function extractTar(buf, destDir) {
  mkdirSync(destDir, { recursive: true });
  const tarPath = join(destDir, "src.tar.gz");
  writeFileSync(tarPath, buf);
  // tar with cwd (`-C`) and relative paths in the archive: strip the top-level
  // `<repo>-<sha>/` directory the GitHub tarball adds so paths under contracts/
  // are relative from the extraction root.
  const r = spawnSync(
    "tar",
    ["-xzf", tarPath, "-C", destDir, "--strip-components=1", `${REPO_NAME}-*/${SUBTREE}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  rmSync(tarPath, { force: true });
  if (r.status !== 0) {
    const stderr = r.stderr?.toString?.() ?? "";
    // BSD tar (macOS) doesn't accept the wildcard the same way; fall back to
    // extracting everything and then reading contracts/ out of the top dir.
    const r2 = spawnSync("tar", ["-xzf", "-", "-C", destDir], {
      input: buf,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (r2.status !== 0) throw new Error(`tar failed: ${stderr || r2.stderr?.toString?.()}`);
    const top = readdirSync(destDir).find((n) => n.startsWith(`${REPO_NAME}-`));
    if (!top) throw new Error(`no ${REPO_NAME}-* directory in tarball`);
    return join(destDir, top, SUBTREE);
  }
  const contractsDir = join(destDir, SUBTREE);
  return contractsDir;
}

async function main() {
  const sha = readSha();
  process.stdout.write(`check-contracts: comparing contracts/ against ${REPO_OWNER}/${REPO_NAME}@${sha}\n`);

  const fetched = await fetchTarball(sha);
  if (!fetched.ok) {
    die(fetched.reason);
  }

  const tmp = mkdtempSync(join(tmpdir(), "contracts-check-"));
  let remoteDir;
  try {
    remoteDir = extractTar(fetched.buf, tmp);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    die(`extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let ok = true;
  try {
    if (!existsDir(remoteDir)) {
      die(`no ${SUBTREE}/ subtree at ${REPO_OWNER}/${REPO_NAME}@${sha}`);
    }
    const localFiles = new Map();
    for (const p of walk(localContracts)) localFiles.set(relative(localContracts, p), p);
    const remoteFiles = new Map();
    for (const p of walk(remoteDir)) remoteFiles.set(relative(remoteDir, p), p);

    const missingLocal = [...remoteFiles.keys()].filter((k) => !localFiles.has(k));
    const extraLocal = [...localFiles.keys()].filter((k) => !remoteFiles.has(k));
    for (const rel of missingLocal) {
      ok = false;
      process.stderr.write(`  missing locally: ${rel}\n`);
    }
    for (const rel of extraLocal) {
      ok = false;
      process.stderr.write(`  extra locally:   ${rel}\n`);
    }
    for (const [rel, localPath] of localFiles) {
      const remotePath = remoteFiles.get(rel);
      if (!remotePath) continue;
      const a = normalize(readFileSync(localPath));
      const b = normalize(readFileSync(remotePath));
      if (sha256(a) !== sha256(b)) {
        ok = false;
        process.stderr.write(`  differs:         ${rel}\n`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (!ok) die(`contracts/ does not match ${REPO_OWNER}/${REPO_NAME}@${sha}`);
  process.stdout.write(`check-contracts: ok\n`);
}

function existsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

main().catch((err) => {
  process.stderr.write(`check-contracts: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
