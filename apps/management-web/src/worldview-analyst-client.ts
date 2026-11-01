import type { AnalystAnswer } from "./worldview-analyst";

export type AnalystModelResult = {
  engine: "local-model" | "external-model" | "deterministic";
  modelStatus: string;
  selectedIds: string[];
  disclosure: string;
  dataLeavesSystem: boolean;
};
export async function organizeAnalystAnswer(
  answer: AnalystAnswer,
  options: {
    mode: "local" | "external";
    token: string;
    consent: boolean;
    signal: AbortSignal;
    fetcher?: typeof fetch;
  },
): Promise<AnalystModelResult> {
  if (options.signal.aborted) throw new Error("Analysis cancelled.");
  if (options.mode === "external" && !options.consent)
    throw new Error("External analysis requires explicit data-export consent.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 65_000);
  try {
    const response = await (options.fetcher ?? fetch)(
      "/api/v1/local-ai/analyst",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.token}`,
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({
          mode: options.mode,
          question: answer.question,
          candidates: answer.claims.map(({ id, text, citationIds }) => ({
            id,
            text,
            citationIds,
          })),
          consent: options.mode === "external" && options.consent,
        }),
      },
    );
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    )
      throw new Error(
        `Model service unavailable (HTTP ${response.status}); deterministic results retained.`,
      );
    const result = (await response.json()) as AnalystModelResult;
    const allowed = new Set(answer.claims.map((c) => c.id));
    if (
      !["local-model", "external-model", "deterministic"].includes(
        result.engine,
      ) ||
      typeof result.disclosure !== "string" ||
      typeof result.modelStatus !== "string" ||
      typeof result.dataLeavesSystem !== "boolean" ||
      !Array.isArray(result.selectedIds) ||
      result.selectedIds.some((id) => !allowed.has(id)) ||
      new Set(result.selectedIds).size !== result.selectedIds.length ||
      (options.mode === "local" &&
        (result.dataLeavesSystem || result.engine === "external-model"))
    )
      throw new Error(
        "Invalid model response; deterministic results retained.",
      );
    return result;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        options.signal.aborted
          ? "Analysis cancelled; late output discarded."
          : "Model request timed out; deterministic results retained.",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  }
}
export function orderedAnalystClaims(answer: AnalystAnswer, ids: string[]) {
  const known = new Map(answer.claims.map((c) => [c.id, c]));
  return [
    ...ids.flatMap((id) => (known.has(id) ? [known.get(id)!] : [])),
    ...answer.claims.filter((c) => !ids.includes(c.id)),
  ];
}
export function analystMarkdown(
  answer: AnalystAnswer,
  disclosure: string,
): string {
  const plain = (s: string) =>
    s
      .replace(/[\r\n]+/g, " ")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/([\\`*_[\]()#!|])/g, "\\$1");
  return [
    "# Scene analyst briefing — ADVISORY DRAFT",
    "",
    "Not verified evidence. No operational instructions. Human review required.",
    `Generated: ${plain(answer.generatedAt)}`,
    `Question: ${plain(answer.question)}`,
    `Engine: ${plain(answer.engine)}`,
    plain(disclosure),
    "",
    "## Source-grounded findings",
    ...answer.claims.map(
      (c) =>
        `- ${plain(c.text)} ${c.citationIds.map((id) => `[${plain(id)}]`).join(" ")}`,
    ),
    "",
    "## Uncertainty and limitations",
    ...answer.warnings.map((w) => `- ${plain(w)}`),
    ...(answer.abstained
      ? ["- Abstained: the loaded evidence cannot support this question."]
      : []),
    "",
    "## Provenance",
    ...answer.citations.map(
      (c) =>
        `- [${plain(c.id)}] Record ${plain(c.recordId)}; source ${plain(c.source)}; time ${plain(c.observedAt)}; ${plain(c.freshness)}${c.synthetic ? "; SYNTHETIC — not physical-world evidence" : ""}. ${plain(c.detail)}`,
    ),
    "",
    "Operator notes remain separate from verified input evidence.",
    "",
  ].join("\n");
}
