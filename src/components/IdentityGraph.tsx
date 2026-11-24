import { useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import {
  Crosshair,
  Filter,
  GitBranch,
  Maximize2,
  Minus,
  Network,
  Orbit,
  Plus,
} from "lucide-react";
import type { GraphEdge, GraphNode, NodeLayer } from "../types";
import { redactNodeLabel, redactText } from "../lib/redact";

type LayoutMode = "concentric" | "cose" | "breadthfirst";

interface IdentityGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  highlightedNodeIds?: Set<string> | null;
  redact: boolean;
  isRunning: boolean;
  onSelectNode: (nodeId: string | null) => void;
}

interface HoverTooltip {
  x: number;
  y: number;
  label: string;
  reason: string;
  branchedFrom: string | null;
  branchedRelation: string | null;
  sources: string;
  confidence: number;
  tier: string;
  hop: number;
  siteCategory: string | null;
  whereFound: string | null;
  matchedIdentifier: string | null;
}

interface RadarPoint {
  id: string;
  x: number;
  y: number;
  isSeed: boolean;
}

type VisualDimension = "seed" | "contact" | "account" | "record" | "darkweb";

const DIMENSION_COLORS: Record<
  VisualDimension,
  { fill: string; border: string }
> = {
  seed: { fill: "#23262d", border: "#ecece9" },
  contact: { fill: "#172a25", border: "#4fb48e" },
  account: { fill: "#18222e", border: "#6d8fad" },
  record: { fill: "#2b2316", border: "#d99b38" },
  darkweb: { fill: "#2e1819", border: "#d9534f" },
};

const CORROBORATION_RELATIONS = new Set([
  "avatar_match",
  "reciprocal_proof",
  "gpg_key_email",
  "commit_email",
  "pgp_uid_email",
  "raw_gpg_uid",
  "html_sameas_pivot",
  "deepened_pivot",
  "hkp_uid_match",
  "cert_san_match",
  "pdf_author_email",
  "owns_email",
  "owns_phone",
  "registered_on",
  "links_to",
  "onion_mention",
  "has_pdf",
  "exposed_in",
]);

function classifyVisualDimension(node: GraphNode): VisualDimension {
  if (node.layer === "seed") return "seed";
  const k = node.kind.toLowerCase();
  if (
    node.layer === "darkweb" ||
    k === "onion" ||
    k === "darkweb" ||
    k === "breach" ||
    k === "corpus_hit" ||
    k === "corpus" ||
    k === "paste" ||
    k === "paste_mention"
  ) {
    return "darkweb";
  }
  if (
    k === "email" ||
    k === "phone" ||
    k === "pgp" ||
    k === "pgp_key" ||
    k === "gpg_key" ||
    k === "gpg" ||
    k === "ssh_key" ||
    k === "ssh"
  ) {
    return "contact";
  }
  if (
    k === "record" ||
    k === "org" ||
    k === "organization" ||
    k === "corporate" ||
    k === "legal" ||
    k === "court" ||
    k === "patent" ||
    k === "academic" ||
    k === "document" ||
    k === "pdf" ||
    k === "domain" ||
    k === "certificate" ||
    k === "service"
  ) {
    return "record";
  }
  return "account";
}

function isCollisionNode(node: GraphNode): boolean {
  if (node.layer === "seed" || node.status === "confirmed") return false;
  if (node.status === "quarantined" || node.metadata?.match_tier === "collision") {
    return true;
  }
  return node.confidence < 0.52;
}

function getEdgeKind(
  relation: string
): "strong" | "amber" | "crimson" | "standard" {
  const rel = relation.toLowerCase();
  if (
    rel.includes("onion") ||
    rel.includes("exposed_in") ||
    rel.includes("corpus") ||
    rel.includes("breach")
  ) {
    return "crimson";
  }
  if (
    rel.includes("avatar") ||
    rel.includes("reciprocal") ||
    rel.includes("gpg") ||
    rel.includes("pgp") ||
    rel.includes("commit") ||
    rel.includes("owns_email") ||
    rel.includes("owns_phone") ||
    rel.includes("certifies_email")
  ) {
    return "strong";
  }
  if (
    CORROBORATION_RELATIONS.has(rel) ||
    rel.includes("registered") ||
    rel.includes("links_to") ||
    rel.includes("sameas") ||
    rel.includes("deepen") ||
    rel.includes("record") ||
    rel.includes("pdf") ||
    rel.includes("leak") ||
    rel.includes("mention")
  ) {
    return "amber";
  }
  return "standard";
}

