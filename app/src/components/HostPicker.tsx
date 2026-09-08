import type { Host } from "../types";

// Pick which Mac a config editor talks to. Remote Macs come from ~/tasks/.dispatch/hosts.json
// and are reached over the overlay network (Tailscale) by ssh, so the picker also explains
// why one is unreachable instead of leaving a dead button.
export function hostReason(hosts: Host[], id: string): string {
  if (id === "local") return "";
  const me = hosts.find((h) => h.local);
  const h = hosts.find((x) => x.id === id);
  if (!h) return "hosts.json 里没有这台机器";
  if (h.online) return "";
  if (me && !me.overlay?.kind) return "本机 Tailscale 没开，连不到它。打开 Tailscale 再试";
  return `${h.name} 离线（或它那边 Tailscale 没开）`;
}

// The sidebar decides which Mac we are looking at; config pages follow it and only
// name the target here. 全部 in the sidebar means this Mac.
export function HostPicker({ hosts, value, onChange, locked = false, fromSidebar = false }: { hosts: Host[]; value: string; onChange: (id: string) => void; locked?: boolean; fromSidebar?: boolean }) {
  const items = [{ id: "local", name: hosts.find((h) => h.local)?.name || "本机", online: true }, ...hosts.filter((h) => !h.local).map((h) => ({ id: h.id, name: h.name, online: h.online }))];
  const reason = hostReason(hosts, value);
  if (locked) { const name = items.find((h) => h.id === value)?.name || value; return <div className="hostpick"><span className="muted small">改的是</span><b className="small">{name}</b><span className="muted small">{items.length > 1 ? (fromSidebar ? "· 要改另一台，在侧栏选它" : "· 侧栏选「全部」时改本机") : ""}</span>{reason && <span className="hostpick-why">⚠ {reason}</span>}</div>; }
  return (
    <div className="hostpick">
      <span className="muted small">在哪台改</span>
      <div className="views">
        {items.map((h) => (
          <button key={h.id} className={value === h.id ? "on" : ""} onClick={() => onChange(h.id)} title={h.id === "local" ? "这台电脑" : hostReason(hosts, h.id) || "在线，改动直接写到那台"}>
            <span className={`dot${h.online ? " on" : ""}`} />{h.name}
          </button>
        ))}
      </div>
      {reason && <span className="hostpick-why">⚠ {reason}</span>}
    </div>
  );
}
