// S3 client: loads auth, builds signed requests, parses S3's XML
// response bodies into plain JS objects without pulling in a full XML
// library. We only handle the response shapes S3 actually emits for
// the operations this plugin supports.

import { signRequest } from "./sigv4.js";

const SERVICE = "s3";

// ── auth ──────────────────────────────────────────────────────────────
export function loadS3Auth(ctx, configName = "s3", regionOverride) {
  const cfg = ctx?.config?.[configName];
  if (!cfg) {
    throw new Error(
      `S3 config "${configName}" not found in workspace. ` +
      `Add a generic config on the Configurations page with endpoint, region, accessKeyId, secretAccessKey.`,
    );
  }
  const endpoint        = String(cfg.endpoint || "").replace(/\/+$/, "");
  const region          = String(regionOverride || cfg.region || "us-east-1");
  const accessKeyId     = String(cfg.accessKeyId     || "");
  const secretAccessKey = String(cfg.secretAccessKey || "");
  const sessionToken    = cfg.sessionToken ? String(cfg.sessionToken) : null;
  // forcePathStyle: bucket goes in the path (https://endpoint/bucket/key)
  // rather than the host (https://bucket.endpoint/key). MinIO requires
  // this; AWS S3 and most others work either way.
  const forcePathStyle  = cfg.forcePathStyle === true || cfg.forcePathStyle === "true";

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      `S3 config "${configName}" is missing one of endpoint / accessKeyId / secretAccessKey.`,
    );
  }
  return { endpoint, region, accessKeyId, secretAccessKey, sessionToken, forcePathStyle };
}

// ── URL building ──────────────────────────────────────────────────────
// AWS S3 (and most clones) support both virtual-host and path style.
// We default to virtual-host (cleaner DNS routing) but flip to path
// style when the config requests it (MinIO, some local setups).
export function buildUrl(auth, { bucket, key, query }) {
  const u = new URL(auth.endpoint);
  if (bucket) {
    if (auth.forcePathStyle) {
      u.pathname = `/${bucket}${key ? `/${encodeKey(key)}` : ""}`;
    } else {
      u.hostname = `${bucket}.${u.hostname}`;
      u.pathname = key ? `/${encodeKey(key)}` : "/";
    }
  } else if (key) {
    u.pathname = `/${encodeKey(key)}`;
  }
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

// Encode an object key for the URL: split on '/' so prefixes look
// natural in the path, encode each segment.
function encodeKey(key) {
  return String(key)
    .split("/")
    .map(seg => encodeURIComponent(seg))
    .join("/");
}

// ── fetch + sign ──────────────────────────────────────────────────────
// Returns { status, headers, body }. `body` is a Buffer (caller decides
// how to decode it). Non-2xx throws with the parsed S3 error envelope.
export async function s3Fetch(auth, { method, url, headers = {}, body = null }, timeoutMs = 30000, signal) {
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`S3 request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onUpstream = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener("abort", onUpstream, { once: true });
  }

  // Normalize body to Buffer for hashing + sending.
  let bodyBuf;
  if (body == null)                bodyBuf = Buffer.alloc(0);
  else if (Buffer.isBuffer(body))  bodyBuf = body;
  else                              bodyBuf = Buffer.from(String(body));

  const signed = signRequest({
    method, url, headers, body: bodyBuf,
    region:          auth.region,
    service:         SERVICE,
    accessKeyId:     auth.accessKeyId,
    secretAccessKey: auth.secretAccessKey,
    sessionToken:    auth.sessionToken,
  });

  try {
    const res = await fetch(url, {
      method,
      headers: signed,
      body:    method === "GET" || method === "HEAD" ? undefined : bodyBuf,
      signal:  ac.signal,
    });
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    if (!res.ok) {
      const text = buf.toString("utf8");
      const err  = parseS3Error(text) || { Code: `HTTP_${res.status}`, Message: text.slice(0, 500) };
      const e = new Error(`S3 ${method} ${url} failed: ${err.Code}: ${err.Message}`);
      e.status = res.status;
      e.code   = err.Code;
      e.body   = err;
      throw e;
    }

    // Collapse Headers into a plain object.
    const hdrs = {};
    for (const [k, v] of res.headers) hdrs[k.toLowerCase()] = v;
    return { status: res.status, headers: hdrs, body: buf };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.("abort", onUpstream);
  }
}

// ── tiny XML helpers ──────────────────────────────────────────────────
// S3 responses are XML. We don't need a full parser — every response
// shape we care about is flat or one level deep. These two helpers
// cover everything: extract a tag's text, or all repeated children of a
// tag.

const TEXT_RE = (tag) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
const ALL_RE  = (tag) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");

export function xmlText(xml, tag, dflt = null) {
  const m = TEXT_RE(tag).exec(xml || "");
  return m ? decodeXmlEntities(m[1].trim()) : dflt;
}

export function xmlAll(xml, tag) {
  const out = [];
  const re  = ALL_RE(tag);
  let m;
  while ((m = re.exec(xml || ""))) out.push(m[1]);
  return out;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseS3Error(xml) {
  if (!xml || !xml.includes("<Error>")) return null;
  return {
    Code:      xmlText(xml, "Code",      "Unknown"),
    Message:   xmlText(xml, "Message",   ""),
    Resource:  xmlText(xml, "Resource",  null),
    RequestId: xmlText(xml, "RequestId", null),
  };
}
