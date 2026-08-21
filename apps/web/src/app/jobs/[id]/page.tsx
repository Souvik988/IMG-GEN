"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AppShell } from "../../../components/app-shell";
import { Icon } from "../../../components/icon";
import { apiFetch } from "../../../lib/api";

type StateEvent = { toState: string; reason: string | null; createdAt: string };
type JobStatus = {
  job: {
    id: string;
    state: string;
    display: string;
    resolution: string;
    aspectRatio: string;
    outputCount: number;
    createdAt: string;
    completedAt: string | null;
  };
  attempts: number;
  isTerminal: boolean;
  stateEvents: StateEvent[];
};
type ResultImage = {
  sequence: number;
  cameraAngle: string | null;
  previewUrl: string | null;
  downloads: { png: string | null; jpg: string | null };
};
type JobResult = {
  state: string;
  resolution: string;
  aspectRatio: string;
  delivery: "final" | "stored_candidate" | "none";
  requestedCount?: number;
  deliveredCount?: number;
  images?: ResultImage[];
  previewUrl: string | null;
  downloads: { png: string | null; jpg: string | null };
};

const angleLabels: Record<string, string> = {
  front: "Front",
  three_quarter_left: "3/4 Left",
  three_quarter_right: "3/4 Right",
  profile_left: "Side Profile",
  back: "Back",
};

const stateLabels: Record<string, string> = {
  created: "Queued",
  validating: "Checking references",
  analyzing: "Reading garment details",
  compiling: "Compiling brief",
  generating: "Creating image",
  reviewing: "Checking quality",
  retrying: "Repairing and retrying",
  finalizing: "Finalizing",
  ready: "Ready to use",
  input_rejected: "Reference rejected",
  failed: "Generation stopped",
  budget_stopped: "Budget stopped",
  manual_review: "Manual review",
  cancelled: "Cancelled",
};
const traceSteps = [
  ["validating", "Checking references"],
  ["analyzing", "Reading garment details"],
  ["compiling", "Compiling brief"],
  ["generating", "Creating image"],
  ["reviewing", "Checking quality"],
  ["retrying", "Repairing and retrying"],
  ["finalizing", "Finalizing"],
  ["ready", "Ready to use"],
] as const;
const terminalStates = new Set([
  "ready",
  "input_rejected",
  "failed",
  "budget_stopped",
  "manual_review",
  "cancelled",
]);
const stoppingStates = new Set(["failed", "input_rejected", "budget_stopped", "manual_review", "cancelled"]);

