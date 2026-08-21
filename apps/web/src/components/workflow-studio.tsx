"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";

type Json = Record<string, unknown>;
type StudioView = "canvas" | "wizard";

type WorkflowNode = {
  node: {
    id: string;
    nodeKey: string;
    sequence: number;
    name: string;
    nodeType: string;
    isEnabled: boolean;
  };
  config: {
    id: string;
    modelId: string | null;
    promptVersionId: string | null;
    timeoutMs: number;
    maxRetries: number;
    thresholds: Json;
    settings: Json;
  } | null;
};

type Model = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  role: string;
  isEnabled: boolean;
  activePrice?: { inputPricePerM?: string | null; outputPricePerM?: string | null; imagePrices?: Json | null } | null;
};

type Prompt = {
  id: string;
  key: string;
  name: string;
  category: string;
  versions: Array<{ id: string; version: number; status: string; body: string; variables?: string[] }>;
};

type JobSummary = {
  id: string;
  state: string;
  requestedResolution: string;
  aspectRatio: string;
  outputCount: number;
  totalCostInr: string;
  createdAt: string;
  updatedAt: string;
  userEmail?: string;
};

type CostEvent = {
  id: string;
  attemptId: string | null;
  stepRunId: string | null;
  nodeKey: string;
  provider: string;
  modelName: string | null;
  modelIdLabel?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  imageCount: number;
  resolution: string | null;
  providerReportedCostUsd: string | null;
  usdCost: string;
  fxRate: string;
  inrCost: string;
  costBasis: "provider_reported" | "configured_price" | "deterministic";
  stepStatus: string | null;
  durationMs: number | null;
  createdAt: string;
};

type CostTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  imageCount: number;
  workflowSteps: number;
  apiCalls: number;
  deterministicSteps: number;
  providerReportedCalls: number;
  configuredPriceCalls: number;
  usdCost: number;
  inrCost: number;
  fxRate: number;
};

type CostModelSubtotal = {
  modelKey: string;
  provider: string;
  modelName: string | null;
  modelIdLabel: string | null;
  nodes: string[];
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  imageCount: number;
  providerReportedLines: number;
  configuredPriceLines: number;
  usdCost: number;
  inrCost: number;
  pricingBasis: "provider_reported" | "configured_price" | "mixed";
};

type JobInspector = {
  job: JobSummary & { truthSheet?: Json | null; characterId?: string | null; environmentPresetId?: string | null };
  inputs: Array<{ role: string; assetUrl: string | null; asset?: { originalFilename?: string | null } | null }>;
  truthSheet: Json | null;
  attempts: Array<{ attemptNumber: number; status: string; decision: string | null; compiledPrompt: string | null; repairInstruction: string | null; startedAt: string; finishedAt: string | null }>;
  workflowNodes: Array<{ nodeKey: string; name: string; sequence: number; isEnabled: boolean }>;
  stepRuns: Array<{ id: string; nodeKey: string; status: string; modelId: string | null; error: string | null; durationMs: number | null; startedAt: string; finishedAt: string | null; outputRef: Json | null }>;
  candidates: Array<{ id: string; sequence: number; isFinal: boolean; assetUrl: string | null; reviews: Array<{ reviewType: string; garmentFidelityScore: number | null; characterIdentityScore: number | null; photorealismScore: number | null; review: Json; defects: Array<{ severity: string; code: string; description: string }> }> }>;
  output: { previewUrl: string | null; jpgUrl: string | null; masterUrl: string | null } | null;
  stateEvents: Array<{ fromState: string | null; toState: string; reason: string | null; createdAt: string }>;
  costTotals: CostTotals;
  costModels: CostModelSubtotal[];
  costEvents: CostEvent[];
};

const terminalStates = new Set(["ready", "input_rejected", "failed", "budget_stopped", "manual_review", "cancelled"]);

