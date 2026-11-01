import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "worldview-umbra-"));
writeFileSync(join(out, "package.json"), '{"type":"module"}\n');
const compile = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), resolve(root, "src/worldview-umbra.ts"), "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck", "--outDir", out], { cwd: root, encoding: "utf8" });
if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`);
const umb = await import(`${pathToFileURL(join(out, "worldview-umbra.js"))}?${Date.now()}`);
test.after(() => rmSync(out, { recursive: true, force: true }));

const xml = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/xml" } });
const listingXml = (extra = "", truncated = false) => `<ListBucketResult><Name>x</Name><Prefix>sar-data/tasks/</Prefix><KeyCount>3</KeyCount><MaxKeys>100</MaxKeys><IsTruncated>${truncated}</IsTruncated>${extra}</ListBucketResult>`;
const objectXml = (key, size = 12, extra = "") => `<Contents><Key>${key}</Key><LastModified>2024-08-28T19:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>${size}</Size>${extra}</Contents>`;

 test("listUmbra makes one bounded S3 request and classifies only returned children", async () => {
  let seen;
  const result = await umb.listUmbra(undefined, "tok", undefined, async (url, init) => { seen = { url, init }; return xml(listingXml(`<CommonPrefixes><Prefix>sar-data/tasks/a/</Prefix></CommonPrefixes>${objectXml("sar-data/tasks/a_METADATA.json")} ${objectXml("sar-data/tasks/a_GEC.tif", 42)} ${objectXml("sar-data/tasks/readme.txt", 2)}`)); });
  const u = new URL(seen.url);
  assert.equal(u.origin, umb.UMBRA_ORIGIN); assert.equal(u.searchParams.get("list-type"), "2"); assert.equal(u.searchParams.get("prefix"), "sar-data/tasks/"); assert.equal(u.searchParams.get("delimiter"), "/"); assert.equal(u.searchParams.get("max-keys"), "100"); assert.equal(u.searchParams.get("continuation-token"), "tok");
  assert.equal(seen.init.credentials, "omit"); assert.equal(seen.init.referrerPolicy, "no-referrer"); assert.equal(seen.init.redirect, "error"); assert.equal(seen.init.cache, "no-store");
  assert.deepEqual(result.folders, ["sar-data/tasks/a/"]); assert.deepEqual(result.objects.map(o => [o.kind, o.size]), [["metadata", 12], ["raster", 42], ["other", 2]]); assert.equal(result.objects[0].url, `${umb.UMBRA_ORIGIN}/sar-data/tasks/a_METADATA.json`); assert.equal(result.objects[0].etag, '"abc"'); assert.equal(result.truncated, false); assert.equal(result.skipped, 0);
 });

test("prefix/token allowlist rejects traversal, controls, and other roots", async () => {
 for (const p of ["https://evil/", "open-data/../x", "sar-data/tasks/x?y", "sar-data/tasks/x\\y", "sar-data/tasks/\nfoo"]) await assert.rejects(() => umb.listUmbra(p, undefined, undefined, async () => xml(listingXml())));
 await assert.rejects(() => umb.listUmbra("open-data/", "x\\y", undefined, async () => xml(listingXml())));
});

test("malformed XML, mismatched Prefix, oversized entry sets, and truncation are rejected without auto paging", async () => {
 await assert.rejects(() => umb.listUmbra(undefined, undefined, undefined, async () => xml("<!DOCTYPE ListBucketResult><ListBucketResult></ListBucketResult>")), /DOCTYPE/);
 await assert.rejects(() => umb.listUmbra(undefined, undefined, undefined, async () => xml("<Nope/>")), /root/);
 await assert.rejects(() => umb.listUmbra(undefined, undefined, undefined, async () => xml(listingXml().replace("sar-data/tasks/", "open-data/"))), /Prefix/);
 const many = Array.from({ length: 101 }, (_, i) => objectXml(`sar-data/tasks/${i}.txt`)).join("");
 await assert.rejects(() => umb.listUmbra(undefined, undefined, undefined, async () => xml(listingXml(many))), /100/);
 let calls = 0; const page = await umb.listUmbra(undefined, undefined, undefined, async () => { calls++; return xml(listingXml(objectXml("sar-data/tasks/x.txt"), true).replace("</ListBucketResult>", "<NextContinuationToken>next</NextContinuationToken></ListBucketResult>")); });
 assert.equal(calls, 1); assert.equal(page.truncated, true); assert.equal(page.nextToken, "next");
});

test("metadata normalization uses the genuine vendor sample and leaves unpublished times unknown", async () => {
 const raw = readFileSync(resolve(root, "tests/fixtures/umbra-metadata.json"), "utf8");
 const object = { key: "sar-data/tasks/x_MM.json", url: `${umb.UMBRA_ORIGIN}/sar-data/tasks/x_MM.json`, size: Buffer.byteLength(raw), kind: "metadata", lastModified: "2026-01-02T00:00:00Z" };
 const m = await umb.loadUmbraMetadata(object, undefined, async (url, init) => { assert.equal(url, object.url); assert.equal(init.credentials, "omit"); return new Response(raw, { status: 200 }); });
 assert.equal(m.id, "404d4431-1653-4674-91c1-30eee63e9ac9"); assert.equal(m.taskId, "9c39dad2-3539-4a7a-b755-47278c11fc96"); assert.equal(m.platform, "UMBRA_08"); assert.equal(m.sensor, "X-band SAR"); assert.equal(m.mode, "SPOTLIGHT"); assert.deepEqual(m.polarization, ["VV"]); assert.equal(m.direction, "DESCENDING"); assert.equal(m.lookDirection, "RIGHT"); assert.equal(m.productType, "GEC"); assert.equal(m.rangeResolution, 0.5); assert.equal(m.azimuthResolution, 0.5); assert.equal(m.processingTime, undefined); assert.equal(m.publicationTime, undefined); assert.equal(m.metadataCreated, undefined); assert.equal(m.objectLastModified, object.lastModified); assert.equal(m.providerLicense, "CC BY 4.0 (dataset-level AWS Registry; vendor metadata has no per-object license)"); assert.equal(m.footprint[0].length, 2); assert.match(m.attribution, /unmodified source data/);
});

test("metadata enforces one collect, validated object URL, body limit, and abort propagation", async () => {
 const object = { key: "sar-data/tasks/x_MM.json", url: `${umb.UMBRA_ORIGIN}/sar-data/tasks/x_MM.json`, size: 2, kind: "metadata" };
 await assert.rejects(() => umb.loadUmbraMetadata({ ...object, kind: "other" }, undefined, async () => new Response("{}")), /validated/);
 await assert.rejects(() => umb.loadUmbraMetadata(object, undefined, async () => new Response(JSON.stringify({ collects: [{}, {}] }))), /exactly one/);
 await assert.rejects(() => umb.loadUmbraMetadata(object, undefined, async () => new Response("x".repeat(1024 * 1024 + 1))), /exceeds/);
 const controller = new AbortController(); controller.abort(); await assert.rejects(() => umb.listUmbra(undefined, undefined, controller.signal, async (_u, init) => { assert.equal(init.signal.aborted, true); throw new DOMException("aborted", "AbortError"); }), /aborted/);
});
