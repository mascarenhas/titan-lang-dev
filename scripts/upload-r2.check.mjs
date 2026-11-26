#!/usr/bin/env node
// No-network check for scripts/upload-r2.mjs: drives the real CLI against an in-process
// fake S3 bucket (create-only PUT, HEAD metadata) and a static CDN over that bucket.
// Usage: node scripts/upload-r2.check.mjs
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "upload-r2.mjs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const REV = "9649f852e9e21046fc574e5c11d81f68b6393e24";

function stage(dir, { pretty = true } = {}) {
  const files = {
    "a.wasm": [Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), "application/wasm", 1],
    "b.mjs": [Buffer.from("export default 1;\n"), "text/javascript", 1],
    "vendor/c.json": [Buffer.from('{"ok":true}\n'), "application/json", 2],
  };
  const assets = Object.keys(files).sort().map((p) => ({ path: p, tier: files[p][2], bytes: files[p][0].length, sha256: sha(files[p][0]), mime: files[p][1] }));
  const hash = sha(JSON.stringify({ schema: 1, titanRevision: REV, profile: "validation", assets }));
  const body = { schema: 1, hash, titanRevision: REV, profile: "validation", assets };
  const manifest = Buffer.from(pretty ? `${JSON.stringify(body, null, 2)}\n` : JSON.stringify(body));
  fs.rmSync(dir, { recursive: true, force: true });
  for (const p of Object.keys(files)) {
    const f = path.join(dir, hash, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, files[p][0]);
  }
  fs.writeFileSync(path.join(dir, "playground-assets.json"), manifest);
  fs.writeFileSync(path.join(dir, hash, "playground-assets.json"), manifest);
  return { hash, manifest };
}

// Fake bucket: key -> { body, headers }. Hooks let a test act between requests.
const bucket = new Map();
const hooks = { onHead: null, onPut: null };
const s3 = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const key = decodeURIComponent(req.url.replace(/^\/test-bucket\//, ""));
    assert.match(req.headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=AKID\//);
    if (req.method === "HEAD") {
      hooks.onHead?.(key);
      const obj = bucket.get(key);
      if (!obj) return res.writeHead(404).end();
      return res.writeHead(200, { "content-length": obj.body.length, ...obj.headers }).end();
    }
    if (req.method === "PUT") {
      hooks.onPut?.(key);
      const body = Buffer.concat(chunks);
      assert.equal(req.headers["x-amz-content-sha256"], sha(body), "signed payload hash is the sent body");
      if (req.headers["if-none-match"] !== "*") return res.writeHead(400).end("not create-only");
      if (bucket.has(key)) return res.writeHead(412).end();
      bucket.set(key, { body, headers: { "content-type": req.headers["content-type"], "cache-control": req.headers["cache-control"], "x-amz-meta-sha256": req.headers["x-amz-meta-sha256"] } });
      return res.writeHead(200).end();
    }
    res.writeHead(405).end();
  });
});
// Static CDN over the fake bucket.
const cdn = http.createServer((req, res) => {
  const obj = bucket.get(decodeURIComponent(req.url.slice(1)));
  if (!obj) return res.writeHead(404).end();
  res.writeHead(200, { ...obj.headers, "access-control-allow-origin": "*" }).end(obj.body);
});
await new Promise((r) => s3.listen(0, "127.0.0.1", r));
await new Promise((r) => cdn.listen(0, "127.0.0.1", r));

const env = { ...process.env, R2_ENDPOINT: `http://127.0.0.1:${s3.address().port}`, R2_BUCKET: "test-bucket", R2_ACCESS_KEY_ID: "AKID", R2_SECRET_ACCESS_KEY: "secret" };
const cdnBase = `http://127.0.0.1:${cdn.address().port}/playground/`;
// The CLI runs in a child so the fake servers keep serving from this process.
async function cli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (status) => resolve({ status, out }));
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upload-r2-check-"));
const dir = path.join(tmp, "staged");
const results = [];
async function check(name, fn) {
  bucket.clear();
  hooks.onHead = hooks.onPut = null;
  await fn();
  results.push(name);
  console.log(`ok - ${name}`);
}

await check("fresh publish creates every object, manifest last", async () => {
  const { hash } = stage(dir);
  const order = [];
  hooks.onPut = (key) => order.push(key);
  const r = await cli("--dir", dir);
  assert.equal(r.status, 0, r.out);
  assert.equal(bucket.size, 4);
  assert.equal(order.at(-1), `playground/${hash}/playground-assets.json`);
});