function pretty(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function formatTokens(value: number) {
  return value.toLocaleString("en-IN");
}

function formatInr(value: number | string) {
  return `₹${Number(value).toFixed(2)}`;
}

function formatUsd(value: number | string) {
  return `$${Number(value).toFixed(6)}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatDuration(value: number | null) {
  if (value == null) return "—";
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}

function costBasisLabel(basis: CostEvent["costBasis"]) {
  if (basis === "provider_reported") return "provider reported";
  if (basis === "configured_price") return "price version";
  return "no API call";
}

function labelForNode(nodeKey: string) {
  return nodeKey.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function modelPricingLabel(basis: CostModelSubtotal["pricingBasis"]) {
  if (basis === "provider_reported") return "provider reported";
  if (basis === "configured_price") return "price version";
  return "mixed basis";
}

function CostLedger({ totals, models, events }: { totals: CostTotals; models: CostModelSubtotal[]; events: CostEvent[] }) {
  return <section className="cost-ledger" aria-label="Exact workflow cost ledger">
    <div className="cost-ledger-head">
      <div><p className="panel-kicker">Exact cost ledger</p><h3 className="panel-title">This image run</h3><p className="help">Every workflow stage is itemized. Deterministic stages are visible but never charged as an API call.</p></div>
      <div className="ledger-total"><strong>{formatInr(totals.inrCost)}</strong><span>{formatUsd(totals.usdCost)} · $1 = ₹{Number(totals.fxRate).toFixed(2)}</span></div>
    </div>
    <div className="ledger-metrics">
      <div className="ledger-metric"><strong>{formatTokens(totals.totalTokens)}</strong><span>total tokens</span><small>{formatTokens(totals.inputTokens)} in · {formatTokens(totals.outputTokens)} out</small></div>
      <div className="ledger-metric"><strong>{totals.imageCount}</strong><span>image units</span><small>{totals.apiCalls} API calls · {totals.deterministicSteps} free steps</small></div>
      <div className="ledger-metric"><strong>{totals.workflowSteps}</strong><span>workflow steps</span><small>{totals.providerReportedCalls} provider priced · {totals.configuredPriceCalls} catalog priced</small></div>
    </div>
    <div className="ledger-models"><div className="ledger-section-head"><h4>Spend by model</h4><span>Use these subtotals to optimize the pipeline</span></div>{models.length === 0 ? <p className="help">No billed model calls yet.</p> : <div className="ledger-table-wrap"><table className="data-table ledger-table model-ledger-table"><thead><tr><th>Model</th><th>Workflow stages</th><th>Usage</th><th>Pricing basis</th><th>Subtotal</th></tr></thead><tbody>{models.map((model) => <tr key={model.modelKey}>
      <td><strong>{model.modelName ?? model.provider}</strong><small>{model.modelIdLabel ?? model.provider}</small></td>
      <td><strong>{model.apiCalls} call{model.apiCalls === 1 ? "" : "s"}</strong><small>{model.nodes.map(labelForNode).join(" · ")}</small></td>
      <td><strong>{formatTokens(model.totalTokens)} tokens</strong><small>{formatTokens(model.inputTokens)} in · {formatTokens(model.outputTokens)} out{model.imageCount ? ` · ${model.imageCount} image` : ""}</small></td>
      <td><span className={`cost-basis cost-basis-${model.pricingBasis}`}>{modelPricingLabel(model.pricingBasis)}</span><small>{model.providerReportedLines} reported · {model.configuredPriceLines} catalog</small></td>
      <td><strong>{formatInr(model.inrCost)}</strong><small>{formatUsd(model.usdCost)}</small></td>
    </tr>)}</tbody></table></div>}</div>
    <div className="ledger-section-head ledger-stage-head"><h4>Stage-by-stage ledger</h4><span>Each line is one executed or intentionally skipped node</span></div>
    {events.length === 0 ? <p className="help">No cost events have been recorded for this run yet.</p> : <div className="ledger-table-wrap"><table className="data-table ledger-table"><thead><tr><th>Stage</th><th>Model / source</th><th>Usage</th><th>Basis</th><th>Cost</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}>
      <td><strong>{labelForNode(event.nodeKey)}</strong><small>{event.stepStatus ?? "recorded"} · {formatDuration(event.durationMs)}</small></td>
      <td><strong>{event.modelName ?? (event.provider === "deterministic" ? "Local rule / state" : event.provider)}</strong><small>{event.modelIdLabel ?? event.provider}</small></td>
      <td><strong>{formatTokens(event.totalTokens)} tokens</strong><small>{formatTokens(event.inputTokens)} in · {formatTokens(event.outputTokens)} out{event.imageCount ? ` · ${event.imageCount} image` : ""}</small></td>
      <td><span className={`cost-basis cost-basis-${event.costBasis}`}>{costBasisLabel(event.costBasis)}</span>{event.providerReportedCostUsd != null && <small>{formatUsd(event.providerReportedCostUsd)} reported</small>}</td>
      <td><strong>{formatInr(event.inrCost)}</strong><small>{formatUsd(event.usdCost)}</small></td>
    </tr>)}</tbody></table></div>}
    <p className="cost-ledger-note">Provider-reported cost is used when OpenRouter returns it. If it does not, the active model price version estimates the line item; INR is USD × the recorded FX rate.</p>
  </section>;
}

export function WorkflowStudio() {
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [activeVersion, setActiveVersion] = useState<number | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promptBody, setPromptBody] = useState("");
  const [studioView, setStudioView] = useState<StudioView>("canvas");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [orderDirty, setOrderDirty] = useState(false);

  const selected = nodes.find((item) => item.node.nodeKey === selectedKey) ?? nodes[0] ?? null;
  const selectedPromptVersion = selected?.config?.promptVersionId
    ? prompts.flatMap((prompt) => prompt.versions).find((version) => version.id === selected.config?.promptVersionId) ?? null
    : null;
  const selectedModels = useMemo(() => {
    if (!selected) return models;
    const roleByNode: Record<string, string> = {
      vision: "vision_analyzer",
      image_generate: "image_generator",
      quality_review: "quality_reviewer",
      second_review: "second_reviewer",
    };
    const role = roleByNode[selected.node.nodeKey];
    return role ? models.filter((model) => model.role === role) : [];
  }, [models, selected]);
  const readiness = useMemo(() => {
    const modelNodeKeys = new Set(["vision", "image_generate", "quality_review", "second_review"]);
    const promptNodeKeys = new Set(["input_check", "vision", "prompt_compile", "image_generate", "quality_review", "second_review"]);
    const enabledNodes = nodes.filter((item) => item.node.isEnabled);
    const modelNodes = enabledNodes.filter((item) => modelNodeKeys.has(item.node.nodeKey));
    const missingModels = modelNodes.filter((item) => {
      const model = models.find((candidate) => candidate.id === item.config?.modelId);
      return !model || !model.isEnabled || !model.activePrice;
    });
    const missingPrompts = enabledNodes.filter((item) => promptNodeKeys.has(item.node.nodeKey) && !item.config?.promptVersionId);
    const draftPrompts = enabledNodes.filter((item) => {
      if (!promptNodeKeys.has(item.node.nodeKey) || !item.config?.promptVersionId) return false;
      const version = prompts.flatMap((prompt) => prompt.versions).find((candidate) => candidate.id === item.config?.promptVersionId);
      return version?.status !== "production";
    });
    return {
      enabledNodes: enabledNodes.length,
      modelNodes: modelNodes.length,
      deterministicNodes: enabledNodes.length - modelNodes.length,
      promptBound: enabledNodes.filter((item) => item.config?.promptVersionId).length,
      missingModels,
      missingPrompts,
      draftPrompts,
    };
  }, [models, nodes, prompts]);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      apiFetch<{ nodes: WorkflowNode[]; activeVersion: { version: number } }>("/api/admin/workflow"),
      apiFetch<{ models: Model[] }>("/api/admin/models"),
      apiFetch<{ prompts: Prompt[] }>("/api/admin/prompts"),
    ])
      .then(([workflow, modelRows, promptRows]) => {
        if (!mounted) return;
        setNodes(workflow.nodes);
        setActiveVersion(workflow.activeVersion.version);
        setModels(modelRows.models);
        setPrompts(promptRows.prompts);
        setSelectedKey(workflow.nodes[0]?.node.nodeKey ?? null);
        setOrderDirty(false);
      })
      .catch((err) => mounted && setError(err instanceof Error ? err.message : "Could not load workflow configuration"))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    setPromptBody(selectedPromptVersion?.body ?? "");
  }, [selectedPromptVersion?.id, selectedPromptVersion?.body]);

  async function savePromptDraft() {
    if (!selectedPromptVersion || !selectedPromptVersion.body || selectedPromptVersion.body === promptBody) {
      setMessage("Change the prompt text before creating a new draft version.");
      return;
    }
    const prompt = prompts.find((item) => item.versions.some((version) => version.id === selectedPromptVersion.id));
    if (!prompt) return;
    try {
      const created = await apiFetch<{ version: Prompt["versions"][number] }>(`/api/admin/prompts/${prompt.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ body: promptBody, variables: selectedPromptVersion.variables ?? [], notes: "Edited in Workflow Studio" }),
      });
      setPrompts((current) => current.map((item) => item.id === prompt.id ? { ...item, versions: [created.version, ...item.versions] } : item));
      setMessage(`Prompt draft v${created.version.version} created. Publish it from the prompt registry before binding it to production.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not create prompt draft");
    }
  }

  async function saveNode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    let thresholds: Json = {};
    let settings: Json = {};
    try {
      thresholds = JSON.parse(String(form.get("thresholds") ?? "{}")) as Json;
      settings = JSON.parse(String(form.get("settings") ?? "{}")) as Json;
    } catch {
      setMessage("Thresholds and settings must be valid JSON.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch(`/api/admin/workflow/${selected.node.nodeKey}`, {
        method: "PUT",
        body: JSON.stringify({
          isEnabled: form.get("isEnabled") === "on",
          modelId: String(form.get("modelId") || "") || null,
          promptVersionId: String(form.get("promptVersionId") || "") || null,
          timeoutMs: Number(form.get("timeoutMs")),
          maxRetries: Number(form.get("maxRetries")),
          thresholds,
          settings,
        }),
      });
      setNodes((current) => current.map((item) => item.node.nodeKey === selected.node.nodeKey
        ? { ...item, node: { ...item.node, isEnabled: form.get("isEnabled") === "on" }, config: { ...(item.config ?? { id: "", modelId: null, promptVersionId: null, timeoutMs: 60000, maxRetries: 1, thresholds: {}, settings: {} }), modelId: String(form.get("modelId") || "") || null, promptVersionId: String(form.get("promptVersionId") || "") || null, timeoutMs: Number(form.get("timeoutMs")), maxRetries: Number(form.get("maxRetries")), thresholds, settings } }
        : item));
      setMessage(`${selected.node.name} saved to production configuration.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save node");
    } finally {
      setSaving(false);
    }
  }

  function reorderNodes(sourceKey: string, targetKey: string) {
    if (sourceKey === targetKey) return;
    setNodes((current) => {
      const sourceIndex = current.findIndex((item) => item.node.nodeKey === sourceKey);
      const targetIndex = current.findIndex((item) => item.node.nodeKey === targetKey);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setOrderDirty(true);
  }

  function moveNode(key: string, direction: -1 | 1) {
    const index = nodes.findIndex((item) => item.node.nodeKey === key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= nodes.length) return;
    reorderNodes(key, nodes[target].node.nodeKey);
  }

  function selectRelative(direction: -1 | 1) {
    if (!selected) return;
    const index = nodes.findIndex((item) => item.node.nodeKey === selected.node.nodeKey);
    const target = nodes[index + direction];
    if (target) setSelectedKey(target.node.nodeKey);
  }

  async function saveOrder() {
    if (!orderDirty) return;
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch("/api/admin/workflow/order", {
        method: "PUT",
        body: JSON.stringify({ nodeKeys: nodes.map((item) => item.node.nodeKey) }),
      });
      setOrderDirty(false);
      setMessage("Execution order saved to the production workflow.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save execution order");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="panel panel-pad loading-panel">Loading production workflow configuration…</section>;
  if (error) return <section className="panel panel-pad error-panel"><strong>Workflow unavailable</strong><p>{error}</p><a className="button button-ghost button-small" href="/login">Sign in as admin</a></section>;

  return <div className="workflow-studio">
    <section className="studio-toolbar panel panel-pad">
      <div><p className="panel-kicker">Workflow Studio</p><h2 className="panel-title">Production pipeline · v{activeVersion ?? "—"}</h2><p className="help">Drag nodes to change the execution order, or use the guided wizard. Every node keeps its model, prompt, thresholds, timeout, and retry policy.</p></div>
      <div className="studio-toolbar-actions"><span className="chip chip-live"><span className="pulse-dot" /> live configuration</span><button type="button" className="button button-coral button-small" disabled={!orderDirty || saving} onClick={saveOrder}>{saving ? "Saving…" : "Save execution order"}</button></div>
    </section>
    <section className={`readiness-strip panel panel-pad ${readiness.missingModels.length || readiness.missingPrompts.length ? "readiness-warn" : ""}`} aria-label="Production readiness">
      <div><p className="panel-kicker">Production readiness</p><strong>{readiness.missingModels.length || readiness.missingPrompts.length ? "Needs attention before live generation" : "Ready for a live garment test"}</strong><p className="help">Every enabled model node needs an active price; every prompt-bearing node needs a production prompt version.</p></div>
      <div className="readiness-checks"><span><strong>{readiness.enabledNodes}</strong> enabled nodes</span><span><strong>{readiness.modelNodes}</strong> billed-capable nodes</span><span><strong>{readiness.deterministicNodes}</strong> deterministic/free nodes</span><span><strong>{readiness.promptBound}</strong> prompt bindings</span></div>
      {(readiness.missingModels.length > 0 || readiness.missingPrompts.length > 0 || readiness.draftPrompts.length > 0) && <p className="readiness-issues">{readiness.missingModels.length > 0 ? `${readiness.missingModels.map((item) => item.node.name).join(", ")} missing an active priced model. ` : ""}{readiness.missingPrompts.length > 0 ? `${readiness.missingPrompts.map((item) => item.node.name).join(", ")} missing a prompt. ` : ""}{readiness.draftPrompts.length > 0 ? `${readiness.draftPrompts.map((item) => item.node.name).join(", ")} use draft prompts.` : ""}</p>}
    </section>
    <div className="studio-modebar" role="tablist" aria-label="Workflow editor mode">
      <button type="button" role="tab" aria-selected={studioView === "canvas"} className={`tab-pill ${studioView === "canvas" ? "active" : ""}`} onClick={() => setStudioView("canvas")}>Canvas · drag &amp; drop</button>
      <button type="button" role="tab" aria-selected={studioView === "wizard"} className={`tab-pill ${studioView === "wizard" ? "active" : ""}`} onClick={() => setStudioView("wizard")}>Wizard · guided setup</button>
      {orderDirty && <span className="help studio-dirty">Unsaved execution order</span>}
    </div>
    <div className="studio-layout">
      {studioView === "canvas" ? <section className="workflow-canvas panel panel-pad" aria-label="Workflow execution order">
        <div className="canvas-label"><span>Input</span><span>Decision path</span><span>Output</span></div>
        <p className="canvas-hint">Drag a node by its handle. Keyboard users can use the ↑ and ↓ controls.</p>
        <div className="workflow-rail" role="list">
          {nodes.map((item, index) => <div className={`workflow-node-wrap ${dragKey === item.node.nodeKey ? "dragging" : ""}`} key={item.node.id} role="listitem" draggable onDragStart={() => setDragKey(item.node.nodeKey)} onDragEnd={() => setDragKey(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (dragKey) reorderNodes(dragKey, item.node.nodeKey); setDragKey(null); }}>
            <div className="workflow-node-line"><span className="drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span><button className={`workflow-node ${selected?.node.id === item.node.id ? "selected" : ""} ${item.node.isEnabled ? "" : "disabled"}`} onClick={() => setSelectedKey(item.node.nodeKey)} aria-pressed={selected?.node.id === item.node.id}>
                <span className="workflow-node-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="workflow-node-copy"><strong>{item.node.name}</strong><small>{item.node.nodeType}{item.config?.modelId ? " · model bound" : " · no model"}{item.config?.promptVersionId ? " · prompt bound" : ""}</small></span>
                <span className={`node-state ${item.node.isEnabled ? "on" : "off"}`}>{item.node.isEnabled ? "ON" : "OFF"}</span>
              </button><div className="workflow-order-actions"><button type="button" className="icon-button" aria-label={`Move ${item.node.name} up`} disabled={index === 0} onClick={() => moveNode(item.node.nodeKey, -1)}>↑</button><button type="button" className="icon-button" aria-label={`Move ${item.node.name} down`} disabled={index === nodes.length - 1} onClick={() => moveNode(item.node.nodeKey, 1)}>↓</button></div></div>
            {item.node.nodeKey === "rule_engine" && <div className="workflow-branch-map" aria-label="SHOTLIN rule branches"><span className="branch-pass">PASS → Finalize → deliver</span><span className="branch-fail">FAIL → Correction skill → Generate again</span></div>}
            {index < nodes.length - 1 && <span className="workflow-connector" aria-hidden="true">↓</span>}
          </div>)}
        </div>
      </section> : <section className="workflow-wizard panel panel-pad" aria-label="Guided workflow setup">
        <div className="panel-head"><div><p className="panel-kicker">Guided workflow</p><h2 className="panel-title">Configure one step at a time.</h2><p className="help">The wizard uses the same production nodes as the canvas. Select a step, edit it in the inspector, then continue.</p></div><span className="chip">Step {Math.max(1, nodes.findIndex((item) => item.node.nodeKey === selectedKey) + 1)} / {nodes.length}</span></div>
        <div className="wizard-progress" aria-label="Workflow steps">{nodes.map((item, index) => <button type="button" key={item.node.id} className={`wizard-step ${selected?.node.id === item.node.id ? "active" : ""} ${item.node.isEnabled ? "" : "disabled"}`} onClick={() => setSelectedKey(item.node.nodeKey)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.node.name}</strong></button>)}</div>
        {selected && <div className="wizard-focus"><span className="workflow-node-index">{String(nodes.findIndex((item) => item.node.nodeKey === selected.node.nodeKey) + 1).padStart(2, "0")}</span><div><p className="panel-kicker">Current step</p><h3>{selected.node.name}</h3><p className="help">{selected.node.nodeType} · {selected.node.isEnabled ? "enabled" : "disabled"}</p></div></div>}
        <div className="wizard-actions"><button type="button" className="button button-ghost button-small" disabled={!selected || nodes.findIndex((item) => item.node.nodeKey === selected?.node.nodeKey) <= 0} onClick={() => selectRelative(-1)}>Previous step</button><button type="button" className="button button-coral button-small" disabled={!selected || nodes.findIndex((item) => item.node.nodeKey === selected?.node.nodeKey) >= nodes.length - 1} onClick={() => selectRelative(1)}>Next step</button></div>
      </section>}
      {selected && <form key={selected.node.id} className="node-inspector panel panel-pad" onSubmit={saveNode}>
        <div className="panel-head"><div><p className="panel-kicker">Node inspector</p><h2 className="panel-title">{selected.node.name}</h2><p className="help">{selected.node.nodeKey} · {selected.node.nodeType}</p></div><span className={`chip ${selected.node.isEnabled ? "" : "chip-warn"}`}>{selected.node.isEnabled ? "enabled" : "disabled"}</span></div>
        <label className="toggle-row"><span><strong>Run this node</strong><small>Disable only for a deliberate workflow version change.</small></span><input type="checkbox" name="isEnabled" defaultChecked={selected.node.isEnabled} /></label>
        <div className="studio-fields">
          <label className="input-field"><span>Model</span><select name="modelId" defaultValue={selected.config?.modelId ?? ""}><option value="">No model / deterministic</option>{selectedModels.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.provider}</option>)}</select></label>
          <label className="input-field"><span>Prompt version</span><select name="promptVersionId" defaultValue={selected.config?.promptVersionId ?? ""}><option value="">No prompt binding</option>{prompts.flatMap((prompt) => prompt.versions.map((version) => <option value={version.id} key={version.id}>{prompt.name} · v{version.version} · {version.status}</option>))}</select></label>
          <label className="input-field"><span>Timeout (ms)</span><input name="timeoutMs" type="number" min="1000" max="600000" defaultValue={selected.config?.timeoutMs ?? 60000} /></label>
          <label className="input-field"><span>Max retries</span><input name="maxRetries" type="number" min="0" max="5" defaultValue={selected.config?.maxRetries ?? 1} /></label>
          <label className="input-field studio-json"><span>Thresholds JSON</span><textarea name="thresholds" rows={6} defaultValue={pretty(selected.config?.thresholds)} spellCheck={false} /></label>
          <label className="input-field studio-json"><span>Settings JSON</span><textarea name="settings" rows={6} defaultValue={pretty(selected.config?.settings)} spellCheck={false} /></label>
          {selectedPromptVersion && <div className="prompt-editor studio-json"><div className="prompt-editor-head"><span>Bound system prompt · v{selectedPromptVersion.version} · {selectedPromptVersion.status}</span><button type="button" className="button button-ghost button-small" onClick={savePromptDraft}>Save as draft version</button></div><textarea rows={10} value={promptBody} onChange={(event) => setPromptBody(event.target.value)} spellCheck={false} /></div>}
        </div>
        {message && <p className="save-message">{message}</p>}
        <button className="button button-coral" disabled={saving}>{saving ? "Saving…" : "Save production node"}</button>
      </form>}
    </div>
  </div>;
}