function computeBfsHops(
  nodes: GraphNode[],
  edges: GraphEdge[]
): { hops: Map<string, number>; parentByNode: Map<string, string> } {
  const hops = new Map<string, number>();
  const parentByNode = new Map<string, string>();
  const seed = nodes.find((n) => n.layer === "seed") ?? nodes[0];
  if (!seed) return { hops, parentByNode };

  const adj = new Map<
    string,
    Array<{ next: string; directed: boolean; confidence: number }>
  >();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source)!.push({
      next: e.target,
      directed: true,
      confidence: e.confidence,
    });
    adj.get(e.target)!.push({
      next: e.source,
      directed: false,
      confidence: e.confidence,
    });
  }
  for (const list of adj.values()) {
    list.sort((a, b) => {
      if (a.directed !== b.directed) return a.directed ? -1 : 1;
      return b.confidence - a.confidence;
    });
  }

  const queue: string[] = [seed.id];
  hops.set(seed.id, 0);

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const nextHop = (hops.get(curr) ?? 0) + 1;
    for (const neighbor of adj.get(curr) ?? []) {
      if (!hops.has(neighbor.next)) {
        hops.set(neighbor.next, nextHop);
        parentByNode.set(neighbor.next, curr);
        queue.push(neighbor.next);
      }
    }
  }

  for (const n of nodes) {
    if (!hops.has(n.id)) {
      hops.set(n.id, Math.max(1, n.depth || 1));
    }
  }

  return { hops, parentByNode };
}

function computeShortestPath(
  nodes: GraphNode[],
  edges: GraphEdge[],
  targetId: string | null
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  if (!targetId) return { nodeIds, edgeIds };

  const seed = nodes.find((n) => n.layer === "seed") ?? nodes[0];
  if (!seed) return { nodeIds, edgeIds };
  if (seed.id === targetId) {
    nodeIds.add(seed.id);
    return { nodeIds, edgeIds };
  }

  const adj = new Map<
    string,
    Array<{ next: string; edgeId: string; directed: boolean; confidence: number }>
  >();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source)!.push({
      next: e.target,
      edgeId: e.id,
      directed: true,
      confidence: e.confidence,
    });
    adj.get(e.target)!.push({
      next: e.source,
      edgeId: e.id,
      directed: false,
      confidence: e.confidence,
    });
  }
  for (const list of adj.values()) {
    list.sort((a, b) => {
      if (a.directed !== b.directed) return a.directed ? -1 : 1;
      return b.confidence - a.confidence;
    });
  }

  const queue: string[] = [seed.id];
  const visited = new Set<string>([seed.id]);
  const parent = new Map<string, { prev: string; edgeId: string }>();

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === targetId) break;
    for (const neighbor of adj.get(curr) ?? []) {
      if (!visited.has(neighbor.next)) {
        visited.add(neighbor.next);
        parent.set(neighbor.next, { prev: curr, edgeId: neighbor.edgeId });
        queue.push(neighbor.next);
      }
    }
  }

  if (!visited.has(targetId)) {
    nodeIds.add(targetId);
    return { nodeIds, edgeIds };
  }

  let cursor: string | undefined = targetId;
  while (cursor) {
    nodeIds.add(cursor);
    const step = parent.get(cursor);
    if (!step) break;
    edgeIds.add(step.edgeId);
    cursor = step.prev;
  }

  return { nodeIds, edgeIds };
}

function getLayoutOptions(mode: LayoutMode, seedId: string | undefined) {
  if (mode === "concentric") {
    return {
      name: "concentric",
      animate: true,
      animationDuration: 520,
      animationEasing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fit: true,
      padding: 52,
      minNodeSpacing: 46,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
      equidistant: false,
      concentric: (ele: cytoscape.NodeSingular) => {
        const dim = ele.data("dimension") as VisualDimension;
        if (dim === "seed") return 10;
        const bfsHop = Number(ele.data("bfsHop") ?? 1);
        return Math.max(1, 10 - bfsHop * 2);
      },
      levelWidth: () => 1,
    };
  }
  if (mode === "breadthfirst") {
    return {
      name: "breadthfirst",
      directed: false,
      roots: seedId ? [seedId] : undefined,
      animate: true,
      animationDuration: 520,
      animationEasing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fit: true,
      padding: 52,
      spacingFactor: 1.35,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
    };
  }
  return {
    name: "cose",
    animate: true,
    animationDuration: 520,
    animationEasing: "cubic-bezier(0.22, 1, 0.36, 1)",
    fit: true,
    padding: 52,
    nodeDimensionsIncludeLabels: true,
    nodeRepulsion: () => 7400,
    idealEdgeLength: () => 116,
    edgeElasticity: () => 90,
    gravity: 0.45,
    numIter: 320,
    randomize: false,
  };
}

