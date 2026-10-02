/**
 * SiteOne WordPress ↔ ChatGPT bridge
 * Bootstrap only. Runtime concerns are separated under ./lib for testability.
 */

import http from "node:http";
import { createBridgeSecurity } from "./lib/auth.js";
import { createFileActivityStore, inferMutationActivity, outcomeFromStatus } from "./lib/activity.js";
import { loadConfig, loadEnvFile } from "./lib/config.js";
import { createRouteHandler } from "./lib/handlers.js";
import { writeBridgeError } from "./lib/http.js";
import { createFileIdempotencyStore } from "./lib/idempotency.js";
import { createFileBulkOperationStore } from "./lib/bulk-operations.js";
import { createWordPressClient } from "./lib/wordpress.js";
import { createSiteControlHandler } from "./lib/site-control.js";

loadEnvFile();

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (err) {
  console.error(`Configuration error: ${err?.message || "Invalid configuration."}`);
  process.exit(1);
}

const wordpress = createWordPressClient(cfg);
const security = createBridgeSecurity(cfg);
const idempotency = createFileIdempotencyStore({
  filePath: cfg.idempotencyStorePath,
  retentionMs: cfg.idempotencyRetentionHours * 60 * 60 * 1000,
  maxRecords: cfg.idempotencyMaxRecords,
});
const activity = createFileActivityStore({
  filePath: cfg.activityStorePath,
  retentionMs: cfg.activityRetentionDays * 24 * 60 * 60 * 1000,
  maxRecords: cfg.activityMaxRecords,
});
const bulkOperations = createFileBulkOperationStore({
  filePath: cfg.bulkOperationStorePath,
  retentionMs: cfg.bulkOperationRetentionHours * 60 * 60 * 1000,
  maxRecords: cfg.bulkOperationMaxRecords,
});
const route = createRouteHandler({ cfg, wordpress, security, idempotency, activity, bulkOperations });
const siteControl = createSiteControlHandler({ cfg, security });

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const pathname = String(req.url || "").split("?")[0];
  try {
    if (pathname.startsWith("/v1/site-control/")) await siteControl(req, res);
    else await route(req, res);
  } catch (err) {
    const requestId = String(res.getHeader("x-request-id") || "") || undefined;
    if (!res.headersSent) {
      writeBridgeError(res, err, requestId);
    } else {
      res.destroy();
    }
  } finally {
    const requestId = String(res.getHeader("x-request-id") || "");
    const effective = req.bridgeTarget || { method: req.method, path: pathname };
    const inferred = inferMutationActivity(effective.method, effective.path);
    if (requestId && inferred) {
      try {
        activity.upsertByRequestId(requestId, {
          time: new Date(started).toISOString(),
          method: effective.method,
          path: effective.path,
          status: res.statusCode,
          outcome:
            String(res.getHeader("x-wpbridge-outcome") || res.getHeader("x-idempotency-state") || "") === "unknown"
              ? "unknown"
              : outcomeFromStatus(res.statusCode),
          ...inferred,
        });
      } catch (activityError) {
        console.error(`Activity log error: ${activityError?.message || "failed to persist activity"}`);
      }
    }
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        method: req.method,
        path: pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      })
    );
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`WordPress bridge listening on http://${cfg.host}:${cfg.port}`);
  console.log(`Target WordPress site: ${cfg.wpUrl}`);
  console.log(`Publishing enabled: ${cfg.allowPublish}`);
  console.log(`Live edits enabled: ${cfg.allowLiveEdits}`);
  console.log(`Idempotency store: ${idempotency.stats().file}`);
  console.log(`Activity store: ${activity.stats().file}`);
  console.log(`Bulk operation store: ${bulkOperations.stats().file}`);
});
