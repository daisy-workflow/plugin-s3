// Operation handlers for the s3 plugin. One async function per
// operation, all sharing the signed-fetch client.

import { buildUrl, s3Fetch, xmlText, xmlAll } from "./client.js";

// ── bucket.getAll ─────────────────────────────────────────────────────
// GET /  →  ListAllMyBuckets
export async function bucketGetAll(auth, input, signal) {
  const { timeoutMs = 30000 } = input || {};
  const url = buildUrl(auth, {});
  const { status, body } = await s3Fetch(auth, { method: "GET", url }, timeoutMs, signal);
  const xml = body.toString("utf8");
  const buckets = xmlAll(xml, "Bucket").map(b => ({
    name:         xmlText(b, "Name"),
    creationDate: xmlText(b, "CreationDate"),
  }));
  return {
    status,
    result: {
      owner:   { id: xmlText(xml, "ID"), displayName: xmlText(xml, "DisplayName") },
      buckets,
      count:   buckets.length,
    },
    url,
  };
}

// ── bucket.create ─────────────────────────────────────────────────────
// PUT /<bucket>
export async function bucketCreate(auth, input, signal) {
  const { bucket, acl, timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=bucket.create requires bucket");

  // For regions other than us-east-1, S3 requires a CreateBucketConfiguration
  // body. Wasabi, MinIO, and most others accept it too.
  let body = "";
  if (auth.region && auth.region !== "us-east-1") {
    body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<LocationConstraint>${auth.region}</LocationConstraint>` +
      `</CreateBucketConfiguration>`;
  }

  const headers = { "Content-Type": "application/xml" };
  if (acl) headers["x-amz-acl"] = acl;

  const url = buildUrl(auth, { bucket });
  const { status } = await s3Fetch(auth, { method: "PUT", url, headers, body }, timeoutMs, signal);
  return {
    status,
    result: { bucket, created: true, region: auth.region },
    url,
  };
}

// ── bucket.delete ─────────────────────────────────────────────────────
// DELETE /<bucket>   (bucket must be empty)
export async function bucketDelete(auth, input, signal) {
  const { bucket, timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=bucket.delete requires bucket");
  const url = buildUrl(auth, { bucket });
  const { status } = await s3Fetch(auth, { method: "DELETE", url }, timeoutMs, signal);
  return { status, result: { bucket, deleted: true }, url };
}

// ── bucket.search ─────────────────────────────────────────────────────
// Alias of file.getAll with prefix. Kept as a separate operation to
// match n8n's nomenclature ("Search within a bucket").
export async function bucketSearch(auth, input, signal) {
  return fileGetAll(auth, input, signal);
}

// ── file.getAll ───────────────────────────────────────────────────────
// GET /<bucket>?list-type=2&prefix=...&max-keys=...&continuation-token=...
export async function fileGetAll(auth, input, signal) {
  const { bucket, prefix, maxKeys = 1000, continuationToken, timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=file.getAll requires bucket");

  const query = { "list-type": "2", "max-keys": String(Math.min(1000, Math.max(1, Number(maxKeys) || 1000))) };
  if (prefix)            query.prefix              = prefix;
  if (continuationToken) query["continuation-token"] = continuationToken;

  const url = buildUrl(auth, { bucket, query });
  const { status, body } = await s3Fetch(auth, { method: "GET", url }, timeoutMs, signal);
  const xml = body.toString("utf8");

  const objects = xmlAll(xml, "Contents").map(c => ({
    key:          xmlText(c, "Key"),
    lastModified: xmlText(c, "LastModified"),
    etag:         (xmlText(c, "ETag") || "").replace(/^"|"$/g, ""),
    size:         Number(xmlText(c, "Size") || 0),
    storageClass: xmlText(c, "StorageClass"),
  }));

  return {
    status,
    result: {
      bucket,
      prefix:                 prefix || null,
      isTruncated:            xmlText(xml, "IsTruncated") === "true",
      nextContinuationToken:  xmlText(xml, "NextContinuationToken"),
      keyCount:               Number(xmlText(xml, "KeyCount") || objects.length),
      objects,
    },
    url,
  };
}

// ── file.upload ───────────────────────────────────────────────────────
// PUT /<bucket>/<key>   body = file content
export async function fileUpload(auth, input, signal) {
  const {
    bucket, key, body = "", bodyEncoding = "utf8",
    contentType, metadata, acl, timeoutMs = 60000,
  } = input || {};
  if (!bucket) throw new Error("operation=file.upload requires bucket");
  if (!key)    throw new Error("operation=file.upload requires key");

  const buf = bodyEncoding === "base64"
    ? Buffer.from(String(body), "base64")
    : Buffer.from(String(body), "utf8");

  const headers = {
    "Content-Type":   contentType || (bodyEncoding === "base64" ? "application/octet-stream" : "text/plain; charset=utf-8"),
    "Content-Length": String(buf.length),
  };
  if (acl) headers["x-amz-acl"] = acl;
  if (metadata && typeof metadata === "object") {
    for (const [k, v] of Object.entries(metadata)) {
      headers[`x-amz-meta-${k.toLowerCase()}`] = String(v);
    }
  }

  const url = buildUrl(auth, { bucket, key });
  const { status, headers: rHdrs } = await s3Fetch(
    auth, { method: "PUT", url, headers, body: buf }, timeoutMs, signal,
  );
  return {
    status,
    result: {
      bucket, key,
      size:    buf.length,
      etag:    (rHdrs.etag || "").replace(/^"|"$/g, ""),
      versionId: rHdrs["x-amz-version-id"] || null,
    },
    url,
  };
}

// ── file.download ─────────────────────────────────────────────────────
// GET /<bucket>/<key>   returns object body as base64 (default) or utf8
export async function fileDownload(auth, input, signal) {
  const { bucket, key, responseEncoding = "base64", timeoutMs = 60000 } = input || {};
  if (!bucket) throw new Error("operation=file.download requires bucket");
  if (!key)    throw new Error("operation=file.download requires key");

  const url = buildUrl(auth, { bucket, key });
  const { status, headers, body } = await s3Fetch(auth, { method: "GET", url }, timeoutMs, signal);

  const data = responseEncoding === "utf8"
    ? body.toString("utf8")
    : body.toString("base64");

  return {
    status,
    result: {
      bucket, key,
      contentType:   headers["content-type"]   || null,
      contentLength: Number(headers["content-length"] || body.length),
      etag:          (headers.etag || "").replace(/^"|"$/g, ""),
      lastModified:  headers["last-modified"]  || null,
      versionId:     headers["x-amz-version-id"] || null,
      encoding:      responseEncoding,
      data,
    },
    url,
  };
}

// ── file.copy ─────────────────────────────────────────────────────────
// PUT /<destBucket>/<destKey>   with x-amz-copy-source: <srcBucket>/<srcKey>
export async function fileCopy(auth, input, signal) {
  const { bucket, key, copySource, timeoutMs = 30000 } = input || {};
  if (!bucket)     throw new Error("operation=file.copy requires bucket");
  if (!key)        throw new Error("operation=file.copy requires key (destination)");
  if (!copySource) throw new Error("operation=file.copy requires copySource ('srcBucket/srcKey')");

  const url = buildUrl(auth, { bucket, key });
  const headers = {
    // x-amz-copy-source must be URL-encoded except for '/'.
    "x-amz-copy-source": "/" + String(copySource).split("/").map((s, i) => i === 0 ? encodeURIComponent(s) : s).join("/"),
  };
  const { status, body } = await s3Fetch(auth, { method: "PUT", url, headers }, timeoutMs, signal);
  const xml = body.toString("utf8");
  return {
    status,
    result: {
      bucket, key,
      copySource,
      etag:         (xmlText(xml, "ETag") || "").replace(/^"|"$/g, ""),
      lastModified: xmlText(xml, "LastModified"),
    },
    url,
  };
}

// ── file.delete ───────────────────────────────────────────────────────
// DELETE /<bucket>/<key>
export async function fileDelete(auth, input, signal) {
  const { bucket, key, timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=file.delete requires bucket");
  if (!key)    throw new Error("operation=file.delete requires key");
  const url = buildUrl(auth, { bucket, key });
  const { status, headers } = await s3Fetch(auth, { method: "DELETE", url }, timeoutMs, signal);
  return {
    status,
    result: { bucket, key, deleted: true, versionId: headers["x-amz-version-id"] || null },
    url,
  };
}

// ── folder.create ─────────────────────────────────────────────────────
// S3 has no folders. Convention: an empty object with key ending in '/'
// shows up as a "folder" in S3 consoles. That's all this does.
export async function folderCreate(auth, input, signal) {
  const { bucket, folderName, acl, timeoutMs = 30000 } = input || {};
  if (!bucket)     throw new Error("operation=folder.create requires bucket");
  if (!folderName) throw new Error("operation=folder.create requires folderName");

  const key = String(folderName).replace(/\/+$/, "") + "/";
  const headers = { "Content-Type": "application/x-directory", "Content-Length": "0" };
  if (acl) headers["x-amz-acl"] = acl;

  const url = buildUrl(auth, { bucket, key });
  const { status } = await s3Fetch(auth, { method: "PUT", url, headers, body: "" }, timeoutMs, signal);
  return { status, result: { bucket, folder: key, created: true }, url };
}

// ── folder.getAll ─────────────────────────────────────────────────────
// GET /<bucket>?list-type=2&delimiter=/&prefix=...   →  CommonPrefixes
export async function folderGetAll(auth, input, signal) {
  const { bucket, prefix, delimiter = "/", timeoutMs = 30000 } = input || {};
  if (!bucket) throw new Error("operation=folder.getAll requires bucket");

  const query = { "list-type": "2", delimiter };
  if (prefix) query.prefix = prefix;

  const url = buildUrl(auth, { bucket, query });
  const { status, body } = await s3Fetch(auth, { method: "GET", url }, timeoutMs, signal);
  const xml = body.toString("utf8");

  const folders = xmlAll(xml, "CommonPrefixes").map(p => xmlText(p, "Prefix"));

  return {
    status,
    result: {
      bucket,
      prefix:    prefix || null,
      delimiter,
      folders,
      count:     folders.length,
    },
    url,
  };
}

// ── folder.delete ─────────────────────────────────────────────────────
// S3 has no folder-delete primitive. We:
//   1. list every object under the prefix (paginated)
//   2. delete them in batches of 1000 via the MultiObjectDelete API
//   3. delete the folder placeholder object if it exists
export async function folderDelete(auth, input, signal) {
  const { bucket, prefix, timeoutMs = 60000 } = input || {};
  if (!bucket) throw new Error("operation=folder.delete requires bucket");
  if (!prefix) throw new Error("operation=folder.delete requires prefix (folder path)");

  const normPrefix = String(prefix).endsWith("/") ? prefix : prefix + "/";
  let token = null;
  let totalDeleted = 0;
  let totalErrors  = 0;

  do {
    // List up to 1000 keys.
    const listUrl = buildUrl(auth, {
      bucket,
      query: { "list-type": "2", prefix: normPrefix, "max-keys": "1000", ...(token ? { "continuation-token": token } : {}) },
    });
    const { body: listBody } = await s3Fetch(auth, { method: "GET", url: listUrl }, timeoutMs, signal);
    const listXml = listBody.toString("utf8");
    const keys = xmlAll(listXml, "Contents").map(c => xmlText(c, "Key")).filter(Boolean);
    token = xmlText(listXml, "IsTruncated") === "true" ? xmlText(listXml, "NextContinuationToken") : null;

    if (keys.length === 0) break;

    // Build the bulk delete XML.
    const deleteXml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        keys.map(k => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("") +
        `<Quiet>false</Quiet>` +
      `</Delete>`;
    const md5 = await md5Base64(deleteXml);

    const delUrl = buildUrl(auth, { bucket, query: { delete: "" } });
    const { body: delBody } = await s3Fetch(
      auth,
      {
        method: "POST",
        url:    delUrl,
        headers: { "Content-Type": "application/xml", "Content-MD5": md5 },
        body:   deleteXml,
      },
      timeoutMs,
      signal,
    );
    const delResXml = delBody.toString("utf8");
    totalDeleted += xmlAll(delResXml, "Deleted").length;
    totalErrors  += xmlAll(delResXml, "Error").length;
  } while (token);

  return {
    status: 200,
    result: { bucket, prefix: normPrefix, deleted: totalDeleted, errors: totalErrors },
    url:    buildUrl(auth, { bucket }),
  };
}

// crypto.subtle.digest requires async; pull it in from node:crypto.
async function md5Base64(text) {
  const { createHash } = await import("node:crypto");
  return createHash("md5").update(text).digest("base64");
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&apos;");
}

// Operation → handler map. Single source of truth used by index.js.
export const OPERATIONS = {
  "bucket.getAll":  bucketGetAll,
  "bucket.create":  bucketCreate,
  "bucket.delete":  bucketDelete,
  "bucket.search":  bucketSearch,
  "file.getAll":    fileGetAll,
  "file.upload":    fileUpload,
  "file.download":  fileDownload,
  "file.copy":      fileCopy,
  "file.delete":    fileDelete,
  "folder.create":  folderCreate,
  "folder.getAll":  folderGetAll,
  "folder.delete":  folderDelete,
};