export function RunInspector() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobInspector | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ jobs: JobSummary[] }>("/api/admin/jobs?limit=20")
      .then((payload) => { setJobs(payload.jobs); setSelectedId(payload.jobs[0]?.id ?? null); })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load jobs"));
  }, []);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await apiFetch<JobInspector>(`/api/admin/jobs/${selectedId}`);
        if (!mounted) return;
        setDetail(next);
        setJobs((current) => current.map((job) => job.id === next.job.id ? { ...job, ...next.job } : job));
        if (!terminalStates.has(next.job.state)) timer = setTimeout(load, 1800);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Could not load run inspector");
      }
    };
    void load();
    return () => { mounted = false; if (timer) clearTimeout(timer); };
  }, [selectedId]);

  return <div className="run-inspector-grid">
    <section className="panel panel-pad job-queue"><div className="panel-head"><div><p className="panel-kicker">Live queue</p><h2 className="panel-title">Generation runs</h2></div><span className="help">polls active runs</span></div>{error && <p className="error-copy">{error}</p>}{jobs.length === 0 && <div className="empty-state"><strong>No runs yet</strong><span>Submit a real generation from Generate and it will appear here.</span></div>}<div className="job-list">{jobs.map((job) => <button key={job.id} className={`job-list-row ${selectedId === job.id ? "selected" : ""}`} onClick={() => setSelectedId(job.id)}><span className={`state-mark state-${job.state}`} /><span><strong>{job.id.slice(0, 8)}</strong><small>{job.userEmail ?? "workspace"} · {job.requestedResolution.toUpperCase()}</small></span><span className="job-list-state">{job.state.replaceAll("_", " ")}</span></button>)}</div></section>
    <section className="panel panel-pad inspector-detail">{!detail ? <div className="empty-state"><strong>Select a run</strong><span>The inspector exposes every node, attempt, prompt, candidate, review, defect, state transition, and cost event.</span></div> : <>
      <div className="panel-head"><div><p className="panel-kicker">Run inspector · {detail.job.id.slice(0, 8)}</p><h2 className="panel-title">{detail.job.state.replaceAll("_", " ")}</h2><p className="help">{detail.job.requestedResolution.toUpperCase()} · {detail.job.aspectRatio} · {detail.job.outputCount} output{detail.job.outputCount === 1 ? "" : "s"}</p></div><span className={`chip ${detail.job.state === "ready" ? "" : detail.job.state === "failed" ? "chip-fail" : "chip-warn"}`}>{detail.job.state}</span></div>
      <div className="trace-line">{detail.workflowNodes.map((node) => { const step = detail.stepRuns.find((candidate) => candidate.nodeKey === node.nodeKey); const status = step?.status ?? (!node.isEnabled ? "disabled" : node.nodeKey === "second_review" ? "skipped · only when uncertain" : node.nodeKey === "retry" ? (detail.job.state === "ready" ? "skipped · PASS" : "waiting") : "not reached"); return <div className="trace-step" key={`${node.nodeKey}-${step?.id ?? "planned"}`}><span className={`trace-dot trace-${step?.status ?? "skipped"}`} /><span><strong>{node.name}</strong><small>{status}{step?.durationMs ? ` · ${step.durationMs}ms` : ""}{step?.error ? ` · ${step.error}` : ""}{step?.outputRef ? ` · ${Object.keys(step.outputRef).length} recorded fields` : ""}</small></span></div>; })}</div>
      <div className="inspector-columns"><div><h3 className="subhead">Attempts</h3>{detail.attempts.length === 0 ? <p className="help">No attempts recorded.</p> : detail.attempts.map((attempt) => <div className="attempt-card" key={attempt.attemptNumber}><div><strong>Attempt {attempt.attemptNumber}</strong><span className="chip">{attempt.status}</span></div><p>{attempt.decision ?? "running"}{attempt.repairInstruction ? ` · ${attempt.repairInstruction}` : ""}</p>{attempt.compiledPrompt && <details><summary>Compiled prompt</summary><pre>{attempt.compiledPrompt}</pre></details>}</div>)}</div><div><h3 className="subhead">Quality gate</h3>{detail.candidates.length === 0 ? <p className="help">No generated candidate yet.</p> : detail.candidates.map((candidate) => <div className="candidate-card" key={candidate.id}><div className="candidate-head"><strong>Candidate {candidate.sequence}</strong>{candidate.isFinal && <span className="chip">final</span>}</div>{candidate.assetUrl && <img src={candidate.assetUrl} alt={`Candidate ${candidate.sequence}`} />}{candidate.reviews.map((review, index) => <div className="review-row" key={`${review.reviewType}-${index}`}><span>{review.reviewType}</span><strong>{review.garmentFidelityScore ?? "—"} garment · {review.characterIdentityScore ?? "—"} identity · {review.photorealismScore ?? "—"} photo</strong>{review.defects.length > 0 && <small>{review.defects.map((defect) => defect.code).join(" · ")}</small>}</div>)}</div>)}</div></div>
      <CostLedger totals={detail.costTotals} models={detail.costModels} events={detail.costEvents} />
      <details className="trace-details"><summary>Raw truth sheet and state events</summary><div className="detail-block"><h3 className="subhead">Garment Truth Sheet</h3><pre>{pretty(detail.truthSheet)}</pre></div><div className="detail-block"><h3 className="subhead">State events</h3><pre>{pretty(detail.stateEvents)}</pre></div><div className="detail-block"><h3 className="subhead">Raw cost events</h3><pre>{pretty(detail.costEvents)}</pre></div></details>
    </>}</section>
  </div>;
}

