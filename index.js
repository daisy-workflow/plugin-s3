// s3 — generic S3-compatible storage from a workflow. The action is
// selected per-node via the `operation` input. Mirrors n8n's S3 node
// (the generic one, not the AWS-specific node).
//
// Wire it up:
//   1. `docker compose -f docker-compose.yml -f docker-compose.plugins.yml \
//          --profile s3 up -d`
//      `npm run install-plugin -- --endpoint http://daisy-s3:8080`
//   2. Create a workspace `generic` config named "s3" with:
//        endpoint, region, accessKeyId, secretAccessKey, forcePathStyle?
//   3. Use the node in any workflow.

import { servePlugin } from "@daisy-workflow/plugin-sdk";
import fs from "node:fs";

import { loadS3Auth } from "./lib/client.js";
import { OPERATIONS } from "./lib/actions.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);

servePlugin({
  manifest,
  async execute(input, ctx) {
    const { operation, config = "s3" } = input || {};
    if (!operation) throw new Error("`operation` is required (see manifest enum for valid values)");

    const handler = OPERATIONS[operation];
    if (!handler) {
      throw new Error(
        `unknown operation "${operation}". Valid: ${Object.keys(OPERATIONS).join(", ")}`,
      );
    }

    // One auth lookup per call. The signer derives a fresh signing key
    // per request, so we never cache signed material here.
    const auth = loadS3Auth(ctx, config, input?.region);

    const { status, result, url } = await handler(auth, input, ctx?.signal);

    return {
      ok:        true,
      operation,
      status,
      result,
      url,
    };
  },
  async readyz() { return true; },
});
