type Props = { name: "grid" | "spark" | "folder" | "settings" | "help" | "bell" | "arrow" | "plus" | "download" | "check" | "lock" };

export function Icon({ name }: Props) {
  const common = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<Props["name"], React.ReactNode> = {
    grid: <><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></>,
    spark: <><path d="M8 1.5 9.3 6.7 14.5 8l-5.2 1.3L8 14.5l-1.3-5.2L1.5 8l5.2-1.3L8 1.5Z"/><path d="m12.8 1.5.3 1.3.9.3-.9.2-.3 1.2-.3-1.2-.9-.2.9-.3.3-1.3Z"/></>,
    folder: <path d="M2 4.5h4l1.2 1.4H14v6.8a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8V4.5Z"/>,
    settings: <><circle cx="8" cy="8" r="2.4"/><path d="m8 1.7.5 1.4 1.3.5 1.4-.6 1 1-.6 1.4.5 1.3 1.4.5v1.5l-1.4.5-.5 1.3.6 1.4-1 1-1.4-.6-1.3.5L8 14.3l-1.5-.5-.5-1.3-1.4.6-1-1 .6-1.4-.5-1.3-1.4-.5V7.4l1.4-.5.5-1.3-.6-1.4 1-1 1.4.6 1.3-.5L8 1.7Z"/></>,
    help: <><circle cx="8" cy="8" r="6"/><path d="M6.4 6.1a1.7 1.7 0 1 1 2.7 1.4c-.8.5-1.1.8-1.1 1.7M8 11.5h.01"/></>,
    bell: <><path d="M3.5 11.7h9l-1.1-1.4V7a3.4 3.4 0 0 0-6.8 0v3.3l-1.1 1.4ZM6.6 13.1a1.5 1.5 0 0 0 2.8 0"/></>,
    arrow: <><path d="M3 8h9"/><path d="m8.5 4.5 3.5 3.5-3.5 3.5"/></>,
    plus: <><path d="M8 3v10M3 8h10"/></>,
    download: <><path d="M8 2.5v7.2M5.2 7.5 8 10.3l2.8-2.8M3 12.7h10"/></>,
    check: <path d="m3.5 8.2 2.7 2.7 6.3-6.1"/>,
    lock: <><rect x="3" y="6.5" width="10" height="7" rx="1"/><path d="M5.2 6.5V5a2.8 2.8 0 0 1 5.6 0v1.5"/></>,
  };
  return <svg {...common} aria-hidden="true">{paths[name]}</svg>;
}