type QualityRules = { minGarmentFidelity: number; minCharacterIdentity: number; minPhotorealism: number; minAnatomy: number; minTechnicalQuality: number; uncertaintyBand: number; minReviewerConfidence: number; isSecondReviewEnabled: boolean };

export function QualityRulesPanel() {
  const [rules, setRules] = useState<QualityRules | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { apiFetch<QualityRules>("/api/admin/quality-rules").then(setRules).catch((err) => setMessage(err instanceof Error ? err.message : "Could not load quality rules")); }, []);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const next = { minGarmentFidelity: Number(data.get("minGarmentFidelity")), minCharacterIdentity: Number(data.get("minCharacterIdentity")), minPhotorealism: Number(data.get("minPhotorealism")), minAnatomy: Number(data.get("minAnatomy")), minTechnicalQuality: Number(data.get("minTechnicalQuality")), uncertaintyBand: Number(data.get("uncertaintyBand")), minReviewerConfidence: Number(data.get("minReviewerConfidence")), isSecondReviewEnabled: data.get("isSecondReviewEnabled") === "on" }; try { await apiFetch("/api/admin/quality-rules", { method: "PUT", body: JSON.stringify(next) }); setRules(next); setMessage("Quality gate saved. New jobs use these thresholds."); } catch (err) { setMessage(err instanceof Error ? err.message : "Could not save quality rules"); } }
  if (!rules) return <section className="panel panel-pad">{message ?? "Loading quality gate…"}</section>;
  return <form className="panel panel-pad config-form" onSubmit={save}><div className="panel-head"><div><p className="panel-kicker">Shotlin rules</p><h2 className="panel-title">Pass / fail gate</h2><p className="help">These are applied after the quality reviewer. Values are scored 0–100; the uncertainty band can trigger second review.</p></div><span className="chip">deterministic gate</span></div><div className="rule-grid">{([ ["minGarmentFidelity", "Garment fidelity"], ["minCharacterIdentity", "Character identity"], ["minPhotorealism", "Photorealism"], ["minAnatomy", "Anatomy"], ["minTechnicalQuality", "Technical quality"], ["minReviewerConfidence", "Reviewer confidence"], ["uncertaintyBand", "Uncertainty band"] ] as const).map(([key, label]) => <label className="input-field" key={key}><span>{label}</span><input name={key} type="number" min="0" max={key === "uncertaintyBand" ? 20 : 100} defaultValue={rules[key]} /></label>)}</div><label className="toggle-row"><span><strong>Second review for uncertain results</strong><small>Runs the conditional reviewer before a retry or delivery decision.</small></span><input type="checkbox" name="isSecondReviewEnabled" defaultChecked={rules.isSecondReviewEnabled} /></label>{message && <p className="save-message">{message}</p>}<button className="button button-coral">Save quality gate</button></form>;
}

