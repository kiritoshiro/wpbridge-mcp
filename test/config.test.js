import test from "node:test";
import assert from "node:assert/strict";
import {
  assertListenerAllowed,
  buildWpRestUrl,
  clientIp,
  loadConfig,
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

test("WordPress subdirectory is preserved in REST targets", () => {
  const wpUrl = normalizeWpUrl("https://example.test/wordpress/");
  assert.equal(wpUrl, "https://example.test/wordpress");
  assert.equal(
    buildWpRestUrl(wpUrl, "/wp-json/wp/v2/posts/42?context=edit").toString(),
    "https://example.test/wordpress/wp-json/wp/v2/posts/42?context=edit"
  );
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
