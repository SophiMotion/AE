import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowUUpLeft,
  ArrowUUpRight,
  ArrowsOutSimple,
  Circuitry,
  Plus,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import "@wokwi/elements/dist/esm/stepper-motor-element.js";
import "@xyflow/react/dist/style.css";
import type { FoldBotDraft } from "./foldbotApi";
import { normalizeGuidedConfig, type GuidedConfig } from "./guidedFlow";
import {
  HARDWARE_CATALOG,
  hardwareSelectionFromGraph,
  normalizedWiringKey,
  recommendedHardwareWiring,
  validateGraphReadiness,
  validateHardwareConnection,
  type HardwareCatalogItem,
  type HardwareComponentId,
  type HardwareGraphEdge,
  type ProjectGraphLayout,
  type ProjectGraphs,
  type WiringGraph,
} from "./projectGraphs";
import { useI18n } from "./i18n";
import "./hardwareGraphCanvas.css";

export interface HardwareGraphCanvasProps {
  draft: FoldBotDraft;
  graphs: ProjectGraphs;
  layout: ProjectGraphLayout;
  onDraftPatch: (patch: Partial<FoldBotDraft>) => void;
  onGraphsChange: (graphs: ProjectGraphs) => void;
  onLayoutChange: (layout: ProjectGraphLayout) => void;
  disabled: boolean;
}

type HardwareNode = Node<
  {
    catalog: HardwareCatalogItem;
    label: string;
    english: boolean;
    disabled: boolean;
  },
  "hardware"
>;
type Snapshot = {
  wiring: WiringGraph;
  hardware: GuidedConfig["hardware"];
  layout: ProjectGraphLayout;
};
const componentMime = "application/x-ae-hardware";
const signalColor = {
  digital: "#4285f4",
  ground: "#667085",
  uart: "#34a853",
  motor: "#c88700",
};
const defaultPositions: Record<string, { x: number; y: number }> = {
  controller: { x: 15, y: 125 },
  "fold-driver-1": { x: 410, y: 0 },
  "fold-driver-2": { x: 410, y: 355 },
  "arm-bus": { x: 805, y: 0 },
  "chassis-left": { x: 805, y: 280 },
  "chassis-right": { x: 805, y: 510 },
};

function HardwarePart({ data, selected }: NodeProps<HardwareNode>) {
  const item = data.catalog;
  const isDriver = item.id.startsWith("fold-driver");
  const isMotor = item.id.startsWith("chassis");
  const outputSide = item.id === "controller";
  const title = displayName(data.label, item, data.english);
  return (
    <div
      className={`hardware-part hardware-part--${item.id} ${selected ? "is-selected" : ""}`}
    >
      <div className="hardware-part-title">
        <Circuitry size={17} aria-hidden="true" />
        <strong>{title}</strong>
      </div>
      <div className="hardware-part-visual" aria-hidden="true">
        {item.id === "controller" ? (
          <div className="hardware-board-drawing">
            <span className="hardware-board-usb">USB</span>
            <span className="hardware-chip">ESP32-S3</span>
            <span className="hardware-board-name">Sophicar</span>
          </div>
        ) : isDriver ? (
          <>
            <div className="hardware-driver-drawing">
              <span>STEP / DIR</span>
              <i />
              <i />
              <i />
              <small>{data.english ? "External driver" : "外置驱动"}</small>
            </div>
            <div className="hardware-stepper-drawing">
              {createElement("wokwi-stepper-motor", { size: "17", angle: 0 })}
            </div>
          </>
        ) : item.id === "arm-bus" ? (
          <div className="hardware-bus-drawing">
            <span>
              TTL
              <br />
              <b>BusLinker</b>
            </span>
            <i />
            <span>
              HX
              <br />
              <b>ID 1–6</b>
            </span>
          </div>
        ) : isMotor ? (
          <div className="hardware-motor-drawing">
            <span />
            <b>MOTOR</b>
            <i />
          </div>
        ) : (
          <span className="hardware-custom-drawing">?</span>
        )}
      </div>
      <small className="hardware-part-caption">
        {data.english
          ? "Illustrative shape · source ports"
          : "外形示意 · 源码端口"}
      </small>
      <div
        className={`hardware-part-ports ${outputSide ? "ports-right" : "ports-left"}`}
      >
        {item.ports.map((port) => (
          <div className="hardware-part-port" key={port.id}>
            <Handle
              id={port.id}
              type="source"
              position={outputSide ? Position.Right : Position.Left}
              isConnectable={!data.disabled}
              style={{ background: signalColor[port.signal] }}
              title={`${title}: ${data.english ? port.labelEn : port.label}`}
              aria-label={`${title}: ${data.english ? port.labelEn : port.label}`}
            />
            <span>{data.english ? port.labelEn : port.label}</span>
            <i style={{ background: signalColor[port.signal] }} />
          </div>
        ))}
        {!item.ports.length && (
          <span className="hardware-part-unadapted">
            {data.english ? "Ports need adaptation" : "端口待适配"}
          </span>
        )}
      </div>
    </div>
  );
}
const nodeTypes = { hardware: HardwarePart };