type Budget = { warnInr: string; hardStopInr: string; maxAttempts: number; planningBudget1kInr: string; planningBudget2kInr: string; planningBudget4kInr: string; usdInrRate: string; perUserDailyJobLimit: number };

type CostHistoryRow = {
  jobId: string;
  state: string;
  resolution: string;
  outputCount: number;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  imageCount: number;
  workflowSteps: number;
  apiCalls: number;
  ledgerInr: number;
  jobTotalInr: number;
  costPerOutputInr: number;
  models: CostModelSubtotal[];
};

function CostHistoryPanel() {
  const [history, setHistory] = useState<CostHistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ history: CostHistoryRow[] }>("/api/admin/costs/history?limit=30")
      .then((payload) => setHistory(payload.history))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load cost history"));
  }, []);

  return <section className="panel panel-pad cost-history" aria-label="Per-image cost history">
    <div className="panel-head"><div><p className="panel-kicker">Per-image history</p><h2 className="panel-title">What each run cost</h2><p className="help">Totals include every attempt and every billed model step for that job. Open a run in Run inspector for the exact line items.</p></div><span className="chip">last {history.length || 0}</span></div>
    {error && <p className="error-copy">{error}</p>}
    {history.length === 0 && !error ? <div className="empty-state"><strong>No generation history yet</strong><span>Once a generation is submitted, its token, image, API-call, and INR totals will appear here.</span></div> : <div className="ledger-table-wrap"><table className="data-table ledger-table history-table"><thead><tr><th>Run</th><th>Model split</th><th>Usage</th><th>Workflow</th><th>Ledger cost</th><th>Per output</th></tr></thead><tbody>{history.map((row) => <tr key={row.jobId}>
      <td><strong>{row.jobId.slice(0, 8)}</strong><small>{formatDate(row.createdAt)} · {row.state.replaceAll("_", " ")}</small></td>
      <td><details className="history-breakdown"><summary>{row.models.length} model{row.models.length === 1 ? "" : "s"}</summary><div className="history-model-list">{row.models.map((model) => <div key={model.modelKey}><strong>{model.modelName ?? model.provider}</strong><span>{model.nodes.map(labelForNode).join(" · ")} · {formatTokens(model.totalTokens)} tokens · {formatInr(model.inrCost)}</span></div>)}{row.models.length === 0 && <span>No billed model calls</span>}</div></details></td>
      <td><strong>{formatTokens(row.totalTokens)} tokens</strong><small>{formatTokens(row.inputTokens)} in · {formatTokens(row.outputTokens)} out · {row.imageCount} image unit{row.imageCount === 1 ? "" : "s"}</small></td>
      <td><strong>{row.apiCalls} API call{row.apiCalls === 1 ? "" : "s"}</strong><small>{row.workflowSteps} recorded steps · {row.resolution.toUpperCase()} · {row.outputCount} output{row.outputCount === 1 ? "" : "s"}</small></td>
      <td><strong>{formatInr(row.ledgerInr)}</strong><small>job total {formatInr(row.jobTotalInr)}{Math.abs(row.ledgerInr - row.jobTotalInr) > 0.01 ? <span className="cost-mismatch"> · mismatch</span> : null}</small></td>
      <td><strong>{formatInr(row.costPerOutputInr)}</strong><small>per requested output</small></td>
    </tr>)}</tbody></table></div>}
    <p className="cost-ledger-note">“Ledger cost” is the sum of recorded line items. “Job total” is the worker’s persisted total; any mismatch is shown instead of hidden.</p>
  </section>;
}

