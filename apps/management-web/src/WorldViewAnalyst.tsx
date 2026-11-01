import { useEffect, useMemo, useRef, useState } from "react";
import {
  answerQuestion,
  analystPresets,
  parseAnalystVoice,
} from "./worldview-analyst";
import type {
  AnalystAnswer,
  AnalystContext,
  AnalystScope,
} from "./worldview-analyst";
import {
  analystMarkdown,
  orderedAnalystClaims,
  organizeAnalystAnswer,
} from "./worldview-analyst-client";
import { validateOverview } from "./observation-state";
import type { AssessmentEvidence } from "./observation-state";
import { getObservationJson } from "./observation-network";
import "./worldview-analyst.css";

type Props = {
  context: AnalystContext;
  selectedId?: string | null;
  onLayer: (layer: string, visible: boolean) => void;
  onNavigate: (place: string) => boolean;
  onDraftAnnotation: (text: string) => void;
};
const LOCAL_DISCLOSURE =
  "Local deterministic tools · no model inference · no network requests for questions. Context is limited to explicitly loaded data.";
export function WorldViewAnalyst({
  context,
  selectedId,
  onLayer,
  onNavigate,
  onDraftAnnotation,
}: Props) {
  const [question, setQuestion] = useState("Summarize the selected region");
  const [answer, setAnswer] = useState<AnalystAnswer | null>(null);
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [onlySelected, setOnlySelected] = useState(false);
  const [mode, setMode] = useState<"local" | "external">("local"),
    [consent, setConsent] = useState(false),
    [token, setToken] = useState("");
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(LOCAL_DISCLOSURE),
    [disclosure, setDisclosure] = useState(LOCAL_DISCLOSURE);
  const [platform, setPlatform] = useState<AssessmentEvidence[]>([]),
    [platformVerified, setPlatformVerified] = useState(false),
    [platformStatus, setPlatformStatus] = useState(
      "Platform context not loaded. No platform API request has been made.",
    );
  const [voiceConsent, setVoiceConsent] = useState(false),
    [listening, setListening] = useState(false),
    [voiceText, setVoiceText] = useState(""),
    [draft, setDraft] = useState("");
  const [citationId, setCitationId] = useState<string | null>(null),
    [snapshotChanged, setSnapshotChanged] = useState(false);
  const active = useRef<AbortController | null>(null),
    platformRead = useRef<AbortController | null>(null),
    recognition = useRef<any>(null),
    serial = useRef(0);
  useEffect(
    () => () => {
      active.current?.abort();
      platformRead.current?.abort();
      recognition.current?.abort?.();
    },
    [],
  );
  const contextRevision = useMemo(
    () => JSON.stringify({ ...context, now: 0 }),
    [context],
  );
  useEffect(() => {
    serial.current++;
    active.current?.abort();
    setBusy(false);
    setSnapshotChanged(true);
  }, [context, platform, platformVerified, from, to, onlySelected, selectedId]);
  const loaded = { ...context, platformEvidence: platform, platformVerified };
  const run = async (text = question) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const version = ++serial.current;
    setQuestion(text);
    setCitationId(null);
    setSnapshotChanged(false);
    setDisclosure(LOCAL_DISCLOSURE);
    if (
      (from && !Number.isFinite(Date.parse(from))) ||
      (to && !Number.isFinite(Date.parse(to))) ||
      (from && to && Date.parse(from) > Date.parse(to))
    ) {
      setStatus("Invalid time window. From must not be later than To.");
      setAnswer(null);
      setBusy(false);
      return;
    }
    const scope: AnalystScope = {
      ...(from ? { from: new Date(from).toISOString() } : {}),
      ...(to ? { to: new Date(to).toISOString() } : {}),
      ...(onlySelected && selectedId ? { selectedId } : {}),
    };
    const result = answerQuestion(text, { ...loaded, now: Date.now() }, scope);
    setAnswer(result);
    setStatus(LOCAL_DISCLOSURE);
    if (result.abstained || !result.claims.length || !token.trim()) {
      if (!token.trim())
        setStatus(
          mode === "external"
            ? "External model was not contacted: administrator token is missing. Local deterministic answer shown."
            : "Deterministic fallback · no model contacted. To prefer installed Qwen, connect its configured local runtime with an administrator token.",
        );
      return;
    }
    if (mode === "external" && !consent) {
      setStatus(
        "External model not contacted: explicit data-export consent is required. Deterministic answer shown.",
      );
      return;
    }
    setBusy(true);
    setStatus(
      mode === "local"
        ? "Waiting for configured local Qwen / compatible runtime (maximum 60 seconds)…"
        : "External model request: question and cited candidate findings leave this system.",
    );
    try {
      const model = await organizeAnalystAnswer(result, {
        mode,
        consent,
        token,
        signal: controller.signal,
      });
      if (controller.signal.aborted || serial.current !== version) return;
      setAnswer({
        ...result,
        engine: model.engine,
        claims: orderedAnalystClaims(result, model.selectedIds),
      });
      setDisclosure(model.disclosure);
      setStatus(`${model.engine} · ${model.modelStatus} · ${model.disclosure}`);
    } catch (error) {
      if (serial.current === version)
        setStatus(
          error instanceof Error
            ? error.message
            : "Model unavailable; deterministic answer retained.",
        );
    } finally {
      if (serial.current === version) setBusy(false);
    }
  };
  const cancel = () => {
    serial.current++;
    active.current?.abort();
    setBusy(false);
    setStatus(
      "Cancelled. Late model output is discarded; the deterministic snapshot remains. A server provider call may continue until its bounded timeout.",
    );
  };
  const changeMode = (next: "local" | "external") => {
    cancel();
    setMode(next);
    setConsent(false);
    setAnswer(null);
    setDisclosure(LOCAL_DISCLOSURE);
    setStatus(
      next === "local"
        ? LOCAL_DISCLOSURE
        : "External mode selected. No data is exported until consent, token, and server configuration are present and you ask a question.",
    );
  };
  const loadPlatform = async () => {
    platformRead.current?.abort();
    const controller = new AbortController();
    platformRead.current = controller;
    setPlatformStatus("Reading same-origin platform evidence…");
    try {
      const overview = validateOverview(
        await getObservationJson<unknown>("/api/v1/lattice/overview", {
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted) return;
      setPlatform(overview.assessment?.evidence ?? []);
      setPlatformVerified(true);
      setPlatformStatus(
        `Loaded ${overview.assessment?.evidence.length ?? 0} platform evidence records at ${overview.generatedAt}. Mock/offline platform data; not a real aircraft connection.`,
      );
    } catch (e) {
      if (controller.signal.aborted) return;
      setPlatformVerified(false);
      setPlatformStatus(
        `Platform read failed; any retained context is unverified. ${e instanceof Error ? e.message : ""}`,
      );
    }
  };
  const startVoice = () => {
    if (listening) {
      recognition.current?.stop?.();
      setListening(false);
      return;
    }
    if (!voiceConsent) {
      setStatus("Enable the separate browser speech disclosure first.");
      return;
    }
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) {
      setStatus(
        "Speech recognition unavailable in this browser. Use typed questions.",
      );
      return;
    }
    const r = new SR();
    recognition.current = r;
    r.lang = "en-US";
    r.continuous = false;
    r.onresult = (event: any) => {
      setVoiceText(String(event.results[0][0].transcript).slice(0, 2000));
      setStatus("Transcript staged for review. Nothing executed.");
    };
    r.onerror = () => {
      setListening(false);
      setStatus(
        "Browser speech failed. No command executed; typed input remains available.",
      );
    };
    r.onend = () => setListening(false);
    try {
      r.start();
      setListening(true);
    } catch {
      setStatus("Could not start browser speech.");
    }
  };
  const applyVoice = () => {
    const intent = parseAnalystVoice(voiceText);
    if (intent.kind === "reject") setStatus(intent.reason);
    else if (intent.kind === "query") {
      setQuestion(intent.question);
      setStatus(
        "Question staged. Press Ask analyst to run the read-only query.",
      );
    } else if (intent.kind === "layer") {
      onLayer(intent.layer, intent.visible);
      setStatus(
        `Layer ${intent.layer} ${intent.visible ? "shown" : "hidden"}; UI only.`,
      );
    } else if (intent.kind === "navigate")
      setStatus(
        onNavigate(intent.place)
          ? "Local camera moved; no vehicle command."
          : "Place unavailable in the local geographic index.",
      );
    else {
      setDraft(intent.text);
      setStatus(
        "Annotation draft staged; not source evidence. Review before saving.",
      );
    }
  };
  const saveDraft = () => {
    if (!draft.trim()) return;
    onDraftAnnotation(`[ADVISORY DRAFT] ${draft.trim().slice(0, 460)}`);
    setDraft("");
    setStatus("Advisory note saved separately from observation evidence.");
  };
  const exportBriefing = () => {
    if (!answer) return;
    const blob = new Blob([analystMarkdown(answer, disclosure)], {
      type: "text/markdown",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "scene-analyst-advisory-draft.md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const citation = answer?.citations.find((c) => c.id === citationId);
  return (
    <section className="wv-analyst" aria-labelledby="wv-analyst-title">
      <header>
        <div>
          <span className="wv-label">LOCAL-FIRST / EVIDENCE WORKSPACE</span>
          <h2 id="wv-analyst-title">Scene analyst</h2>
          <p>
            Ask across loaded layers, observation history and platform evidence.
            Advisory only; no commands to aircraft or effectors.
          </p>
        </div>
        <span className="analyst-engine">
          {mode === "local" ? "LOCAL" : "EXTERNAL · OPT-IN"} ·{" "}
          {answer?.engine ?? "deterministic"}
        </span>
      </header>
      <div className="analyst-columns">
        <div>
          <div
            className="analyst-presets"
            aria-label="Available analyst questions"
          >
            {analystPresets(loaded).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setQuestion(p);
                  void run(p);
                }}
              >
                {p}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <label>
              Question
              <textarea
                aria-label="Analyst question"
                maxLength={2000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </label>
            <div className="analyst-scope">
              <label>
                From
                <input
                  aria-label="Analyst from time"
                  type="datetime-local"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                To
                <input
                  aria-label="Analyst to time"
                  type="datetime-local"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={onlySelected}
                  disabled={!selectedId}
                  onChange={(e) => setOnlySelected(e.target.checked)}
                />{" "}
                Selected record history only
              </label>
            </div>
            <p className="fine-print">
              Scope: enabled layers ·{" "}
              {context.radiusKm === Infinity
                ? "global"
                : `${context.radiusKm} km around the camera`}{" "}
              · {context.sceneName}. Times use your browser time zone. History
              only includes loaded samples retained in this session.
            </p>
            <div className="analyst-actions">
              <button type="submit" disabled={busy || !question.trim()}>
                Ask analyst
              </button>
              <button type="button" disabled={!busy} onClick={cancel}>
                Cancel analysis
              </button>
              <button
                type="button"
                disabled={!answer || snapshotChanged}
                onClick={exportBriefing}
              >
                Export briefing draft
              </button>
              <button
                type="button"
                disabled={!answer || snapshotChanged}
                onClick={() =>
                  setDraft(
                    answer!.claims
                      .slice(0, 2)
                      .map((c) => `${c.text} [${c.citationIds.join(", ")}]`)
                      .join(" ")
                      .slice(0, 460),
                  )
                }
              >
                Draft annotation
              </button>
            </div>
          </form>
          <p role="status" className="analyst-status">
            {status}
          </p>
          {answer && (
            <article className="analyst-answer" aria-label="Analyst answer">
              <h3>
                {answer.abstained
                  ? "Insufficient support — abstained"
                  : "Source-grounded advisory findings"}
              </h3>
              <small>
                Tool: {answer.tool} · Snapshot: {answer.generatedAt} ·{" "}
                {answer.engine}
              </small>
              {snapshotChanged && (
                <p className="analyst-warning">
                  Scope or loaded evidence changed. This is a historical answer;
                  ask again before exporting.
                </p>
              )}
              {answer.claims.map((c) => (
                <div key={c.id} className="analyst-claim">
                  <p>{c.text}</p>
                  <div>
                    {c.citationIds.map((id) => (
                      <button
                        key={id}
                        onClick={() => setCitationId(id)}
                        aria-label={`Inspect citation ${id}`}
                      >
                        [{id}]
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <ul className="analyst-warning">
                {answer.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
              <p className="fine-print">
                Model outputs and notes are never written into verified
                evidence. Coincidence does not establish causation; missing data
                does not prove absence.
              </p>
            </article>
          )}
          {draft && (
            <div className="analyst-draft">
              <label>
                Advisory annotation draft
                <textarea
                  aria-label="Advisory annotation draft"
                  maxLength={460}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
              <button onClick={saveDraft}>Save reviewed advisory note</button>
              <button onClick={() => setDraft("")}>Discard draft</button>
            </div>
          )}
        </div>
        <aside>
          <details>
            <summary>Model & privacy settings</summary>
            <label>
              Analysis mode
              <select
                aria-label="Analyst mode"
                value={mode}
                onChange={(e) =>
                  changeMode(e.target.value as "local" | "external")
                }
              >
                <option value="local">
                  Local only — prefer configured Qwen
                </option>
                <option value="external">External AI — explicit export</option>
              </select>
            </label>
            <label>
              Administrator token (memory only)
              <input
                aria-label="Analyst administrator token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => {
                  cancel();
                  setToken(e.target.value);
                }}
              />
            </label>
            <p className="fine-print">
              With a token, a fixed same-origin API can use the configured
              loopback Qwen runtime. No automatic downloads or external
              fallback. Without a runtime, cited deterministic tools remain
              available.
            </p>
            {mode === "external" && (
              <label className="analyst-warning">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => {
                    cancel();
                    setConsent(e.target.checked);
                  }}
                />{" "}
                I consent to export this question and candidate findings,
                including record/source/time references and any values in the
                findings, to the explicitly server-configured external provider.
                No raw scene pack is sent. Server-side consent is also required.
              </label>
            )}
          </details>
          <div className="analyst-grounding">
            <h3>Grounding & provenance</h3>
            <p>
              {context.records.length} loaded observation samples ·{" "}
              {platform.length} platform fields · {context.passes.length}{" "}
              calculated passes · {context.annotations.length} operator notes
              (not evidence)
            </p>
            <button onClick={() => void loadPlatform()}>
              Load platform context
            </button>
            <p className="fine-print">{platformStatus}</p>
            {citation ? (
              <dl>
                <dt>Citation / record</dt>
                <dd>
                  {citation.id} / {citation.recordId}
                </dd>
                <dt>Source / time</dt>
                <dd>
                  {citation.source}
                  <br />
                  {citation.observedAt}
                </dd>
                <dt>Freshness / class</dt>
                <dd>
                  {citation.freshness} ·{" "}
                  {citation.synthetic
                    ? "SYNTHETIC — not physical-world evidence"
                    : "Reported / derived; not independently verified"}
                </dd>
                <dt>Evidence detail</dt>
                <dd>
                  <pre>{citation.detail}</pre>
                </dd>
              </dl>
            ) : (
              <p className="fine-print">
                Choose a citation beside a finding to inspect the exact record,
                source, time and freshness.
              </p>
            )}
            {answer && (
              <details>
                <summary>All {answer.citations.length} citations</summary>
                {answer.citations.map((c) => (
                  <button
                    className="analyst-citation"
                    key={c.id}
                    onClick={() => setCitationId(c.id)}
                  >
                    {c.id} · {c.source} · {c.freshness}
                  </button>
                ))}
              </details>
            )}
          </div>
          <details>
            <summary>Optional browser speech</summary>
            <label>
              <input
                type="checkbox"
                checked={voiceConsent}
                onChange={(e) => {
                  setVoiceConsent(e.target.checked);
                  if (!e.target.checked) {
                    recognition.current?.abort?.();
                    setListening(false);
                  }
                }}
              />{" "}
              Browser speech may send audio to its own speech service, even in
              local analyst mode. I opt in separately.
            </label>
            <button disabled={!voiceConsent} onClick={startVoice}>
              {listening
                ? "Stop listening"
                : "Dictate question or safe UI request"}
            </button>
            <label>
              Review transcript
              <input
                aria-label="Analyst voice transcript"
                maxLength={2000}
                value={voiceText}
                onChange={(e) => setVoiceText(e.target.value)}
              />
            </label>
            <button disabled={!voiceText} onClick={applyVoice}>
              Review / apply safe UI intent
            </button>
            <p className="fine-print">
              Only allowlisted layer toggles, local camera navigation and
              annotation drafts. Queries are staged for review. No vehicle
              control, identity lookup, target ranking or weapon actions.
            </p>
          </details>
        </aside>
      </div>
    </section>
  );
}
