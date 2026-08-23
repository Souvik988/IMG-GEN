"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { BudgetPanel, ModelsPanel, QualityRulesPanel, RunInspector, WorkflowStudio } from "../../components/workflow-studio";
import { apiFetch } from "../../lib/api";

type Overview = {
  jobsToday: number;
  successfulImages: number;
  avgAttemptsPerSuccess: number;
  avgCostInrPerSuccess: number;
  stateCounts: Array<{ state: string; count: number }>;
  resolutionMix: Array<{ resolution: string; count: number }>;
  topDefects: Array<{ code: string; count: number }>;
  firstPassAcceptance: { passed: number; total: number };
};

const tabs = ["Overview", "Workflow Studio", "Models", "Prompts", "Skills", "Quality rules", "Budget & cost", "Run inspector"] as const;

export default function Admin() {
  const [auth, setAuth] = useState<"loading" | "admin" | "blocked">("loading");
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  useEffect(() => {
    apiFetch<{ user: { role: string } }>("/api/auth/me")
      .then(({ user }) => setAuth(user.role === "admin" ? "admin" : "blocked"))
      .catch(() => setAuth("blocked"));
  }, []);

  if (auth === "loading") return <AppShell section="Control room"><div className="page"><section className="panel panel-pad loading-panel">Checking operator access…</section></div></AppShell>;
  if (auth === "blocked") return <AppShell section="Control room"><div className="page"><section className="access-card panel"><p className="eyebrow">Control room</p><h1 className="display">Operator access <em>required.</em></h1><p className="lede">The control room is connected to production configuration and run data. Sign in with an admin account to inspect or change it.</p><Link className="button button-coral" href="/login">Sign in as admin</Link><p className="help access-note">Local seed account: admin@shotlin.local · password from your local seed configuration.</p></section></div></AppShell>;

  return <AppShell section="Control room"><div className="page">
    <div className="page-head"><div><p className="eyebrow">Admin / {tab}</p><h1 className="display">Keep the pipeline <em>honest.</em></h1><p className="lede">Operate the actual workflow: versioned nodes, editable model and prompt bindings, live run traces, quality rules, and spend controls.</p></div><span className="chip chip-live"><span className="pulse-dot" /> admin API connected</span></div>
    <nav className="admin-tabs" aria-label="Control room sections">{tabs.map((item) => <button className={`tab-pill ${tab === item ? "active" : ""}`} onClick={() => setTab(item)} key={item}>{item}</button>)}</nav>
    {tab === "Overview" && <OverviewPanel />}
    {tab === "Workflow Studio" && <WorkflowStudio />}
    {tab === "Models" && <ModelsPanel />}
    {tab === "Prompts" && <PromptPanel />}
    {tab === "Skills" && <ResourcePanel title="Skill selector library" endpoint="/api/admin/skills" collection="skills" columns={["name", "category", "isEnabled"]} />}
    {tab === "Quality rules" && <QualityRulesPanel />}
    {tab === "Budget & cost" && <BudgetPanel />}
    {tab === "Run inspector" && <RunInspector />}
  </div></AppShell>;
}

