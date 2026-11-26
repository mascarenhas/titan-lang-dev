#!/usr/bin/env node
/**
 * Publishes and verifies content-hashed playground asset versions on R2.
 *
 * A version is the directory staged by `scripts/build-playground-assets.mjs`:
 *
 *   <dir>/playground-assets.json   manifest (byte-identical to the versioned copy)
 *   <dir>/<hash>/<path>            one file per manifest asset row
 *
 * and is served from `https://cdn.titan-lang.dev/playground/<hash>/`.
 *
 * Publish (S3 API, needs R2 credentials):
 *   node scripts/upload-r2.mjs --dir <staged-dir> [--dry-run]
 *
 *   Verifies every staged row (bytes, SHA-256, manifest hash), then uploads
 *   assets first and `<hash>/playground-assets.json` last, so a version URL is
 *   never half-published. Each buffer is checked against its row again right
 *   before it is sent. Objects are immutable: every PUT is create-only
 *   (`If-None-Match: *`). An existing object holding the same row (size,
 *   `x-amz-meta-sha256`, Content-Type, Cache-Control) is skipped, and one
 *   holding anything else stops the run.
 *   Environment: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and
 *   R2_ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID, or an explicit R2_ENDPOINT).
 *   `--dry-run` prints the plan and needs credentials only to report which
 *   objects are already present.
 *
 * Verify (public HTTPS, no credentials):
 *   node scripts/upload-r2.mjs --verify-live --manifest <file> --titan-revision <commit>
 *                              [--base <url>] [--download <dir>]
 *
 *   Requires the manifest's titanRevision to equal the pinned full commit ID,
 *   the live `<hash>/playground-assets.json` to equal <file> byte for byte,
 *   and every asset to be served with status 200, its exact bytes and
 *   SHA-256, the manifest MIME type, the immutable Cache-Control, and
 *   `Access-Control-Allow-Origin: *`. `--download` stages the verified version
 *   in the same layout as the build script. Exit status 3 means the version is
 *   not published at all (its manifest is absent); 1 means any other failure.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const MANIFEST_NAME = "playground-assets.json";
const KEY_PREFIX = "playground/";
const DEFAULT_BASE = "https://cdn.titan-lang.dev/playground/";
const IMMUTABLE = "public, max-age=31536000, immutable";
const MANIFEST_MIME = "application/json";
const CONCURRENCY = 4;
const EXIT_NOT_PUBLISHED = 3;
// Verification sends a cross-origin request so the CORS policy is exercised.
const VERIFY_ORIGIN = "https://titan-lang.dev";

class NotPublished extends Error {}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

// CONTRACTS.md §2: the hash covers exactly these keys, in this order.
function manifestHash(manifest) {
  return sha256(
    JSON.stringify({
      schema: 1,
      titanRevision: manifest.titanRevision,
      profile: "validation",
      assets: manifest.assets.map(({ path, tier, bytes, sha256, mime }) => ({ path, tier, bytes, sha256, mime })),
    }),
  );
}

function parseManifest(bytes, source) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${source}: invalid JSON (${error.message})`);
  }
  const bad = (why) => fail(`${source}: ${why}`);
  if (manifest?.schema !== 1) bad("schema must be 1");
  if (manifest.profile !== "validation") bad("profile must be 'validation'");
  if (typeof manifest.titanRevision !== "string" || !manifest.titanRevision) bad("missing titanRevision");
  if (!/^[0-9a-f]{64}$/.test(manifest.hash ?? "")) bad("hash must be lowercase hex SHA-256");
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) bad("assets must be a non-empty array");
  let previous = null;
  for (const row of manifest.assets) {
    const { path: p, tier, bytes: size, sha256: digest, mime } = row ?? {};
    if (typeof p !== "string" || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p)) bad(`invalid asset path ${JSON.stringify(p)}`);
    if (p.split("/").some((segment) => segment === "." || segment === "..")) bad(`invalid asset path ${p}`);
    if (p === MANIFEST_NAME) bad(`asset path ${p} collides with the manifest`);
    if (previous !== null && !(previous < p)) bad(`asset rows are not sorted and unique at ${p}`);
    if (tier !== 1 && tier !== 2) bad(`${p}: tier must be 1 or 2`);
    if (!Number.isSafeInteger(size) || size < 0) bad(`${p}: bytes must be a non-negative integer`);
    if (!/^[0-9a-f]{64}$/.test(digest ?? "")) bad(`${p}: sha256 must be lowercase hex`);
    if (typeof mime !== "string" || !mime) bad(`${p}: missing mime`);
    previous = p;
  }
  if (manifestHash(manifest) !== manifest.hash) bad(`hash ${manifest.hash} does not match the manifest contents`);
  return manifest;
}

function checkPayload(row, bytes, where) {
  if (bytes.length !== row.bytes) fail(`${where}: ${bytes.length} bytes, manifest says ${row.bytes}`);
  const digest = sha256(bytes);
  if (digest !== row.sha256) fail(`${where}: sha256 ${digest}, manifest says ${row.sha256}`);
}

async function eachLimited(items, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) await worker(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
}

function formatBytes(n) {
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${n} B`;
}

// ---------------------------------------------------------------------------
// Minimal S3 client (AWS Signature Version 4, region "auto") for the R2 API.

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function encodeKey(key) {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

function r2Client({ endpoint, bucket, accessKeyId, secretAccessKey }) {
  const base = new URL(endpoint);
  const host = base.host;
  const region = "auto";

  async function request(method, key, { body, headers = {} } = {}) {
    const uri = `/${bucket}/${encodeKey(key)}`;
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? Buffer.alloc(0));
    const all = { ...headers, host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const names = Object.keys(all).map((name) => name.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(all).map(([name, value]) => [name.toLowerCase(), String(value).trim()]));
    const signedHeaders = names.join(";");
    // Each canonical header line ends in "\n", so the join leaves the blank line SigV4 requires.
    const canonicalHeaders = names.map((name) => `${name}:${lower[name]}\n`).join("");
    const canonical = [method, uri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(Buffer.from(canonical))].join("\n");
    let key4 = hmac(`AWS4${secretAccessKey}`, date);
    for (const part of [region, "s3", "aws4_request"]) key4 = hmac(key4, part);
    const signature = crypto.createHmac("sha256", key4).update(toSign).digest("hex");
    // fetch derives Host from the URL; it was signed above and must not be sent twice.
    const { host: _host, ...sent } = lower;
    sent.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return fetch(`${base.origin}${uri}`, { method, headers: sent, body });
  }

  return {
    async head(key) {
      // R2 omits Content-Length from HEAD replies it would compress; fetch asks for gzip by default.
      const response = await request("HEAD", key, { headers: { "accept-encoding": "identity" } });
      if (response.status === 404) return null;
      if (!response.ok) fail(`HEAD ${key}: HTTP ${response.status}`);
      return {
        bytes: Number(response.headers.get("content-length")),
        sha256: response.headers.get("x-amz-meta-sha256"),
        mime: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
      };
    },
    // Create-only: returns false, writing nothing, when the key already exists.
    async create(key, bytes, { mime, digest }) {
      const response = await request("PUT", key, {
        body: bytes,
        headers: { "cache-control": IMMUTABLE, "content-type": mime, "if-none-match": "*", "x-amz-meta-sha256": digest },
      });
      if (response.status === 412) return false;
      if (!response.ok) fail(`PUT ${key}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
      return true;
    },
  };
}

function credentialsFromEnv() {
  const env = process.env;
  const accountId = env.R2_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const values = {
    // R2_ENDPOINT selects a jurisdiction endpoint (e.g. <account>.eu.r2.cloudflarestorage.com).
    endpoint: env.R2_ENDPOINT || (accountId && `https://${accountId}.r2.cloudflarestorage.com`),
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
  const names = { endpoint: "R2_ACCOUNT_ID", bucket: "R2_BUCKET", accessKeyId: "R2_ACCESS_KEY_ID", secretAccessKey: "R2_SECRET_ACCESS_KEY" };
  const missing = Object.keys(values).filter((name) => !values[name]).map((name) => names[name]);
  return { values, missing };
}

// ---------------------------------------------------------------------------

async function publish({ dir, dryRun }) {
  const manifestPath = path.join(dir, MANIFEST_NAME);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = parseManifest(manifestBytes, manifestPath);
  const versionDir = path.join(dir, manifest.hash);
  const versioned = path.join(versionDir, MANIFEST_NAME);
  if (fs.existsSync(versioned) && !fs.readFileSync(versioned).equals(manifestBytes)) {
    fail(`${versioned} differs from ${manifestPath}`);
  }

  // Every staged row is checked before anything is uploaded.
  const rows = manifest.assets.map((row) => {
    const file = path.join(versionDir, ...row.path.split("/"));
    checkPayload(row, fs.readFileSync(file), file);
    return { ...row, file, key: `${KEY_PREFIX}${manifest.hash}/${row.path}` };
  });
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  console.log(`[upload-r2] version ${manifest.hash}: ${rows.length} assets, ${formatBytes(total)} (titan ${manifest.titanRevision})`);

  const { values, missing } = credentialsFromEnv();
  if (missing.length && !dryRun) fail(`missing environment: ${missing.join(", ")}`);
  const client = missing.length ? null : r2Client(values);
  if (client) console.log(`[upload-r2] bucket ${values.bucket}`);
  else console.log("[upload-r2] no R2 credentials; dry run cannot check existing objects");

  const manifestRow = { key: `${KEY_PREFIX}${manifest.hash}/${MANIFEST_NAME}`, file: manifestPath, bytes: manifestBytes.length, sha256: sha256(manifestBytes), mime: MANIFEST_MIME };
  // Keys are immutable: an existing object must hold exactly this row, or publishing stops.
  const existing = async (row) => {
    const found = await client.head(row.key);
    if (found === null) return false;
    if (found.bytes === row.bytes && found.sha256 === row.sha256 && found.mime === row.mime && found.cacheControl === IMMUTABLE) return true;
    fail(
      `${row.key} already exists with different content (${found.bytes} B, sha256 ${found.sha256}, ${found.mime}, ${found.cacheControl}); ` +
        "published objects are immutable and never overwritten",
    );
  };

  let uploaded = 0;
  let skipped = 0;
  const upload = async (row, read) => {
    if (client && (await existing(row))) {
      skipped++;
      console.log(`  present  ${row.key}`);
      return;
    }
    if (dryRun) {
      uploaded++;
      console.log(`  would put ${row.key} (${formatBytes(row.bytes)}, ${row.mime})`);
      return;
    }
    // The buffer being sent is checked again, so a file changed since preflight is never published.
    const body = read();
    checkPayload(row, body, row.file);
    if (!(await client.create(row.key, body, { mime: row.mime, digest: row.sha256 }))) {
      // Another publisher created the key between HEAD and PUT; accept only identical content.
      if (!(await existing(row))) fail(`${row.key}: create-only PUT was refused, but the object is absent`);
      skipped++;
      console.log(`  present  ${row.key} (created concurrently)`);
      return;
    }
    uploaded++;
    console.log(`  put      ${row.key} (${formatBytes(row.bytes)}, ${row.mime})`);
  };

  await eachLimited(rows, (row) => upload(row, () => fs.readFileSync(row.file)));
  // The manifest goes last: its presence marks the version complete.
  await upload(manifestRow, () => manifestBytes);
  console.log(`[upload-r2] ${dryRun ? "dry run: " : ""}${uploaded} ${dryRun ? "to upload" : "uploaded"}, ${skipped} already present`);
}

function normalizeBase(base) {
  const url = new URL(base);
  if (url.protocol !== "https:" && url.protocol !== "http:") fail(`--base must be an HTTP(S) URL: ${base}`);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}

async function verifyLive({ manifestPath, titanRevision, base, download }) {
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = parseManifest(manifestBytes, manifestPath);
  if (!/^[0-9a-f]{40}$/.test(titanRevision)) fail(`--titan-revision must be a full lowercase commit ID: ${titanRevision}`);
  if (manifest.titanRevision !== titanRevision) {
    fail(`${manifestPath} was built from Titan ${manifest.titanRevision}, but the pinned Titan revision is ${titanRevision}; rebuild and commit the pointer`);
  }
  const versionUrl = new URL(`${manifest.hash}/`, normalizeBase(base)).href;
  console.log(`[upload-r2] verifying ${versionUrl} (${manifest.assets.length} assets)`);

  const fetchChecked = async (url, mime) => {
    const response = await fetch(url, { headers: { origin: VERIFY_ORIGIN }, cache: "no-store" });
    if (!response.ok) return { response };
    const problems = [];
    const header = (name) => response.headers.get(name);
    if (header("content-type") !== mime) problems.push(`Content-Type ${header("content-type")}, expected ${mime}`);
    if (header("cache-control")?.replace(/\s+/g, "") !== IMMUTABLE.replace(/\s+/g, "")) problems.push(`Cache-Control ${header("cache-control")}`);
    if (header("access-control-allow-origin") !== "*") problems.push(`Access-Control-Allow-Origin ${header("access-control-allow-origin")}`);
    if (problems.length) fail(`${url}: ${problems.join("; ")}`);
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  };

  const live = await fetchChecked(`${versionUrl}${MANIFEST_NAME}`, MANIFEST_MIME);
  if (live.response.status === 404) {
    throw new NotPublished(`version ${manifest.hash} is not published: ${versionUrl}${MANIFEST_NAME} returned HTTP ${live.response.status}`);
  }
  if (!live.bytes) fail(`${versionUrl}${MANIFEST_NAME}: HTTP ${live.response.status}`);
  if (!live.bytes.equals(manifestBytes)) fail(`${versionUrl}${MANIFEST_NAME} differs from ${manifestPath}`);

  const target = download ? path.join(download, manifest.hash) : null;
  await eachLimited(manifest.assets, async (row) => {
    const url = `${versionUrl}${row.path}`;
    const { response, bytes } = await fetchChecked(url, row.mime);
    if (!bytes) fail(`${url}: HTTP ${response.status}`);
    checkPayload(row, bytes, url);
    if (target) {
      const file = path.join(target, ...row.path.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    console.log(`  ok  ${row.path} (${formatBytes(row.bytes)})`);
  });
  if (target) {
    fs.writeFileSync(path.join(target, MANIFEST_NAME), manifestBytes);
    fs.writeFileSync(path.join(download, MANIFEST_NAME), manifestBytes);
    console.log(`[upload-r2] staged verified version in ${download}`);
  }
  console.log(`[upload-r2] version ${manifest.hash} is live and complete`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "verify-live": { type: "boolean", default: false },
      manifest: { type: "string" },
      "titan-revision": { type: "string" },
      base: { type: "string", default: DEFAULT_BASE },
      download: { type: "string" },
    },
    strict: true,
  });
  if (values["verify-live"]) {
    if (!values.manifest || !values["titan-revision"] || values.dir || values["dry-run"]) {
      fail("usage: --verify-live --manifest <file> --titan-revision <commit> [--base <url>] [--download <dir>]");
    }
    await verifyLive({ manifestPath: values.manifest, titanRevision: values["titan-revision"], base: values.base, download: values.download });
  } else {
    if (!values.dir || values.manifest || values["titan-revision"] || values.download) fail("usage: --dir <staged-dir> [--dry-run]");
    await publish({ dir: values.dir, dryRun: values["dry-run"] });
  }
}

main().catch((error) => {
  // fetch() reports network failures as "fetch failed" with the reason in `cause`.
  const cause = error.cause?.message ? ` (${error.cause.message})` : "";
  console.error(`[upload-r2] ${error instanceof NotPublished ? "" : "error: "}${error.message}${cause}`);
  process.exit(error instanceof NotPublished ? EXIT_NOT_PUBLISHED : 1);
});
