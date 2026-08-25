"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { apiFetch } from "../../components/api";

type Settings = {
  providerKeys: { openrouterConfigured: boolean };
  mockProviders: boolean;
  webUrl: string;
};

type TestResult = { connected: boolean; status: number; message?: string; modelCount?: number; sampleModels?: string[]; baseUrl?: string };

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [baseUrl, setBaseUrl] = useState("https://openrouter.ai/api/v1");
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  useEffect(() => { apiFetch<Settings>("/api/admin/settings").then(setSettings).catch(() => setBlocked(true)); }, []);

  async function testConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setTesting(true); setResult(null);
    try {
      const response = await apiFetch<TestResult>("/api/admin/settings/test-openrouter", { method: "POST", body: JSON.stringify({ baseUrl, apiKey }) });
      setResult(response);
      if (response.connected) setApiKey("");
    } catch (err) {
      setResult({ connected: false, status: 0, message: err instanceof Error ? err.message : "Could not test provider" });
    } finally { setTesting(false); }
  }

  return <AppShell section="Settings"><div className="page"><div className="page-head"><div><p className="eyebrow">Settings / Providers</p><h1 className="display">Connect the <em>engine.</em></h1><p className="lede">Check the single OpenRouter gateway from the API server and confirm that the configured model catalog is reachable. Secrets never return to the browser or appear in the audit feed.</p></div><span className="chip">server-side test</span></div>{blocked ? <section className="access-card panel"><h2 className="section-heading">Admin access required</h2><p className="lede">Provider settings are operational controls. Sign in with an admin account before testing a key.</p><Link className="button button-coral" href="/login">Sign in as admin</Link></section> : <div className="settings-grid"><section className="panel panel-pad"><div className="panel-head"><div><p className="panel-kicker">OpenRouter</p><h2 className="panel-title">Connection test</h2></div>{settings && <span className={`chip ${settings.providerKeys.openrouterConfigured ? "" : "chip-warn"}`}>{settings.providerKeys.openrouterConfigured ? "env key configured" : "no env key"}</span>}</div><form onSubmit={testConnection}><label className="input-field"><span>Base URL</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://openrouter.ai/api/v1" /></label><label className="input-field"><span>API key</span><input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="sk-or-v1-…" autoComplete="off" /></label><p className="help settings-note">The key is sent over your local API connection for this single test only. The worker’s generation credentials remain controlled by the server environment.</p><button className="button button-coral" disabled={testing || !apiKey}>{testing ? "Checking provider…" : "Test provider connection"}</button></form>{result && <div className={`connection-result ${result.connected ? "success" : "failure"}`}><strong>{result.connected ? "Provider reachable" : "Connection failed"}</strong><span>{result.message ?? `${result.modelCount ?? 0} models available · HTTP ${result.status}`}</span>{result.sampleModels && result.sampleModels.length > 0 && <small>{result.sampleModels.join(" · ")}</small>}</div>}</section><section className="panel panel-pad"><div className="panel-head"><div><p className="panel-kicker">Runtime posture</p><h2 className="panel-title">What is active locally</h2></div></div><div className="settings-status"><div><span>API</span><strong>{settings?.webUrl ? "connected" : "loading"}</strong></div><div><span>Mock providers</span><strong>{settings?.mockProviders ? "enabled" : "disabled"}</strong></div><div><span>OpenRouter env</span><strong>{settings?.providerKeys.openrouterConfigured ? "configured" : "not configured"}</strong></div></div><p className="help settings-note">For a real generation run, add the OpenRouter key to the API and worker environment, disable mock providers, then restart both processes. This screen verifies credentials; it does not pretend to persist a secret it cannot safely use.</p></section></div>}</div></AppShell>;
}
