import test from "node:test";
import assert from "node:assert/strict";
import {
  assertListenerAllowed,
  buildWpRestUrl,
  clientIp,
  loadConfig,
  normalizePublicBaseUrl,
  normalizeWpUrl,
  parseBooleanSetting,
  parseDefaultAuthor,
  parseIntegerSetting,
  parseTrustedProxyIps,
} from "../lib/config.js";

test("numeric settings accept bounded integers", () => {
  assert.equal(parseIntegerSetting({ PORT: "8787" }, "PORT", 1, { min: 1, max: 65535 }), 8787);
});

test("numeric settings reject non-numeric, fractional, and out-of-range values", () => {
  for (const value of ["abc", "12.5", "NaN", "0", "65536"]) {
    assert.throws(
      () => parseIntegerSetting({ PORT: value }, "PORT", 8787, { min: 1, max: 65535 }),
      /PORT must/
    );
  }
});

test("boolean settings are explicit", () => {
  assert.equal(parseBooleanSetting({ FLAG: "true" }, "FLAG"), true);
  assert.equal(parseBooleanSetting({ FLAG: "FALSE" }, "FLAG"), false);
  assert.throws(() => parseBooleanSetting({ FLAG: "yes" }, "FLAG"), /true or false/);
});

test("calendar controls are disabled by default and explicitly enabled", () => {
  const base = {
    WP_URL: "https://example.test/wordpress",
    WP_USERNAME: "bridge",
    WP_APP_PASSWORD: "app-password",
    BRIDGE_API_KEY: "k".repeat(40),
  };
  assert.equal(loadConfig(base).calendarEnabled, false);
  assert.equal(loadConfig({ ...base, CALENDAR_ENABLED: "true" }).calendarEnabled, true);
  assert.throws(() => loadConfig({ ...base, CALENDAR_ENABLED: "yes" }), /CALENDAR_ENABLED must be either true or false/);
});

test("WordPress subdirectory is preserved in REST targets", () => {
  const wpUrl = normalizeWpUrl("https://example.test/wordpress/");
  assert.equal(wpUrl, "https://example.test/wordpress");
  assert.equal(
    buildWpRestUrl(wpUrl, "/wp-json/wp/v2/posts/42?context=edit").toString(),
    "https://example.test/wordpress/wp-json/wp/v2/posts/42?context=edit"
  );
});

test("public base URL is optional but must be HTTPS without credentials or query state", () => {
  assert.equal(normalizePublicBaseUrl(""), null);
  assert.equal(normalizePublicBaseUrl("https://bridge.example.test/"), "https://bridge.example.test");
  assert.throws(() => normalizePublicBaseUrl("http://bridge.example.test"), /HTTPS/);
  assert.throws(() => normalizePublicBaseUrl("https://user:pass@bridge.example.test"), /credentials/);
  assert.throws(() => normalizePublicBaseUrl("https://bridge.example.test/?token=1"), /query string/);
});

test("external listener binding requires an explicit opt-in", () => {
  assert.doesNotThrow(() => assertListenerAllowed("127.0.0.1", false));
  assert.doesNotThrow(() => assertListenerAllowed("::1", false));
  assert.throws(() => assertListenerAllowed("0.0.0.0", false), /ALLOW_EXTERNAL_ACCESS=true/);
  assert.doesNotThrow(() => assertListenerAllowed("0.0.0.0", true));
});

test("forwarded IP headers are ignored unless the direct peer is trusted", () => {
  const trusted = parseTrustedProxyIps("127.0.0.1,::1");
  const spoofed = {
    socket: { remoteAddress: "203.0.113.10" },
    headers: { "cf-connecting-ip": "198.51.100.8", "x-forwarded-for": "198.51.100.9" },
  };
  assert.equal(clientIp(spoofed, trusted), "203.0.113.10");

  const proxied = {
    socket: { remoteAddress: "::ffff:127.0.0.1" },
    headers: { "cf-connecting-ip": "198.51.100.8" },
  };
  assert.equal(clientIp(proxied, trusted), "198.51.100.8");
});

test("trusted proxy setting rejects malformed IPs", () => {
  assert.throws(() => parseTrustedProxyIps("127.0.0.1,not-an-ip"), /invalid IP address/);
});


