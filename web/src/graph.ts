/**
 * Modern, friendly SVG renderer for a Steppr workflow tree.
 *
 * Visual choices:
 *   - All nodes are rounded rectangles. Type is communicated by a colored
 *     left strip + type icon, not by shape.
 *   - Compact nodes (smaller width/height) so workflows fit on screen.
 *   - Soft drop shadow + subtle gradient give depth without noise.
 *   - Branch labels render in pill-shaped chips on edge midpoints.
 *   - Click any node to invoke onSelect.
 */

import type { Node, WorkflowDef } from "@steppr/sdk";

interface LayoutNode {
  id: string;
  type: Node["type"];
  label: string;
  x: number;
  y: number;
  status?: "ok" | "fail" | "active";
  orphan?: boolean;
  isStart?: boolean;
}

const NODE_W = 140;
const NODE_H = 44;
const ROW_GAP = 60;
const COL_GAP = 28;
const PAD = 16;

export interface GraphRenderOptions {
  statuses?: Record<string, "ok" | "fail" | "active">;
  selectedId?: string;
  /** When set, the named node is the active wiring source: clicking another
   *  node completes the wire instead of opening its editor. */
  wiringSourceId?: string;
  onSelect?: (id: string) => void;
  onAddNode?: () => void;
  onWireStart?: (sourceId: string) => void;
  onWireComplete?: (sourceId: string, targetId: string) => void;
  onWireCancel?: () => void;
  onEdgeDelete?: (fromId: string, toId: string, branchLabel?: string) => void;
}