function displayName(
  label: string,
  item: HardwareCatalogItem,
  english: boolean,
) {
  return !label || label === item.label || label === item.labelEn
    ? english
      ? item.labelEn
      : item.label
    : label;
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
function sameEndpoints(a: HardwareGraphEdge, b: HardwareGraphEdge) {
  return (
    (a.source === b.source &&
      a.sourcePort === b.sourcePort &&
      a.target === b.target &&
      a.targetPort === b.targetPort) ||
    (a.source === b.target &&
      a.sourcePort === b.targetPort &&
      a.target === b.source &&
      a.targetPort === b.sourcePort)
  );
}

/** Diagram editing only: this component never opens a port or sends device commands. */
export default function HardwareGraphCanvas(props: HardwareGraphCanvasProps) {
  const { draft, graphs, layout, onDraftPatch, onLayoutChange, disabled } =
    props;
  const { t, locale } = useI18n();
  const english = locale === "en";
  const prefix = useId();
  const [instance, setInstance] = useState<ReactFlowInstance<
    HardwareNode,
    Edge
  > | null>(null);
  const [nodes, setNodes] = useState<HardwareNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [notice, setNotice] = useState("");
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [notesInput, setNotesInput] = useState(
    draft.guided?.hardware.notes || "",
  );
  const dragStart = useRef<Snapshot | null>(null);
  const endingDrag = useRef(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const latest = useRef(props);
  latest.current = props;

  const selected = nodes.filter((node) => node.selected);
  const selectedNode =
    selected.length === 1
      ? graphs.wiring.nodes.find((node) => node.id === selected[0].id)
      : undefined;
  const selectedItem = HARDWARE_CATALOG.find(
    (item) => item.id === selectedNode?.component,
  );
  const selectedEdge = edges.filter((edge) => edge.selected);
  const canRemove = selected.length > 0 || selectedEdge.length > 0;
  const issues = useMemo(
    () =>
      validateGraphReadiness(graphs).filter(
        (issue) => issue.scope === "wiring",
      ),
    [graphs],
  );
  const endpoints = useMemo(
    () =>
      graphs.wiring.nodes.flatMap((node) => {
        const item = HARDWARE_CATALOG.find(
          (part) => part.id === node.component,
        )!;
        return item.ports.map((port) => ({
          value: `${node.id}|${port.id}`,
          label: `${displayName(node.label, item, english)} · ${english ? port.labelEn : port.label}`,
        }));
      }),
    [graphs.wiring.nodes, english],
  );

  useEffect(() => {
    setNodes((previous) =>
      graphs.wiring.nodes.map((node, index) => ({
        id: node.id,
        type: "hardware",
        position: layout[node.id] ||
          previous.find((old) => old.id === node.id)?.position ||
          defaultPositions[node.component] || {
            x: (index % 3) * 360,
            y: Math.floor(index / 3) * 340,
          },
        selected: previous.find((old) => old.id === node.id)?.selected || false,
        data: {
          catalog: HARDWARE_CATALOG.find((item) => item.id === node.component)!,
          label: node.label,
          english,
          disabled,
        },
        ariaLabel: node.label || node.component,
      })),
    );
  }, [graphs.wiring.nodes, layout, english, disabled]);

  useEffect(() => {
    setEdges((previous) =>
      graphs.wiring.edges.map((edge) => {
        const sourceNode = graphs.wiring.nodes.find(
          (node) => node.id === edge.source,
        );
        const signal = HARDWARE_CATALOG.find(
          (item) => item.id === sourceNode?.component,
        )?.ports.find((port) => port.id === edge.sourcePort)?.signal;
        const invalid =
          validateHardwareConnection(graphs.wiring, edge).length > 0;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourcePort,
          targetHandle: edge.targetPort,
          type: "smoothstep",
          selected:
            previous.find((old) => old.id === edge.id)?.selected || false,
          style: {
            stroke: invalid ? "#d93025" : signalColor[signal || "digital"],
            strokeWidth: 2.3,
          },
          interactionWidth: 24,
          ariaLabel: `${edge.sourcePort} ↔ ${edge.targetPort}`,
        };
      }),
    );
  }, [graphs.wiring]);

  useEffect(() => {
    setLabelInput(selectedNode?.label || "");
  }, [selectedNode?.id, selectedNode?.label]);
  useEffect(() => {
    setNotesInput(draft.guided?.hardware.notes || "");
  }, [draft.guided?.hardware.notes]);

  const snapshot = useCallback((): Snapshot => {
    const current = latest.current;
    return structuredClone({
      wiring: current.graphs.wiring,
      hardware: normalizeGuidedConfig(current.draft.guided).hardware,
      layout: {
        ...current.layout,
        ...Object.fromEntries(
          nodesRef.current.map((node) => [node.id, node.position]),
        ),
      },
    });
  }, []);

  const remember = (before = snapshot()) => {
    setPast((history) => [...history.slice(-39), before]);
    setFuture([]);
  };

  const applyWiring = (
    wiring: WiringGraph,
    nextLayout = layout,
    historicalHardware?: GuidedConfig["hardware"],
  ) => {
    const guided = normalizeGuidedConfig(draft.guided);
    const hardware =
      historicalHardware || hardwareSelectionFromGraph(wiring, guided.hardware);
    const semanticChange =
      normalizedWiringKey(wiring) !== normalizedWiringKey(graphs.wiring) ||
      JSON.stringify(hardware) !== JSON.stringify(guided.hardware);
    onDraftPatch({
      guided: {
        ...guided,
        hardware,
        wiring_binding_sha256: semanticChange
          ? null
          : guided.wiring_binding_sha256,
      },
      graphs: { ...graphs, wiring },
    });
    onLayoutChange(nextLayout);
  };

  const restore = (saved: Snapshot) => {
    const current = snapshot();
    if (
      JSON.stringify(saved.wiring) === JSON.stringify(current.wiring) &&
      JSON.stringify(saved.hardware) === JSON.stringify(current.hardware)
    )
      onLayoutChange(saved.layout);
    else applyWiring(saved.wiring, saved.layout, saved.hardware);
  };

  const undo = () => {
    if (disabled || !past.length) return;
    const previous = past[past.length - 1];
    setFuture((next) => [...next, snapshot()]);
    setPast((history) => history.slice(0, -1));
    restore(previous);
    setNotice(t("已撤销上一次编辑。", "Last edit undone."));
  };
  const redo = () => {
    if (disabled || !future.length) return;
    const next = future[future.length - 1];
    setPast((history) => [...history, snapshot()]);
    setFuture((history) => history.slice(0, -1));
    restore(next);
    setNotice(t("已恢复编辑。", "Edit restored."));
  };

  const addPart = (
    component: HardwareComponentId,
    point?: { x: number; y: number },
  ) => {
    if (disabled) return;
    const item = HARDWARE_CATALOG.find((part) => part.id === component);
    if (!item) return;
    const existing = graphs.wiring.nodes.find(
      (node) => node.component === component,
    );
    if (component !== "custom" && existing) {
      setNodes((list) =>
        list.map((node) => ({ ...node, selected: node.id === existing.id })),
      );
      void instance?.fitView({
        nodes: [{ id: existing.id }],
        maxZoom: 1,
        padding: 0.25,
        duration: 200,
      });
      setNotice(
        t(
          "这个元件已在画布中，已为你选中。",
          "This component is already on the canvas and is now selected.",
        ),
      );
      return;
    }
    if (graphs.wiring.nodes.length >= 64) {
      setNotice(
        t(
          "草稿最多保留 64 个元件。",
          "A draft can contain up to 64 components.",
        ),
      );
      return;
    }
    remember();
    const id = makeId("part");
    const position = point ||
      defaultPositions[component] || {
        x: 370,
        y: graphs.wiring.nodes.length * 45,
      };
    applyWiring(
      {
        ...graphs.wiring,
        nodes: [...graphs.wiring.nodes, { id, component, label: "" }],
      },
      { ...layout, [id]: position },
    );
    setNotice(
      t(
        "已添加元件。从圆点拖线，或用下方的端口选择器接线。",
        "Component added. Drag between ports, or use the selectors below.",
      ),
    );
  };

  const connect = (connection: Connection) => {
    if (
      disabled ||
      !connection.source ||
      !connection.target ||
      !connection.sourceHandle ||
      !connection.targetHandle
    )
      return;
    const edge: HardwareGraphEdge = {
      id: makeId("wire"),
      source: connection.source,
      sourcePort: connection.sourceHandle,
      target: connection.target,
      targetPort: connection.targetHandle,
    };
    const errors = validateHardwareConnection(graphs.wiring, edge);
    if (errors.length) {
      setNotice(english ? errors[0].messageEn : errors[0].message);
      return;
    }
    if (graphs.wiring.edges.some((wire) => sameEndpoints(wire, edge))) {
      setNotice(
        t("这两个端口已经连接。", "These two ports are already connected."),
      );
      return;
    }
    if (graphs.wiring.edges.length >= 160) {
      setNotice(
        t("草稿最多保留 160 条连线。", "A draft can contain up to 160 wires."),
      );
      return;
    }
    remember();
    applyWiring({ ...graphs.wiring, edges: [...graphs.wiring.edges, edge] });
    setNotice(
      t(
        "连线已保存到草稿，仍需核对实际硬件。",
        "Wire saved to the draft. Physical hardware still needs review.",
      ),
    );
  };

  const remove = (
    nodeIds = selected.map((node) => node.id),
    edgeIds = selectedEdge.map((edge) => edge.id),
  ) => {
    if (disabled || (!nodeIds.length && !edgeIds.length)) return;
    remember();
    const remainingLayout = { ...layout };
    nodeIds.forEach((id) => {
      delete remainingLayout[id];
    });
    applyWiring(
      {
        nodes: graphs.wiring.nodes.filter((node) => !nodeIds.includes(node.id)),
        edges: graphs.wiring.edges.filter(
          (edge) =>
            !edgeIds.includes(edge.id) &&
            !nodeIds.includes(edge.source) &&
            !nodeIds.includes(edge.target),
        ),
      },
      remainingLayout,
    );
    setNotice(
      t(
        "已删除选中项，相关连线一并移除。",
        "Selection deleted together with its attached wires.",
      ),
    );
  };

  const loadReference = () => {
    if (disabled) return;
    remember();
    const wiring = recommendedHardwareWiring();
    applyWiring(
      wiring,
      Object.fromEntries(
        wiring.nodes.map((node) => [
          node.id,
          defaultPositions[node.component] || { x: 0, y: 0 },
        ]),
      ),
    );
    setNotice(
      t(
        "已载入现有整机接线草稿。可继续修改；这不会确认接线或连接机器人。",
        "Existing wiring draft loaded. You can edit it; no wiring is approved and no robot is connected.",
      ),
    );
    window.setTimeout(() => {
      void instance?.fitView({ padding: 0.15, duration: 200, maxZoom: 0.9 });
    }, 100);
  };

  const saveLabel = () => {
    if (disabled || !selectedNode || selectedNode.label === labelInput) return;
    remember();
    applyWiring({
      ...graphs.wiring,
      nodes: graphs.wiring.nodes.map((node) =>
        node.id === selectedNode.id
          ? { ...node, label: labelInput.slice(0, 120) }
          : node,
      ),
    });
  };
  const saveNotes = () => {
    if (disabled || notesInput === (draft.guided?.hardware.notes || "")) return;
    remember();
    const guided = normalizeGuidedConfig(draft.guided);
    onDraftPatch({
      guided: {
        ...guided,
        hardware: { ...guided.hardware, notes: notesInput.slice(0, 2000) },
        wiring_binding_sha256: null,
      },
    });
  };

  return (
    <section
      className="hardware-graph"
      aria-label={t("硬件接线画布", "Hardware wiring canvas")}
    >
      <header className="hardware-graph-header">
        <div>
          <span className="hardware-graph-kicker">
            <Circuitry size={16} />
            {t("硬件接线", "Hardware wiring")}
          </span>
          <h3>
            {t(
              "把硬件拖进来，再连接端口",
              "Place components, then connect their ports",
            )}
          </h3>
        </div>
        <button
          type="button"
          className="hardware-reference-button"
          onClick={loadReference}
          disabled={disabled}
        >
          {t("载入现有整机接线", "Load existing robot wiring")}
        </button>
      </header>
      <p className="hardware-graph-intro">
        {t(
          "选择元件可改名称。拖动圆点接线，也可用端口下拉框。草稿与硬件选择保持同步。",
          "Select a component to rename it. Drag between ports or use the selectors. This draft stays in sync with your hardware choices.",
        )}
      </p>
      <div className="hardware-graph-shell">
        <aside
          className="hardware-palette"
          aria-label={t("元件库", "Component library")}
        >
          <h4>{t("元件库", "Components")}</h4>
          <span className="hardware-palette-hint">
            {t("拖入或点击 +", "Drag in or select +")}
          </span>
          {HARDWARE_CATALOG.map((item) => {
            const exists =
              item.id !== "custom" &&
              graphs.wiring.nodes.some((node) => node.component === item.id);
            return (
              <button
                key={item.id}
                type="button"
                draggable={!disabled}
                disabled={disabled}
                onDragStart={(event) => {
                  event.dataTransfer.setData(componentMime, item.id);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => addPart(item.id)}
                className={`hardware-palette-item ${exists ? "is-present" : ""}`}
                title={english ? item.descriptionEn : item.description}
              >
                <span
                  className={`hardware-palette-symbol hardware-symbol-${item.id}`}
                  aria-hidden="true"
                >
                  <Circuitry size={22} />
                </span>
                <span>
                  <strong>{english ? item.labelEn : item.label}</strong>
                  <small>
                    {exists
                      ? t("已添加 · 点击定位", "Added · locate")
                      : item.id === "custom"
                        ? t("保留待适配", "For adaptation")
                        : t("加入接线草稿", "Add to wiring")}
                  </small>
                </span>
                <Plus size={16} aria-hidden="true" />
              </button>
            );
          })}
        </aside>

        <div className="hardware-canvas-column">
          <div className="hardware-canvas-toolbar">
            <div>
              <button
                type="button"
                onClick={undo}
                disabled={disabled || !past.length}
                title={t("撤销", "Undo")}
                aria-label={t("撤销", "Undo")}
              >
                <ArrowUUpLeft size={18} />
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={disabled || !future.length}
                title={t("重做", "Redo")}
                aria-label={t("重做", "Redo")}
              >
                <ArrowUUpRight size={18} />
              </button>
              <button
                type="button"
                onClick={() => remove()}
                disabled={disabled || !canRemove}
                title={t("删除选中项", "Delete selection")}
                aria-label={t("删除选中项", "Delete selection")}
              >
                <Trash size={18} />
              </button>
            </div>
            <span>
              {graphs.wiring.nodes.length} {t("元件", "parts")} ·{" "}
              {graphs.wiring.edges.length} {t("连线", "wires")}
            </span>
            <button
              type="button"
              onClick={() => {
                void instance?.fitView({
                  padding: 0.15,
                  maxZoom: 1,
                  duration: 200,
                });
              }}
              title={t("适应画布", "Fit diagram")}
              aria-label={t("适应画布", "Fit diagram")}
            >
              <ArrowsOutSimple size={18} />
            </button>
          </div>
          <div
            className="hardware-canvas"
            onDragOver={(event) => {
              if (!disabled) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!disabled && instance)
                addPart(
                  event.dataTransfer.getData(
                    componentMime,
                  ) as HardwareComponentId,
                  instance.screenToFlowPosition({
                    x: event.clientX,
                    y: event.clientY,
                  }),
                );
            }}
          >
            <ReactFlow<HardwareNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={setInstance}
              connectionMode={ConnectionMode.Loose}
              onConnect={connect}
              nodesDraggable={!disabled}
              nodesConnectable={!disabled}
              edgesReconnectable={false}
              onNodesChange={(changes) => {
                setNodes((list) =>
                  applyNodeChanges(
                    changes.filter((change) => change.type !== "remove"),
                    list,
                  ),
                );
                if (disabled || dragStart.current || endingDrag.current) return;
                const moves = changes.filter(
                  (change) =>
                    change.type === "position" &&
                    change.position &&
                    !change.dragging,
                );
                if (moves.length) {
                  const next = { ...layout };
                  moves.forEach((move) => {
                    if (move.type === "position" && move.position)
                      next[move.id] = move.position;
                  });
                  remember();
                  onLayoutChange(next);
                }
              }}
              onEdgesChange={(changes) => {
                setEdges((list) =>
                  applyEdgeChanges(
                    changes.filter((change) => change.type !== "remove"),
                    list,
                  ),
                );
              }}
              onNodeDragStart={() => {
                dragStart.current = snapshot();
              }}
              onNodeDragStop={(_event, _node, draggedNodes) => {
                if (disabled) return;
                endingDrag.current = true;
                const next = { ...layout };
                draggedNodes.forEach((node) => {
                  next[node.id] = node.position;
                });
                if (JSON.stringify(next) !== JSON.stringify(layout)) {
                  remember(dragStart.current || snapshot());
                  onLayoutChange(next);
                }
                dragStart.current = null;
                queueMicrotask(() => {
                  endingDrag.current = false;
                });
              }}
              onBeforeDelete={async ({
                nodes: removedNodes,
                edges: removedEdges,
              }) => {
                remove(
                  removedNodes.map((node) => node.id),
                  removedEdges.map((edge) => edge.id),
                );
                return false;
              }}
              deleteKeyCode={disabled ? null : ["Backspace", "Delete"]}
              minZoom={0.25}
              maxZoom={1.5}
              fitView
              fitViewOptions={{ padding: 0.15, maxZoom: 0.85 }}
              panOnScroll
              zoomOnDoubleClick={false}
              snapToGrid
              snapGrid={[10, 10]}
              ariaLabelConfig={{
                "controls.zoomIn.ariaLabel": t("放大", "Zoom in"),
                "controls.zoomOut.ariaLabel": t("缩小", "Zoom out"),
                "controls.fitView.ariaLabel": t("适应画布", "Fit view"),
                "node.a11yDescription.default": t(
                  "按方向键移动，按 Delete 删除，按 Escape 取消选择。",
                  "Use arrow keys to move, Delete to remove and Escape to deselect.",
                ),
                "edge.a11yDescription.default": t(
                  "按 Delete 删除连线，按 Escape 取消选择。",
                  "Press Delete to remove a wire and Escape to deselect.",
                ),
              }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                color="#ccd6e5"
                gap={20}
                size={1}
              />
              <Controls showInteractive={false} />
            </ReactFlow>
            {!graphs.wiring.nodes.length && (
              <div className="hardware-canvas-empty">
                <Circuitry size={36} aria-hidden="true" />
                <strong>
                  {t("先放入你的第一块硬件", "Place your first component")}
                </strong>
                <p>
                  {t(
                    "从左侧拖入，或直接点击元件。",
                    "Drag one from the library, or click to add it.",
                  )}
                </p>
              </div>
            )}
          </div>
          <div className="hardware-wire-legend">
            {(
              [
                ["digital", t("控制信号", "Control")],
                ["uart", "UART"],
                ["ground", "GND"],
                ["motor", t("电机双线", "Motor pair")],
              ] as const
            ).map(([key, text]) => (
              <span key={key}>
                <i style={{ background: signalColor[key] }} />
                {text}
              </span>
            ))}
          </div>
          <div className="hardware-connect-form">
            <label htmlFor={`${prefix}-from`}>
              {t("端口 A", "Port A")}
              <select
                id={`${prefix}-from`}
                value={source}
                onChange={(event) => setSource(event.target.value)}
                disabled={disabled}
              >
                <option value="">
                  {t("选择元件和端口", "Select a component and port")}
                </option>
                {endpoints.map((endpoint) => (
                  <option key={endpoint.value} value={endpoint.value}>
                    {endpoint.label}
                  </option>
                ))}
              </select>
            </label>
            <span aria-hidden="true">↔</span>
            <label htmlFor={`${prefix}-to`}>
              {t("端口 B", "Port B")}
              <select
                id={`${prefix}-to`}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                disabled={disabled}
              >
                <option value="">
                  {t("选择另一端", "Select the other end")}
                </option>
                {endpoints.map((endpoint) => (
                  <option key={endpoint.value} value={endpoint.value}>
                    {endpoint.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={disabled || !source || !target}
              onClick={() => {
                const [sourceNode, sourceHandle] = source.split("|");
                const [targetNode, targetHandle] = target.split("|");
                connect({
                  source: sourceNode,
                  sourceHandle,
                  target: targetNode,
                  targetHandle,
                });
              }}
            >
              {t("连接", "Connect")}
            </button>
          </div>
        </div>

        <aside
          className="hardware-inspector"
          aria-label={t("元件与接线设置", "Component and wire settings")}
        >
          <h4>
            {selectedNode
              ? t("元件设置", "Component settings")
              : t("选择一个元件", "Select a component")}
          </h4>
          {selectedNode && selectedItem ? (
            <>
              <p className="hardware-inspector-kind">
                {english ? selectedItem.labelEn : selectedItem.label}
              </p>
              <label htmlFor={`${prefix}-label`}>
                {t("显示名称", "Display name")}
                <input
                  id={`${prefix}-label`}
                  value={labelInput}
                  maxLength={120}
                  placeholder={
                    english ? selectedItem.labelEn : selectedItem.label
                  }
                  disabled={disabled}
                  onChange={(event) => setLabelInput(event.target.value)}
                  onBlur={saveLabel}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </label>
              <p>
                {english
                  ? selectedItem.descriptionEn
                  : selectedItem.description}
              </p>
              <dl className="hardware-inspector-pins">
                {selectedItem.ports.map((port) => (
                  <div key={port.id}>
                    <dt>{english ? port.labelEn : port.label}</dt>
                    <dd>
                      {port.signal === "ground"
                        ? "GND"
                        : port.signal === "uart"
                          ? "UART"
                          : port.signal === "motor"
                            ? t("电机", "Motor")
                            : "STEP / DIR / EN"}
                    </dd>
                  </div>
                ))}
              </dl>
              <small>
                {t(
                  "端口来自现有源码。改变 GPIO 或驱动型号需要另外适配。",
                  "Ports come from existing source. GPIO or driver changes require adaptation.",
                )}
              </small>
              <button
                type="button"
                onClick={() => remove([selectedNode.id], [])}
                disabled={disabled}
                className="hardware-delete-button"
              >
                <Trash size={16} />
                {t("移除这个元件", "Remove component")}
              </button>
            </>
          ) : (
            <p>
              {t(
                "点选画布中的板卡、电机或驱动器，查看端口并改名称。",
                "Select a board, motor or driver on the canvas to inspect ports and rename it.",
              )}
            </p>
          )}
          <label className="hardware-notes" htmlFor={`${prefix}-notes`}>
            {t("硬件备注", "Hardware notes")}
            <textarea
              id={`${prefix}-notes`}
              rows={4}
              maxLength={2000}
              value={notesInput}
              disabled={disabled}
              onChange={(event) => setNotesInput(event.target.value)}
              onBlur={saveNotes}
              placeholder={t(
                "记录实物型号、线束或待核对参数",
                "Record model, wiring or parameters to verify",
              )}
            />
          </label>
        </aside>
      </div>
      <p className="hardware-graph-notice" role="status" aria-live="polite">
        {notice ||
          t(
            "连接规则按当前固件检查；未完成的草稿也会保留。",
            "Connections are checked against the current firmware. Incomplete drafts are retained.",
          )}
      </p>
      <details
        className={`hardware-graph-checks ${issues.length ? "has-issues" : ""}`}
      >
        <summary>
          <WarningCircle size={17} aria-hidden="true" />
          {issues.length
            ? t(
                `接线草稿还有 ${issues.length} 项待补齐`,
                `${issues.length} wiring items still need attention`,
              )
            : t(
                "源码要求的连接已齐全 · 实物仍待核对",
                "Source connections complete · physical review pending",
              )}
        </summary>
        {issues.length > 0 && (
          <ul>
            {issues.slice(0, 24).map((issue, index) => (
              <li
                key={`${issue.code}-${issue.nodeId || issue.edgeId || index}`}
              >
                {english ? issue.messageEn : issue.message}
              </li>
            ))}
          </ul>
        )}
        <p>
          {t(
            "GPIO35–37 与 N16R8 的兼容性、驱动电源/电流、舵机波特率及实物线序仍需现场核对。画布不发送运动指令。",
            "Verify GPIO35–37 / N16R8 compatibility, driver power/current, servo baud rate and physical wiring on site. The canvas sends no motion commands.",
          )}
        </p>
      </details>
      <details className="hardware-source-credit">
        <summary>
          {t("元件图形与源码来源", "Component graphics and source")}
        </summary>
        <p>
          {t(
            "通用步进电机外形复用 Wokwi Elements 1.9.2（MIT），画布使用 React Flow。Sophicar、外置驱动和 HX 总线接口按本项目资料单独定义。",
            "Generic stepper graphics reuse Wokwi Elements 1.9.2 (MIT); the canvas uses React Flow. Sophicar, external driver and HX bus interfaces are defined separately for this project.",
          )}
        </p>
        <a
          href={`${import.meta.env.BASE_URL}Wokwi-elements-NOTICE.txt`}
          target="_blank"
          rel="noreferrer"
        >
          {t("查看来源与许可证", "Source and license")}
        </a>
      </details>
    </section>
  );
}
