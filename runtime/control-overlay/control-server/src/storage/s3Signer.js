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
  return parseS3ListPage(xml).keys;
}

export function parseS3ListPage(xml) {
  const body = String(xml || "");
  const keys = Array.from(body.matchAll(/<Key>([\s\S]*?)<\/Key>/g), (match) => decodeXmlText(match[1]));
  const truncatedText = xmlElement(body, "IsTruncated");
  const isTruncated = truncatedText === "true"
    ? true
    : truncatedText === "false"
      ? false
      : null;
  const tokenText = xmlElement(body, "NextContinuationToken");
  return {
    keys,
    isTruncated,
    nextContinuationToken: tokenText === null ? null : decodeXmlText(tokenText)
  };
}

function signingKey(secretKey, dateStamp, region) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

export async function signedS3Put({
  endpoint, region, accessKey, secretKey, bucket, key, body, contentType,
  ifNoneMatch = "", ifMatch = "", fetchImpl = fetch, timeoutMs
}) {
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const method = "PUT";
  const canonicalUri = `/${bucket}/${encodeS3Key(key)}`;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  const { amzDate, dateStamp } = getS3Dates(new Date());
  const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
  const immutableCondition = String(ifNoneMatch || "") === "*" ? "*" : "";
  const compareCondition = normalizeEtag(ifMatch);
  if (immutableCondition && compareCondition) throw new Error("S3 PUT cannot combine If-Match and If-None-Match");
  const canonicalHeaderLines = [
    `content-type:${contentType}`,
    `host:${host}`
  ];
  const signedHeaderNames = ["content-type", "host"];
  if (compareCondition) {
    canonicalHeaderLines.push(`if-match:${compareCondition}`);
    signedHeaderNames.push("if-match");
  }
  if (immutableCondition) {
    canonicalHeaderLines.push(`if-none-match:${immutableCondition}`);
    signedHeaderNames.push("if-none-match");
  }
  canonicalHeaderLines.push(
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`
  );
  signedHeaderNames.push("x-amz-content-sha256", "x-amz-date");
  const canonicalHeaders = `${canonicalHeaderLines.join("\n")}\n`;
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(secretKey, dateStamp, region), stringToSign, "hex");
  const authorization = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = {
    Authorization: authorization,
    "Content-Type": contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  if (compareCondition) headers["If-Match"] = compareCondition;
  if (immutableCondition) headers["If-None-Match"] = immutableCondition;
  const signal = requestTimeoutSignal(timeoutMs);
  const response = await fetchImpl(`${endpoint.replace(/\/$/, "")}${canonicalUri}`, {
    method,
    headers,
    body: payload,
    signal
  });
  if ((immutableCondition || compareCondition) && response.status === 412) {
    return { ok: false, key, status: 412, created: false, conditionEnforced: true };
  }
  if (!response.ok) throw new Error(`IDrive e2 write failed for ${key}: ${response.status} ${(await response.text()).slice(0, 240)}`);
  return {
    ok: true,
    key,
    status: response.status,
    created: true,
    conditionEnforced: Boolean(immutableCondition || compareCondition),
    etag: normalizeEtag(response.headers?.get?.("etag"))
  };
}

export async function signedS3Get({
  endpoint, region, accessKey, secretKey, bucket, key, fetchImpl = fetch, timeoutMs,
  allowNotFound = false, responseType = "text"
}) {
  if (!["text", "buffer"].includes(responseType)) throw new Error("Unsupported S3 response type");
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
  const signal = requestTimeoutSignal(timeoutMs);
  const response = await fetchImpl(`${endpoint.replace(/\/$/, "")}${canonicalUri}`, {
    method,
    signal,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    }
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const body = responseType === "buffer" ? bytes : bytes.toString("utf8");
  if (allowNotFound === true && response.status === 404) {
    return { ok: false, key, status: 404, body: responseType === "buffer" ? Buffer.alloc(0) : "" };
  }
  if (!response.ok) throw new Error(`IDrive e2 read failed for ${key}: ${response.status} ${bytes.toString("utf8").slice(0, 240)}`);
  return {
    ok: true,
    key,
    status: response.status,
    body,
    etag: normalizeEtag(response.headers?.get?.("etag"))
  };
}

export async function signedS3List({
  endpoint, region, accessKey, secretKey, bucket, prefix, continuationToken = null,
  fetchImpl = fetch, timeoutMs
}) {
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const method = "GET";
  const canonicalUri = `/${bucket}`;
  const queryPairs = [
    ["list-type", "2"],
    ["max-keys", "1000"],
    ["prefix", prefix]
  ];
  if (continuationToken !== null && continuationToken !== undefined && continuationToken !== "") {
    queryPairs.push(["continuation-token", String(continuationToken)]);
  }
  const canonicalQuery = queryPairs
    .map(([key, value]) => `${encodeS3QueryValue(key)}=${encodeS3QueryValue(value)}`)
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
    const signal = requestTimeoutSignal(timeoutMs ?? process.env.IDRIVE_E2_STATUS_TIMEOUT_MS);
    const response = await fetchImpl(url, {
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

function xmlElement(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(xml);
  return match ? match[1].trim() : null;
}

function decodeXmlText(value) {
  return String(value).replace(/&(?:#(\d+)|#x([a-f0-9]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hexadecimal) => {
    if (decimal) return safeCodePoint(Number(decimal), entity);
    if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16), entity);
    return {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'"
    }[entity.toLowerCase()] || entity;
  });
}

function safeCodePoint(value, fallback) {
  try {
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : fallback;
  } catch {
    return fallback;
  }
}

function encodeS3QueryValue(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function requestTimeoutSignal(value) {
  const milliseconds = boundedNumber(value, 2_500, 100, 30_000);
  return typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? AbortSignal.timeout(milliseconds)
    : undefined;
}

function normalizeEtag(value) {
  const etag = String(value || "").trim();
  return /^"[\x21\x23-\x7e]{1,200}"$/.test(etag) && !etag.includes("\\") ? etag : "";
}