export function renderGraph(
  wf: WorkflowDef,
  container: SVGSVGElement,
  opts: GraphRenderOptions = {},
): void {
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  const start = nodes.get(wf.start);
  if (!start) {
    container.innerHTML = `<text x="20" y="40" font-size="13" fill="#666">No start node defined.</text>`;
    return;
  }

  // Subtree width.
  const widths = new Map<string, number>();
  const computeWidth = (id: string, seen = new Set<string>()): number => {
    if (widths.has(id)) return widths.get(id)!;
    if (seen.has(id)) return 1;
    seen.add(id);
    const n = nodes.get(id);
    if (!n) return 1;
    const succs = successorIds(n);
    if (succs.length === 0) {
      widths.set(id, 1);
      return 1;
    }
    let total = 0;
    for (const s of succs) total += computeWidth(s, seen);
    const w = Math.max(1, total);
    widths.set(id, w);
    return w;
  };
  computeWidth(start.id);

  const placed: LayoutNode[] = [];
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  const reachable = new Set<string>();

  const assign = (id: string, depth: number, leftSlot: number): void => {
    const n = nodes.get(id);
    if (!n) return;
    if (reachable.has(id)) return; // cycle guard
    reachable.add(id);
    const width = widths.get(id) ?? 1;
    const myCenterSlot = leftSlot + width / 2;
    const x = PAD + myCenterSlot * (NODE_W + COL_GAP) - NODE_W / 2;
    const y = PAD + depth * (NODE_H + ROW_GAP);
    placed.push({
      id: n.id,
      type: n.type,
      label: n.id,
      x,
      y,
      status: opts.statuses?.[n.id],
      isStart: n.id === wf.start,
    });

    if (n.type === "filter" && n.branches) {
      let cursor = leftSlot;
      for (const b of n.branches) {
        const bw = widths.get(b.next_node) ?? 1;
        if (b.next_node) edges.push({ from: n.id, to: b.next_node, label: b.label });
        if (b.next_node) assign(b.next_node, depth + 1, cursor);
        cursor += bw;
      }
    } else if (n.next_node) {
      edges.push({ from: n.id, to: n.next_node });
      assign(n.next_node, depth + 1, leftSlot);
    }
  };
  assign(start.id, 0, 0);

  // Orphans: nodes not reachable from start. Render them in a separate row
  // below the main tree so the user can still see and click them.
  const orphans = wf.nodes.filter((n) => !reachable.has(n.id));
  if (orphans.length > 0) {
    const baseY = placed.length > 0
      ? Math.max(...placed.map((p) => p.y + NODE_H)) + ROW_GAP + 30
      : PAD;
    orphans.forEach((n, i) => {
      placed.push({
        id: n.id,
        type: n.type,
        label: n.id,
        x: PAD + i * (NODE_W + COL_GAP),
        y: baseY,
        status: opts.statuses?.[n.id],
        orphan: true,
        isStart: n.id === wf.start,
      });
    });
  }

  const maxX = Math.max(...placed.map((p) => p.x + NODE_W)) + PAD;
  const maxY = Math.max(...placed.map((p) => p.y + NODE_H)) + PAD;

  container.setAttribute("viewBox", `0 0 ${maxX} ${maxY}`);
  container.setAttribute("preserveAspectRatio", "xMidYMin meet");
  // Render at intrinsic size; CSS scales down on narrow screens but never up.
  container.setAttribute("width", String(maxX));
  container.setAttribute("height", String(maxY));
  container.innerHTML = "";

  // Defs: shadow filter + arrowhead.
  const defs = svg("defs");
  defs.innerHTML = `
    <filter id="node-shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="1.2"/>
      <feOffset dx="0" dy="1" result="offsetblur"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.18"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#a0aec0"/>
    </marker>`;
  container.appendChild(defs);

  const byId = new Map(placed.map((p) => [p.id, p]));
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) continue;
    const x1 = from.x + NODE_W / 2;
    const y1 = from.y + NODE_H;
    const x2 = to.x + NODE_W / 2;
    const y2 = to.y;
    const midY = (y1 + y2) / 2;

    const d = `M ${x1},${y1} C ${x1},${midY} ${x2},${midY} ${x2},${y2 - 3}`;

    // Wide transparent hit area so the edge is easy to click for deletion.
    if (opts.onEdgeDelete) {
      const hit = svg("path");
      hit.setAttribute("d", d);
      hit.setAttribute("fill", "none");
      hit.setAttribute("stroke", "transparent");
      hit.setAttribute("stroke-width", "14");
      hit.setAttribute("class", "wf-edge-hit");
      hit.style.cursor = "pointer";
      hit.addEventListener("click", () => {
        if (confirm(`Remove this connection from "${e.from}" → "${e.to}"?`)) {
          opts.onEdgeDelete!(e.from, e.to, e.label);
        }
      });
      container.appendChild(hit);
    }

    const path = svg("path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#a0aec0");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("marker-end", "url(#arrow)");
    path.setAttribute("class", "wf-edge");
    path.style.pointerEvents = "none";
    container.appendChild(path);

    if (e.label) {
      // Pill background + text
      const cx = (x1 + x2) / 2;
      const cy = midY;
      const labelText = svg("text");
      labelText.setAttribute("x", String(cx));
      labelText.setAttribute("y", String(cy + 3));
      labelText.setAttribute("text-anchor", "middle");
      labelText.setAttribute("font-size", "10.5");
      labelText.setAttribute("fill", "#4a5568");
      labelText.setAttribute("font-weight", "500");
      labelText.textContent = e.label;
      // Width estimate
      const w = e.label.length * 6.2 + 14;
      const pill = svg("rect");
      pill.setAttribute("x", String(cx - w / 2));
      pill.setAttribute("y", String(cy - 8));
      pill.setAttribute("width", String(w));
      pill.setAttribute("height", "16");
      pill.setAttribute("rx", "8");
      pill.setAttribute("fill", "#fff");
      pill.setAttribute("stroke", "#e2e8f0");
      pill.setAttribute("stroke-width", "1");
      container.appendChild(pill);
      container.appendChild(labelText);
    }
  }

  // If there are orphans, draw a section header above them.
  const orphanNodes = placed.filter((p) => p.orphan);
  if (orphanNodes.length > 0) {
    const headerY = Math.min(...orphanNodes.map((p) => p.y)) - 14;
    const t = svg("text");
    t.setAttribute("x", String(PAD));
    t.setAttribute("y", String(headerY));
    t.setAttribute("font-size", "11");
    t.setAttribute("font-weight", "600");
    t.setAttribute("letter-spacing", "0.06em");
    t.setAttribute("fill", "#a0aec0");
    t.textContent = "DISCONNECTED — click to wire up";
    container.appendChild(t);
  }

  for (const p of placed) {
    container.appendChild(renderNode(p, opts));
  }
}

