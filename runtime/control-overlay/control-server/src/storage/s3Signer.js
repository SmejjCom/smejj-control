// smejj.com control-server — SigV4-signierte IDrive-e2-Zugriffe (Single Responsibility: S3-Signierung).
// Der Control Server schreibt nur kleine Steuerobjekte (Capsules, Manifeste). Große Dateien
// laufen ausschließlich über presigned URLs direkt gegen IDrive e2 (Object Brain).
import crypto from "node:crypto";
import { hmac, sha256 } from "../shared/hash.js";

export function encodeS3Key(key) {
  return String(key).split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function getS3Dates(date) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function parseS3Keys(xml) {
  return Array.from(xml.matchAll(/<Key>([^<]+)<\/Key>/g), (match) => match[1]);
}

function signingKey(secretKey, dateStamp, region) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

export async function signedS3Put({ endpoint, region, accessKey, secretKey, bucket, key, body, contentType }) {
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const method = "PUT";
  const canonicalUri = `/${bucket}/${encodeS3Key(key)}`;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  const { amzDate, dateStamp } = getS3Dates(new Date());
  const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    ""
  ].join("\n");
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(secretKey, dateStamp, region), stringToSign, "hex");
  const authorization = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`${endpoint.replace(/\/$/, "")}${canonicalUri}`, {
    method,
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    },
    body: payload
  });
  if (!response.ok) throw new Error(`IDrive e2 write failed for ${key}: ${response.status} ${(await response.text()).slice(0, 240)}`);
  return { ok: true, key, status: response.status };
}

export async function signedS3Get({ endpoint, region, accessKey, secretKey, bucket, key }) {
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const method = "GET";
  const canonicalUri = `/${bucket}/${encodeS3Key(key)}`;
  const { amzDate, dateStamp } = getS3Dates(new Date());
  const payloadHash = sha256("");
  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    ""
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(secretKey, dateStamp, region), stringToSign, "hex");
  const authorization = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`${endpoint.replace(/\/$/, "")}${canonicalUri}`, {
    method,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`IDrive e2 read failed for ${key}: ${response.status} ${body.slice(0, 240)}`);
  return { ok: true, key, status: response.status, body };
}

export async function signedS3List({ endpoint, region, accessKey, secretKey, bucket, prefix }) {
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const method = "GET";
  const canonicalUri = `/${bucket}`;
  const queryPairs = [
    ["list-type", "2"],
    ["max-keys", "1000"],
    ["prefix", prefix]
  ];
  const canonicalQuery = queryPairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .sort()
    .join("&");
  const { amzDate, dateStamp } = getS3Dates(new Date());
  const payloadHash = sha256("");
  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    ""
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(secretKey, dateStamp, region), stringToSign, "hex");
  const authorization = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `${endpoint.replace(/\/$/, "")}${canonicalUri}?${canonicalQuery}`;
  try {
    const timeoutMs = boundedNumber(process.env.IDRIVE_E2_STATUS_TIMEOUT_MS, 2_500, 500, 8_000);
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetch(url, {
      signal,
      headers: {
        Authorization: authorization,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate
      }
    });
    return { response, body: await response.text() };
  } catch (error) {
    return {
      response: { ok: false, status: 0 },
      body: JSON.stringify({ error: "idrive_fetch_failed", message: error.message || "fetch failed" })
    };
  }
}