await check("idempotent retry skips identical objects and PUTs nothing", async () => {
  stage(dir);
  assert.equal((await cli("--dir", dir)).status, 0);
  let puts = 0;
  hooks.onPut = () => puts++;
  const r = await cli("--dir", dir);
  assert.equal(r.status, 0, r.out);
  assert.equal(puts, 0);
  assert.match(r.out, /0 uploaded, 4 already present/);
});

await check("same canonical version with different manifest bytes fails without overwriting", async () => {
  const { hash, manifest } = stage(dir, { pretty: true });
  assert.equal((await cli("--dir", dir)).status, 0);
  const compact = stage(dir, { pretty: false });
  assert.equal(compact.hash, hash);
  assert.notDeepEqual(compact.manifest, manifest);
  const r = await cli("--dir", dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /playground-assets\.json already exists with different content/);
  assert.deepEqual(bucket.get(`playground/${hash}/playground-assets.json`).body, manifest);
});

await check("conflicting existing asset fails and is never overwritten", async () => {
  const { hash } = stage(dir);
  const key = `playground/${hash}/b.mjs`;
  bucket.set(key, { body: Buffer.from("export default 2;\n"), headers: { "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable", "x-amz-meta-sha256": "0".repeat(64) } });
  const r = await cli("--dir", dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /b\.mjs already exists with different content/);
  assert.equal(bucket.get(key).body.toString(), "export default 2;\n");
  assert.ok(!bucket.has(`playground/${hash}/playground-assets.json`));
});

await check("staged payload changed between preflight and send is never published", async () => {
  const { hash } = stage(dir);
  const file = path.join(dir, hash, "b.mjs");
  hooks.onHead = (key) => {
    if (key.endsWith("/b.mjs")) fs.writeFileSync(file, "export default 9;\n"); // same length
  };
  const r = await cli("--dir", dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /b\.mjs: sha256 [0-9a-f]{64}, manifest says/);
  assert.ok(!bucket.has(`playground/${hash}/b.mjs`));
  assert.ok(!bucket.has(`playground/${hash}/playground-assets.json`));
});

await check("losing a create race to identical content counts as present", async () => {
  const { hash } = stage(dir);
  const key = `playground/${hash}/a.wasm`;
  const bytes = fs.readFileSync(path.join(dir, hash, "a.wasm"));
  hooks.onPut = (k) => {
    if (k === key && !bucket.has(key)) bucket.set(key, { body: bytes, headers: { "content-type": "application/wasm", "cache-control": "public, max-age=31536000, immutable", "x-amz-meta-sha256": sha(bytes) } });
  };
  const r = await cli("--dir", dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /present {2}playground\/[0-9a-f]+\/a\.wasm \(created concurrently\)/);
});

await check("losing a create race to different content fails", async () => {
  const { hash } = stage(dir);
  const key = `playground/${hash}/a.wasm`;
  hooks.onPut = (k) => {
    if (k === key && !bucket.has(key)) bucket.set(key, { body: Buffer.from("garbage!"), headers: { "content-type": "application/wasm", "cache-control": "public, max-age=31536000, immutable", "x-amz-meta-sha256": sha(Buffer.from("garbage!")) } });
  };
  const r = await cli("--dir", dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /a\.wasm already exists with different content/);
  assert.equal(bucket.get(key).body.toString(), "garbage!");
});

await check("verify-live passes for the pinned revision and fails for a moved pin", async () => {
  stage(dir);
  assert.equal((await cli("--dir", dir)).status, 0);
  const pointer = path.join(dir, "playground-assets.json");
  const ok = await cli("--verify-live", "--manifest", pointer, "--titan-revision", REV, "--base", cdnBase);
  assert.equal(ok.status, 0, ok.out);
  const moved = await cli("--verify-live", "--manifest", pointer, "--titan-revision", "1".repeat(40), "--base", cdnBase);
  assert.equal(moved.status, 1, moved.out);
  assert.match(moved.out, /was built from Titan 9649f852.*pinned Titan revision is 1{40}/);
  const short = await cli("--verify-live", "--manifest", pointer, "--titan-revision", "9649f852", "--base", cdnBase);
  assert.equal(short.status, 1, short.out);
  assert.match(short.out, /must be a full lowercase commit ID/);
});

await check("verify-live reports an unpublished version with exit 3", async () => {
  stage(dir);
  const r = await cli("--verify-live", "--manifest", path.join(dir, "playground-assets.json"), "--titan-revision", REV, "--base", cdnBase);
  assert.equal(r.status, 3, r.out);
});

s3.close();
cdn.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${results.length} checks passed`);