test("activity history configuration is strictly validated", () => {
  const base = {
    WP_URL: "https://example.test/wordpress",
    WP_USERNAME: "bridge",
    WP_APP_PASSWORD: "app-password",
    BRIDGE_API_KEY: "k".repeat(40),
  };
  const cfg = loadConfig({
    ...base,
    ACTIVITY_RETENTION_DAYS: "45",
    ACTIVITY_MAX_RECORDS: "3000",
    ACTIVITY_STORE_PATH: ".data/custom-activity.json",
  });
  assert.equal(cfg.activityRetentionDays, 45);
  assert.equal(cfg.activityMaxRecords, 3000);
  assert.equal(cfg.activityStorePath, ".data/custom-activity.json");

  assert.throws(() => loadConfig({ ...base, ACTIVITY_RETENTION_DAYS: "0" }), /ACTIVITY_RETENTION_DAYS must/);
  assert.throws(() => loadConfig({ ...base, ACTIVITY_MAX_RECORDS: "9" }), /ACTIVITY_MAX_RECORDS must/);
  assert.throws(() => loadConfig({ ...base, ACTIVITY_STORE_PATH: "   " }), /ACTIVITY_STORE_PATH must not be empty/);
});

test("prepared bulk operation settings are bounded and configurable", () => {
  const base = {
    WP_URL: "https://example.test/wordpress",
    WP_USERNAME: "bridge",
    WP_APP_PASSWORD: "app-password",
    BRIDGE_API_KEY: "k".repeat(40),
  };
  const cfg = loadConfig({
    ...base,
    BULK_OPERATION_STORE_PATH: ".data/bulk.json",
    BULK_OPERATION_RETENTION_HOURS: "48",
    BULK_OPERATION_MAX_RECORDS: "40",
    BULK_OPERATION_MAX_ITEMS: "500",
    BULK_OPERATION_LARGE_THRESHOLD: "80",
    BULK_OPERATION_CHUNK_SIZE: "10",
  });
  assert.equal(cfg.bulkOperationStorePath, ".data/bulk.json");
  assert.equal(cfg.bulkOperationRetentionHours, 48);
  assert.equal(cfg.bulkOperationMaxRecords, 40);
  assert.equal(cfg.bulkOperationMaxItems, 500);
  assert.equal(cfg.bulkOperationLargeThreshold, 80);
  assert.equal(cfg.bulkOperationChunkSize, 10);
  assert.throws(() => loadConfig({ ...base, BULK_OPERATION_MAX_ITEMS: "99" }), /BULK_OPERATION_MAX_ITEMS must/);
  assert.throws(() => loadConfig({ ...base, BULK_OPERATION_STORE_PATH: " " }), /BULK_OPERATION_STORE_PATH must not be empty/);
});

test("conversation image limits and optimization settings are bounded and consistent", () => {
  const base = {
    WP_URL: "https://example.test/wordpress",
    WP_USERNAME: "bridge",
    WP_APP_PASSWORD: "app-password",
    BRIDGE_API_KEY: "k".repeat(40),
  };
  const cfg = loadConfig({
    ...base,
    MAX_MEDIA_BYTES: "30000000",
    MAX_SOURCE_IMAGE_BYTES: "30000000",
    MAX_SOURCE_IMAGE_BATCH_BYTES: "50000000",
    IMAGE_OPTIMIZE_THRESHOLD_BYTES: "1500000",
    IMAGE_OPTIMIZE_MAX_DIMENSION: "1920",
    IMAGE_OPTIMIZE_QUALITY: "82",
    MAX_ARCHIVE_ENTRIES: "1000",
    MAX_EXTRACTED_IMAGES: "50",
  });
  assert.equal(cfg.maxMediaBytes, 30_000_000);
  assert.equal(cfg.maxSourceImageBytes, 30_000_000);
  assert.equal(cfg.maxSourceImageBatchBytes, 50_000_000);
  assert.equal(cfg.imageOptimizeThresholdBytes, 1_500_000);
  assert.equal(cfg.imageOptimizeMaxDimension, 1920);
  assert.equal(cfg.imageOptimizeQuality, 82);
  assert.equal(cfg.maxArchiveEntries, 1000);
  assert.equal(cfg.maxExtractedImages, 50);
  assert.throws(() => loadConfig({ ...base, MAX_MEDIA_BYTES: "30000000", MAX_SOURCE_IMAGE_BYTES: "29999999" }), /at least MAX_MEDIA_BYTES/);
  assert.throws(() => loadConfig({ ...base, MAX_SOURCE_IMAGE_BYTES: "30000000", MAX_SOURCE_IMAGE_BATCH_BYTES: "10000000" }), /at least MAX_SOURCE_IMAGE_BYTES/);
  assert.throws(() => loadConfig({ ...base, MAX_SOURCE_IMAGE_BYTES: "30000000", IMAGE_OPTIMIZE_THRESHOLD_BYTES: "30000001" }), /must not exceed MAX_SOURCE_IMAGE_BYTES/);
  assert.throws(() => loadConfig({ ...base, MAX_MEDIA_BYTES: "30000001" }), /MAX_MEDIA_BYTES must/);
});

