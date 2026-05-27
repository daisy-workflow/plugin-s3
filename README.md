# s3 plugin for Daisy AI Orchestrator

One Daisy node that talks to any **S3-compatible** storage service.
Tested with AWS S3, Wasabi, MinIO, Cloudflare R2, DigitalOcean Spaces,
and Backblaze B2. Modeled on n8n's
[generic S3 node](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.s3/).


[![Docker Hub](https://img.shields.io/badge/Docker%20Hub-Image-blue?logo=docker)](https://hub.docker.com/repository/docker/vivek13186/daisy-plugin-asw-s3)

The action is selected per-node via the **operation** dropdown.

## Operations

| operation | What it does |
|---|---|
| `bucket.getAll` | List all buckets the credential has access to. |
| `bucket.create` | Create a new bucket. Sends a `LocationConstraint` body when region ≠ us-east-1. |
| `bucket.delete` | Delete a bucket (bucket must be empty). |
| `bucket.search` | List objects in a bucket matching a `prefix` (alias of `file.getAll`). |
| `file.getAll`   | List objects with optional `prefix` + pagination (`continuationToken`). |
| `file.upload`   | PUT an object. Body can be plain text (`utf8`) or `base64` for binary. |
| `file.download` | GET an object. Body returned as `base64` (default) or `utf8`. |
| `file.copy`     | Copy an object from `copySource` (`srcBucket/srcKey`) to `bucket/key`. |
| `file.delete`   | Delete an object. |
| `folder.create` | Create a "folder" placeholder (empty object with key ending in `/`). |
| `folder.getAll` | List "folders" using `delimiter` (default `/`) → CommonPrefixes. |
| `folder.delete` | Recursively delete everything under a prefix via bulk MultiObjectDelete. |

## Configure auth

Create one **generic** config on the **Configurations** page (default
name `s3`):

| Key               | Example                                | Notes                                        |
|-------------------|----------------------------------------|----------------------------------------------|
| `endpoint`        | `https://s3.amazonaws.com`             | AWS                                          |
| `endpoint`        | `https://s3.wasabisys.com`             | Wasabi                                       |
| `endpoint`        | `http://minio:9000`                    | MinIO                                        |
| `endpoint`        | `https://<account>.r2.cloudflarestorage.com` | Cloudflare R2                          |
| `region`          | `us-east-1` / `eu-central-1` / `auto`  | R2 uses `auto`                               |
| `accessKeyId`     | …                                      |                                              |
| `secretAccessKey` | …                                      |                                              |
| `sessionToken`    | …                                      | Optional, for STS / role-assumed credentials |
| `forcePathStyle`  | `true`                                 | Required for MinIO and most on-prem setups   |

A node can override the config name per-call via the `config` input and
the region per-call via the `region` input — useful if a workspace
talks to multiple S3-compatible stores.

## Setting file permissions (Wasabi, S3)

Use the `acl` input on `file.upload` (or `bucket.create` / `folder.create`):

- `private`, `public-read`, `public-read-write`, `authenticated-read`
- `bucket-owner-read`, `bucket-owner-full-control`

Wasabi enforces ACLs via the same `x-amz-acl` header AWS uses. Some
buckets have ACLs disabled — in that case Wasabi will return an
`AccessControlListNotSupported` error and you need to manage permissions
via bucket policy instead.

## Install

```bash
docker compose -f docker-compose.yml -f docker-compose.plugins.yml \
  --profile s3 up -d

npm run install-plugin -- --endpoint http://daisy-s3:8080
```

## Per-operation inputs

The manifest declares every input as optional except `operation`; each
handler checks its own required fields and returns a clear error if
they're missing.

- `bucket.getAll` — *(none)*
- `bucket.create` — `bucket` (required), `acl`
- `bucket.delete` — `bucket` (required)
- `bucket.search` — `bucket` (required), `prefix`, `maxKeys`, `continuationToken`
- `file.getAll`   — `bucket` (required), `prefix`, `maxKeys`, `continuationToken`
- `file.upload`   — `bucket` + `key` (required), `body`, `bodyEncoding` (`utf8`|`base64`), `contentType`, `metadata`, `acl`
- `file.download` — `bucket` + `key` (required), `responseEncoding` (`base64`|`utf8`)
- `file.copy`     — `bucket` + `key` (dest, required), `copySource` (`srcBucket/srcKey`, required)
- `file.delete`   — `bucket` + `key` (required)
- `folder.create` — `bucket` + `folderName` (required), `acl`
- `folder.getAll` — `bucket` (required), `prefix`, `delimiter`
- `folder.delete` — `bucket` + `prefix` (required) — paginates + bulk-deletes

Shared by every op: `config`, `region`, `timeoutMs`.

## Output envelope

```json
{
  "ok":        true,
  "operation": "file.upload",
  "status":    200,
  "result":    { "bucket": "logs", "key": "2026/05/event.json", "size": 412, "etag": "ab12..." },
  "url":       "https://logs.s3.amazonaws.com/2026/05/event.json"
}
```

Operation-specific `result` shapes are documented inline in
`lib/actions.js`. A few highlights:

- `bucket.getAll` → `{ owner, buckets: [{ name, creationDate }], count }`
- `file.getAll`   → `{ bucket, prefix, isTruncated, nextContinuationToken, keyCount, objects: [{ key, lastModified, etag, size, storageClass }] }`
- `file.download` → `{ bucket, key, contentType, contentLength, etag, lastModified, encoding, data }`
- `folder.delete` → `{ bucket, prefix, deleted, errors }`

## Auth model — why hand-rolled SigV4?

This plugin signs every request itself with Node's built-in `node:crypto`
(see `lib/sigv4.js`). That keeps the container image tiny and the
dependency surface at exactly one package (the Daisy plugin SDK). The
signer is ~150 lines and is verified against AWS's published test
vectors during build.

If you ever need features that go beyond the basics — multipart upload,
presigned URLs, transfer acceleration, virtual-hosted requester-pays,
event subscriptions — the right move is to drop in `@aws-sdk/client-s3`
and add a new operation that uses it. Don't extend the hand-rolled
signer for niche cases.

## Files

```
plugins-external/s3/
├── manifest.json        # node schema (inputs + outputs)
├── index.js             # servePlugin entry, dispatches by operation
├── lib/
│   ├── sigv4.js         # AWS Signature Version 4 signer (no deps)
│   ├── client.js        # auth loader + signed fetch + tiny XML helpers
│   └── actions.js       # one async handler per operation
├── package.json
├── Dockerfile
├── publish-docker.sh
└── README.md
```

## Publish the image

```bash
docker login                       # one time, as your Hub user
./publish-docker.sh                # builds + pushes :0.1.0 and :latest, multi-arch
```

Env overrides: `IMAGE=foo/bar`, `PLATFORMS=linux/amd64`, `PUSH=0`, `NO_LATEST=1`.
