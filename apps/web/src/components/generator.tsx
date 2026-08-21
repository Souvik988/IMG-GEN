"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";
import { apiFetch, type CatalogCharacter, type CatalogEnvironment } from "../lib/api";

type Props = { onSubmit: (jobId: string) => void };
type RecentProject = { id: string; state: string; display: string; resolution: string; aspectRatio: string; createdAt: string; thumbnailUrl: string | null };
const environments = [["Outdoor / natural", "Open shade"], ["Studio commercial", "Clean sweep"], ["Festive", "Warm ceremony"], ["Cinematic fashion", "Low-key light"]];

export function Generator({ onSubmit }: Props) {
  const [image, setImage] = useState<string | null>(null);
  const [environment, setEnvironment] = useState(0);
  const [resolution, setResolution] = useState("2K");
  const [aspect, setAspect] = useState("Portrait");
  // Cost-safe default: one provider image request producing one output.
  const [count, setCount] = useState("1 image");
  const [age, setAge] = useState("mid-20s");
  const [height, setHeight] = useState("average");
  const [pose, setPose] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [characters, setCharacters] = useState<CatalogCharacter[]>([]);
  const [catalogEnvironments, setCatalogEnvironments] = useState<CatalogEnvironment[]>([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [customCharacterAssetId, setCustomCharacterAssetId] = useState<string | null>(null);
  const [customCharacterName, setCustomCharacterName] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const generationRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const characterFileInputRef = useRef<HTMLInputElement>(null);
  const sceneOptions = catalogEnvironments.length
    ? catalogEnvironments.map((item) => [item.name, item.category, item.id] as const)
    : environments.map((item) => [item[0], item[1], ""] as const);

  const imageCount = Number.parseInt(count, 10) || 1;
  // Mirrors the server-side default angle set in @shotlin/core.
  const angleLabels = ["Front", "3/4 Left", "3/4 Right", "Side Profile", "Back"].slice(0, imageCount);
  // Planning reserve is priced per delivered image, same as the worker budget.
  const reserveInr = imageCount * (resolution === "4K" ? 30 : resolution === "1K" ? 8 : 20);

  async function handleFile(file?: File) {
    if (!file) return;
    setImage(URL.createObjectURL(file));
    setMessage(null);
    try {
      const presign = await apiFetch<{ assetId: string; uploadUrl: string; headers: Record<string, string> }>("/api/uploads", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, contentType: file.type, kind: "garment_reference" }),
      });
      const upload = await fetch(presign.uploadUrl, { method: "PUT", headers: presign.headers, body: file });
      if (!upload.ok) throw new Error("Reference upload failed");
      await apiFetch(`/api/uploads/${presign.assetId}/complete`, { method: "POST", body: JSON.stringify({ filename: file.name }) });
      setAssetId(presign.assetId);
      setMessage("Reference uploaded and checked");
    } catch (error) {
      setMessage(error instanceof Error && error.message.includes("Not signed in") ? "Preview ready — sign in to connect this upload" : error instanceof Error ? error.message : "Reference preview ready");
    }
  }

  async function handleCharacterFile(file?: File) {
    if (!file) return;
    setMessage(null);
    try {
      const presign = await apiFetch<{ assetId: string; uploadUrl: string; headers: Record<string, string> }>("/api/uploads", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, contentType: file.type, kind: "character_reference" }),
      });
      const upload = await fetch(presign.uploadUrl, { method: "PUT", headers: presign.headers, body: file });
      if (!upload.ok) throw new Error("Character upload failed");
      await apiFetch(`/api/uploads/${presign.assetId}/complete`, { method: "POST", body: JSON.stringify({ filename: file.name }) });
      setCustomCharacterAssetId(presign.assetId);
      setCustomCharacterName(file.name);
      setSelectedCharacterId(null);
      setMessage("Character reference uploaded and checked");
    } catch (error) {
      setMessage(error instanceof Error && error.message.includes("Not signed in") ? "Preview ready — sign in to connect this upload" : error instanceof Error ? error.message : "Character upload failed");
    }
  }

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      if (!assetId) throw new Error("Upload a reference and sign in before generating");
      const environmentId = sceneOptions[environment]?.[2] || null;
      const requestBody = { mainGarmentAssetId: assetId, characterId: customCharacterAssetId ? null : selectedCharacterId, characterAssetId: customCharacterAssetId, environmentPresetId: environmentId, resolution: resolution.toLowerCase(), aspectRatio: aspect.toLowerCase(), outputCount: Number.parseInt(count, 10), inputType: "photo", ageAppearance: age, heightAppearance: height, pose };
      const fingerprint = JSON.stringify(requestBody);
      if (!generationRequestRef.current || generationRequestRef.current.fingerprint !== fingerprint) {
        generationRequestRef.current = { fingerprint, key: crypto.randomUUID() };
      }
      const result = await apiFetch<{ job: { id: string } }>("/api/jobs", {
        method: "POST",
        headers: { "Idempotency-Key": generationRequestRef.current.key },
        body: JSON.stringify(requestBody),
      });
      onSubmit(result.job.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start generation");
      setBusy(false);
    }
  }

  useEffect(() => {
    apiFetch<CatalogCharacter[]>("/api/customer/characters").then((data) => { setCharacters(data); setSelectedCharacterId(data[0]?.id ?? null); }).catch(() => undefined);
    apiFetch<CatalogEnvironment[]>("/api/customer/environments").then(setCatalogEnvironments).catch(() => undefined);
    apiFetch<{ projects: RecentProject[] }>("/api/projects").then((payload) => setRecentProjects(payload.projects.slice(0, 3))).catch(() => undefined);
  }, []);
  return <div className="page">
    <div className="page-head"><div><p className="eyebrow">Zero-prompt image studio</p><h1 className="display">Make the garment<br /><em>the main character.</em></h1><p className="lede">Bring a reference. Shotlin handles the visual language, fidelity checks, and repair loop for you.</p></div><div className="top-actions"><span className="help">Draft · autosaved just now</span></div></div>
    <div className="dashboard-grid">
      <section className="panel generator">
        <div className="generator-head"><div><p className="panel-kicker">New generation</p><h2 className="panel-title">Build a look</h2></div><div className="generator-head-note"><span className="status-dot" /> Queue + quality loop online</div></div>
        <div className="steps">{[["01", "Garment"], ["02", "Character"], ["03", "Scene"], ["04", "Output"], ["05", "Review"]].map(([step, label], i) => <button className={`step-tab ${i === 0 ? "active" : ""}`} data-step={step} key={step}>{label}</button>)}</div>
        <div className="form-body">
          <div className="form-section"><div className="section-head"><h3 className="section-heading">Start with a reference</h3><span className="section-caption">Required · 1 main image</span></div><label className="dropzone">{image ? <img className="upload-preview" src={image} alt="Uploaded garment reference" /> : <><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => handleFile(e.target.files?.[0])} /><div><span className="upload-symbol"><Icon name="plus" /></span><p className="drop-title">Drop your garment reference here</p><p className="drop-subtitle">JPG, PNG or WEBP · up to 25 MB</p></div></>}</label></div>
          <div className="form-section"><div className="section-head"><h3 className="section-heading">Choose a character</h3><span className="section-caption">Identity stays consistent</span></div><div className="choice-grid">{(characters.length ? characters.slice(0, 2).map((character) => [character.name, character.description ?? "Studio character", character.id]) : [["Mira", "Editorial · 5'7\"", ""], ["Anika", "Natural · 5'5\"", ""]]).map(([name, note, id], i) => <button className={`choice ${!customCharacterAssetId && (selectedCharacterId === id || (!selectedCharacterId && i === 0)) ? "selected" : ""}`} onClick={() => { setSelectedCharacterId(id || null); setCustomCharacterAssetId(null); setCustomCharacterName(null); }} key={name}><span className="choice-title">{name}</span><span className="choice-note">{note}</span>{!customCharacterAssetId && (selectedCharacterId === id || (!selectedCharacterId && i === 0)) && <span className="choice-mark"><Icon name="check" /></span>}</button>)}<input ref={characterFileInputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{display: "none"}} onChange={(e) => handleCharacterFile(e.target.files?.[0])} /><button className={`choice ${customCharacterAssetId ? "selected" : ""}`} onClick={() => characterFileInputRef.current?.click()}><span className="choice-title">{customCharacterName ?? "Upload character"}</span><span className="choice-note">Use your own reference</span>{customCharacterAssetId && <span className="choice-mark"><Icon name="check" /></span>}</button></div><div className="select-row"><div className="select-field"><label>Age appearance</label><select value={age} onChange={(event) => setAge(event.target.value)}><option value="young-adult">Young adult</option><option value="mid-20s">Mid-20s</option><option value="mature">Mature</option></select></div><div className="select-field"><label>Height</label><select value={height} onChange={(event) => setHeight(event.target.value)}><option value="petite">Petite</option><option value="average">Average</option><option value="tall">Tall</option></select></div><div className="select-field"><label>Pose</label><select value={pose} onChange={(event) => setPose(event.target.value)}><option value="auto">Auto</option><option value="standing">Standing</option><option value="walking">Walking</option><option value="closeup">Close-up</option></select></div></div></div>
          <div className="form-section"><div className="section-head"><h3 className="section-heading">Set the scene</h3><span className="section-caption">Indoor / outdoor is an actual environment preset</span></div><div className="choice-grid">{sceneOptions.map(([name, note], i) => <button className={`choice choice-card ${environment === i ? "selected" : ""}`} key={name} onClick={() => setEnvironment(i)}><span className="choice-title">{name}</span><span className="choice-note">{note}</span></button>)}</div></div>
          <div className="form-section"><div className="section-head"><h3 className="section-heading">Output</h3><span className="section-caption">The pipeline will pick the right model</span></div><div className="select-row"><div className="select-field"><label>Resolution</label><select value={resolution} onChange={(e) => setResolution(e.target.value)}><option>1K</option><option>2K</option><option>4K</option></select></div><div className="select-field"><label>Frame</label><select value={aspect} onChange={(e) => setAspect(e.target.value)}><option>Portrait</option><option>Square</option><option>Landscape</option></select></div><div className="select-field"><label>Set size</label><select value={count} onChange={(e) => setCount(e.target.value)}><option>1 image</option><option>2 images</option><option>3 images</option><option>4 images</option><option>5 images</option></select></div></div></div>
          <div className="form-footer"><div><p className="summary-line"><strong>{resolution} · {aspect}</strong> · {count} · {sceneOptions[environment]?.[0] ?? "Choose a scene"}{imageCount > 1 ? ` · ${imageCount} angles, same character` : ""}</p>{message && <p className="help" style={{marginTop: 7, color: message.includes("failed") || message.includes("sign in") ? "var(--coral)" : "#4f9875"}}>{message}</p>}</div><button className="button button-coral" onClick={submit} disabled={busy}>{busy ? "Starting…" : "Generate look"}<span style={{marginLeft: 12}}><Icon name="arrow" /></span></button></div>
        </div>
      </section>
      <aside className="panel reference-rail"><div className="panel-head"><div><p className="panel-kicker">Reference rail</p><h2 className="panel-title">What Shotlin is holding</h2></div><span className="chip">protected</span></div><div className="reference-item"><span className="reference-number">01</span><div><div className="reference-name">Garment structure</div><div className="reference-status ready">{assetId ? "Uploaded · validation pending" : "Waiting for image"}</div></div></div><div className="reference-item"><span className="reference-number">02</span><div><div className="reference-name">Character identity</div><div className="reference-status ready">{customCharacterAssetId ? (customCharacterName ?? "Custom character") : (characters.find((c) => c.id === selectedCharacterId)?.name ?? characters[0]?.name ?? "Choose a character")} · locked</div></div></div><div className="reference-item"><span className="reference-number">03</span><div><div className="reference-name">Environment language</div><div className="reference-status">{sceneOptions[environment]?.[0] ?? "Choose a scene"}</div></div></div><div className="reference-item"><span className="reference-number">04</span><div><div className="reference-name">Quality bar</div><div className="reference-status">Fidelity-first review</div></div></div><div className="reference-item"><span className="reference-number">05</span><div><div className="reference-name">Camera angles</div><div className="reference-status ready">{imageCount === 1 ? "Single frame" : angleLabels.join(" · ")}</div></div></div><div className="rail-total"><span>Estimated internal reserve</span><strong>₹{reserveInr}</strong></div><p className="help" style={{marginTop: 11}}>The prompt stays behind the scenes. Your choices are the brief.</p></aside>
    </div>
    <section className="panel panel-pad mini-projects"><div className="panel-head"><div><p className="panel-kicker">Your studio</p><h2 className="panel-title">Recent projects</h2></div><a className="help" href="/projects">View archive <Icon name="arrow" /></a></div>{recentProjects.length ? <div className="project-list">{recentProjects.map((project) => <a href={`/jobs/${project.id}`} className="project-row" key={project.id}><span className="project-thumb project-thumb-real">{project.thumbnailUrl && <img src={project.thumbnailUrl} alt="" />}</span><div><div className="project-name">{project.display}</div><div className="project-meta">{project.resolution.toUpperCase()} · {project.aspectRatio} · {new Date(project.createdAt).toLocaleDateString()}</div></div><span className="project-state" style={{color: project.state === "ready" ? "#4f9875" : "#c18442"}}>{project.state.replaceAll("_", " ")}</span></a>)}</div> : <div className="empty-state"><strong>No connected jobs yet</strong><span>Sign in and submit a generation to populate this archive.</span></div>}</section>
  </div>;
}

function Project({ name, meta, tone }: { name: string; meta: string; tone: string }) { return <div className="project-row"><span className={`project-thumb ${tone}`} /><div><div className="project-name">{name}</div><div className="project-meta">{meta}</div></div><span className="project-state">Ready</span></div>; }
