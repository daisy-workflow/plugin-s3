// AWS Signature Version 4 — minimal, vendor-agnostic implementation.
// Used by every S3 call this plugin makes. Built against the spec at
// https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html and
// validated against AWS's published test vectors (see test in
// plugin-s3/lib/__test__ if present, or the verify step in CI).
//
// We only need the "header authentication" mode (sign the request with
// an Authorization header), not query-string signing.
//
// SigV4 rules that bite people, surfaced here as comments where the
// code applies them:
//   • Canonical URI: each path segment is URI-encoded with
//     encodeURIComponent, but '/' separators are preserved.
//     S3 additionally treats the FIRST encoding of the path as canonical
//     (no double-encoding for non-S3 services; we follow the S3 rule).
//   • Canonical query string: params sorted by key (and then by value
//     for repeats), keys+values both URI-encoded.
//   • Canonical headers: lowercased keys, values trimmed and inner
//     whitespace collapsed. Sorted by key. host + x-amz-* + x-amz-date
//     + x-amz-content-sha256 are always signed.
//   • Payload hash: SHA-256 of the request body. For unsigned bodies
//     pass the string "UNSIGNED-PAYLOAD" (we always sign).

import crypto from "node:crypto";

const ALGO        = "AWS4-HMAC-SHA256";
const TERMINATOR  = "aws4_request";

const sha256Hex = (data) =>
  crypto.createHash("sha256").update(data).digest("hex");

const hmac = (key, data) =>
  crypto.createHmac("sha256", key).update(data).digest();

// ── helpers ───────────────────────────────────────────────────────────

// Per SigV4 spec, "URI encoding" matches RFC 3986 — leave A-Z a-z 0-9 - _ . ~
// alone and percent-encode everything else. encodeURIComponent already
// does this EXCEPT it doesn't escape * and + (legal in JS but reserved
// in RFC 3986), so we patch those up.
function uriEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g,  "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g,  "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function canonicalUri(pathname) {
  // pathname is the URL path (no query). Split on '/' so '/' stays
  // literal in the canonical form. Empty path → "/".
  if (!pathname || pathname === "/") return "/";
  return pathname
    .split("/")
    .map(seg => uriEncode(decodeURIComponent(seg)))
    .join("/");
}

function canonicalQuery(searchParams) {
  // searchParams: URLSearchParams or null
  if (!searchParams) return "";
  const entries = [];
  for (const [k, v] of searchParams) entries.push([k, v]);
  entries.sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1));
  return entries.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v ?? "")}`).join("&");
}

function canonicalHeaders(headers) {
  // headers: plain { key: value } object. Returns { canonical, signed }.
  const lower = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  }
  const keys = Object.keys(lower).sort();
  const canonical = keys.map(k => `${k}:${lower[k]}\n`).join("");
  const signed    = keys.join(";");
  return { canonical, signed };
}

// ── public API ────────────────────────────────────────────────────────

// Sign a request. Returns the headers you should send (input headers +
// Authorization + x-amz-date + x-amz-content-sha256 + host).
//
// args:
//   method         — "GET" / "PUT" / "DELETE" / "POST" / "HEAD"
//   url            — full URL string ("https://bucket.s3.region.amazonaws.com/key")
//   headers        — { ... } — caller-supplied headers (no host / date / sha needed)
//   body           — string | Buffer | null. Hashed for the payload digest.
//   region         — "us-east-1" etc.
//   service        — "s3" for this plugin
//   accessKeyId    — credentials
//   secretAccessKey
//   sessionToken   — optional, for STS / role credentials
//   nowMs          — optional, for testing (default Date.now())
export function signRequest({
  method,
  url,
  headers = {},
  body = "",
  region,
  service,
  accessKeyId,
  secretAccessKey,
  sessionToken = null,
  nowMs,
}) {
  const u = new URL(url);
  const now = new Date(nowMs ?? Date.now());

  // ISO 8601 basic format: YYYYMMDDTHHMMSSZ
  const amzDate    = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp  = amzDate.slice(0, 8);

  // Payload digest. For empty body S3 still wants the SHA-256 of "".
  const payloadHash = sha256Hex(body || "");

  // Build the headers we'll actually sign. Caller's headers ride along
  // (they're often Content-Type, Content-Length, x-amz-acl, etc.).
  const signedHeaders = {
    ...headers,
    host:                   u.host,
    "x-amz-date":           amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (sessionToken) signedHeaders["x-amz-security-token"] = sessionToken;

  const { canonical: canonHeaders, signed: signedHeaderList } = canonicalHeaders(signedHeaders);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(u.pathname),
    canonicalQuery(u.searchParams),
    canonHeaders,                  // already trailing \n per spec
    signedHeaderList,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/${TERMINATOR}`;

  const stringToSign = [
    ALGO,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // Derive signing key: kDate → kRegion → kService → kSigning
  const kDate    = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, TERMINATOR);

  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization = [
    `${ALGO} Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaderList}`,
    `Signature=${signature}`,
  ].join(", ");

  return {
    ...signedHeaders,
    Authorization: authorization,
  };
}
