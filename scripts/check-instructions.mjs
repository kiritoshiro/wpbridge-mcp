import fs from "node:fs";

const file = "GPT-INSTRUCTIONS.txt";
const text = fs.readFileSync(file, "utf8");
const characters = [...text].length;
const limit = 8000;

if (characters > limit) {
  console.error(`${file} has ${characters} characters; the Custom GPT limit is ${limit}.`);
  process.exit(1);
}

for (const required of [
  "contentRead",
  "preview_token",
  "expected_modified_gmt",
  "idempotency_key",
  "outcome=unknown",
  "ALLOW_PUBLISH",
  "ALLOW_LIVE_EDITS",
  "RESTORE_ACTIVITY",
  "APPLY_BULK_EDIT",
  "untrusted",
]) {
  if (!text.includes(required)) {
    console.error(`${file} is missing required guidance: ${required}`);
    process.exit(1);
  }
}

console.log(`${file} is ${characters}/${limit} characters.`);
