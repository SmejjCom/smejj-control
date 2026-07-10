import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex");
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 5_000;

export function readBootstrapConfig(env = process.env) {
  const endpoint = required(env.IDRIVE_E2_ENDPOINT, "IDRIVE_E2_ENDPOINT").replace(/\/+$/, "");
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "https:") throw new Error("IDrive e2 endpoint must use HTTPS");
  const bucket = required(env.IDRIVE_E2_DEPLOY_BUCKET || env.IDRIVE_E2_BUCKET, "IDRIVE_E2_DEPLOY_BUCKET or IDRIVE_E2_BUCKET");
  const key = required(env.SMEJJ_CONTROL_ARTIFACT_KEY, "SMEJJ_CONTROL_ARTIFACT_KEY");
  const expectedSha256 = required(env.SMEJJ_CONTROL_ARTIFACT_SHA256, "SMEJJ_CONTROL_ARTIFACT_SHA256").toLowerCase();
  if (!/^deployments\/control\/[a-z0-9._/-]+\.tar\.gz$/i.test(key) || key.includes("..")) {
    throw new Error("Control artifact key is outside the approved prefix");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Control artifact SHA-256 is invalid");
  return {
    endpoint,
    region: String(env.IDRIVE_E2_REGION || "us-west-2"),
    accessKey: required(env.IDRIVE_E2_ACCESS_KEY, "IDRIVE_E2_ACCESS_KEY"),
    secretKey: required(env.IDRIVE_E2_SECRET_KEY, "IDRIVE_E2_SECRET_KEY"),
    bucket,
    key,
    expectedSha256,
    maxArchiveBytes: boundedNumber(env.SMEJJ_CONTROL_ARTIFACT_MAX_BYTES, 8 * 1024 * 1024, 64 * 1024, MAX_ARCHIVE_BYTES),
    timeoutMs: boundedNumber(env.SMEJJ_CONTROL_BOOTSTRAP_TIMEOUT_MS, 45_000, 5_000, 120_000)
  };
}

export function createSignedGet(config, now = new Date()) {
  const host = new URL(config.endpoint).host;
  const canonicalUri = `/${config.bucket}/${encodeS3Key(config.key)}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${EMPTY_SHA256}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["GET", canonicalUri, "", canonicalHeaders, signedHeaders, EMPTY_SHA256].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(config.secretKey, dateStamp, config.region), stringToSign, "hex");
  return {
    url: `${config.endpoint}${canonicalUri}`,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": amzDate
    }
  };
}

export async function downloadVerifiedArtifact(config, fetchImpl = fetch) {
  const request = createSignedGet(config);
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? AbortSignal.timeout(config.timeoutMs)
    : undefined;
  const response = await fetchImpl(request.url, { headers: request.headers, signal });
  if (!response.ok) throw new Error(`IDrive e2 artifact download failed with HTTP ${response.status}`);
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (declaredBytes > config.maxArchiveBytes) throw new Error("Control artifact exceeds configured byte limit");
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length === 0 || archive.length > config.maxArchiveBytes) throw new Error("Control artifact size is invalid");
  const actualSha256 = sha256(archive);
  if (actualSha256 !== config.expectedSha256) throw new Error("Control artifact SHA-256 mismatch");
  return { archive, actualSha256 };
}

export function validateArchiveEntries(listing) {
  const entries = String(listing || "").split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("Control artifact entry count is invalid");
  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, "");
    const parts = normalized.split("/");
    if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || parts.includes("..")) {
      throw new Error("Control artifact contains an unsafe path");
    }
  }
  const normalizedEntries = new Set(entries.map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, "")));
  if (!normalizedEntries.has("src/server.js") || !normalizedEntries.has("package.json")) {
    throw new Error("Control artifact is missing its required entrypoint");
  }
  return entries;
}

export async function extractVerifiedArtifact(archive, { tmpRoot = os.tmpdir(), execFile = execFileSync } = {}) {
  const releaseRoot = await fs.mkdtemp(path.join(tmpRoot, "smejj-control-"));
  const archivePath = path.join(releaseRoot, "release.tar.gz");
  await fs.writeFile(archivePath, archive, { mode: 0o600 });
  const listing = execFile("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  validateArchiveEntries(listing);
  execFile("tar", ["--no-same-owner", "-xzf", archivePath, "-C", releaseRoot], { stdio: "pipe", maxBuffer: 2 * 1024 * 1024 });
  const entrypoint = path.join(releaseRoot, "src", "server.js");
  await fs.access(entrypoint);
  return { releaseRoot, entrypoint };
}

export async function runBootstrap({ env = process.env, fetchImpl = fetch } = {}) {
  const config = readBootstrapConfig(env);
  const { archive, actualSha256 } = await downloadVerifiedArtifact(config, fetchImpl);
  const { releaseRoot, entrypoint } = await extractVerifiedArtifact(archive);
  console.log(JSON.stringify({
    app: "smejj.com",
    event: "control_artifact_verified",
    key: config.key,
    bytes: archive.length,
    sha256: actualSha256
  }));
  process.chdir(releaseRoot);
  process.env.PROJECT_ROOT = releaseRoot;
  await import(pathToFileURL(entrypoint).href);
}

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function encodeS3Key(key) {
  return String(key).split("/").map((part) => encodeURIComponent(part)).join("/");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest(encoding);
}

function signingKey(secretKey, dateStamp, region) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

const directPath = import.meta.url.startsWith("file:") && process.argv[1]
  ? path.resolve(process.argv[1])
  : "";
if (directPath && fileURLToPath(import.meta.url) === directPath) {
  runBootstrap().catch((error) => {
    const safeMessage = String(error?.message || error).replace(/https?:\/\/\S+/g, "[redacted-url]");
    console.error(`smejj.com control bootstrap failed: ${safeMessage}`);
    process.exitCode = 1;
  });
}
