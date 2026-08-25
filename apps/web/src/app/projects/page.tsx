"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { Icon } from "../../components/icon";
import { apiFetch } from "../../components/api";

type Project = { id: string; state: string; display: string; resolution: string; aspectRatio: string; outputCount: number; createdAt: string; thumbnailUrl: string | null };

export default function Projects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<{ projects: Project[] }>("/api/projects").then((payload) => setProjects(payload.projects)).catch((err) => setError(err instanceof Error ? err.message : "Sign in to view projects")); }, []);
  return <AppShell section="Projects"><div className="page"><div className="page-head"><div><p className="eyebrow">Your archive</p><h1 className="display">A library of <em>looks.</em></h1><p className="lede">Every job is loaded from the API. Open a run to watch its worker state or download its signed output when ready.</p></div><Link className="button button-coral" href="/">New generation <span style={{marginLeft: 9}}><Icon name="plus" /></span></Link></div><section className="panel panel-pad"><div className="panel-head"><div><p className="panel-kicker">Workspace archive</p><h2 className="panel-title">All projects</h2></div><span className="chip">{projects?.length ?? "…"} jobs</span></div>{error ? <div className="empty-state"><strong>Projects unavailable</strong><span>{error}</span><Link className="button button-ghost button-small" href="/login">Sign in</Link></div> : !projects ? <p className="help">Loading archive…</p> : projects.length === 0 ? <div className="empty-state"><strong>No jobs yet</strong><span>Your first generation will appear here.</span></div> : <div className="project-list">{projects.map((project) => <Link href={`/jobs/${project.id}`} className="project-row" key={project.id}><span className="project-thumb project-thumb-real">{project.thumbnailUrl && <img src={project.thumbnailUrl} alt="" />}</span><div><div className="project-name">{project.id.slice(0, 8)} · {project.display}</div><div className="project-meta">{project.resolution.toUpperCase()} · {project.aspectRatio} · {project.outputCount} output{project.outputCount === 1 ? "" : "s"} · {new Date(project.createdAt).toLocaleString()}</div></div><span className="project-state" style={{color: project.state === "ready" ? "#4f9875" : project.state.includes("fail") ? "#c65d4b" : "#c18442"}}>{project.state.replaceAll("_", " ")}</span></Link>)}</div>}</section></div></AppShell>;
}