export function BudgetPanel() {
  const [budget, setBudget] = useState<Budget | null>(null); const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { apiFetch<Budget>("/api/admin/budget").then(setBudget).catch((err) => setMessage(err instanceof Error ? err.message : "Could not load budget")); }, []);
  async function save(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const next = Object.fromEntries([...data.entries()].map(([key, value]) => [key, key === "maxAttempts" || key === "perUserDailyJobLimit" ? Number(value) : Number(value)])); try { await apiFetch("/api/admin/budget", { method: "PUT", body: JSON.stringify(next) }); setMessage("Budget controls saved."); } catch (err) { setMessage(err instanceof Error ? err.message : "Could not save budget"); } }
  if (!budget) return <section className="panel panel-pad">{message ?? "Loading budget controls…"}</section>;
  return <div className="budget-stack"><form className="panel panel-pad config-form" onSubmit={save}><div className="panel-head"><div><p className="panel-kicker">Spend discipline</p><h2 className="panel-title">Budget & retry policy</h2><p className="help">The worker checks the hard stop before every attempt and records cost events per node.</p></div></div><div className="rule-grid">{([ ["warnInr", "Warn at ₹"], ["hardStopInr", "Hard stop at ₹"], ["maxAttempts", "Max attempts"], ["planningBudget1kInr", "Planning 1K ₹"], ["planningBudget2kInr", "Planning 2K ₹"], ["planningBudget4kInr", "Planning 4K ₹"], ["usdInrRate", "USD / INR"], ["perUserDailyJobLimit", "Daily jobs / user"] ] as const).map(([key, label]) => <label className="input-field" key={key}><span>{label}</span><input name={key} type="number" min="0" step="0.01" defaultValue={budget[key]} /></label>)}</div>{message && <p className="save-message">{message}</p>}<button className="button button-coral">Save budget controls</button></form><CostHistoryPanel /></div>;
}
