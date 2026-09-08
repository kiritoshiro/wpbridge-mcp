import test from "node:test";
import assert from "node:assert/strict";
import { createWordPressClient } from "../lib/wordpress.js";

const cfg = {
  wpUrl: "https://example.test/wordpress",
  wpUsername: "editor",
  wpAppPassword: "abcd efgh",
};

for (const operation of [
  (client) => client.wpRequest("/wp-json/wp/v2/posts", { method: "POST", body: { title: "Draft" } }),
  (client) => client.wpSeoHelperRequest("/wp-json/wpbridge/v1/seo/post/1", { method: "POST", body: { title: "SEO" } }),
  (client) => client.wpImageUpload("image.png", "image/png", Buffer.from([1])),
]) {
  test(`write response failures preserve unknown outcome (${operation.toString().match(/client\.(\w+)/)[1]})`, async () => {
    for (const failure of ["disconnect", "timeout", "invalid-json"]) {
      const client = createWordPressClient(cfg, {
        fetchImpl: async () => ({
          ok: true,
          status: 201,
          text: async () => {
            if (failure === "invalid-json") return "<html>proxy error</html>";
            const error = new Error("private transport details");
            if (failure === "timeout") error.name = "AbortError";
            throw error;
          },
        }),
      });
      await assert.rejects(() => operation(client), (error) => {
        assert.equal(error.outcomeUnknown, true);
        assert.equal(error.status, failure === "timeout" ? 504 : 502);
        assert.equal(error.message.includes("private transport details"), false);
        return true;
      });
    }
  });
}

test("read response disconnect is sanitized without claiming a mutation", async () => {
  const client = createWordPressClient(cfg, {
    fetchImpl: async () => ({ text: async () => { throw new Error("private transport details"); } }),
  });
  await assert.rejects(() => client.wpRequest("/wp-json/wp/v2/posts"), (error) =>
    error.status === 502 && error.code === "wordpress_unreachable" && !error.outcomeUnknown
  );
});

test("WordPress client preserves subdirectory path and maps network failures to 502", async () => {
  let target;
  const client = createWordPressClient(cfg, {
    fetchImpl: async (url) => {
      target = String(url);
      throw new TypeError("connect ECONNREFUSED 127.0.0.1");
    },
  });

  await assert.rejects(
    () => client.wpRequest("/wp-json/wp/v2/posts/1?context=edit"),
    (err) => err.status === 502 && err.code === "wordpress_unreachable" && !err.message.includes("ECONNREFUSED")
  );
  assert.equal(target, "https://example.test/wordpress/wp-json/wp/v2/posts/1?context=edit");
});

test("WordPress client converts aborts into explicit 504 timeouts", async () => {
  const client = createWordPressClient(cfg, {
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
  });

  await assert.rejects(
    () => client.wpRequest("/wp-json/wp/v2/posts"),
    (err) => err.status === 504 && err.code === "wordpress_timeout"
  );
});

test("WordPress client sanitizes upstream HTML error messages", async () => {
  const client = createWordPressClient(cfg, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: "rest_forbidden", message: "<b>Forbidden</b> details" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () => client.wpRequest("/wp-json/wp/v2/posts"),
    (err) => err.status === 403 && err.code === "rest_forbidden" && err.message === "Forbidden details"
  );
});

test("image uploads send raw bytes with constrained WordPress media headers", async () => {
  let captured;
  const client = createWordPressClient(cfg, {
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(JSON.stringify({ id: 44, media_type: "image", mime_type: "image/png" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const result = await client.wpImageUpload('image"unsafe.png', "image/png", data);

  assert.equal(result.id, 44);
  assert.equal(captured.url, "https://example.test/wordpress/wp-json/wp/v2/media");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["content-type"], "image/png");
  assert.equal(captured.options.headers["content-length"], String(data.length));
  assert.equal(captured.options.headers["content-disposition"], 'attachment; filename="image_unsafe.png"');
  assert.deepEqual(captured.options.body, data);
});


test("mutating WordPress timeouts are marked as unknown outcomes", async () => {
  const client = createWordPressClient(cfg, {
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
  });

  await assert.rejects(
    () => client.wpRequest("/wp-json/wp/v2/posts", { method: "POST", body: { title: "Draft" } }),
    (err) =>
      err.status === 504 &&
      err.code === "wordpress_write_timeout_outcome_unknown" &&
      err.outcomeUnknown === true
  );
});
