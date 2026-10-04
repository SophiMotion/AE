import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Handle,
  Position,
  MarkerType,
  type NodeProps,
  type Node,
  type Edge,
} from "@xyflow/react";
import { ArrowCounterClockwise, Check } from "@phosphor-icons/react";
import type { Status } from "./api";

const steps = [
  ["机器人与需求", "明确任务与硬件"],
  ["环境与检查", "核对拆分和通信"],
  ["程序生成", "生成 ROS 与 ESP32 工程"],
  ["运行与评估", "编译、运行、修改"],
];
type StageNode = Node<
  {
    index: number;
    selected: boolean;
    current: number;
    onSelect: (n: number) => void;
    title: string;
    description: string;
  },
  "stage"
>;
function Stage({ data }: NodeProps<StageNode>) {
  return (
    <button
      className={`flow-stage ${data.selected ? "selected" : ""} ${data.current > data.index ? "completed" : ""}`}
      onClick={() => data.onSelect(data.index)}
      aria-pressed={data.selected}
    >
      <Handle type="target" position={Position.Left} />
      <span className="step-number">
        {data.current > data.index ? (
          <Check size={22} />
        ) : (
          String(data.index + 1).padStart(2, "0")
        )}
      </span>
      <span>
        <strong>{data.title}</strong>
        <small>{data.description}</small>
      </span>
      <Handle type="source" position={Position.Right} />
    </button>
  );
}
const nodeTypes = { stage: Stage };
function currentStage(status: Status, hasPlan: boolean, hasResult: boolean) {
  if (!hasPlan) return 0;
  if (status === "draft" || status === "planning") return 0;
  if (status === "awaiting_approval" || status === "approved") return 1;
  if (["queued", "generating", "building", "repairing"].includes(status))
    return 2;
  if (["failed", "cancelled", "interrupted"].includes(status))
    return hasResult ? 3 : 2;
  return 3;
}
export default function Workflow({
  selected,
  status,
  onSelect,
  hasPlan,
  hasResult,
}: {
  selected: number;
  status: Status;
  onSelect: (n: number) => void;
  hasPlan: boolean;
  hasResult: boolean;
}) {
  const current = currentStage(status, hasPlan, hasResult);
  const container = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver((entries) => {
      setCanvasWidth(Math.round(entries[0].contentRect.width));
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const nodes = useMemo<StageNode[]>(
    () =>
      steps.map(([title, description], index) => ({
        id: String(index),
        type: "stage",
        position: { x: index * 290, y: 8 },
        data: {
          index,
          title,
          description,
          selected: selected === index,
          current,
          onSelect,
        },
        draggable: false,
        selectable: false,
      })),
    [selected, current, onSelect],
  );
  const edges = useMemo<Edge[]>(
    () =>
      [0, 1, 2].map((index) => ({
        id: `${index}-${index + 1}`,
        source: String(index),
        target: String(index + 1),
        type: "straight",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: index < current ? "#ec563a" : "#626d75",
        },
        style: {
          stroke: index < current ? "#ec563a" : "#626d75",
          strokeWidth: 1.5,
        },
      })),
    [current],
  );
  return (
    <section className="workflow" aria-label="工程流程">
      <div className="flow-scroll">
        <div className="flow-canvas" ref={container}>
          <ReactFlow
            key={canvasWidth}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.015 }}
            nodesDraggable={false}
            nodesConnectable={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            panOnDrag={false}
            panOnScroll={false}
            preventScrolling={false}
            minZoom={0.5}
            maxZoom={1.3}
            proOptions={{ hideAttribution: true }}
          />
        </div>
      </div>
      <div className="feedback-caption">
        <ArrowCounterClockwise size={14} />
        <span>根据检查结果修改，再跑一遍</span>
      </div>
    </section>
  );
}
