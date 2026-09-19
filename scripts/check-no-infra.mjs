// Fails when a tracked file names real infrastructure or carries a credential.
// This repository is public: account ids, ARNs, registry and database hosts,
// identity pool ids, CDN hosts, private network addresses, personal domains,
// project ids, and keys of any kind belong in CI secrets and variables or in
// the operator's private notes, never here. Docs use <placeholder> names.
// A line that must keep a match (a documented example value) is listed, as the
// exact matched text, one per line, in .no-infra-allow at the repository root.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const RULES = [
  ["aws account id", /\b\d{12}(?=\.dkr\.ecr\.)|(?<=arn:aws:[a-z0-9-]*:[a-z0-9-]*:)\d{12}\b/g],
  ["aws host", /\b[a-z0-9-]+\.[a-z0-9.-]*(?:rds|cache|elb|execute-api)\.[a-z0-9.-]*amazonaws\.com\b/g],
  ["cognito pool id", /\b(?:us|eu|ap|sa|ca|me|af)-[a-z]+-\d_[A-Za-z0-9]{9}\b/g],
  ["cognito domain", /\b[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com\b/g],
  ["cloudfront host", /\b[a-z0-9]{13,14}\.cloudfront\.net\b/g],
  ["private network address", /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
  ["google api key", /AIza[0-9A-Za-z_-]{35}/g],
  ["aws access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github token", /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g],
  ["vercel id", /\b(?:prj|team)_[A-Za-z0-9]{20,}\b/g],
  ["operator resource name", /\bbk-[a-z0-9]+(?:-[a-z0-9]+)*\b/g],
  ["operator domain", /\b[a-z0-9.-]*benkile\.com\b/g],
];

// Addresses every Android emulator and Docker bridge uses, and AWS's public CA bundle host.
const ALWAYS_ALLOWED = new Set(["10.0.2.2", "10.0.0.1", "172.17.0.1", "truststore.pki.rds.amazonaws.com"]);
const allowFile = join(root, ".no-infra-allow");
const allowed = new Set(ALWAYS_ALLOWED);
if (existsSync(allowFile)) {
  for (const line of readFileSync(allowFile, "utf8").split(/\r?\n/)) {
    const v = line.trim();
    if (v && !v.startsWith("#")) allowed.add(v);
  }
}

const SKIP = /(^|\/)(package-lock\.json|.*\.(png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|zip|tgz|gz|jar|keystore|p12|pdf|mp4|webm|bin|so|dll))$/i;
const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 1 << 28 })
  .toString()
  .split("\0")
  .filter((f) => f && !SKIP.test(f));

const hits = [];
for (const file of files) {
  let text;
  try {
    const buf = readFileSync(join(root, file));
    if (buf.subarray(0, 8000).includes(0)) continue;
    text = buf.toString("utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [name, re] of RULES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i]))) {
        if (!allowed.has(m[0])) hits.push(`${file}:${i + 1}: ${name}: ${m[0]}`);
      }
    }
  }
}

if (hits.length) {
  process.stderr.write(`check-no-infra: ${hits.length} finding(s)\n${hits.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`check-no-infra: ok (${files.length} files)\n`);
