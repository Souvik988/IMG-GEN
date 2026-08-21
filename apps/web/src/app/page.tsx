"use client";

import { useState } from "react";
import Link from "next/link";
import { AppShell } from "../components/app-shell";
import { Generator } from "../components/generator";

export default function Home() {
  const [submitted, setSubmitted] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  return <AppShell section="Generate">
    {submitted && jobId ? <div className="page">
      <div className="page-head"><div><p className="eyebrow">Generation queued</p><h1 className="display">Your next <em>look</em> is in motion.</h1><p className="lede">Shotlin is checking your references, preparing garment details, and keeping every protected detail in frame.</p></div><Link className="button button-primary" href={`/jobs/${jobId}`}>Open live job</Link></div>
      <div className="panel panel-pad" style={{maxWidth: 760}}><div className="job-timeline">{[["01", "Checking references", "done"], ["02", "Preparing garment details", "done"], ["03", "Creating image", "running"], ["04", "Checking quality", "next"]].map(([n, label, state]) => <div className="timeline-row" key={n}><span className="timeline-dot" style={{background: state === "next" ? "#cfc6bb" : undefined}} /><span><strong>{n}</strong>&nbsp;&nbsp;{label}</span><span className="timeline-time">{state === "done" ? "complete" : state === "running" ? "now" : "queued"}</span></div>)}</div></div>
    </div> : <Generator onSubmit={(id) => { if (id) { setJobId(id); setSubmitted(true); } }} />}
  </AppShell>;
}
