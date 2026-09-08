export function integer(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    const err = new Error(`${name} must be an integer between ${min} and ${max}.`);
    err.status = 400;
    throw err;
  }
  return n;
}

export function optionalIdArray(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    const err = new Error(`${name} must be an array with at most 100 numeric IDs.`);
    err.status = 400;
    throw err;
  }
  return value.map((v) => integer(v, name));
}

export function optionalString(value, name, maxLen) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLen) {
    const err = new Error(`${name} must be a string no longer than ${maxLen} characters.`);
    err.status = 400;
    throw err;
  }
  return value;
}

export function futureGmtForWordPress(value, now = Date.now()) {
  const raw = optionalString(value, "scheduled_for_gmt", 20);
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw)) {
    const err = new Error(
      'scheduled_for_gmt must be a UTC timestamp in the form "YYYY-MM-DDTHH:MM:SSZ".'
    );
    err.status = 400;
    err.code = "invalid_schedule_time";
    throw err;
  }

  const ms = Date.parse(raw);
  const normalized = Number.isFinite(ms) ? new Date(ms).toISOString().replace(".000Z", "Z") : "";
  if (!Number.isFinite(ms) || normalized !== raw) {
    const err = new Error("scheduled_for_gmt is not a valid calendar date/time.");
    err.status = 400;
    err.code = "invalid_schedule_time";
    throw err;
  }
  if (ms <= now + 60_000) {
    const err = new Error("scheduled_for_gmt must be at least 60 seconds in the future.");
    err.status = 400;
    err.code = "schedule_time_not_future";
    throw err;
  }
  return raw.slice(0, -1);
}