export function IdentityGraph({
  nodes,
  edges,
  selectedNodeId,
  highlightedNodeIds,
  redact,
  isRunning,
  onSelectNode,
}: IdentityGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const topologySigRef = useRef<string>("");
  const layoutTimerRef = useRef<number | null>(null);
  const nodesRef = useRef<GraphNode[]>(nodes);
  const visibleNodesRef = useRef<GraphNode[]>(nodes);
  const visibleEdgesRef = useRef<GraphEdge[]>(edges);
  const bfsInfoRef = useRef<{
    hops: Map<string, number>;
    parentByNode: Map<string, string>;
  }>({ hops: new Map(), parentByNode: new Map() });
  const redactRef = useRef<boolean>(redact);
  nodesRef.current = nodes;
  redactRef.current = redact;

  // Strictly Name-Root concentric default so the typed Name always sits dead-center
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("concentric");
  const [showCollisions, setShowCollisions] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<HoverTooltip | null>(null);
  const [radarPoints, setRadarPoints] = useState<RadarPoint[]>([]);

  const collisionCount = useMemo(
    () => nodes.filter((n) => isCollisionNode(n)).length,
    [nodes]
  );

  const visibleNodes = useMemo(() => {
    if (showCollisions) return nodes;
    return nodes.filter(
      (n) => !isCollisionNode(n) || n.id === selectedNodeId
    );
  }, [nodes, showCollisions, selectedNodeId]);

  const visibleEdges = useMemo(() => {
    const idSet = new Set(visibleNodes.map((n) => n.id));
    return edges.filter(
      (e) => e.source !== e.target && idSet.has(e.source) && idSet.has(e.target)
    );
  }, [visibleNodes, edges]);

  const bfsInfo = useMemo(
    () => computeBfsHops(visibleNodes, visibleEdges),
    [visibleNodes, visibleEdges]
  );

  visibleNodesRef.current = visibleNodes;
  visibleEdgesRef.current = visibleEdges;
  bfsInfoRef.current = bfsInfo;

  const activeFocusId = hoveredNodeId ?? selectedNodeId;

  const pathHighlight = useMemo(
    () => computeShortestPath(visibleNodes, visibleEdges, activeFocusId),
    [visibleNodes, visibleEdges, activeFocusId]
  );

  const syncRadarPoints = () => {
    const cy = cyRef.current;
    if (!cy) return;
    const pts: RadarPoint[] = [];
    cy.nodes().forEach((ele) => {
      const layer = ele.data("layer") as NodeLayer;
      if (layer === "seed" || layer === "anchor") {
        const pos = ele.renderedPosition();
        if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          pts.push({
            id: ele.id(),
            x: pos.x,
            y: pos.y,
            isSeed: layer === "seed",
          });
        }
      }
    });
    setRadarPoints(pts.slice(0, 4));
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cy = cytoscape({
      container,
      elements: [],
      minZoom: 0.28,
      maxZoom: 2.8,
      wheelSensitivity: 0.25,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(fillColor)",
            "border-color": "data(borderColor)",
            "border-width": "data(borderWidth)",
            width: "data(size)",
            height: "data(size)",
            label: "data(displayLabel)",
            color: "#d9dad6",
            "font-family": '"IBM Plex Sans", system-ui, sans-serif',
            "font-size": "11px",
            "font-weight": 500,
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 7,
            "text-max-width": "126px",
            "text-wrap": "ellipsis",
            "text-background-color": "#0d0e10",
            "text-background-opacity": 0.84,
            "text-background-padding": "3px",
            "text-background-shape": "roundrectangle",
            "overlay-opacity": 0,
            "transition-property":
              "opacity, border-width, border-color, width, height",
            "transition-duration": 180,
          },
        },
        {
          selector: "node[status = 'dismissed'], node[status = 'quarantined']",
          style: {
            "border-style": "dashed",
            opacity: 0.3,
          },
        },
        {
          selector: "node[matchTier = 'collision']",
          style: {
            "border-style": "dotted",
            opacity: 0.62,
          },
        },
        {
          // Unmistakable Name-Root central node
          selector: "node[layer = 'seed']",
          style: {
            color: "#ffffff",
            "font-size": "13px",
            "font-weight": 600,
            "border-style": "double",
            "border-width": 4.5,
            "border-color": "#ecece9",
            "text-margin-y": 9,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.25,
            "line-color": "rgba(160, 163, 171, 0.24)",
            "target-arrow-color": "rgba(160, 163, 171, 0.34)",
            "target-arrow-shape": "vee",
            "arrow-scale": 0.72,
            "curve-style": "bezier",
            "overlay-opacity": 0,
            "transition-property": "opacity, line-color, width",
            "transition-duration": 180,
          },
        },
        {
          selector: "edge[edgeKind = 'strong']",
          style: {
            width: 1.9,
            "line-color": "rgba(79, 180, 142, 0.68)",
            "target-arrow-color": "rgba(79, 180, 142, 0.82)",
            "line-style": "solid",
          },
        },
        {
          selector: "edge[edgeKind = 'amber']",
          style: {
            width: 1.75,
            "line-color": "rgba(217, 155, 56, 0.56)",
            "target-arrow-color": "rgba(217, 155, 56, 0.72)",
          },
        },
        {
          selector: "edge[edgeKind = 'crimson']",
          style: {
            width: 1.75,
            "line-color": "rgba(217, 83, 79, 0.52)",
            "target-arrow-color": "rgba(217, 83, 79, 0.72)",
          },
        },
        {
          selector: "edge.is-flowing",
          style: {
            "line-style": "dashed",
            "line-dash-pattern": [6, 4],
          },
        },
        {
          selector: ".dimmed",
          style: {
            opacity: 0.22,
          },
        },
        {
          selector: ".tab-dimmed",
          style: {
            opacity: 0.36,
          },
        },
        {
          selector: "node.in-tab",
          style: {
            opacity: 1,
            "border-width": 2.4,
            color: "#ecece9",
          },
        },
        {
          selector: "node.in-path",
          style: {
            opacity: 1,
            "border-width": 2.5,
            color: "#ecece9",
          },
        },
        {
          selector: "node.is-selected",
          style: {
            opacity: 1,
            "border-width": 3,
            "border-color": "#d99b38",
            color: "#ecece9",
          },
        },
        {
          selector: "edge.in-path",
          style: {
            opacity: 1,
            width: 2.3,
            "line-color": "#d99b38",
            "target-arrow-color": "#d99b38",
            "line-style": "dashed",
            "line-dash-pattern": [7, 4],
            label: "data(relationLabel)",
            color: "#ecece9",
            "font-family": '"IBM Plex Mono", monospace',
            "font-size": "10px",
            "font-weight": 500,
            "text-background-color": "#0d0e10",
            "text-background-opacity": 0.95,
            "text-background-padding": "3px",
            "text-background-shape": "roundrectangle",
            "text-border-width": 1,
            "text-border-color": "rgba(217, 155, 56, 0.45)",
            "text-border-opacity": 1,
            "text-rotation": "autorotate",
            "z-index": 20,
          },
        },
        {
          selector: "edge.in-path[edgeKind = 'strong']",
          style: {
            "line-color": "#4fb48e",
            "target-arrow-color": "#4fb48e",
            "text-border-color": "rgba(79, 180, 142, 0.45)",
          },
        },
        {
          selector: "edge.in-path[edgeKind = 'crimson']",
          style: {
            "line-color": "#d9534f",
            "target-arrow-color": "#d9534f",
            "text-border-color": "rgba(217, 83, 79, 0.48)",
          },
        },
      ],
    });

    cy.on("tap", "node", (evt) => {
      const id = evt.target.id();
      onSelectNode(id);
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) {
        onSelectNode(null);
      }
    });

    cy.on("mouseover", "node", (evt) => {
      const target = evt.target;
      const id = target.id();
      setHoveredNodeId(id);
      const rawNode = nodesRef.current.find((n) => n.id === id);
      if (!rawNode) return;

      const rPos = target.renderedPosition();
      const box = container.getBoundingClientRect();
      const clampedX = Math.max(12, Math.min(box.width - 288, rPos.x + 18));
      const clampedY = Math.max(12, Math.min(box.height - 196, rPos.y - 14));
      const useRedact = redactRef.current;

      const { hops, parentByNode } = bfsInfoRef.current;
      const hop = hops.get(id) ?? rawNode.depth ?? 0;
      const bfsParentId = parentByNode.get(id);
      const incomingEdges = visibleEdgesRef.current
        .filter((e) => e.target === id && e.source !== id)
        .sort((a, b) => {
          const aBfs = a.source === bfsParentId ? 1 : 0;
          const bBfs = b.source === bfsParentId ? 1 : 0;
          if (aBfs !== bBfs) return bBfs - aBfs;
          const aHop = hops.get(a.source) ?? 99;
          const bHop = hops.get(b.source) ?? 99;
          if (aHop !== bHop) return aHop - bHop;
          return b.confidence - a.confidence;
        });

      const bestIncoming =
        incomingEdges[0] ??
        (bfsParentId
          ? visibleEdgesRef.current.find(
              (e) =>
                (e.source === bfsParentId && e.target === id) ||
                (e.target === bfsParentId && e.source === id)
            )
          : undefined);
      const parentId =
        rawNode.layer === "seed"
          ? undefined
          : bestIncoming
          ? bestIncoming.source === id
            ? bestIncoming.target
            : bestIncoming.source
          : bfsParentId;
      const parentNode = parentId
        ? visibleNodesRef.current.find((n) => n.id === parentId)
        : undefined;

      const isOnion =
        rawNode.kind.toLowerCase() === "onion" ||
        (rawNode.layer === "darkweb" &&
          Boolean(
            rawNode.metadata?.onion_host ||
              rawNode.metadata?.where_found ||
              (rawNode.url || "").toLowerCase().includes(".onion")
          ));
      const onionHost = rawNode.metadata?.onion_host;
      const extraOnion = onionHost ? [onionHost] : [];

      setTooltip({
        x: clampedX,
        y: clampedY,
        label: redactNodeLabel(rawNode.label, rawNode.kind, useRedact),
        reason: redactText(
          rawNode.metadata?.match_reason || rawNode.sublabel || rawNode.kind,
          useRedact,
          extraOnion
        ),
        branchedFrom: parentNode
          ? redactNodeLabel(parentNode.label, parentNode.kind, useRedact)
          : null,
        branchedRelation: bestIncoming
          ? bestIncoming.relation.replace(/_/g, " ")
          : null,
        sources: rawNode.sources.join(" · "),
        confidence: Math.round(rawNode.confidence * 100),
        tier:
          rawNode.metadata?.match_tier ||
          (rawNode.status === "confirmed" ? "verified" : "probable"),
        hop,
        siteCategory: isOnion ? rawNode.metadata?.site_category || null : null,
        whereFound:
          isOnion && rawNode.metadata?.where_found
            ? redactText(rawNode.metadata.where_found, useRedact, extraOnion)
            : null,
        matchedIdentifier:
          isOnion && rawNode.metadata?.matched_identifier
            ? redactText(rawNode.metadata.matched_identifier, useRedact, extraOnion)
            : null,
      });
    });

    cy.on("mouseout", "node", () => {
      setHoveredNodeId(null);
      setTooltip(null);
    });

    cy.on("pan zoom layoutstop position", () => {
      syncRadarPoints();
    });

    cyRef.current = cy;

    const resizeObserver = new ResizeObserver(() => {
      cy.resize();
      syncRadarPoints();
    });
    resizeObserver.observe(container);

    return () => {
      if (layoutTimerRef.current !== null) {
        window.clearTimeout(layoutTimerRef.current);
      }
      resizeObserver.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [onSelectNode]);

  // Incrementally sync elements with Parent-Origin Node Spawning
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const seed = visibleNodes.find((n) => n.layer === "seed") ?? visibleNodes[0];
    const seedEl = seed ? cy.getElementById(seed.id) : null;
    const defaultOrigin =
      seedEl && seedEl.length > 0
        ? seedEl.position()
        : { x: cy.width() / 2 || 240, y: cy.height() / 2 || 220 };

    const parentByTarget = new Map<string, string>();
    for (const e of visibleEdges) {
      if (!parentByTarget.has(e.target)) {
        parentByTarget.set(e.target, e.source);
      }
    }

    const nextElements: ElementDefinition[] = [
      ...visibleNodes.map((node) => {
        const dim = classifyVisualDimension(node);
        const colors = DIMENSION_COLORS[dim];
        // Seed is unmistakably the 58px central root; all other entity types scale equally by confidence
        const baseSize =
          dim === "seed"
            ? 58
            : Math.round(
                20 +
                  Math.max(0.2, Math.min(1, node.confidence)) * 14 +
                  Math.min(5, node.sources.length * 1.5)
              );
        const displayLabel = redactNodeLabel(node.label, node.kind, redact);
        return {
          group: "nodes" as const,
          data: {
            id: node.id,
            layer: node.layer,
            dimension: dim,
            depth: node.depth,
            bfsHop: bfsInfo.hops.get(node.id) ?? Math.max(1, node.depth || 1),
            status: node.status,
            matchTier: node.metadata?.match_tier ?? "",
            confidence: node.confidence,
            fillColor: colors.fill,
            borderColor: colors.border,
            borderWidth:
              dim === "seed"
                ? 4.5
                : node.status === "confirmed" ||
                  node.metadata?.match_tier === "verified"
                ? 2.2
                : 1.5,
            size: baseSize,
            displayLabel,
          },
        };
      }),
      ...visibleEdges.map((edge) => ({
        group: "edges" as const,
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          edgeKind: getEdgeKind(edge.relation),
          relationLabel: edge.relation.replace(/_/g, " "),
        },
      })),
    ];

    const newSig = `${visibleNodes
      .map((n) => n.id)
      .sort()
      .join("|")}::${visibleEdges
      .map((e) => e.id)
      .sort()
      .join("|")}`;
    const topologyChanged = newSig !== topologySigRef.current;

    let spawnIdx = 0;

    cy.batch(() => {
      const nextNodeMap = new Map(
        nextElements
          .filter((el) => el.group === "nodes")
          .map((el) => [String(el.data.id), el])
      );
      const nextEdgeMap = new Map(
        nextElements
          .filter((el) => el.group === "edges")
          .map((el) => [String(el.data.id), el])
      );

      cy.edges().forEach((el) => {
        if (!nextEdgeMap.has(el.id())) el.remove();
      });
      cy.nodes().forEach((el) => {
        if (!nextNodeMap.has(el.id())) el.remove();
      });

      for (const [id, def] of nextNodeMap) {
        const existing = cy.getElementById(id);
        if (existing.length > 0) {
          existing.data(def.data);
        } else {
          const parentId = parentByTarget.get(id);
          const parentEl = parentId ? cy.getElementById(parentId) : null;
          const origin =
            parentEl && parentEl.length > 0
              ? parentEl.position()
              : defaultOrigin;
          const angle = (spawnIdx * 137.5 * Math.PI) / 180;
          spawnIdx += 1;
          cy.add({
            ...def,
            position: {
              x: origin.x + Math.cos(angle) * 8,
              y: origin.y + Math.sin(angle) * 8,
            },
          });
        }
      }

      for (const [id, def] of nextEdgeMap) {
        const existing = cy.getElementById(id);
        if (existing.length > 0) {
          existing.data(def.data);
        } else {
          cy.add(def);
        }
      }
    });

    if (topologyChanged && visibleNodes.length > 0) {
      topologySigRef.current = newSig;
      if (layoutTimerRef.current !== null) {
        window.clearTimeout(layoutTimerRef.current);
      }
      const seedId = seed?.id;
      layoutTimerRef.current = window.setTimeout(() => {
        if (!cyRef.current) return;
        const layout = cyRef.current.layout(
          getLayoutOptions(layoutMode, seedId) as cytoscape.LayoutOptions
        );
        layout.on("layoutstop", () => syncRadarPoints());
        layout.run();
      }, 150);
    } else {
      syncRadarPoints();
    }
  }, [visibleNodes, visibleEdges, bfsInfo, redact, layoutMode]);

  // Apply path highlight classes & tab highlight when selection/hover/tab changes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.elements().removeClass(
        "dimmed tab-dimmed in-tab in-path is-selected is-flowing"
      );

      if (isRunning) {
        cy.edges().addClass("is-flowing");
      }

      if (!activeFocusId) {
        if (highlightedNodeIds && highlightedNodeIds.size > 0) {
          let matchedAny = false;
          for (const nid of highlightedNodeIds) {
            if (cy.getElementById(nid).length > 0) {
              matchedAny = true;
              break;
            }
          }
          if (matchedAny) {
            cy.elements().addClass("tab-dimmed");
            cy.nodes("[layer = 'seed']").removeClass("tab-dimmed");
            for (const nid of highlightedNodeIds) {
              const el = cy.getElementById(nid);
              if (el.length > 0) {
                el.removeClass("tab-dimmed").addClass("in-tab");
                el.connectedEdges().removeClass("tab-dimmed");
              }
            }
          }
        }
        return;
      }

      cy.elements().addClass("dimmed");

      for (const nid of pathHighlight.nodeIds) {
        const el = cy.getElementById(nid);
        if (el.length > 0) {
          el.removeClass("dimmed").addClass("in-path");
        }
      }

      for (const eid of pathHighlight.edgeIds) {
        const el = cy.getElementById(eid);
        if (el.length > 0) {
          el.removeClass("dimmed").addClass("in-path");
        }
      }

      const focusedEl = cy.getElementById(activeFocusId);
      if (focusedEl.length > 0) {
        focusedEl.connectedEdges().forEach((edge) => {
          if (edge.data("edgeKind") === "strong") {
            edge.removeClass("dimmed").addClass("in-path");
            edge.connectedNodes().removeClass("dimmed").addClass("in-path");
          }
        });
        focusedEl.removeClass("dimmed");
        if (activeFocusId === selectedNodeId) {
          focusedEl.addClass("is-selected");
        }
      }
    });
  }, [
    activeFocusId,
    selectedNodeId,
    highlightedNodeIds,
    pathHighlight,
    isRunning,
    visibleNodes.length,
    visibleEdges.length,
  ]);

  // Smoothly animate camera onto the selected node's corroborated path on click
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !selectedNodeId) return;
    const pathNodes = cy.nodes(".in-path, .is-selected");
    if (pathNodes.length === 0) return;
    cy.stop(true, false);
    cy.animate({
      fit: { eles: pathNodes, padding: 84 },
      duration: 420,
      easing: "ease-out-cubic",
    });
  }, [selectedNodeId]);

  // Flowing marching-ants dash offset animation for active / streaming edges
  useEffect(() => {
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) return;
    if (!isRunning && !activeFocusId) return;

    let rafId = 0;
    let offset = 0;

    const tick = () => {
      const cy = cyRef.current;
      if (cy) {
        offset = (offset - 0.45) % 22;
        const animatedEdges = cy.edges(".in-path, .is-flowing");
        if (animatedEdges.length > 0) {
          animatedEdges.style("line-dash-offset", offset);
        }
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [isRunning, activeFocusId]);

  const runExplicitLayout = (mode: LayoutMode) => {
    setLayoutMode(mode);
    const cy = cyRef.current;
    if (!cy || visibleNodes.length === 0) return;
    const seedId = visibleNodes.find((n) => n.layer === "seed")?.id;
    const layout = cy.layout(
      getLayoutOptions(mode, seedId) as cytoscape.LayoutOptions
    );
    layout.on("layoutstop", () => syncRadarPoints());
    layout.run();
  };

  const handleZoom = (factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    const next = Math.max(0.28, Math.min(2.8, cy.zoom() * factor));
    cy.animate({
      zoom: {
        level: next,
        renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
      },
      duration: 180,
      easing: "ease-out-cubic",
    });
  };

  const handleFit = () => {
    cyRef.current?.animate({
      fit: { eles: cyRef.current.elements(), padding: 52 },
      duration: 320,
      easing: "ease-out-cubic",
    });
  };

  return (
    <section className="zone-graph" aria-label="Interactive identity graph">
      <div className="graph-canvas-wrap">
        <div ref={containerRef} className="graph-canvas" />

        {/* Forensic live scan radar rings anchored to seed & expanding anchors */}
        {isRunning && radarPoints.length > 0 && (
          <div className="radar-layer" aria-hidden="true">
            {radarPoints.map((pt) => (
              <span
                key={pt.id}
                className={`radar-pulse ${
                  pt.isSeed ? "radar-seed" : "radar-anchor"
                }`}
                style={{
                  transform: `translate3d(${pt.x}px, ${pt.y}px, 0)`,
                }}
              />
            ))}
          </div>
        )}

        {/* Crisp floating proof tooltip on node hover */}
        {tooltip && (
          <div
            className="graph-tooltip"
            style={{
              transform: `translate3d(${tooltip.x}px, ${tooltip.y}px, 0)`,
            }}
            role="status"
          >
            <div className="tooltip-top">
              <span className="tooltip-label">{tooltip.label}</span>
              <span className="mono tabular tooltip-conf">
                {tooltip.confidence}%
              </span>
            </div>
            <div className="tooltip-reason">{tooltip.reason}</div>
            {tooltip.branchedFrom && (
              <div className="tooltip-branch">
                <span className="tooltip-meta-k">Branched from:</span>{" "}
                <span className="tooltip-meta-v">{tooltip.branchedFrom}</span>
                {tooltip.branchedRelation && (
                  <span className="tooltip-rel mono">
                    {" "}
                    ({tooltip.branchedRelation})
                  </span>
                )}
              </div>
            )}
            {(tooltip.siteCategory ||
              tooltip.whereFound ||
              tooltip.matchedIdentifier) && (
              <div className="tooltip-onion-meta">
                {tooltip.siteCategory && (
                  <div className="tooltip-onion-row">
                    <span className="tooltip-meta-k">Category:</span>{" "}
                    <span className="tooltip-meta-v">
                      {tooltip.siteCategory}
                    </span>
                  </div>
                )}
                {tooltip.whereFound && (
                  <div className="tooltip-onion-row">
                    <span className="tooltip-meta-k">Where:</span>{" "}
                    <span className="tooltip-meta-v mono">
                      {tooltip.whereFound}
                    </span>
                  </div>
                )}
                {tooltip.matchedIdentifier && (
                  <div className="tooltip-onion-row">
                    <span className="tooltip-meta-k">Matched:</span>{" "}
                    <span className="tooltip-meta-v">
                      {tooltip.matchedIdentifier}
                    </span>
                  </div>
                )}
              </div>
            )}
            <div className="tooltip-sources mono">
              <span>{tooltip.tier}</span>
              <span>·</span>
              <span>hop {tooltip.hop}</span>
              <span>·</span>
              <span>{tooltip.sources}</span>
            </div>
          </div>
        )}

        {visibleNodes.length === 0 && (
          <div className="graph-empty">
            <p className="muted-text">Waiting for local identity signals</p>
          </div>
        )}
      </div>

      {/* Top-left intelligent map collision filter toggle */}
      <div
        className="graph-mode-bar"
        role="group"
        aria-label="Map intelligence filter"
      >
        <button
          type="button"
          className={`map-mode-pill ${!showCollisions ? "is-active" : ""}`}
          onClick={() => setShowCollisions(false)}
        >
          <Filter size={12} strokeWidth={1.5} />
          <span>Corroborated map</span>
        </button>
        <button
          type="button"
          className={`map-mode-pill ${showCollisions ? "is-active" : ""}`}
          onClick={() => setShowCollisions((v) => !v)}
          disabled={collisionCount === 0}
          title="Show or hide low-confidence handle-only name collisions"
        >
          <span>Collisions</span>
          <span className="mono tabular">({collisionCount})</span>
        </button>
      </div>

      {/* Unobtrusive bottom HUD row (legend + controls never overlap) */}
      <div className="graph-bottom-bar">
        <div className="graph-legend" aria-label="Graph entity dimensions">
          <span className="legend-item">
            <span className="layer-dot layer-seed" />
            Name root
          </span>
          <span className="legend-item">
            <span className="layer-dot layer-anchor" />
            Contacts
          </span>
          <span className="legend-item">
            <span className="layer-dot layer-surface" />
            Accounts
          </span>
          <span className="legend-item">
            <span className="layer-dot layer-deep" />
            Records &amp; docs
          </span>
          <span className="legend-item">
            <span className="layer-dot layer-darkweb" />
            Dark web &amp; leaks
          </span>
        </div>

        <div className="graph-controls" role="toolbar" aria-label="Graph controls">
          <div className="control-cluster">
            <button
              type="button"
              className={`icon-ctrl ${
                layoutMode === "concentric" ? "is-active" : ""
              }`}
              onClick={() => runExplicitLayout("concentric")}
              title="Radial name-root layout"
              aria-label="Radial name-root layout"
            >
              <Orbit size={15} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className={`icon-ctrl ${layoutMode === "cose" ? "is-active" : ""}`}
              onClick={() => runExplicitLayout("cose")}
              title="Force layout"
              aria-label="Force layout"
            >
              <Network size={15} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className={`icon-ctrl ${
                layoutMode === "breadthfirst" ? "is-active" : ""
              }`}
              onClick={() => runExplicitLayout("breadthfirst")}
              title="Pivot tree layout"
              aria-label="Pivot tree layout"
            >
              <GitBranch size={15} strokeWidth={1.5} />
            </button>
          </div>

          <div className="control-cluster">
            <button
              type="button"
              className="icon-ctrl"
              onClick={() => handleZoom(1.25)}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <Plus size={15} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className="icon-ctrl"
              onClick={() => handleZoom(0.8)}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <Minus size={15} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className="icon-ctrl"
              onClick={handleFit}
              title="Fit graph"
              aria-label="Fit graph"
            >
              <Maximize2 size={15} strokeWidth={1.5} />
            </button>
            {selectedNodeId && (
              <button
                type="button"
                className="icon-ctrl"
                onClick={() => onSelectNode(null)}
                title="Clear node selection"
                aria-label="Clear node selection"
              >
                <Crosshair size={15} strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
