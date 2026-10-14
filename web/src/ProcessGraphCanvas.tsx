import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowRight,
  CheckCircle,
  FlowArrow,
  ListBullets,
  Plus,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { useI18n } from "./i18n";
import type { FoldBotDraft } from "./foldbotApi";
import { defaultFoldBotFlow, type FoldBotFlowConfig } from "./foldbotFlow";
import {
  defaultGuidedConfig,
  guidedRequirementsReady,
  type GuidedConfig,
} from "./guidedFlow";
import {
  defaultProjectGraphs,
  validateGraphReadiness,
  type BehaviorGraphNode,
  type ProjectGraphs,
  type ProjectStage,
} from "./projectGraphs";
import "@xyflow/react/dist/style.css";
import "./processGraphCanvas.css";

type Layout = Record<string, { x: number; y: number }>;
type DraftFields = Pick<FoldBotDraft, "request" | "guided" | "workflow">;
type Snapshot = {
  graphs: ProjectGraphs;
  layout: Layout;
  fields: DraftFields;
};
type Props = {
  draft: FoldBotDraft;
  graphs: ProjectGraphs;
  layout: Layout;
  onDraftPatch: (patch: Partial<FoldBotDraft>) => void;
  onGraphsChange: (graphs: ProjectGraphs) => void;
  onLayoutChange: (layout: Layout) => void;
  onOpenStage: (index: number) => void;
  disabled: boolean;
};
const stages: ProjectStage[] = [
  "requirements",
  "hardware",
  "wiring",
  "preview",
  "program",
  "deploy",
  "control",
];
const stageNames: Record<ProjectStage, [string, string]> = {
  requirements: ["说清需求", "Requirements"],
  hardware: ["选择硬件", "Hardware"],
  wiring: ["生成接线", "Wiring"],
  preview: ["动作预览", "Motion preview"],
  program: ["生成程序", "Program"],
  deploy: ["部署设备", "Deployment"],
  control: ["机器人控制台", "Robot console"],
};
const actions: {
  value: FoldBotFlowConfig["action_group"];
  names: [string, string];
}[] = [
  { value: "fold-cycle", names: ["展开与收拢", "Unfold and fold"] },
  { value: "arm-demo", names: ["机械臂动作", "Arm movement"] },
  { value: "chassis-demo", names: ["底盘移动", "Chassis movement"] },
];
type GraphNode = Node<
  {
    title: string;
    subtitle: string;
    kind: BehaviorGraphNode["kind"];
    index?: number;
    incoming: boolean;
    outgoing: boolean;
    invalid: boolean;
    pauseLabel: string;
    openLabel: string;
    onOpen?: () => void;
  },
  "project-step"
>;

function ProjectStepNode({ data, selected }: NodeProps<GraphNode>) {
  return (
    <div
      className={`pg-node pg-node-${data.kind}${selected ? " is-selected" : ""}${data.invalid ? " is-invalid" : ""}`}
    >
      {data.incoming && (
        <Handle
          type="target"
          id="in"
          position={Position.Left}
          aria-label={`${data.title} input`}
        />
      )}
      <div className="pg-node-top">
        <span className="pg-node-number">
          {data.index === undefined
            ? data.kind === "action"
              ? "A"
              : "?"
            : String(data.index + 1).padStart(2, "0")}
        </span>
        <strong>{data.title}</strong>
      </div>
      <p>{data.subtitle}</p>
      {data.onOpen && (
        <button
          type="button"
          className="pg-node-open nodrag nopan"
          onClick={(event) => {
            event.stopPropagation();
            data.onOpen?.();
          }}
        >
          {data.openLabel}
          <ArrowRight size={13} />
        </button>
      )}
      {data.kind === "condition" && (
        <small className="pg-pause-label">{data.pauseLabel}</small>
      )}
      {data.outgoing && (
        <Handle
          type="source"
          id={data.kind === "condition" ? "true" : "next"}
          position={Position.Right}
          aria-label={`${data.title} ${data.kind === "condition" ? "true" : "next"}`}
        />
      )}
    </div>
  );
}
const nodeTypes = { "project-step": ProjectStepNode };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function fallbackPosition(node: BehaviorGraphNode, index: number) {
  const order = node.kind === "stage" ? stages.indexOf(node.stage) : 7 + index;
  const row = Math.floor(order / 3);
  return {
    x: (row % 2 === 0 ? order % 3 : 2 - (order % 3)) * 275,
    y: row * 180,
  };
}