function renderNode(n: LayoutNode, opts: GraphRenderOptions): SVGGElement {
  const g = svg("g");
  g.setAttribute("transform", `translate(${n.x}, ${n.y})`);
  const wiring = !!opts.wiringSourceId;
  const isSource = opts.wiringSourceId === n.id;
  const cls = ["wf-node"];
  if (opts.selectedId === n.id) cls.push("selected");
  if (isSource) cls.push("wiring-source");
  if (wiring && !isSource) cls.push("wiring-target");
  g.setAttribute("class", cls.join(" "));
  g.style.cursor = opts.onSelect || wiring ? "pointer" : "default";

  g.addEventListener("click", (ev) => {
    if (wiring) {
      ev.stopPropagation();
      if (isSource) {
        opts.onWireCancel?.();
      } else {
        opts.onWireComplete?.(opts.wiringSourceId!, n.id);
      }
      return;
    }
    opts.onSelect?.(n.id);
  });

  // Drop-shadow rect
  const r = svg("rect");
  r.setAttribute("x", "0");
  r.setAttribute("y", "0");
  r.setAttribute("width", String(NODE_W));
  r.setAttribute("height", String(NODE_H));
  r.setAttribute("rx", "6");
  r.setAttribute("fill", n.orphan ? "#fafbfc" : "#fff");
  r.setAttribute("stroke", strokeFor(n));
  r.setAttribute("stroke-width", opts.selectedId === n.id ? "2.5" : "1.25");
  if (n.orphan) r.setAttribute("stroke-dasharray", "4 3");
  r.setAttribute("filter", "url(#node-shadow)");
  g.appendChild(r);

  // Left accent strip
  const strip = svg("path");
  strip.setAttribute(
    "d",
    `M 0,6 a 6,6 0 0 1 6,-6 L 6,${NODE_H - 6} a 6,6 0 0 1 -6,-6 z M 0,${
      NODE_H - 6
    } a 0,0 0 0 0 0,0 z`,
  );
  // Simpler: filled rect for the strip
  const accent = svg("rect");
  accent.setAttribute("x", "0");
  accent.setAttribute("y", "0");
  accent.setAttribute("width", "5");
  accent.setAttribute("height", String(NODE_H));
  accent.setAttribute("rx", "0");
  accent.setAttribute("fill", accentFor(n));
  g.appendChild(accent);

  // Start badge — anchored top-right, slightly outside the node
  if (n.isStart) {
    const badge = svg("g");
    badge.setAttribute("class", "wf-start-badge");
    badge.setAttribute("transform", `translate(${NODE_W - 4}, -10)`);
    const bg = svg("rect");
    bg.setAttribute("x", "-44");
    bg.setAttribute("y", "0");
    bg.setAttribute("width", "48");
    bg.setAttribute("height", "16");
    bg.setAttribute("rx", "8");
    bg.setAttribute("fill", "#3182ce");
    badge.appendChild(bg);
    const text = svg("text");
    text.setAttribute("x", "-20");
    text.setAttribute("y", "11");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "9");
    text.setAttribute("font-weight", "700");
    text.setAttribute("fill", "#fff");
    text.setAttribute("letter-spacing", "0.06em");
    text.style.pointerEvents = "none";
    text.textContent = "▶ START";
    badge.appendChild(text);
    g.appendChild(badge);
  }

  // Status pip
  if (n.status) {
    const pip = svg("circle");
    pip.setAttribute("cx", String(NODE_W - 10));
    pip.setAttribute("cy", "10");
    pip.setAttribute("r", "4");
    pip.setAttribute("fill", n.status === "ok" ? "#48bb78" : n.status === "fail" ? "#f56565" : "#ecc94b");
    g.appendChild(pip);
  }

  // Type label (small, light)
  const type = svg("text");
  type.setAttribute("x", "14");
  type.setAttribute("y", "16");
  type.setAttribute("font-size", "9.5");
  type.setAttribute("fill", "#718096");
  type.setAttribute("font-weight", "600");
  type.setAttribute("letter-spacing", "0.05em");
  type.textContent = n.type.toUpperCase();
  g.appendChild(type);

  // Node ID (main)
  const id = svg("text");
  id.setAttribute("x", "14");
  id.setAttribute("y", "33");
  id.setAttribute("font-size", "13");
  id.setAttribute("font-weight", "600");
  id.setAttribute("fill", "#1a202c");
  id.textContent = n.label;
  g.appendChild(id);

  // Wire handle — small "+" circle on the bottom-center edge. Click to start
  // a wire from this node; click again on a target to complete.
  if (opts.onWireStart) {
    const handle = svg("g");
    handle.setAttribute("class", "wf-wire-handle");
    handle.setAttribute("transform", `translate(${NODE_W / 2}, ${NODE_H})`);
    handle.style.cursor = "pointer";
    const ring = svg("circle");
    ring.setAttribute("r", "8");
    ring.setAttribute("fill", "#fff");
    ring.setAttribute("stroke", accentFor(n));
    ring.setAttribute("stroke-width", "1.5");
    handle.appendChild(ring);
    const plus = svg("text");
    plus.setAttribute("x", "0");
    plus.setAttribute("y", "4");
    plus.setAttribute("text-anchor", "middle");
    plus.setAttribute("font-size", "13");
    plus.setAttribute("font-weight", "700");
    plus.setAttribute("fill", accentFor(n));
    plus.style.pointerEvents = "none";
    plus.textContent = "+";
    handle.appendChild(plus);
    handle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      opts.onWireStart!(n.id);
    });
    g.appendChild(handle);
  }

  return g;
}

function accentFor(n: LayoutNode): string {
  if (n.type === "filter") return "#4299e1";
  if (n.type === "action") return "#ed8936";
  return "#48bb78";
}

function strokeFor(n: LayoutNode): string {
  if (n.status === "ok") return "#48bb78";
  if (n.status === "fail") return "#f56565";
  return "#e2e8f0";
}

function successorIds(n: Node): string[] {
  if (n.type === "filter") return (n.branches ?? []).map((b) => b.next_node).filter(Boolean);
  return n.next_node ? [n.next_node] : [];
}

function svg<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/2000/svg", name);
}