function OverviewPanel() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<Overview>("/api/admin/overview").then(setOverview).catch((err) => setError(err instanceof Error ? err.message : "Could not load overview")); }, []);
  if (error) return <section className="panel panel-pad error-panel"><strong>Overview unavailable</strong><p>{error}</p></section>;
  if (!overview) return <section className="panel panel-pad loading-panel">Loading live operating metrics…</section>;
  const acceptance = overview.firstPassAcceptance.total > 0 ? Math.round((overview.firstPassAcceptance.passed / overview.firstPassAcceptance.total) * 100) : 0;
  return <>
    <div className="metric-grid"><Metric label="Jobs today" value={String(overview.jobsToday)} detail={`${overview.stateCounts.reduce((sum, item) => sum + item.count, 0)} total recorded`} /><Metric label="First-pass acceptance" value={`${acceptance}%`} detail={`${overview.firstPassAcceptance.passed} of ${overview.firstPassAcceptance.total} ready jobs`} /><Metric label="Avg cost / success" value={`₹${overview.avgCostInrPerSuccess.toFixed(2)}`} detail="measured from cost events" coral /><Metric label="Avg attempts" value={overview.avgAttemptsPerSuccess.toFixed(2)} detail="successful jobs only" /></div>
    <div className="admin-grid"><section className="panel panel-pad"><div className="panel-head"><div><p className="panel-kicker">Live state</p><h2 className="panel-title">Jobs by workflow state</h2></div><span className="help">database aggregate</span></div><div className="state-grid">{overview.stateCounts.length === 0 ? <p className="help">No jobs recorded.</p> : overview.stateCounts.map((item) => <div className="state-card" key={item.state}><span className={`state-mark state-${item.state}`} /><strong>{item.count}</strong><span>{item.state.replaceAll("_", " ")}</span></div>)}</div></section><section className="panel panel-pad"><div className="panel-head"><div><p className="panel-kicker">Quality signal</p><h2 className="panel-title">Observed defects</h2></div><span className="chip chip-warn">from reviews</span></div>{overview.topDefects.length === 0 ? <p className="help">No reviewed defects yet.</p> : <div className="insight-list">{overview.topDefects.map((defect) => <div className="insight" key={defect.code}><span>{defect.code}</span><strong>{defect.count} occurrence{defect.count === 1 ? "" : "s"}</strong></div>)}</div>}<div className="overview-foot"><span>Resolution mix</span><strong>{overview.resolutionMix.map((item) => `${item.resolution.toUpperCase()} ${item.count}`).join(" · ") || "—"}</strong></div></section></div>
    <section className="panel panel-pad" style={{ marginTop: 20 }}><div className="panel-head"><div><p className="panel-kicker">Operations</p><h2 className="panel-title">What this control room proves</h2></div></div><div className="proof-grid"><Proof label="Workflow" value="Ordered production graph" note="versioned in database" /><Proof label="Quality" value="Pass / fail / uncertain" note="second review is conditional" /><Proof label="Spend" value="Per-node cost events" note="hard stop before retry" /><Proof label="Trace" value="Prompt + truth sheet" note="available per job" /></div></section>
  </>;
}

function Metric({ label, value, detail, coral = false }: { label: string; value: string; detail: string; coral?: boolean }) { return <div className={`metric ${coral ? "metric-coral" : ""}`}><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-delta">{detail}</div></div>; }
function Proof({ label, value, note }: { label: string; value: string; note: string }) { return <div className="proof-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>; }

function ResourcePanel({ title, endpoint, collection, columns }: { title: string; endpoint: string; collection: string; columns: string[] }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<Record<string, Array<Record<string, unknown>>>>(endpoint).then((payload) => setRows(payload[collection] ?? [])).catch((err) => setError(err instanceof Error ? err.message : "Could not load resource")); }, [endpoint, collection]);
  return <section className="panel panel-pad resource-panel"><div className="panel-head"><div><p className="panel-kicker">Live registry</p><h2 className="panel-title">{title}</h2><p className="help">Read from the admin API. Editing versioned resources remains auditable and can be added without changing run history.</p></div><span className="chip">{rows?.length ?? "…"} records</span></div>{error ? <p className="error-copy">{error}</p> : !rows ? <p className="help">Loading…</p> : rows.length === 0 ? <div className="empty-state"><strong>No records</strong><span>Seed or create a record before binding it to a workflow node.</span></div> : <div className="table-scroll"><table className="data-table"><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{columns.map((column) => <td key={column}>{typeof row[column] === "boolean" ? <span className={`chip ${row[column] ? "" : "chip-warn"}`}>{row[column] ? "on" : "off"}</span> : String(row[column] ?? "—")}</td>)}</tr>)}</tbody></table></div>}</section>;
}

function PromptPanel() {
  const [rows, setRows] = useState<Array<{ id: string; key: string; name: string; category: string; versions: Array<{ version: number; status: string; body: string }> }> | null>(null);
  useEffect(() => { apiFetch<{ prompts: NonNullable<typeof rows> }>("/api/admin/prompts").then((payload) => setRows(payload.prompts ?? [])).catch(() => setRows([])); }, []);
  return <section className="panel panel-pad resource-panel"><div className="panel-head"><div><p className="panel-kicker">Versioned prompt registry</p><h2 className="panel-title">System prompts and compiler instructions</h2><p className="help">Every workflow binding points to a prompt version. Drafts can be published or rolled back through the API.</p></div><span className="chip">{rows?.length ?? "…"} prompts</span></div>{!rows ? <p className="help">Loading…</p> : <div className="prompt-list">{rows.map((prompt) => <details className="prompt-row" key={prompt.id}><summary><strong>{prompt.name}</strong><span>{prompt.category} · {prompt.versions.length} version{prompt.versions.length === 1 ? "" : "s"}</span></summary><div className="prompt-versions">{prompt.versions.map((version) => <div className="prompt-version" key={version.version}><div><strong>v{version.version}</strong><span className="chip">{version.status}</span></div><pre>{version.body}</pre></div>)}</div></details>)}</div>}</section>;
}