test("media upload defaults provide 30 MB decoded-file and base64 body headroom", () => {
  const cfg = loadConfig({
    WP_URL: "https://example.test/wordpress",
    WP_USERNAME: "bridge",
    WP_APP_PASSWORD: "app-password",
    BRIDGE_API_KEY: "k".repeat(40),
  });
  assert.equal(cfg.maxBodyBytes, 42_000_000);
  assert.equal(cfg.maxMediaBytes, 30_000_000);
  assert.equal(cfg.maxSourceImageBytes, 30_000_000);
  assert.equal(cfg.maxSourceImageBatchBytes, 50_000_000);
});

test("large content response limit is bounded and configurable", () => {
  const base = {
    WP_URL: "https://example.test/wordpress",
    WP_USERNAME: "bridge",
    WP_APP_PASSWORD: "app-password",
    BRIDGE_API_KEY: "k".repeat(40),
  };
  const cfg = loadConfig({ ...base, MAX_CONTENT_RESPONSE_CHARS: "32000" });
  assert.equal(cfg.maxContentResponseChars, 32_000);
  assert.throws(() => loadConfig({ ...base, MAX_CONTENT_RESPONSE_CHARS: "3999" }), /MAX_CONTENT_RESPONSE_CHARS must/);
  assert.throws(() => loadConfig({ ...base, MAX_CONTENT_RESPONSE_CHARS: "200001" }), /MAX_CONTENT_RESPONSE_CHARS must/);
});

test("media download limit is independently bounded for OpenAI file responses", () => {
  const base = {
    WP_URL: "https://example.test/wordpress",
    WP_USERNAME: "bridge",
    WP_APP_PASSWORD: "app-password",
    BRIDGE_API_KEY: "k".repeat(40),
  };
  const cfg = loadConfig({ ...base, MAX_MEDIA_BYTES: "30000000", MAX_MEDIA_DOWNLOAD_BYTES: "10000000" });
  assert.equal(cfg.maxMediaBytes, 30_000_000);
  assert.equal(cfg.maxMediaDownloadBytes, 10_000_000);
  assert.throws(() => loadConfig({ ...base, MAX_MEDIA_DOWNLOAD_BYTES: "10000001" }), /MAX_MEDIA_DOWNLOAD_BYTES must/);
});


test("default author accepts a positive user ID or exact name/slug", () => {
  assert.deepEqual(parseDefaultAuthor("42"), { kind: "id", value: 42, raw: "42" });
  assert.deepEqual(parseDefaultAuthor("SiteOne.lt"), {
    kind: "name",
    value: "SiteOne.lt",
    raw: "SiteOne.lt",
  });
  assert.equal(parseDefaultAuthor("   "), null);
  assert.throws(() => parseDefaultAuthor("0"), /positive safe integers/);
});

test("enforcing a default author requires DEFAULT_AUTHOR", () => {
  const base = {
    WP_URL: "https://example.test/wordpress",
    WP_USERNAME: "bridge",
    WP_APP_PASSWORD: "app-password",
    BRIDGE_API_KEY: "k".repeat(40),
  };
  assert.throws(
    () => loadConfig({ ...base, ENFORCE_DEFAULT_AUTHOR: "true" }),
    /requires DEFAULT_AUTHOR/
  );
  const cfg = loadConfig({
    ...base,
    DEFAULT_AUTHOR: "SiteOne.lt",
    ENFORCE_DEFAULT_AUTHOR: "true",
  });
  assert.equal(cfg.defaultAuthor.value, "SiteOne.lt");
  assert.equal(cfg.enforceDefaultAuthor, true);
});
