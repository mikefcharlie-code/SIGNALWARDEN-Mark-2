import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../src/worldview-analyst-client.ts");
const output = mkdtempSync(join(tmpdir(), "worldview-analyst-client-"));
writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
const tsc = resolve(here, "../node_modules/typescript/bin/tsc");
const compile = spawnSync(
  process.execPath,
  [
    tsc,
    source,
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--moduleResolution",
    "Bundler",
    "--skipLibCheck",
    "--outDir",
    output,
  ],
  { encoding: "utf8", cwd: output },
);
if (compile.status !== 0) {
  throw new Error(
    `Unable to compile worldview-analyst-client.ts with ${tsc}:\n${compile.stdout}\n${compile.stderr}`,
  );
}
const client = await import(
  `${pathToFileURL(join(output, "worldview-analyst-client.js")).href}?test=${Date.now()}`
);

const answer = {
  question: "Which observations are relevant?",
  tool: "deterministic-worldview",
  claims: [
    { id: "claim-a", text: "Aircraft A was observed.", citationIds: ["cit-a"] },
    { id: "claim-b", text: "Vessel B was observed.", citationIds: ["cit-b"] },
    { id: "claim-c", text: "The source is synthetic.", citationIds: ["cit-c"] },
  ],
  citations: [
    {
      id: "cit-a",
      recordId: "rec-a",
      source: "Open Feed Alpha",
      observedAt: "2025-01-02T03:04:05Z",
      freshness: "fresh",
      synthetic: false,
      detail: "Verified source detail.",
    },
    {
      id: "cit-b",
      recordId: "rec-b",
      source: "Synthetic Test Feed",
      observedAt: "2025-01-03T04:05:06Z",
      freshness: "stale",
      synthetic: true,
      detail: "Generated fixture detail.",
    },
    {
      id: "cit-c",
      recordId: "rec-c",
      source: "Archive Gamma",
      observedAt: "2025-01-04T05:06:07Z",
      freshness: "unknown",
      synthetic: false,
      detail: "Historical detail.",
    },
  ],
  warnings: ["Model output is advisory."],
  abstained: false,
  engine: "deterministic",
  generatedAt: "2025-01-05T06:07:08Z",
};

const jsonResponse = (body, status = 200, contentType = "application/json") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
const validLocal = {
  engine: "local-model",
  modelStatus: "ready",
  selectedIds: ["claim-b"],
  disclosure: "Local-only model; no data leaves this system.",
  dataLeavesSystem: false,
};
const baseOptions = (fetcher, overrides = {}) => ({
  mode: "local",
  token: "memory-token",
  consent: false,
  signal: new AbortController().signal,
  fetcher,
  ...overrides,
});

test("local mode uses the fixed same-origin endpoint and exact request modes", async () => {
  const calls = [];
  const result = await client.organizeAnalystAnswer(
    answer,
    baseOptions(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(validLocal);
    }),
  );
  assert.deepEqual(result, validLocal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/local-ai/analyst");
  assert.equal(
    new URL(calls[0].url, "https://same-origin.invalid").origin,
    "https://same-origin.invalid",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.Authorization, "Bearer memory-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    mode: "local",
    question: answer.question,
    candidates: answer.claims.map(({ id, text, citationIds }) => ({
      id,
      text,
      citationIds,
    })),
    consent: false,
  });

  const externalCalls = [];
  await client.organizeAnalystAnswer(
    answer,
    baseOptions(
      async (url, init) => {
        externalCalls.push({ url, init });
        return jsonResponse({
          ...validLocal,
          engine: "external-model",
          dataLeavesSystem: true,
        });
      },
      { mode: "external", consent: true },
    ),
  );
  assert.equal(JSON.parse(externalCalls[0].init.body).mode, "external");
  assert.equal(JSON.parse(externalCalls[0].init.body).consent, true);
});

test("external mode without consent rejects before fetch", async () => {
  let fetched = false;
  await assert.rejects(
    client.organizeAnalystAnswer(
      answer,
      baseOptions(
        async () => {
          fetched = true;
          return jsonResponse(validLocal);
        },
        { mode: "external", consent: false },
      ),
    ),
    /explicit data-export consent/,
  );
  assert.equal(fetched, false);
});

test("already-aborted signal rejects before fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  await assert.rejects(
    client.organizeAnalystAnswer(
      answer,
      baseOptions(
        async () => {
          fetched = true;
          return jsonResponse(validLocal);
        },
        { signal: controller.signal },
      ),
    ),
    /Analysis cancelled/,
  );
  assert.equal(fetched, false);
});

test("cancellation aborts the fetch and returns a cancellation error", async () => {
  const controller = new AbortController();
  let fetchAborted = false;
  const pendingFetch = (_url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          fetchAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  const request = client.organizeAnalystAnswer(
    answer,
    baseOptions(pendingFetch, { signal: controller.signal }),
  );
  controller.abort();
  await assert.rejects(request, /Analysis cancelled; late output discarded/);
  assert.equal(fetchAborted, true);
});

test("invalid unknown IDs, external engines, and data-leaving local results are rejected", async (t) => {
  const cases = [
    ["unknown selected ID", { ...validLocal, selectedIds: ["not-a-claim"] }],
    [
      "external engine in local mode",
      { ...validLocal, engine: "external-model" },
    ],
    [
      "data leaves system in local mode",
      { ...validLocal, dataLeavesSystem: true },
    ],
  ];
  for (const [name, payload] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        client.organizeAnalystAnswer(
          answer,
          baseOptions(async () => jsonResponse(payload)),
        ),
        /Invalid model response; deterministic results retained/,
      );
    });
  }
});

test("orderedAnalystClaims preserves every deterministic claim while honoring model subset order", () => {
  const ordered = client.orderedAnalystClaims(answer, ["claim-c", "claim-a"]);
  assert.deepEqual(
    ordered.map(({ id }) => id),
    ["claim-c", "claim-a", "claim-b"],
  );
  assert.deepEqual(
    client.orderedAnalystClaims(answer, ["claim-b", "unknown"]),
    [answer.claims[1], answer.claims[0], answer.claims[2]],
  );
});

test("analystMarkdown retains citations and synthetic, time, and source provenance", () => {
  const markdown = client.analystMarkdown(
    { ...answer, engine: "local-model" },
    "Local disclosure text.",
  );
  for (const text of [
    "# Scene analyst briefing — ADVISORY DRAFT",
    "Generated: 2025-01-05T06:07:08Z",
    "[cit-a]",
    "[cit-b]",
    "Record rec-b",
    "source Synthetic Test Feed",
    "time 2025-01-03T04:05:06Z",
    "SYNTHETIC — not physical-world evidence",
    "stale",
    "Generated fixture detail.",
    "Local disclosure text.",
  ])
    assert.match(
      markdown,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
});

test("WorldViewAnalyst keeps token memory-only, separates speech consent, avoids unsafe HTML, and stages query intent", () => {
  const ui = readFileSync(resolve(here, "../src/WorldViewAnalyst.tsx"), "utf8");
  assert.match(ui, /Administrator token \(memory only\)/);
  assert.match(ui, /separate browser speech disclosure/);
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|innerHTML/);
  assert.match(
    ui,
    /Question staged\. Press Ask analyst to run the read-only query/,
  );
});

test.after(() => rmSync(output, { recursive: true, force: true }));
