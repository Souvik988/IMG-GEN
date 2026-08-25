"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "./api";

type Json = Record<string, unknown>;
type StudioView = "canvas" | "wizard";

type WorkflowVersionMeta = {
  id: string;
  workflowId: string;
  version: number;
  status: "draft" | "production" | "archived";
  createdAt: string;
  publishedAt: string | null;
};

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
  const [versions, setVersions] = useState<WorkflowVersionMeta[]>([]);
  const [viewingVersionId, setViewingVersionId] = useState<string | null>(null);
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

  const viewingVersion = versions.find((v) => v.id === viewingVersionId) ?? null;
  const isEditable = viewingVersion?.status === "draft";
  const existingDraft = versions.find((v) => v.status === "draft") ?? null;

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
      apiFetch<{ nodes: WorkflowNode[]; activeVersion: WorkflowVersionMeta; versions: WorkflowVersionMeta[] }>("/api/admin/workflow"),
      apiFetch<{ models: Model[] }>("/api/admin/models"),
      apiFetch<{ prompts: Prompt[] }>("/api/admin/prompts"),
    ])
      .then(([workflow, modelRows, promptRows]) => {
        if (!mounted) return;
        setNodes(workflow.nodes);
        setActiveVersion(workflow.activeVersion.version);
        setVersions(workflow.versions);
        setViewingVersionId(workflow.activeVersion.id);
        setModels(modelRows.models);
        setPrompts(promptRows.prompts);
        setSelectedKey(workflow.nodes[0]?.node.nodeKey ?? null);
        setOrderDirty(false);
      })
      .catch((err) => mounted && setError(err instanceof Error ? err.message : "Could not load workflow configuration"))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, []);

  async function refreshVersions() {
    const workflow = await apiFetch<{ nodes: WorkflowNode[]; activeVersion: WorkflowVersionMeta; versions: WorkflowVersionMeta[] }>("/api/admin/workflow");
    setVersions(workflow.versions);
    setActiveVersion(workflow.activeVersion.version);
    return workflow;
  }

  async function switchToVersion(versionId: string) {
    setSaving(true);
    setMessage(null);
    try {
      const detail = await apiFetch<{ version: WorkflowVersionMeta; nodes: WorkflowNode[] }>(`/api/admin/workflow/versions/${versionId}`);
      setNodes(detail.nodes);
      setViewingVersionId(detail.version.id);
      setSelectedKey(detail.nodes[0]?.node.nodeKey ?? null);
      setOrderDirty(false);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not load that version");
    } finally {
      setSaving(false);
    }
  }

  async function createOrContinueDraft() {
    setSaving(true);
    setMessage(null);
    try {
      const draft = await apiFetch<{ version: WorkflowVersionMeta; nodes: WorkflowNode[] }>("/api/admin/workflow/draft", { method: "POST" });
      await refreshVersions();
      setNodes(draft.nodes);
      setViewingVersionId(draft.version.id);
      setSelectedKey(draft.nodes[0]?.node.nodeKey ?? null);
      setOrderDirty(false);
      setMessage(`Editing draft v${draft.version.version}, cloned from production. Nothing here affects live jobs until you publish.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not create a draft");
    } finally {
      setSaving(false);
    }
  }

  async function discardDraft() {
    if (!viewingVersionId || !isEditable) return;
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch(`/api/admin/workflow/versions/${viewingVersionId}`, { method: "DELETE" });
      const workflow = await refreshVersions();
      setNodes(workflow.nodes);
      setViewingVersionId(workflow.activeVersion.id);
      setSelectedKey(workflow.nodes[0]?.node.nodeKey ?? null);
      setMessage("Draft discarded.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not discard draft");
    } finally {
      setSaving(false);
    }
  }

  async function publishDraft() {
    if (!viewingVersionId || !isEditable) return;
    setSaving(true);
    setMessage(null);
    try {
      const check = await apiFetch<{ valid: boolean; errors: string[] }>(`/api/admin/workflow/versions/${viewingVersionId}/validate`, { method: "POST" });
      if (!check.valid) {
        setMessage(`Cannot publish — ${check.errors.join("; ")}`);
        return;
      }
      await apiFetch(`/api/admin/workflow/versions/${viewingVersionId}/publish`, { method: "POST" });
      const workflow = await refreshVersions();
      setNodes(workflow.nodes);
      setViewingVersionId(workflow.activeVersion.id);
      setSelectedKey(workflow.nodes[0]?.node.nodeKey ?? null);
      setMessage(`v${workflow.activeVersion.version} is now live in production.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not publish draft");
    } finally {
      setSaving(false);
    }
  }

  async function rollbackToVersion(versionId: string) {
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch(`/api/admin/workflow/versions/${versionId}/rollback`, { method: "POST" });
      const workflow = await refreshVersions();
      setNodes(workflow.nodes);
      setViewingVersionId(workflow.activeVersion.id);
      setSelectedKey(workflow.nodes[0]?.node.nodeKey ?? null);
      setMessage(`Rolled back — v${workflow.activeVersion.version} is now live in production.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not roll back to that version");
    } finally {
      setSaving(false);
    }
  }

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
    if (!selected || !viewingVersionId) return;
    if (!isEditable) {
      setMessage("This version is read-only. Create a draft to make changes.");
      return;
    }
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
      await apiFetch(`/api/admin/workflow/versions/${viewingVersionId}/${selected.node.nodeKey}`, {
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
      setMessage(`${selected.node.name} saved to draft v${viewingVersion?.version ?? "?"}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save node");
    } finally {
      setSaving(false);
    }
  }

  function reorderNodes(sourceKey: string, targetKey: string) {
    if (sourceKey === targetKey || !isEditable) return;
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
    if (!orderDirty || !viewingVersionId || !isEditable) return;
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch(`/api/admin/workflow/versions/${viewingVersionId}/order`, {
        method: "PUT",
        body: JSON.stringify({ nodeKeys: nodes.map((item) => item.node.nodeKey) }),
      });
      setOrderDirty(false);
      setMessage(`Execution order saved to draft v${viewingVersion?.version ?? "?"}.`);
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
      <div><p className="panel-kicker">Workflow Studio</p><h2 className="panel-title">{isEditable ? `Editing draft · v${viewingVersion?.version ?? "—"}` : `Viewing ${viewingVersion?.status ?? "production"} · v${viewingVersion?.version ?? activeVersion ?? "—"}`}</h2><p className="help">{isEditable ? "Changes here only affect this draft. Publish to make them live." : "Read-only. Create a draft to change the order or any node's configuration."}</p></div>
      <div className="studio-toolbar-actions">
        {isEditable ? <span className="chip chip-warn">draft — not live</span> : <span className="chip chip-live"><span className="pulse-dot" /> {viewingVersion?.status ?? "production"}</span>}
        <div className="studio-toolbar-buttons">
          {isEditable && <button type="button" className="button button-coral button-small" disabled={!orderDirty || saving} onClick={saveOrder}>{saving ? "Saving…" : "Save execution order"}</button>}
          {isEditable ? <>
            <button type="button" className="button button-coral button-small" disabled={saving} onClick={publishDraft}>Publish</button>
            <button type="button" className="button button-ghost button-small" disabled={saving} onClick={discardDraft}>Discard draft</button>
          </> : viewingVersion?.status === "archived" ? (
            <button type="button" className="button button-coral button-small" disabled={saving} onClick={() => rollbackToVersion(viewingVersion.id)}>Roll back to this version</button>
          ) : (
            <button type="button" className="button button-ghost button-small" disabled={saving} onClick={createOrContinueDraft}>{existingDraft ? `Continue draft v${existingDraft.version}` : "Create draft"}</button>
          )}
        </div>
      </div>
    </section>
    <div className="studio-version-strip" role="tablist" aria-label="Workflow versions">
      {versions.map((v) => <button type="button" key={v.id} role="tab" aria-selected={v.id === viewingVersionId} className={`tab-pill ${v.id === viewingVersionId ? "active" : ""} ${v.status === "draft" ? "tab-pill-draft" : ""}`} onClick={() => switchToVersion(v.id)}>v{v.version} · {v.status}</button>)}
    </div>
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
        <p className="canvas-hint">{isEditable ? "Drag a node by its handle. Keyboard users can use the ↑ and ↓ controls." : "Read-only — create a draft to reorder nodes."}</p>
        <div className="workflow-rail" role="list">
          {nodes.map((item, index) => <div className={`workflow-node-wrap ${dragKey === item.node.nodeKey ? "dragging" : ""}`} key={item.node.id} role="listitem" draggable={isEditable} onDragStart={() => isEditable && setDragKey(item.node.nodeKey)} onDragEnd={() => setDragKey(null)} onDragOver={(event) => isEditable && event.preventDefault()} onDrop={() => { if (dragKey && isEditable) reorderNodes(dragKey, item.node.nodeKey); setDragKey(null); }}>
            <div className="workflow-node-line"><span className="drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span><button className={`workflow-node ${selected?.node.id === item.node.id ? "selected" : ""} ${item.node.isEnabled ? "" : "disabled"}`} onClick={() => setSelectedKey(item.node.nodeKey)} aria-pressed={selected?.node.id === item.node.id}>
                <span className="workflow-node-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="workflow-node-copy"><strong>{item.node.name}</strong><small>{item.node.nodeType}{item.config?.modelId ? " · model bound" : " · no model"}{item.config?.promptVersionId ? " · prompt bound" : ""}</small></span>
                <span className={`node-state ${item.node.isEnabled ? "on" : "off"}`}>{item.node.isEnabled ? "ON" : "OFF"}</span>
              </button><div className="workflow-order-actions"><button type="button" className="icon-button" aria-label={`Move ${item.node.name} up`} disabled={!isEditable || index === 0} onClick={() => moveNode(item.node.nodeKey, -1)}>↑</button><button type="button" className="icon-button" aria-label={`Move ${item.node.name} down`} disabled={!isEditable || index === nodes.length - 1} onClick={() => moveNode(item.node.nodeKey, 1)}>↓</button></div></div>
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
        {!isEditable && <p className="help studio-readonly-note">Read-only — create a draft to edit this node.</p>}
        <fieldset disabled={!isEditable} className="studio-fieldset">
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
        </fieldset>
        {message && <p className="save-message">{message}</p>}
        {isEditable && <button className="button button-coral" disabled={saving}>{saving ? "Saving…" : `Save to draft v${viewingVersion?.version ?? "?"}`}</button>}
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

type DiscoverModel = { id: string; name: string; description: string | null };
type DiscoverDetail = {
  capabilities: { resolutions: string[]; maxImageRefs: number; supportsMultiOutput: boolean };
  pricePerImageUsd: number | null;
  suggestedImagePrices: Record<string, number> | null;
};

export function ModelsPanel() {
  const [models, setModels] = useState<Model[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<DiscoverModel[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DiscoverModel | null>(null);
  const [detail, setDetail] = useState<DiscoverDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function reload() {
    apiFetch<{ models: Model[] }>("/api/admin/models")
      .then((payload) => setModels(payload.models))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Could not load model registry"));
  }
  useEffect(() => { reload(); }, []);

  function loadCatalog() {
    setCatalogLoading(true);
    setCatalogError(null);
    apiFetch<{ models: DiscoverModel[] }>("/api/admin/models/discover")
      .then((payload) => setCatalog(payload.models))
      .catch((err) => setCatalogError(err instanceof Error ? err.message : "Could not load the OpenRouter catalog"))
      .finally(() => setCatalogLoading(false));
  }

  async function pick(model: DiscoverModel) {
    setSelected(model);
    setDetail(null);
    setDetailError(null);
    try {
      const d = await apiFetch<DiscoverDetail>(`/api/admin/models/discover-detail?modelId=${encodeURIComponent(model.id)}`);
      setDetail(d);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Could not load this model's capabilities");
    }
  }

  async function addModel() {
    if (!selected || !detail) return;
    setSaving(true);
    setMessage(null);
    try {
      await apiFetch("/api/admin/models", {
        method: "POST",
        body: JSON.stringify({
          name: selected.name,
          provider: "openrouter",
          modelId: selected.id,
          role: "image_generator",
          isEnabled: false,
          capabilities: detail.capabilities,
          notes: selected.description,
          prices: detail.suggestedImagePrices ? { imagePrices: detail.suggestedImagePrices } : undefined,
        }),
      });
      setMessage(`${selected.name} added to the catalog, disabled — enable it below once you've reviewed it.`);
      setSelected(null);
      setDetail(null);
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not add this model");
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(model: Model) {
    setMessage(null);
    try {
      await apiFetch(`/api/admin/models/${model.id}`, { method: "PUT", body: JSON.stringify({ isEnabled: !model.isEnabled }) });
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not update this model");
    }
  }

  const filtered = catalog?.filter((m) => {
    const q = search.trim().toLowerCase();
    return !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  }) ?? [];

  return <div className="models-panel">
    <section className="panel panel-pad">
      <div className="panel-head"><div><p className="panel-kicker">Live registry</p><h2 className="panel-title">Model registry</h2><p className="help">Every model a workflow node can be bound to. New additions start disabled.</p></div><span className="chip">{models.length} records</span></div>
      {loadError && <p className="error-copy">{loadError}</p>}
      {models.length === 0 && !loadError ? <p className="help">Loading…</p> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Name</th><th>Provider</th><th>Role</th><th>Model ID</th><th>Enabled</th></tr></thead><tbody>{models.map((m) => <tr key={m.id}>
        <td>{m.name}</td>
        <td>{m.provider}</td>
        <td>{m.role}</td>
        <td>{m.modelId}</td>
        <td><button type="button" className={`chip ${m.isEnabled ? "" : "chip-warn"}`} onClick={() => toggleEnabled(m)}>{m.isEnabled ? "on" : "off"}</button></td>
      </tr>)}</tbody></table></div>}
    </section>

    <section className="panel panel-pad">
      <div className="panel-head"><div><p className="panel-kicker">Add from OpenRouter</p><h2 className="panel-title">Browse the live image-model catalog</h2><p className="help">Capabilities and pricing are read directly from OpenRouter, not guessed — filtered to models that actually support reference images, since every generation here is reference-driven.</p></div>{!catalog && <button type="button" className="button button-ghost button-small" disabled={catalogLoading} onClick={loadCatalog}>{catalogLoading ? "Loading…" : "Load catalog"}</button>}</div>
      {catalogError && <p className="error-copy">{catalogError}</p>}
      {catalog && <>
        <input className="input-field-plain" placeholder="Search models…" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="catalog-list">{filtered.map((m) => <button type="button" key={m.id} className={`catalog-row ${selected?.id === m.id ? "selected" : ""}`} onClick={() => pick(m)}><strong>{m.name}</strong><small>{m.id}</small></button>)}</div>
      </>}
    </section>

    {selected && <section className="panel panel-pad">
      <div className="panel-head"><div><p className="panel-kicker">Preview</p><h2 className="panel-title">{selected.name}</h2><p className="help">{selected.description}</p></div></div>
      {detailError && <p className="error-copy">{detailError}</p>}
      {!detail && !detailError && <p className="help">Loading capabilities…</p>}
      {detail && <>
        <div className="state-grid">
          <div className="state-card"><strong>{detail.capabilities.resolutions.map((r) => r.toUpperCase()).join(", ") || "—"}</strong><span>Resolutions</span></div>
          <div className="state-card"><strong>{detail.capabilities.maxImageRefs}</strong><span>Max reference images</span></div>
          <div className="state-card"><strong>{detail.capabilities.supportsMultiOutput ? "Yes" : "No"}</strong><span>Multi-output per call</span></div>
          <div className="state-card"><strong>{detail.pricePerImageUsd != null ? `$${detail.pricePerImageUsd.toFixed(4)}` : "—"}</strong><span>Price / image</span></div>
        </div>
        <button type="button" className="button button-coral" disabled={saving} onClick={addModel}>{saving ? "Adding…" : "Add to catalog (disabled by default)"}</button>
      </>}
    </section>}
    {message && <p className="save-message">{message}</p>}
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

type CostSummary = {
  today: { inr: number; usd: number };
  total: { inr: number; usd: number };
  byModel: Array<{ modelId: string | null; modelName: string; provider: string; calls: number; inr: number; usd: number }>;
  byProvider: Array<{ provider: string; calls: number; inr: number }>;
  daily: Array<{ day: string; inr: number }>;
  byResolution: Array<{ resolution: string; successfulJobs: number; totalInr: number; avgInrPerImage: number }>;
  failed: { inr: number; jobs: number };
};

function CostSummaryPanel() {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<CostSummary>("/api/admin/costs")
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load cost summary"));
  }, []);

  if (error) return <section className="panel panel-pad"><p className="error-copy">{error}</p></section>;
  if (!summary) return <section className="panel panel-pad">Loading cost summary…</section>;

  const maxDaily = Math.max(1, ...summary.daily.map((d) => d.inr));

  return <section className="panel panel-pad cost-summary" aria-label="Aggregate spend breakdown">
    <div className="panel-head"><div><p className="panel-kicker">Spend, aggregated</p><h2 className="panel-title">Where the money is going</h2><p className="help">Summed straight from the cost ledger — every model call, every job, all time (or today).</p></div></div>
    <div className="state-grid">
      <div className="state-card"><strong>{formatInr(summary.today.inr)}</strong><span>Today ({formatUsd(summary.today.usd)})</span></div>
      <div className="state-card"><strong>{formatInr(summary.total.inr)}</strong><span>All time ({formatUsd(summary.total.usd)})</span></div>
      <div className="state-card"><strong>{formatInr(summary.failed.inr)}</strong><span>Never delivered ({summary.failed.jobs} job{summary.failed.jobs === 1 ? "" : "s"})</span></div>
    </div>
    {summary.daily.length > 0 && <div className="chart" aria-label="Daily spend, last 14 days">{summary.daily.map((d) => <div className="bar-wrap" key={d.day} title={`${d.day}: ${formatInr(d.inr)}`}><div className="bar" style={{ height: `${Math.max(4, (d.inr / maxDaily) * 100)}%` }} /><span className="bar-label">{d.day.slice(5)}</span></div>)}</div>}
    <div className="inspector-columns">
      <div><h4>By model</h4>{summary.byModel.length === 0 ? <p className="help">No billed model calls yet.</p> : <table className="data-table"><thead><tr><th>Model</th><th>Calls</th><th>Cost</th></tr></thead><tbody>{summary.byModel.map((m) => <tr key={`${m.modelId}-${m.provider}`}><td>{m.modelName}<small>{m.provider}</small></td><td>{m.calls}</td><td>{formatInr(m.inr)}</td></tr>)}</tbody></table>}</div>
      <div><h4>By provider</h4>{summary.byProvider.length === 0 ? <p className="help">No billed calls yet.</p> : <table className="data-table"><thead><tr><th>Provider</th><th>Calls</th><th>Cost</th></tr></thead><tbody>{summary.byProvider.map((p) => <tr key={p.provider}><td>{p.provider}</td><td>{p.calls}</td><td>{formatInr(p.inr)}</td></tr>)}</tbody></table>}</div>
      <div><h4>Cost per delivered image, by resolution</h4>{summary.byResolution.length === 0 ? <p className="help">No successful jobs yet.</p> : <table className="data-table"><thead><tr><th>Resolution</th><th>Delivered</th><th>Avg / image</th></tr></thead><tbody>{summary.byResolution.map((r) => <tr key={r.resolution}><td>{r.resolution.toUpperCase()}</td><td>{r.successfulJobs}</td><td>{formatInr(r.avgInrPerImage)}</td></tr>)}</tbody></table>}</div>
    </div>
  </section>;
}

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
  return <div className="budget-stack"><form className="panel panel-pad config-form" onSubmit={save}><div className="panel-head"><div><p className="panel-kicker">Spend discipline</p><h2 className="panel-title">Budget & retry policy</h2><p className="help">The worker checks the hard stop before every attempt and records cost events per node.</p></div></div><div className="rule-grid">{([ ["warnInr", "Warn at ₹"], ["hardStopInr", "Hard stop at ₹"], ["maxAttempts", "Max attempts"], ["planningBudget1kInr", "Planning 1K ₹"], ["planningBudget2kInr", "Planning 2K ₹"], ["planningBudget4kInr", "Planning 4K ₹"], ["usdInrRate", "USD / INR"], ["perUserDailyJobLimit", "Daily jobs / user"] ] as const).map(([key, label]) => <label className="input-field" key={key}><span>{label}</span><input name={key} type="number" min="0" step="0.01" defaultValue={budget[key]} /></label>)}</div>{message && <p className="save-message">{message}</p>}<button className="button button-coral">Save budget controls</button></form><CostSummaryPanel /><CostHistoryPanel /></div>;
}