/** These nodes edit the existing engineering draft; they do not run robot commands. */
export default function ProcessGraphCanvas({
  draft,
  graphs,
  layout,
  onDraftPatch,
  onGraphsChange,
  onLayoutChange,
  onOpenStage,
  disabled,
}: Props) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [selectedId, setSelectedId] = useState(
    () =>
      graphs.behavior.nodes.find(
        (node) => node.kind === "stage" && node.stage === "requirements",
      )?.id ?? "",
  );
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [interactionNotice, setInteractionNotice] = useState("");
  const [linkSource, setLinkSource] = useState("");
  const [linkTarget, setLinkTarget] = useState("");
  const [instance, setInstance] = useState<ReactFlowInstance<
    GraphNode,
    Edge
  > | null>(null);
  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  const dragSnapshot = useRef<Snapshot | null>(null);
  const fieldSnapshot = useRef<Snapshot | null>(null);
  const guided = draft.guided ?? defaultGuidedConfig();
  const flow = draft.workflow ?? defaultFoldBotFlow();
  const issues = useMemo(
    () =>
      validateGraphReadiness(graphs).filter(
        (issue) => issue.scope === "behavior",
      ),
    [graphs],
  );
  const selected = graphs.behavior.nodes.find((node) => node.id === selectedId);
  const orderedNodes = useMemo(() => {
    const ordered: BehaviorGraphNode[] = [];
    const seen = new Set<string>();
    let node = graphs.behavior.nodes.find(
      (item) => item.kind === "stage" && item.stage === "requirements",
    );
    while (node && !seen.has(node.id)) {
      ordered.push(node);
      seen.add(node.id);
      const outgoing = graphs.behavior.edges.filter(
        (edge) => edge.source === node!.id,
      );
      node =
        outgoing.length === 1
          ? graphs.behavior.nodes.find((item) => item.id === outgoing[0].target)
          : undefined;
    }
    return [
      ...ordered,
      ...graphs.behavior.nodes.filter((item) => !seen.has(item.id)),
    ];
  }, [graphs.behavior]);
  const snapshot = (): Snapshot =>
    clone({
      graphs,
      layout,
      fields: {
        request: draft.request,
        guided: draft.guided,
        workflow: draft.workflow,
      },
    });
  const remember = (before = snapshot()) => {
    setUndoStack((old) => [...old.slice(-29), before]);
    setRedoStack([]);
  };
  function changeBehavior(
    behavior: ProjectGraphs["behavior"],
    before?: Snapshot,
  ) {
    if (disabled) return;
    remember(before);
    onGraphsChange({ ...graphs, behavior });
  }
  function restore(value: Snapshot) {
    const current = snapshot();
    if (JSON.stringify(current.layout) !== JSON.stringify(value.layout))
      onLayoutChange(clone(value.layout));
    // One atomic draft patch keeps the hardware graph and its form choices together.
    // A layout-only undo never invalidates wiring, review or generated source.
    if (
      JSON.stringify(current.graphs) !== JSON.stringify(value.graphs) ||
      JSON.stringify(current.fields) !== JSON.stringify(value.fields)
    )
      onDraftPatch({ ...clone(value.fields), graphs: clone(value.graphs) });
  }
  function undo() {
    if (disabled || !undoStack.length) return;
    setRedoStack((old) => [...old, snapshot()]);
    restore(undoStack[undoStack.length - 1]);
    setUndoStack((old) => old.slice(0, -1));
  }
  function redo() {
    if (disabled || !redoStack.length) return;
    setUndoStack((old) => [...old, snapshot()]);
    restore(redoStack[redoStack.length - 1]);
    setRedoStack((old) => old.slice(0, -1));
  }
  function patchFields(patch: Partial<FoldBotDraft>) {
    if (disabled) return;
    if (!fieldSnapshot.current) remember();
    onDraftPatch(patch);
  }
  function patchGuided(patch: Partial<GuidedConfig>) {
    patchFields({
      guided: { ...guided, ...patch, wiring_binding_sha256: null },
      workflow: {
        ...flow,
        wiring_reviewed: false,
        ...(patch.primary_task &&
        actions.some((action) => action.value === patch.primary_task)
          ? {
              action_group:
                patch.primary_task as FoldBotFlowConfig["action_group"],
            }
          : {}),
      },
    });
  }
  function patchFlow(patch: Partial<FoldBotFlowConfig>) {
    patchFields({ workflow: { ...flow, ...patch } });
  }
  const nameOf = (node: BehaviorGraphNode) =>
    node.kind === "stage"
      ? t(...stageNames[node.stage])
      : node.kind === "action"
        ? t("动作组", "Action group")
        : t("检查条件", "Check condition");
  const detailOf = (node: BehaviorGraphNode) => {
    if (node.kind === "action")
      return t(
        ...(actions.find((action) => action.value === flow.action_group)
          ?.names ?? actions[0].names),
      );
    if (node.kind === "condition")
      return node.check === "requirements_ready"
        ? t("需求完整后继续", "Continue when requirements are complete")
        : t("接线核对后继续", "Continue after wiring review");
    if (node.stage === "requirements")
      return (
        guided.purpose.trim() ||
        t("机器人、动作、期望结果", "Robot, task and expected result")
      );
    if (node.stage === "hardware")
      return guided.hardware.controller === "sophicar-s3"
        ? "Sophicar · ESP32-S3"
        : t("选择主控与执行器", "Choose the controller and actuators");
    if (node.stage === "program")
      return flow.control === "esp"
        ? t("ESP32 固件工程", "ESP32 firmware project")
        : `ROS 2 ${flow.ros_version} · ${flow.ros_host}`;
    const names: Partial<Record<ProjectStage, [string, string]>> = {
      wiring: ["硬件引脚与连接检查", "Hardware pins and wiring checks"],
      preview: ["查看模型动作与曲线", "Inspect motion and curves"],
      deploy: ["先核对设备与工程版本", "Review the device and build version"],
      control: ["完成前序步骤后进入", "Open after the required steps"],
    };
    return t(...names[node.stage]!);
  };
  const derivedNodes = useMemo<GraphNode[]>(
    () =>
      graphs.behavior.nodes.map((node, index) => ({
        id: node.id,
        type: "project-step",
        position: layout[node.id] ?? fallbackPosition(node, index),
        selected: selectedId === node.id,
        data: {
          title: nameOf(node),
          subtitle: detailOf(node),
          kind: node.kind,
          index: node.kind === "stage" ? stages.indexOf(node.stage) : undefined,
          incoming: !(node.kind === "stage" && node.stage === "requirements"),
          outgoing: !(node.kind === "stage" && node.stage === "control"),
          invalid: issues.some((issue) => issue.nodeId === node.id),
          pauseLabel: t(
            "否 → 暂停，补齐后继续",
            "False → pause until resolved",
          ),
          openLabel: t("打开步骤", "Open step"),
          onOpen:
            node.kind === "stage"
              ? () => onOpenStage(stages.indexOf(node.stage))
              : undefined,
        },
      })),
    [
      graphs.behavior.nodes,
      layout,
      selectedId,
      issues,
      draft,
      locale,
      onOpenStage,
    ],
  );
  const [nodes, setNodes] = useState<GraphNode[]>(derivedNodes);
  useEffect(() => setNodes(derivedNodes), [derivedNodes]);
  const edges = useMemo<Edge[]>(
    () =>
      graphs.behavior.edges.map((edge) => {
        const invalid = issues.some((issue) => issue.edgeId === edge.id);
        const color = invalid
          ? "#c5221f"
          : selectedEdge === edge.id
            ? "#002fa7"
            : "#4285f4";
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourcePort,
          targetHandle: edge.targetPort,
          selected: edge.id === selectedEdge,
          type: "smoothstep",
          className: invalid ? "pg-invalid-edge" : undefined,
          markerEnd: { type: MarkerType.ArrowClosed, color },
          style: {
            stroke: color,
            strokeWidth: edge.id === selectedEdge ? 3 : 2,
          },
          label: invalid ? t("待修正", "Check connection") : undefined,
          labelStyle: { fill: color, fontSize: 11 },
        };
      }),
    [graphs.behavior.edges, issues, selectedEdge, locale],
  );

  function connect(connection: Connection) {
    if (disabled || !connection.source || !connection.target) return;
    if (graphs.behavior.edges.length >= 160) {
      setInteractionNotice(
        t(
          "最多保留 160 条流程连线，请先删除不需要的连接。",
          "Keep at most 160 process connections; remove an unused connection first.",
        ),
      );
      return;
    }
    setInteractionNotice("");
    const edge = {
      id: `flow-${crypto.randomUUID()}`,
      source: connection.source,
      sourcePort: connection.sourceHandle ?? "next",
      target: connection.target,
      targetPort: connection.targetHandle ?? "in",
    };
    if (
      graphs.behavior.edges.some(
        (existing) =>
          existing.source === edge.source &&
          existing.sourcePort === edge.sourcePort &&
          existing.target === edge.target &&
          existing.targetPort === edge.targetPort,
      )
    )
      return;
    changeBehavior({
      ...graphs.behavior,
      edges: [...graphs.behavior.edges, edge],
    });
    setSelectedEdge(edge.id);
  }
  function addNode(
    kind: ProjectStage | "action" | "condition",
    position?: { x: number; y: number },
  ) {
    if (disabled) return;
    const existing = graphs.behavior.nodes.find((node) =>
      stages.includes(kind as ProjectStage)
        ? node.kind === "stage" && node.stage === kind
        : kind === "action" && node.kind === "action",
    );
    if (existing) {
      setSelectedId(existing.id);
      return;
    }
    if (graphs.behavior.nodes.length >= 64) {
      setInteractionNotice(
        t(
          "最多保留 64 个流程节点，请先删除不需要的节点。",
          "Keep at most 64 process nodes; remove an unused node first.",
        ),
      );
      return;
    }
    setInteractionNotice("");
    const id = `node-${kind}-${crypto.randomUUID()}`;
    const node: BehaviorGraphNode =
      kind === "action"
        ? { id, kind, ref: "workflow.action_group" }
        : kind === "condition"
          ? { id, kind, check: "requirements_ready" }
          : { id, kind: "stage", stage: kind };
    changeBehavior({
      ...graphs.behavior,
      nodes: [...graphs.behavior.nodes, node],
    });
    onLayoutChange({
      ...layout,
      [id]: position ?? {
        x: 275,
        y:
          560 +
          graphs.behavior.nodes.filter((item) => item.kind !== "stage").length *
            160,
      },
    });
    setSelectedId(id);
    setSelectedEdge(null);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void instance?.fitView({ padding: 0.16, duration: 0 });
      }),
    );
  }
  function deleteSelection() {
    if (disabled) return;
    if (selectedEdge) {
      changeBehavior({
        ...graphs.behavior,
        edges: graphs.behavior.edges.filter((edge) => edge.id !== selectedEdge),
      });
      setSelectedEdge(null);
    } else if (selected) {
      changeBehavior({
        nodes: graphs.behavior.nodes.filter((node) => node.id !== selected.id),
        edges: graphs.behavior.edges.filter(
          (edge) => edge.source !== selected.id && edge.target !== selected.id,
        ),
      });
      setSelectedId("");
    }
  }
  function resetFlow() {
    if (disabled) return;
    changeBehavior(defaultProjectGraphs(draft).behavior);
    onLayoutChange({});
    setSelectedEdge(null);
    setTimeout(() => {
      void instance?.fitView({ padding: 0.15, duration: 250 });
    }, 40);
  }
  function arrangeNodes() {
    if (disabled) return;
    remember();
    onLayoutChange(
      Object.fromEntries(
        orderedNodes.map((node, index) => {
          const row = Math.floor(index / 3);
          return [
            node.id,
            {
              x: (row % 2 === 0 ? index % 3 : 2 - (index % 3)) * 275,
              y: row * 180,
            },
          ];
        }),
      ),
    );
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void instance?.fitView({ padding: 0.16, duration: 0 });
      }),
    );
  }
  function selectNode(id: string) {
    setSelectedId(id);
    setSelectedEdge(null);
  }
  const conditionPassed =
    selected?.kind === "condition" &&
    (selected.check === "requirements_ready"
      ? guidedRequirementsReady(draft)
      : flow.wiring_reviewed && !!guided.wiring_binding_sha256);
  const palette: {
    id: ProjectStage | "action" | "condition";
    label: string;
  }[] = [
    ...stages.map((stage) => ({ id: stage, label: t(...stageNames[stage]) })),
    { id: "action", label: t("动作组", "Action group") },
    { id: "condition", label: t("检查条件", "Check condition") },
  ];

  return (
    <section
      className="process-graph"
      aria-label={t(
        "需求与工程流程图",
        "Requirements and project process graph",
      )}
    >
      <header className="pg-heading">
        <div>
          <span className="pg-eyebrow">PROJECT FLOW</span>
          <h2>{t("把你的方案连接起来", "Connect your project")}</h2>
          <p>
            {t(
              "拖动节点整理位置，从右端口连到下一步的左端口；点选节点修改同一份工程。",
              "Arrange nodes, connect an output to the next input, and select a node to edit this project.",
            )}
          </p>
        </div>
        <div
          className="pg-view-switch"
          role="group"
          aria-label={t("流程显示方式", "Process view")}
        >
          <button
            type="button"
            aria-pressed={view === "canvas"}
            onClick={() => setView("canvas")}
          >
            <FlowArrow size={17} />
            {t("流程画布", "Canvas")}
          </button>
          <button
            type="button"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <ListBullets size={17} />
            {t("步骤列表", "Step list")}
          </button>
        </div>
      </header>
      <div className="pg-toolbar">
        <div className="pg-history">
          <button
            type="button"
            disabled={disabled || !undoStack.length}
            onClick={undo}
          >
            <ArrowCounterClockwise size={16} />
            {t("撤销", "Undo")}
          </button>
          <button
            type="button"
            disabled={disabled || !redoStack.length}
            onClick={redo}
          >
            <ArrowClockwise size={16} />
            {t("恢复", "Redo")}
          </button>
          <button
            type="button"
            disabled={disabled || (!selected && !selectedEdge)}
            onClick={deleteSelection}
          >
            <Trash size={16} />
            {t("删除选中", "Delete selected")}
          </button>
        </div>
        <div className="pg-history">
          <button type="button" disabled={disabled} onClick={arrangeNodes}>
            {t("整理布局", "Arrange nodes")}
          </button>
          <button type="button" disabled={disabled} onClick={resetFlow}>
            {t("恢复七步流程", "Restore seven steps")}
          </button>
        </div>
      </div>
      <details className="pg-palette" open>
        <summary>
          {t(
            "添加节点 · 拖入画布或点击添加",
            "Add nodes · drag onto the canvas or click",
          )}
        </summary>
        <div>
          {palette.map((item) => {
            const exists = stages.includes(item.id as ProjectStage)
              ? graphs.behavior.nodes.some(
                  (node) => node.kind === "stage" && node.stage === item.id,
                )
              : item.id === "action" &&
                graphs.behavior.nodes.some((node) => node.kind === "action");
            return (
              <button
                key={item.id}
                type="button"
                disabled={disabled}
                draggable={!disabled && !exists}
                className={`pg-palette-${item.id === "action" || item.id === "condition" ? item.id : "stage"}`}
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    "application/ae-project-node",
                    item.id,
                  );
                  event.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => addNode(item.id)}
                title={
                  exists
                    ? t("定位已有节点", "Select existing node")
                    : t("添加到画布", "Add to canvas")
                }
              >
                {exists ? <CheckCircle size={14} /> : <Plus size={14} />}
                {item.label}
              </button>
            );
          })}
        </div>
      </details>
      {interactionNotice && (
        <p className="pg-interaction-notice" role="status">
          {interactionNotice}
        </p>
      )}
      <div className="pg-workspace">
        <div className="pg-main">
          {view === "canvas" ? (
            <div
              className="pg-canvas"
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const kind = event.dataTransfer.getData(
                  "application/ae-project-node",
                );
                if (palette.some((item) => item.id === kind))
                  addNode(
                    kind as ProjectStage | "action" | "condition",
                    instance?.screenToFlowPosition({
                      x: event.clientX,
                      y: event.clientY,
                    }),
                  );
              }}
            >
              <ReactFlow<GraphNode, Edge>
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onInit={setInstance}
                fitView
                fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
                minZoom={0.25}
                maxZoom={1.6}
                nodesDraggable={!disabled}
                nodesConnectable={!disabled}
                elementsSelectable={!disabled}
                deleteKeyCode={null}
                onNodesChange={(changes) =>
                  setNodes((current) => applyNodeChanges(changes, current))
                }
                onNodeClick={(_, node) => selectNode(node.id)}
                onEdgeClick={(_, edge) => setSelectedEdge(edge.id)}
                onPaneClick={() => setSelectedEdge(null)}
                onConnect={connect}
                onNodeDragStart={() => {
                  dragSnapshot.current = snapshot();
                }}
                onNodeDragStop={(_, node) => {
                  if (!disabled) {
                    remember(dragSnapshot.current ?? snapshot());
                    onLayoutChange({ ...layout, [node.id]: node.position });
                  }
                  dragSnapshot.current = null;
                }}
                onNodeDoubleClick={(_, node) => {
                  const source = graphs.behavior.nodes.find(
                    (item) => item.id === node.id,
                  );
                  if (source?.kind === "stage")
                    onOpenStage(stages.indexOf(source.stage));
                }}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={20}
                  color="#c7d2e4"
                />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          ) : (
            <>
              <ol className="pg-step-list">
                {orderedNodes.map((node) => (
                  <li
                    key={node.id}
                    className={selectedId === node.id ? "is-selected" : ""}
                  >
                    <button type="button" onClick={() => selectNode(node.id)}>
                      <strong>
                        {node.kind === "stage"
                          ? `${stages.indexOf(node.stage) + 1}. `
                          : ""}
                        {nameOf(node)}
                      </strong>
                      <span>{detailOf(node)}</span>
                    </button>
                    {node.kind === "stage" && (
                      <button
                        type="button"
                        className="pg-list-open"
                        onClick={() => onOpenStage(stages.indexOf(node.stage))}
                        aria-label={`${t("打开", "Open")} ${nameOf(node)}`}
                      >
                        <ArrowRight size={18} />
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              <section
                className="pg-list-connections"
                aria-label={t("使用列表连接步骤", "Connect steps using lists")}
              >
                <h4>{t("连接步骤", "Connect steps")}</h4>
                <div className="pg-connection-fields">
                  <label>
                    {t("从哪个步骤", "From")}
                    <select
                      disabled={disabled}
                      aria-label={t("从哪个步骤", "From")}
                      value={linkSource}
                      onChange={(event) => setLinkSource(event.target.value)}
                    >
                      <option value="">{t("选择输出", "Choose output")}</option>
                      {graphs.behavior.nodes
                        .filter(
                          (node) =>
                            !(
                              node.kind === "stage" && node.stage === "control"
                            ),
                        )
                        .map((node) => (
                          <option key={node.id} value={node.id}>
                            {nameOf(node)}
                            {node.kind === "condition"
                              ? ` · ${detailOf(node)}`
                              : ""}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    {t("连接到", "To")}
                    <select
                      disabled={disabled}
                      aria-label={t("连接到", "To")}
                      value={linkTarget}
                      onChange={(event) => setLinkTarget(event.target.value)}
                    >
                      <option value="">{t("选择输入", "Choose input")}</option>
                      {graphs.behavior.nodes
                        .filter(
                          (node) =>
                            !(
                              node.kind === "stage" &&
                              node.stage === "requirements"
                            ),
                        )
                        .map((node) => (
                          <option key={node.id} value={node.id}>
                            {nameOf(node)}
                            {node.kind === "condition"
                              ? ` · ${detailOf(node)}`
                              : ""}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={
                      disabled ||
                      !graphs.behavior.nodes.some(
                        (node) => node.id === linkSource,
                      ) ||
                      !graphs.behavior.nodes.some(
                        (node) => node.id === linkTarget,
                      )
                    }
                    onClick={() =>
                      connect({
                        source: linkSource,
                        sourceHandle:
                          graphs.behavior.nodes.find(
                            (node) => node.id === linkSource,
                          )?.kind === "condition"
                            ? "true"
                            : "next",
                        target: linkTarget,
                        targetHandle: "in",
                      })
                    }
                  >
                    {t("添加连线", "Connect")}
                  </button>
                </div>
                <ul>
                  {graphs.behavior.edges.map((edge) => {
                    const from = graphs.behavior.nodes.find(
                      (node) => node.id === edge.source,
                    );
                    const to = graphs.behavior.nodes.find(
                      (node) => node.id === edge.target,
                    );
                    return (
                      <li key={edge.id}>
                        <span>
                          {from ? nameOf(from) : edge.source} →{" "}
                          {to ? nameOf(to) : edge.target}
                        </span>
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`${t("删除连线", "Delete connection")} ${from ? nameOf(from) : edge.source} → ${to ? nameOf(to) : edge.target}`}
                          onClick={() =>
                            changeBehavior({
                              ...graphs.behavior,
                              edges: graphs.behavior.edges.filter(
                                (item) => item.id !== edge.id,
                              ),
                            })
                          }
                        >
                          <Trash size={15} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </>
          )}
          <div
            className={`pg-validation${issues.length ? " has-issues" : ""}`}
            aria-live="polite"
          >
            <div>
              {issues.length ? (
                <WarningCircle size={18} />
              ) : (
                <CheckCircle size={18} />
              )}
              <strong>
                {issues.length
                  ? t(
                      `还有 ${issues.length} 项连线需调整`,
                      `${issues.length} connection checks to resolve`,
                    )
                  : t(
                      "七个必要步骤已连接",
                      "All seven required steps are connected",
                    )}
              </strong>
            </div>
            {issues.length > 0 && (
              <ul>
                {issues.slice(0, 5).map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    {t(issue.message, issue.messageEn)}
                  </li>
                ))}
              </ul>
            )}
            <p>
              {t(
                "未完成的图会保留为草稿。流程连通只说明步骤关系完整，生成和设备操作仍需完成对应检查。",
                "Incomplete graphs remain as drafts. Connections describe the process; generation and device actions still require their checks.",
              )}
            </p>
          </div>
        </div>
        <aside
          className="pg-inspector"
          aria-label={t("节点参数", "Node parameters")}
          onFocusCapture={(event) => {
            if (
              event.target instanceof HTMLInputElement ||
              event.target instanceof HTMLTextAreaElement
            )
              fieldSnapshot.current = snapshot();
          }}
          onBlurCapture={() => {
            if (fieldSnapshot.current) {
              const before = fieldSnapshot.current;
              fieldSnapshot.current = null;
              if (
                JSON.stringify(before.fields) !==
                JSON.stringify(snapshot().fields)
              )
                remember(before);
            }
          }}
        >
          <span className="pg-eyebrow">
            {t("同一工程 · 实时同步", "ONE PROJECT · SHARED SETTINGS")}
          </span>
          <h3>
            {selected ? nameOf(selected) : t("选择一个节点", "Select a node")}
          </h3>
          {selectedEdge && (
            <div className="pg-edge-selection">
              <strong>{t("已选中连线", "Connection selected")}</strong>
              <p>
                {t(
                  "删除后从输出端口重新连接，或点击撤销恢复。",
                  "Delete and reconnect from the output port, or use Undo to restore it.",
                )}
              </p>
              <button
                type="button"
                disabled={disabled}
                onClick={deleteSelection}
              >
                {t("删除这条连线", "Delete connection")}
              </button>
            </div>
          )}
          {!selected && (
            <p>
              {t(
                "点选画布或列表中的节点，查看它的参数。",
                "Select a node on the canvas or in the list to inspect its settings.",
              )}
            </p>
          )}
          {selected?.kind === "stage" && selected.stage === "requirements" && (
            <>
              <label>
                {t("机器人类型", "Robot type")}
                <select
                  disabled={disabled}
                  aria-label={t("机器人类型", "Robot type")}
                  value={guided.robot_choice}
                  onChange={(event) =>
                    patchGuided({
                      robot_choice: event.target
                        .value as GuidedConfig["robot_choice"],
                    })
                  }
                >
                  <option value="undecided">{t("请选择", "Choose one")}</option>
                  <option value="foldbot">
                    {t("折叠机器人", "Folding robot")}
                  </option>
                  <option value="other">
                    {t("其他设备 · 待适配", "Other device · adaptation needed")}
                  </option>
                </select>
              </label>
              <label>
                {t("你的需求", "Your request")}
                <textarea
                  rows={3}
                  maxLength={12000}
                  disabled={disabled}
                  aria-label={t("你的需求", "Your request")}
                  value={draft.request}
                  onChange={(event) =>
                    patchFields({
                      request: event.target.value,
                      guided: { ...guided, wiring_binding_sha256: null },
                      workflow: { ...flow, wiring_reviewed: false },
                    })
                  }
                />
              </label>
              <label>
                {t("主要动作", "Main task")}
                <select
                  disabled={disabled}
                  aria-label={t("主要动作", "Main task")}
                  value={guided.primary_task}
                  onChange={(event) =>
                    patchGuided({
                      primary_task: event.target
                        .value as GuidedConfig["primary_task"],
                    })
                  }
                >
                  <option value="unselected">
                    {t("请选择", "Choose one")}
                  </option>
                  {actions.map((action) => (
                    <option value={action.value} key={action.value}>
                      {t(...action.names)}
                    </option>
                  ))}
                  <option value="custom">
                    {t("组合或其他动作", "Combined or custom task")}
                  </option>
                </select>
              </label>
              <label>
                {t("期望做到什么程度？", "What result would count as done?")}
                <textarea
                  rows={3}
                  maxLength={2000}
                  disabled={disabled}
                  aria-label={t(
                    "期望做到什么程度？",
                    "What result would count as done?",
                  )}
                  value={guided.purpose}
                  onChange={(event) =>
                    patchGuided({ purpose: event.target.value })
                  }
                  placeholder={t(
                    "例如先预览，再逐步控制，并能随时停止。",
                    "For example: preview, operate step by step, and stop at any time.",
                  )}
                />
              </label>
            </>
          )}
          {selected?.kind === "stage" && selected.stage === "hardware" && (
            <>
              {(
                [
                  [
                    "controller",
                    t("主控制板", "Controller"),
                    "sophicar-s3",
                    "Sophicar ESP32-S3",
                  ],
                  [
                    "fold_driver",
                    t("折叠板驱动", "Fold drive"),
                    "external-step-dir",
                    t("外置 STEP / DIR 驱动器", "External STEP / DIR driver"),
                  ],
                  [
                    "arm_bus",
                    t("机械臂总线", "Arm bus"),
                    "buslinker-hx",
                    "BusLinker + HX",
                  ],
                  [
                    "chassis",
                    t("底盘驱动", "Chassis drive"),
                    "sophicar-m1-m2",
                    "Sophicar M1 / M2",
                  ],
                ] as const
              ).map(([key, label, value, name]) => (
                <label key={key}>
                  {label}
                  <select
                    disabled={disabled}
                    aria-label={label}
                    value={guided.hardware[key]}
                    onChange={(event) =>
                      patchGuided({
                        hardware: {
                          ...guided.hardware,
                          [key]: event.target.value,
                        },
                      })
                    }
                  >
                    <option value="unselected">
                      {t("请选择", "Choose one")}
                    </option>
                    <option value={value}>{name}</option>
                    <option value="other">
                      {t("其他 · 待适配", "Other · adaptation needed")}
                    </option>
                  </select>
                </label>
              ))}
              <label>
                {t("硬件补充说明", "Hardware notes")}
                <textarea
                  rows={3}
                  maxLength={2000}
                  disabled={disabled}
                  aria-label={t("硬件补充说明", "Hardware notes")}
                  value={guided.hardware.notes}
                  onChange={(event) =>
                    patchGuided({
                      hardware: {
                        ...guided.hardware,
                        notes: event.target.value,
                      },
                    })
                  }
                />
              </label>
              <p className="pg-help">
                {t(
                  "这些选项对应已有源码方案，选择不代表实物兼容性已经验证。",
                  "These choices refer to existing source. Selection does not prove physical compatibility.",
                )}
              </p>
            </>
          )}
          {selected?.kind === "stage" && selected.stage === "program" && (
            <>
              <fieldset disabled={disabled}>
                <legend>
                  {t("生成哪一端程序？", "Which program should be generated?")}
                </legend>
                <div className="pg-route-choice">
                  {(["esp", "ros"] as const).map((route) => (
                    <button
                      type="button"
                      key={route}
                      aria-pressed={flow.control === route}
                      onClick={() => patchFlow({ control: route })}
                    >
                      {route === "esp" ? "ESP32" : "ROS 2"}
                    </button>
                  ))}
                </div>
              </fieldset>
              {flow.control === "ros" && (
                <>
                  <label>
                    {t("ROS 运行设备", "ROS host")}
                    <select
                      disabled={disabled}
                      aria-label={t("ROS 运行设备", "ROS host")}
                      value={flow.ros_host}
                      onChange={(event) =>
                        patchFlow({
                          ros_host: event.target
                            .value as FoldBotFlowConfig["ros_host"],
                        })
                      }
                    >
                      <option value="local">
                        {t("本机电脑", "Local computer")}
                      </option>
                      <option value="jetson">Jetson</option>
                      <option value="raspberrypi">Raspberry Pi</option>
                    </select>
                  </label>
                  <label>
                    {t("ROS 版本", "ROS version")}
                    <select
                      disabled={disabled}
                      aria-label={t("ROS 版本", "ROS version")}
                      value={flow.ros_version}
                      onChange={(event) =>
                        patchFlow({
                          ros_version: event.target
                            .value as FoldBotFlowConfig["ros_version"],
                        })
                      }
                    >
                      <option value="humble">Humble</option>
                      <option value="jazzy">Jazzy</option>
                    </select>
                  </label>
                  <label>
                    {t("串口配置（可暂留空）", "Serial port (optional)")}
                    <input
                      disabled={disabled}
                      maxLength={120}
                      aria-label={t(
                        "串口配置（可暂留空）",
                        "Serial port (optional)",
                      )}
                      value={flow.ros_serial}
                      placeholder="/dev/ttyUSB0"
                      onChange={(event) =>
                        patchFlow({ ros_serial: event.target.value })
                      }
                    />
                  </label>
                  <p className="pg-help">
                    {t(
                      "ROS 在此生成演示工程；尚未完成实机 ROS 控制验收。",
                      "ROS produces a demonstration project here; real ROS control has not been validated.",
                    )}
                  </p>
                </>
              )}
            </>
          )}
          {selected?.kind === "action" && (
            <>
              <label>
                {t("使用已有动作组", "Use an existing action group")}
                <select
                  disabled={disabled}
                  aria-label={t(
                    "使用已有动作组",
                    "Use an existing action group",
                  )}
                  value={flow.action_group}
                  onChange={(event) =>
                    patchFlow({
                      action_group: event.target
                        .value as FoldBotFlowConfig["action_group"],
                    })
                  }
                >
                  {actions.map((action) => (
                    <option value={action.value} key={action.value}>
                      {t(...action.names)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="pg-help">
                {t(
                  "把此节点接在动作预览与生成程序之间。它与原动作组选项同步，用于预览和工程记录；不会自动驱动电机或新增固件动作。",
                  "Place this node between motion preview and program generation. It shares the existing action-group choice for preview and project records; it does not run motors or add firmware routines.",
                )}
              </p>
            </>
          )}
          {selected?.kind === "condition" && (
            <>
              <label>
                {t("要检查什么？", "What should be checked?")}
                <select
                  disabled={disabled}
                  aria-label={t("要检查什么？", "What should be checked?")}
                  value={selected.check}
                  onChange={(event) =>
                    changeBehavior({
                      ...graphs.behavior,
                      nodes: graphs.behavior.nodes.map((node) =>
                        node.id === selected.id
                          ? {
                              ...selected,
                              check: event.target.value as
                                "requirements_ready" | "wiring_reviewed",
                            }
                          : node,
                      ),
                    })
                  }
                >
                  <option value="requirements_ready">
                    {t("需求已填写完整", "Requirements are complete")}
                  </option>
                  <option value="wiring_reviewed">
                    {t("接线已核对", "Wiring has been reviewed")}
                  </option>
                </select>
              </label>
              <p
                className={`pg-condition-state${conditionPassed ? " is-ready" : ""}`}
              >
                {conditionPassed
                  ? t(
                      "当前满足 · 仍以步骤检查为准",
                      "Currently satisfied · stage checks still apply",
                    )
                  : t(
                      "当前未满足 · 暂停等待补齐",
                      "Not satisfied · pause until resolved",
                    )}
              </p>
              <p className="pg-help">
                {selected.check === "requirements_ready"
                  ? t(
                      "连接在需求与硬件之间。真：继续；假：暂停，返回补齐需求。",
                      "Place between requirements and hardware. True: continue. False: pause and complete requirements.",
                    )
                  : t(
                      "连接在接线与动作预览之间。真：继续；假：暂停，先核对接线。",
                      "Place between wiring and motion preview. True: continue. False: pause and review wiring.",
                    )}
              </p>
            </>
          )}
          {selected?.kind === "stage" &&
            !["requirements", "hardware", "program"].includes(
              selected.stage,
            ) && (
              <p className="pg-help">
                {t(
                  "进入对应步骤查看完整内容。这里的连线不会跳过需求、接线、工程核对或设备连接检查。",
                  "Open this step for its full content. Connections cannot bypass requirement, wiring, project-review or device-connection checks.",
                )}
              </p>
            )}
          {selected?.kind === "stage" && (
            <button
              type="button"
              className="pg-open-stage"
              onClick={() => onOpenStage(stages.indexOf(selected.stage))}
            >
              {t("打开这一步", "Open this step")}
              <ArrowRight size={17} />
            </button>
          )}
        </aside>
      </div>
    </section>
  );
}