export default function Job() {
  const { id } = useParams<{ id: string }>();
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [result, setResult] = useState<JobResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState(0);

  useEffect(() => {
    if (!id) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await apiFetch<JobStatus>(`/api/jobs/${id}`);
        if (!mounted) return;
        setStatus(next);
        if (terminalStates.has(next.job.state)) {
          const output = await apiFetch<JobResult>(`/api/jobs/${id}/result`);
          if (mounted) setResult(output);
        }
        if (!terminalStates.has(next.job.state)) timer = setTimeout(poll, 1500);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Could not load this job");
      }
    };

    void poll();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  async function sendFeedback(rating: "good" | "needs_improvement") {
    try {
      await apiFetch(`/api/jobs/${id}/feedback`, {
        method: "POST",
        body: JSON.stringify({ rating }),
      });
      setFeedback("Thanks — feedback recorded.");
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Could not record feedback");
    }
  }

  const job = status?.job;
  const state = job?.state ?? "created";
  const hasStoredCandidate = result?.delivery === "stored_candidate";
  const isFailure = !hasStoredCandidate && stoppingStates.has(state);
  const galleryImages = result?.images ?? [];
  const activeImage = galleryImages[selectedImage] ?? galleryImages[0] ?? null;
  const activeAngleLabel = activeImage?.cameraAngle
    ? angleLabels[activeImage.cameraAngle] ?? activeImage.cameraAngle
    : null;
  // A short set means at least one angle did not clear quality review.
  const missingAngles =
    result?.requestedCount && result.deliveredCount
      ? result.requestedCount - result.deliveredCount
      : 0;
  const resultLabel = hasStoredCandidate ? "Image saved" : stateLabels[state] ?? state;
  const workflowStateLabel = hasStoredCandidate && stoppingStates.has(state) ? "review stopped" : state;
  const recordedStates = new Set(status?.stateEvents.map((event) => event.toState) ?? []);
  const stopEvent = [...(status?.stateEvents ?? [])]
    .reverse()
    .find((event) => stoppingStates.has(event.toState));
  const stopReason = stopEvent?.reason;

  return (
    <AppShell section="Job result">
      <div className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">Project / {id?.slice(0, 8) ?? "loading"}</p>
            <h1 className="display">Your generation<br /><em>{resultLabel}.</em></h1>
            <p className="lede">View the real file from private storage and the exact workflow status for this run.</p>
          </div>
          <div className="top-actions">
            {(activeImage?.downloads.png ?? result?.downloads.png) && (
              <a className="button button-ghost" href={activeImage?.downloads.png ?? result?.downloads.png ?? "#"} target="_blank" rel="noreferrer">
                <Icon name="download" /> {hasStoredCandidate ? "Download image" : galleryImages.length > 1 ? `Download ${activeAngleLabel ?? "frame"}` : "Download master"}
              </a>
            )}
            <Link className="button button-primary" href="/">Generate another</Link>
          </div>
        </div>

        {error ? (
          <section className="panel panel-pad error-panel">
            <strong>Job unavailable</strong><p>{error}</p>
            <Link className="button button-ghost button-small" href="/login">Sign in</Link>
          </section>
        ) : (
          <>
            {hasStoredCandidate && (
              <section className="panel panel-pad" style={{ marginBottom: 22 }}>
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">Image saved safely</p>
                    <h2 className="panel-title">Generation finished; automated review stopped</h2>
                  </div>
                  <span className="chip chip-warn">review incomplete</span>
                </div>
                <p className="help">The generated image is real and is stored. It is not called a final delivery because the automated quality check did not complete.</p>
              </section>
            )}

            {missingAngles > 0 && (
              <section className="panel panel-pad" style={{ marginBottom: 18 }}>
                <div className="panel-head">
                  <div>
                    <p className="panel-kicker">Partial set</p>
                    <h2 className="panel-title">{result?.deliveredCount} of {result?.requestedCount} angles delivered</h2>
                  </div>
                  <span className="chip chip-warn">{missingAngles} withheld</span>
                </div>
                <p className="help">The angles shown passed quality review. {missingAngles === 1 ? "One angle" : `${missingAngles} angles`} did not meet the fidelity bar and {missingAngles === 1 ? "was" : "were"} not delivered. Generate again to retry the full set.</p>
              </section>
            )}

            <div className="job-hero">
              <div className="result-art result-art-real">
                {activeImage?.previewUrl ?? result?.previewUrl ? (
                  <img src={activeImage?.previewUrl ?? result?.previewUrl ?? ""} alt={hasStoredCandidate ? "Stored generated image" : `Generated garment result${activeAngleLabel ? ` — ${activeAngleLabel}` : ""}`} />
                ) : (
                  <div className="result-placeholder">
                    <span className={`state-mark state-${state}`} />
                    <strong>{stateLabels[state] ?? state}</strong>
                    <small>{job ? "The worker is updating this run." : "Loading job status…"}</small>
                  </div>
                )}
                {galleryImages.length > 1 && (
                  <div className="angle-strip">
                    {galleryImages.map((image, index) => (
                      <button
                        key={image.sequence}
                        className={`angle-thumb ${index === selectedImage ? "selected" : ""}`}
                        onClick={() => setSelectedImage(index)}
                        title={image.cameraAngle ? angleLabels[image.cameraAngle] ?? image.cameraAngle : `Image ${image.sequence}`}
                      >
                        {image.previewUrl && <img src={image.previewUrl} alt="" />}
                        <span>{image.cameraAngle ? angleLabels[image.cameraAngle] ?? image.cameraAngle : `#${image.sequence}`}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="job-side">
                <div className={`status-card ${isFailure ? "status-card-failure" : ""}`}>
                  <p className="panel-kicker">Workflow outcome</p>
                  <h2 className="status-title">{hasStoredCandidate ? "Image created" : resultLabel}</h2>
                  <p className="status-copy">
                    {hasStoredCandidate
                      ? "The image-generation stage completed. Review stopped before the file could be marked final."
                      : job
                        ? `${status?.attempts ?? 0} attempt${status?.attempts === 1 ? "" : "s"} recorded · ${job.outputCount} output${job.outputCount === 1 ? "" : "s"} requested.`
                        : "Loading the real queue state."}
                  </p>
                  <div className="progress">
                    <div className="progress-line"><span style={{ width: terminalStates.has(state) ? "100%" : "58%" }} /></div>
                    <div className="workflow-state-line"><span>Workflow state</span><strong>{workflowStateLabel}</strong></div>
                  </div>
                </div>

                <div className="meta-card">
                  <div className="panel-head">
                    <div><p className="panel-kicker">Generation brief</p><h2 className="panel-title">Locked request</h2></div>
                    <Icon name="lock" />
                  </div>
                  <div className="meta-grid">
                    <div><div className="meta-label">Resolution</div><div className="meta-value">{job?.resolution?.toUpperCase() ?? "—"}</div></div>
                    <div><div className="meta-label">Frame</div><div className="meta-value">{job?.aspectRatio ?? "—"}</div></div>
                    <div><div className="meta-label">Outputs</div><div className="meta-value">{job?.outputCount ?? "—"}</div></div>
                    <div><div className="meta-label">Attempts</div><div className="meta-value">{status?.attempts ?? "—"}</div></div>
                  </div>
                </div>

                <div className="meta-card">
                  <div className="panel-head">
                    <div><p className="panel-kicker">Run trace</p><h2 className="panel-title">What actually happened</h2></div>
                    <span className={`chip ${isFailure ? "chip-fail" : state === "ready" ? "" : "chip-warn"}`}>{workflowStateLabel}</span>
                  </div>
                  {stopReason && <p className="trace-reason">Stopped: {stopReason}</p>}
                  <div className="job-timeline">
                    {traceSteps.map(([key, label]) => {
                      const recorded = recordedStates.has(key);
                      const stateText = recorded ? "completed" : terminalStates.has(state) ? "not run" : "waiting";
                      return (
                        <div className="timeline-row" key={key}>
                          <span className={`timeline-dot ${recorded ? "" : "timeline-dot-muted"}`} />
                          <span>{label}</span><span className="timeline-time">{stateText}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {job?.state === "ready" && (
          <div className="panel panel-pad" style={{ marginTop: 22 }}>
            <div className="panel-head">
              <div><p className="panel-kicker">Feedback</p><h2 className="panel-title">Did this land?</h2></div>
              <span className="help">Your feedback is stored against this job.</span>
            </div>
            <div className="top-actions">
              <button className="button button-primary" onClick={() => sendFeedback("good")}>Good result</button>
              <button className="button button-ghost" onClick={() => sendFeedback("needs_improvement")}>Needs improvement</button>
            </div>
            {feedback && <p className="save-message" style={{ marginTop: 14 }}>{feedback}</p>}
          </div>
        )}
      </div>
    </AppShell>
  );
}
