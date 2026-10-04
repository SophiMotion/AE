import { useMemo, useState } from "react";
import {
  ReactFlow,
  Handle,
  Position,
  Controls,
  Background,
  BackgroundVariant,
  MarkerType,
  applyNodeChanges,
  type Node,
  type NodeProps,
  type Edge,
} from "@xyflow/react";
import {
  ArrowsCounterClockwise,
  CheckCircle,
  FlowArrow,
  WarningCircle,
} from "@phosphor-icons/react";
import { api, type EngineeringWorkflow } from "./api";
import {
  defaultWorkflow,
  sequenceWorkflow,
  stepLabels,
  validateWorkflow,
} from "./workflowModel";
type ProcessNode = Node<{ label: string; gate: boolean }, "process">;
function Process({ data }: NodeProps<ProcessNode>) {
  return (
    <div className={`process-node ${data.gate ? "review-gate" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <strong>{data.label}</strong>
      <small>{data.gate ? "核对通过才能继续" : "固定步骤 · 可拖动位置"}</small>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { process: Process };
export default function WorkflowEditor({
  value,
  onChange,
  locked,
  defaultValue,
}: {
  value: EngineeringWorkflow;
  onChange: (graph: EngineeringWorkflow) => void;
  locked: boolean;
  defaultValue?: EngineeringWorkflow;
}) {
  const [expanded, setExpanded] = useState(false);
  const [serverMessage, setServerMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const validation = validateWorkflow(value);
  const order = validation.order;
  const nodes = useMemo<ProcessNode[]>(
    () =>
      value.nodes.map((n) => ({
        id: n.id,
        type: "process",
        position: n.position,
        data: { label: stepLabels[n.type], gate: n.type === "review" },
        deletable: false,
      })),
    [value.nodes],
  );
  const edges = useMemo<Edge[]>(
    () =>
      value.edges.map((e, i) => ({
        ...e,
        id: e.id || `${e.source}-${e.target}-${i}`,
        selected: selectedEdge === (e.id || `${e.source}-${e.target}-${i}`),
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, color: "#ec563a" },
        style: {
          stroke: "#ec563a",
          strokeWidth:
            selectedEdge === (e.id || `${e.source}-${e.target}-${i}`) ? 3 : 1.4,
        },
      })),
    [value.edges, selectedEdge],
  );
  const change = (graph: EngineeringWorkflow) => {
    setServerMessage("");
    onChange(graph);
  };
  const check = async () => {
    setChecking(true);
    setServerMessage("");
    try {
      const response = await api<{ workflow: EngineeringWorkflow }>(
        "/workflow/validate",
        value,
      );
      onChange(response.workflow);
      setServerMessage("后台检查通过。保存后，执行程序会按这份连线安排顺序。");
    } catch (e) {
      setServerMessage((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  return (
    <section className="workflow-editor">
      <div className="section-intro">
        <div>
          <h3>
            <FlowArrow size={18} /> 工程流程
          </h3>
          <p>连线决定先后，拖动只改变位置。审核和必要检查不能跳过。</p>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起流程图" : "编辑流程图"}
        </button>
      </div>
      <div
        className={`workflow-validation ${validation.error ? "invalid" : "valid"}`}
        role={validation.error ? "alert" : undefined}
      >
        {validation.error ? (
          <WarningCircle size={18} />
        ) : (
          <CheckCircle size={18} />
        )}
        <span>
          {validation.error || "十个必要步骤已连通，可保存并交给后台核对。"}
        </span>
      </div>
      {!validation.error && (
        <ol className="workflow-order">
          {order.map((id) => (
            <li key={id}>{stepLabels[id] || id}</li>
          ))}
        </ol>
      )}
      {expanded && (
        <>
          <div className="workflow-editor-toolbar">
            <label>
              编译先后
              <select
                aria-label="编译先后"
                disabled={locked}
                value={
                  order.indexOf("esp_build") < order.indexOf("ros_build")
                    ? "esp"
                    : "ros"
                }
                onChange={(e) =>
                  change(
                    sequenceWorkflow(
                      value,
                      e.target.value === "esp",
                      order.indexOf("simulation") <
                        order.indexOf("communication"),
                    ),
                  )
                }
              >
                <option value="ros">先 ROS，再 ESP32</option>
                <option value="esp">先 ESP32，再 ROS</option>
              </select>
            </label>
            <label>
              检查先后
              <select
                aria-label="检查先后"
                disabled={locked}
                value={
                  order.indexOf("simulation") < order.indexOf("communication")
                    ? "simulation"
                    : "communication"
                }
                onChange={(e) =>
                  change(
                    sequenceWorkflow(
                      value,
                      order.indexOf("esp_build") < order.indexOf("ros_build"),
                      e.target.value === "simulation",
                    ),
                  )
                }
              >
                <option value="communication">先通信，再仿真</option>
                <option value="simulation">先仿真，再通信</option>
              </select>
            </label>
            <button
              className="button secondary"
              disabled={locked}
              onClick={() =>
                change(structuredClone(defaultValue || defaultWorkflow()))
              }
            >
              <ArrowsCounterClockwise size={16} />
              恢复默认
            </button>
            <button
              className="button secondary"
              disabled={locked || checking || !!validation.error}
              onClick={() => void check()}
            >
              {checking ? "正在检查…" : "后台核对连线"}
            </button>
          </div>
          <div className="workflow-edit-canvas" aria-label="可编辑工程流程图">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.12 }}
              minZoom={0.35}
              maxZoom={1.6}
              colorMode="dark"
              nodesDraggable={!locked}
              nodesConnectable={!locked}
              edgesReconnectable={false}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
              onNodesChange={(changes) => {
                if (locked) return;
                const updated = applyNodeChanges(
                  changes.filter((c) => c.type === "position"),
                  nodes,
                );
                if (changes.some((c) => c.type === "position"))
                  change({
                    schema_version: 1,
                    nodes: value.nodes.map((n) => ({
                      ...n,
                      position: updated.find((u) => u.id === n.id)!.position,
                    })),
                    edges: value.edges,
                  });
              }}
              onConnect={(connection) => {
                if (locked || !connection.source || !connection.target) return;
                if (
                  value.edges.some(
                    (e) =>
                      e.source === connection.source &&
                      e.target === connection.target,
                  )
                ) {
                  setServerMessage("这两个步骤已经连在一起了。");
                  return;
                }
                change({
                  schema_version: 1,
                  nodes: value.nodes,
                  edges: [
                    ...value.edges,
                    {
                      id: `${connection.source}-${connection.target}`,
                      source: connection.source,
                      target: connection.target,
                    },
                  ],
                });
              }}
              onEdgeClick={(_, edge) => setSelectedEdge(edge.id)}
              onPaneClick={() => setSelectedEdge(null)}
            >
              <Background
                variant={BackgroundVariant.Dots}
                color="#31383d"
                gap={22}
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <div className="workflow-edit-help">
            <span>拖动圆点连线；点选线后可移除。拖动画布空白处平移，手机可双指缩放。</span>
            <button
              className="button secondary"
              disabled={locked || !selectedEdge}
              onClick={() => {
                change({
                  schema_version: 1,
                  nodes: value.nodes,
                  edges: value.edges.filter(
                    (_, i) => edges[i].id !== selectedEdge,
                  ),
                });
                setSelectedEdge(null);
              }}
            >
              移除选中连线
            </button>
          </div>
        </>
      )}
      {serverMessage && <div className="notice">{serverMessage}</div>}
    </section>
  );
}
