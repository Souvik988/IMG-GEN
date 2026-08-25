"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./icon";
import { apiFetch } from "./api";

const nav = [
  { href: "/", label: "Generate", icon: "spark" as const },
  { href: "/projects", label: "Projects", icon: "folder" as const },
  { href: "/admin", label: "Control room", icon: "grid" as const },
];

export function AppShell({ section, children }: { section: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  useEffect(() => {
    apiFetch<{ status: string }>("/api/health").then(() => setApiOnline(true)).catch(() => setApiOnline(false));
  }, []);
  return <div className="app-frame">
    <aside className="rail">
      <Link className="brand" href="/"><span className="brand-mark" /><span className="brand-word">shotlin<span className="brand-dot">.</span></span></Link>
      <p className="rail-label">Workspace</p>
      <nav className="nav-list" aria-label="Primary navigation">
        {nav.map((item) => <Link className={`nav-link ${pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href)) ? "active" : ""}`} href={item.href} key={item.href}><Icon name={item.icon} /><span>{item.label}</span></Link>)}
      </nav>
      <div className="rail-spacer" />
      <div className="rail-foot">
        <Link className="nav-link" href="/settings"><Icon name="settings" /><span>Settings</span></Link>
        <div className="profile-row"><span className="avatar">AS</span><div><div className="profile-name">Aarav Studio</div><div className="profile-role">Customer workspace</div></div></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="crumb"><span>Shotlin</span><span>/</span><strong>{section}</strong><span style={{display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8}}><span className="status-dot" style={{background: apiOnline === false ? "#d46e5c" : undefined}} />{apiOnline === null ? "connecting" : apiOnline ? "local stack online" : "API offline"}</span></div><div className="top-actions"><button className="icon-button" aria-label="Help"><Icon name="help" /></button><button className="icon-button" aria-label="Notifications"><Icon name="bell" /></button></div></header>
      {children}
    </main>
  </div>;
}
