import type { FoldBotDraft } from "./foldbotApi.ts";
import type { GuidedConfig } from "./guidedFlow.ts";

export type ProjectStage = "requirements" | "hardware" | "wiring" | "preview" | "program" | "deploy" | "control";
export const PROJECT_STAGES: { id: ProjectStage; label: string; labelEn: string }[] = [
  { id: "requirements", label: "说明需求", labelEn: "Requirements" },
  { id: "hardware", label: "选择硬件", labelEn: "Hardware" },
  { id: "wiring", label: "生成接线", labelEn: "Wiring" },
  { id: "preview", label: "仿真预览", labelEn: "Preview" },
  { id: "program", label: "生成程序", labelEn: "Program" },
  { id: "deploy", label: "部署程序", labelEn: "Deploy" },
  { id: "control", label: "机器人控制", labelEn: "Control" },
];
export type HardwareComponentId = "controller" | "fold-driver-1" | "fold-driver-2" | "arm-bus" | "chassis-left" | "chassis-right" | "custom";
export interface HardwarePort {
  id: string; label: string; labelEn: string;
  signal: "digital" | "ground" | "uart" | "motor";
  direction: "in" | "out" | "bidirectional";
}
export interface HardwareCatalogItem {
  id: HardwareComponentId; label: string; labelEn: string;
  description: string; descriptionEn: string; ports: HardwarePort[];
}
const port = (id: string, label: string, labelEn: string, signal: HardwarePort["signal"], direction: HardwarePort["direction"]): HardwarePort => ({ id, label, labelEn, signal, direction });
const driverPorts = (): HardwarePort[] => [
  ...["DIR", "PUL", "ENA"].map((name) => port(`${name.toLowerCase()}+`, `${name}+`, `${name}+`, "digital", "in")),
  ...["DIR", "PUL", "ENA"].map((name) => port(`${name.toLowerCase()}-`, `${name}-`, `${name}-`, "ground", "bidirectional")),
];
export const HARDWARE_CATALOG: HardwareCatalogItem[] = [
  { id: "controller", label: "Sophicar ESP32-S3", labelEn: "Sophicar ESP32-S3", description: "既有源码端口；GPIO35–37 与 N16R8 存储器兼容性待确认。M1/M2 为扩展板电机端子。", descriptionEn: "Existing source ports. GPIO35–37 / N16R8 compatibility is unresolved. M1/M2 are expansion-board motor terminals.", ports: [
    ...[3, 8, 10, 4, 5, 9].map((pin) => port(`gpio${pin}`, `GPIO${pin}`, `GPIO${pin}`, "digital", "out")),
    port("gpio6", "GPIO6 TX", "GPIO6 TX", "uart", "out"), port("gpio7", "GPIO7 RX", "GPIO7 RX", "uart", "in"),
    port("gnd", "逻辑 GND", "Logic GND", "ground", "bidirectional"),
    port("m1", "M1 双线端子", "M1 two-wire terminal", "motor", "out"), port("m2", "M2 双线端子", "M2 two-wire terminal", "motor", "out"),
  ] },
  ...([1, 2] as const).map((axis): HardwareCatalogItem => ({ id: `fold-driver-${axis}`, label: `折叠板 ${axis} 外置驱动`, labelEn: `Fold plate ${axis} external driver`, description: "STEP/DIR 控制；具体型号、电流、动力电源与线圈接法待现场核对。", descriptionEn: "STEP/DIR control; verify model, current, motor supply and coil wiring on site.", ports: driverPorts() })),
  { id: "arm-bus", label: "BusLinker + HX 总线舵机", labelEn: "BusLinker + HX bus servos", description: "使用 TTL RX/TX/GND，舵机独立供电；波特率待核对。", descriptionEn: "TTL RX/TX/GND, separate servo supply; confirm the baud rate.", ports: [port("rx", "TTL RX", "TTL RX", "uart", "in"), port("tx", "TTL TX", "TTL TX", "uart", "out"), port("gnd", "TTL GND", "TTL GND", "ground", "bidirectional")] },
  ...(["left", "right"] as const).map((side): HardwareCatalogItem => ({ id: `chassis-${side}`, label: `${side === "left" ? "左" : "右"}履带电机`, labelEn: `${side === "left" ? "Left" : "Right"} track motor`, description: "双线电机连接；实际极性与方向须现场核对。", descriptionEn: "Two-wire motor connection; verify physical polarity and direction.", ports: [port("motor", "电机双线", "Motor wire pair", "motor", "in")] })),
  { id: "custom", label: "待适配元件", labelEn: "Unadapted component", description: "可记录名称；没有可信端口定义，不生成适配代码。", descriptionEn: "Record a name; no trusted port definition or adapted code generation.", ports: [] },
];
export interface HardwareGraphNode { id: string; component: HardwareComponentId; label: string; }
export interface HardwareGraphEdge { id: string; source: string; sourcePort: string; target: string; targetPort: string; }
export interface WiringGraph { nodes: HardwareGraphNode[]; edges: HardwareGraphEdge[]; }
export type BehaviorGraphNode =
  | { id: string; kind: "stage"; stage: ProjectStage }
  | { id: string; kind: "action"; ref: "workflow.action_group" }
  | { id: string; kind: "condition"; check: "requirements_ready" | "wiring_reviewed" };
export interface BehaviorGraphEdge { id: string; source: string; sourcePort: string; target: string; targetPort: string; }
export interface BehaviorGraph { nodes: BehaviorGraphNode[]; edges: BehaviorGraphEdge[]; }
export interface ProjectGraphs { schema_version: 1; wiring: WiringGraph; behavior: BehaviorGraph; }
export interface GraphIssue { scope: "wiring" | "behavior"; code: string; message: string; messageEn: string; nodeId?: string; edgeId?: string; }
/** Layout belongs to browser/editor state, never a generation binding. */
export type ProjectGraphLayout = Record<string, { x: number; y: number }>;

const knownComponents = HARDWARE_CATALOG.filter((c) => c.id !== "custom").map((c) => c.id);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v) && v.trim() === v && v.length <= 80;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !v.includes("\0");
const endpoint = (v: unknown): v is string => text(v, 64) && v.length > 0 && v.trim() === v && /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(v);
function validEdges(value: unknown): value is HardwareGraphEdge[] {
  return Array.isArray(value) && value.length <= 160 && value.every((e) => exact(e, ["id", "source", "sourcePort", "target", "targetPort"]) && identifier(e.id) && identifier(e.source) && identifier(e.target) && endpoint(e.sourcePort) && endpoint(e.targetPort)) && new Set(value.map((e) => e.id)).size === value.length;
}
export function validateProjectGraphs(value: unknown): value is ProjectGraphs {
  if (!exact(value, ["schema_version", "wiring", "behavior"]) || value.schema_version !== 1 || !exact(value.wiring, ["nodes", "edges"]) || !exact(value.behavior, ["nodes", "edges"])) return false;
  const { wiring: w, behavior: b } = value;
  if (!Array.isArray(w.nodes) || w.nodes.length > 64 || !w.nodes.every((n) => exact(n, ["id", "component", "label"]) && identifier(n.id) && HARDWARE_CATALOG.some((c) => c.id === n.component) && text(n.label, 120))) return false;
  if (!Array.isArray(b.nodes) || b.nodes.length > 64 || !b.nodes.every((n) => {
    if (!n || typeof n !== "object" || !identifier(n.id)) return false;
    if (n.kind === "stage") return exact(n, ["id", "kind", "stage"]) && PROJECT_STAGES.some((s) => s.id === n.stage);
    if (n.kind === "action") return exact(n, ["id", "kind", "ref"]) && n.ref === "workflow.action_group";
    return n.kind === "condition" && exact(n, ["id", "kind", "check"]) && ["requirements_ready", "wiring_reviewed"].includes(n.check as string);
  })) return false;
  return new Set(w.nodes.map((n) => n.id)).size === w.nodes.length && new Set(b.nodes.map((n) => n.id)).size === b.nodes.length && validEdges(w.edges) && validEdges(b.edges);
}
export function normalizeProjectGraphs(value: unknown): ProjectGraphs {
  if (!validateProjectGraphs(value)) throw new Error("invalid_project_graphs");
  return JSON.parse(JSON.stringify(value)) as ProjectGraphs;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sortCanonical = <T,>(items: T[]): T[] => items.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
export function normalizedWiringKey(wiring: WiringGraph): string {
  const nodes = sortCanonical(wiring.nodes.map(({ id, component }) => ({ id, component })));
  const edges = sortCanonical(wiring.edges.map((e) => sortCanonical([{ node: e.source, port: e.sourcePort }, { node: e.target, port: e.targetPort }])));
  return canonical({ nodes, edges });
}
export function normalizedProjectGraphsKey(graphs: ProjectGraphs): string {
  const value = normalizeProjectGraphs(graphs);
  value.wiring.nodes.sort((a, b) => a.id.localeCompare(b.id, "en"));
  value.wiring.edges.sort((a, b) => a.id.localeCompare(b.id, "en"));
  value.behavior.nodes.sort((a, b) => a.id.localeCompare(b.id, "en"));
  value.behavior.edges.sort((a, b) => a.id.localeCompare(b.id, "en"));
  return canonical(value);
}

type SourceConnection = [HardwareComponentId, string, HardwareComponentId, string];
export const FOLDBOT_GRAPH_CONNECTIONS: SourceConnection[] = [
  ["controller", "gpio3", "fold-driver-1", "dir+"], ["controller", "gpio8", "fold-driver-1", "pul+"], ["controller", "gpio10", "fold-driver-1", "ena+"],
  ["controller", "gpio4", "fold-driver-2", "dir+"], ["controller", "gpio5", "fold-driver-2", "pul+"], ["controller", "gpio9", "fold-driver-2", "ena+"],
  ...(["fold-driver-1", "fold-driver-2"] as const).flatMap((axis) => ["dir-", "pul-", "ena-"].map((p): SourceConnection => ["controller", "gnd", axis, p])),
  ["controller", "gpio6", "arm-bus", "rx"], ["controller", "gpio7", "arm-bus", "tx"], ["controller", "gnd", "arm-bus", "gnd"],
  ["controller", "m1", "chassis-left", "motor"], ["controller", "m2", "chassis-right", "motor"],
];
const connectionKey = (a: string, ap: string, b: string, bp: string) => canonical(sortCanonical([{ node: a, port: ap }, { node: b, port: bp }]));
function sourceEdges(nodes: HardwareGraphNode[]): HardwareGraphEdge[] {
  return FOLDBOT_GRAPH_CONNECTIONS.flatMap(([a, ap, b, bp], index) => {
    const source = nodes.find((n) => n.component === a), target = nodes.find((n) => n.component === b);
    return source && target ? [{ id: `wire-${index + 1}`, source: source.id, sourcePort: ap, target: target.id, targetPort: bp }] : [];
  });
}
export function defaultProjectGraphs(draft: Pick<FoldBotDraft, "guided">): ProjectGraphs {
  const nodes: HardwareGraphNode[] = [];
  const add = (role: HardwareComponentId, selected: string | undefined, known: string) => {
    if (!selected || selected === "unselected") return;
    const item = HARDWARE_CATALOG.find((c) => c.id === role)!;
    nodes.push({ id: `hw-${role}`, component: selected === known ? role : "custom", label: selected === known ? item.label : `待适配：${item.label}` });
  };
  if (draft.guided?.robot_choice === "foldbot") {
    const h = draft.guided.hardware;
    add("controller", h.controller, "sophicar-s3"); add("fold-driver-1", h.fold_driver, "external-step-dir"); add("fold-driver-2", h.fold_driver, "external-step-dir");
    add("arm-bus", h.arm_bus, "buslinker-hx"); add("chassis-left", h.chassis, "sophicar-m1-m2"); add("chassis-right", h.chassis, "sophicar-m1-m2");
  }
  return { schema_version: 1, wiring: { nodes, edges: sourceEdges(nodes) }, behavior: {
    nodes: PROJECT_STAGES.map(({ id }) => ({ id: `stage-${id}`, kind: "stage", stage: id })),
    edges: PROJECT_STAGES.slice(0, -1).map(({ id }, i) => ({ id: `flow-${id}`, source: `stage-${id}`, sourcePort: "next", target: `stage-${PROJECT_STAGES[i + 1].id}`, targetPort: "in" })),
  } };
}

export function recommendedHardwareWiring(): WiringGraph {
  return defaultProjectGraphs({ guided: {
    schema_version: 1, robot_choice: "foldbot", purpose: "", primary_task: "unselected", wiring_binding_sha256: null,
    hardware: { controller: "sophicar-s3", fold_driver: "external-step-dir", arm_bus: "buslinker-hx", chassis: "sophicar-m1-m2", notes: "" },
  } }).wiring;
}
export function hardwareSelectionFromGraph(wiring: WiringGraph, current: GuidedConfig["hardware"]): GuidedConfig["hardware"] {
  const selected = (roles: HardwareComponentId[], known: string) => {
    if (wiring.nodes.some((n) => roles.includes(n.component))) return known;
    if (wiring.nodes.some((n) => n.component === "custom" && roles.some((role) => n.id === `hw-${role}`))) return "other";
    return "unselected";
  };
  return { ...current,
    controller: selected(["controller"], "sophicar-s3") as GuidedConfig["hardware"]["controller"],
    fold_driver: selected(["fold-driver-1", "fold-driver-2"], "external-step-dir") as GuidedConfig["hardware"]["fold_driver"],
    arm_bus: selected(["arm-bus"], "buslinker-hx") as GuidedConfig["hardware"]["arm_bus"],
    chassis: selected(["chassis-left", "chassis-right"], "sophicar-m1-m2") as GuidedConfig["hardware"]["chassis"],
  };
}

export function reconcileGraphsFromForm(previousDraft: FoldBotDraft, nextDraft: FoldBotDraft): ProjectGraphs {
  const existing = previousDraft.graphs ? normalizeProjectGraphs(previousDraft.graphs) : defaultProjectGraphs(previousDraft);
  const previous = previousDraft.guided, next = nextDraft.guided;
  const defaults = defaultProjectGraphs(nextDraft);
  if (previous?.robot_choice !== next?.robot_choice) return { ...existing, wiring: defaults.wiring };
  const affected = new Set<HardwareComponentId>();
  for (const [field, roles] of Object.entries({ controller: ["controller"], fold_driver: ["fold-driver-1", "fold-driver-2"], arm_bus: ["arm-bus"], chassis: ["chassis-left", "chassis-right"] })) {
    if (previous?.hardware[field as keyof typeof previous.hardware] !== next?.hardware[field as keyof typeof next.hardware]) roles.forEach((r) => affected.add(r as HardwareComponentId));
  }
  if (!affected.size) return existing;
  const removed = new Set(existing.wiring.nodes.filter((n) => affected.has(n.component) || [...affected].some((role) => n.id === `hw-${role}`)).map((n) => n.id));
  const newNodes = defaults.wiring.nodes.filter((n) => [...affected].some((role) => n.id === `hw-${role}`));
  const nodes = [...existing.wiring.nodes.filter((n) => !removed.has(n.id)), ...newNodes];
  const addedIds = new Set(newNodes.map((n) => n.id));
  const preservedEdges = existing.wiring.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
  const used = new Set(preservedEdges.map((e) => e.id));
  const addedEdges = sourceEdges(nodes).filter((e) => addedIds.has(e.source) || addedIds.has(e.target)).map((e) => {
    let id = e.id; for (let n = 1; used.has(id); n++) id = `${e.id}-${n}`; used.add(id); return { ...e, id };
  });
  return { ...existing, wiring: { nodes, edges: [...preservedEdges, ...addedEdges] } };
}

export function validateHardwareConnection(wiring: WiringGraph, edge: HardwareGraphEdge): GraphIssue[] {
  const issue = (code: string, message: string, messageEn: string): GraphIssue[] => [{ scope: "wiring", code, message, messageEn, edgeId: edge.id }];
  const source = wiring.nodes.find((n) => n.id === edge.source), target = wiring.nodes.find((n) => n.id === edge.target);
  if (!source || !target) return issue("missing_endpoint", "连线引用了不存在的元件。", "A wire refers to a missing component.");
  if (source.id === target.id) return issue("self_connection", "不能连接元件自身的端口。", "A component cannot be wired to itself.");
  const sp = HARDWARE_CATALOG.find((c) => c.id === source.component)?.ports.find((p) => p.id === edge.sourcePort), tp = HARDWARE_CATALOG.find((c) => c.id === target.component)?.ports.find((p) => p.id === edge.targetPort);
  if (!sp || !tp) return issue("unknown_port", "端口没有适配定义，请核对硬件。", "A port has no supported definition; check the hardware.");
  if (sp.signal !== tp.signal || (sp.direction === "out" && tp.direction === "out")) return issue("port_mismatch", "信号类型或方向不匹配。", "Signal types or directions do not match.");
  const key = connectionKey(source.component, sp.id, target.component, tp.id);
  if (!FOLDBOT_GRAPH_CONNECTIONS.some(([a, ap, b, bp]) => connectionKey(a, ap, b, bp) === key)) return issue("unadapted_connection", "此接法尚未适配，不能套用原固件引脚。", "This connection is not adapted to the existing firmware pinout.");
  return [];
}
export function validateGraphReadiness(graphs: ProjectGraphs): GraphIssue[] {
  if (!validateProjectGraphs(graphs)) return [{ scope: "wiring", code: "invalid_project_graphs", message: "图数据格式无效。", messageEn: "Invalid graph data." }];
  const issues: GraphIssue[] = [];
  const add = (scope: GraphIssue["scope"], code: string, message: string, messageEn: string, nodeId?: string, edgeId?: string) => issues.push({ scope, code, message, messageEn, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) });
  const w = graphs.wiring;
  for (const role of knownComponents) {
    if (w.nodes.filter((n) => n.component === role).length !== 1) add("wiring", "required_component", `需要且只允许一个 ${role}。`, `Exactly one ${role} is required.`);
  }
  w.nodes.filter((n) => n.component === "custom").forEach((n) => add("wiring", "unadapted_component", "元件尚未适配。", "The component is not adapted.", n.id));
  const wireKeys = new Set<string>();
  for (const edge of w.edges) {
    issues.push(...validateHardwareConnection(w, edge));
    const key = connectionKey(edge.source, edge.sourcePort, edge.target, edge.targetPort);
    if (wireKeys.has(key)) add("wiring", "duplicate_connection", "相同端口对重复连线。", "The same port pair is wired more than once.", undefined, edge.id);
    wireKeys.add(key);
  }
  for (const expected of sourceEdges(w.nodes)) if (!wireKeys.has(connectionKey(expected.source, expected.sourcePort, expected.target, expected.targetPort))) add("wiring", "missing_connection", "缺少源码要求的连接。", "A connection required by the source is missing.", undefined, expected.id);
  const b = graphs.behavior;
  const stageNodes = PROJECT_STAGES.map((stage) => b.nodes.filter((n) => n.kind === "stage" && n.stage === stage.id));
  stageNodes.forEach((nodes, i) => { if (nodes.length !== 1) add("behavior", "required_stage", `需要且只允许一个${PROJECT_STAGES[i].label}阶段。`, `Exactly one ${PROJECT_STAGES[i].labelEn} stage is required.`); });
  for (const edge of b.edges) {
    const from = b.nodes.find((n) => n.id === edge.source), to = b.nodes.find((n) => n.id === edge.target);
    if (!from || !to) add("behavior", "missing_endpoint", "流程连线引用了不存在的节点。", "A flow edge refers to a missing node.", undefined, edge.id);
    else if (edge.source === edge.target || edge.sourcePort !== (from.kind === "condition" ? "true" : "next") || edge.targetPort !== "in") add("behavior", "invalid_flow_port", "连线端口无效；条件不满足时流程暂停。", "Invalid ports; a false condition pauses the workflow.", undefined, edge.id);
  }
  for (const node of b.nodes) {
    const ins = b.edges.filter((e) => e.target === node.id).length, outs = b.edges.filter((e) => e.source === node.id).length;
    const start = node.kind === "stage" && node.stage === "requirements", end = node.kind === "stage" && node.stage === "control";
    if (ins !== (start ? 0 : 1) || outs !== (end ? 0 : 1)) add("behavior", "incomplete_flow", "流程必须完整连接，不能跳步、并行或循环。", "Connect a complete workflow without skipped stages, parallel branches or cycles.", node.id);
  }
  if (stageNodes.every((nodes) => nodes.length === 1)) {
    const path: BehaviorGraphNode[] = [], visited = new Set<string>();
    let node: BehaviorGraphNode | undefined = stageNodes[0][0];
    while (node && !visited.has(node.id)) { path.push(node); visited.add(node.id); const e = b.edges.find((edge) => edge.source === node!.id); node = e ? b.nodes.find((n) => n.id === e.target) : undefined; }
    if (node || visited.size !== b.nodes.length) add("behavior", "cycle_or_disconnected", "流程含循环或未连接节点。", "The workflow contains a cycle or disconnected nodes.");
    const stageOrder = path.filter((n) => n.kind === "stage").map((n) => n.stage);
    if (stageOrder.join(",") !== PROJECT_STAGES.map((s) => s.id).join(",")) add("behavior", "stage_order", "七个工程阶段必须按需求到控制的依赖顺序连接。", "The seven stages must follow their requirements-to-control dependency order.");
    for (const [index, n] of path.entries()) {
      if (n.kind === "stage") continue;
      const before = path.slice(0, index).filter((p) => p.kind === "stage").at(-1);
      const after = path.slice(index + 1).find((p) => p.kind === "stage");
      const pair = n.kind === "action" ? ["preview", "program"] : n.check === "requirements_ready" ? ["requirements", "hardware"] : ["wiring", "preview"];
      if (before?.kind !== "stage" || after?.kind !== "stage" || before.stage !== pair[0] || after.stage !== pair[1]) add("behavior", "node_position", "此节点只能放在它对应的工程阶段之间。", "Place this node between its corresponding workflow stages.", n.id);
    }
  }
  if (b.nodes.filter((n) => n.kind === "action").length > 1) add("behavior", "duplicate_action", "当前流程只引用一个共享动作预览组。", "This workflow references one shared action preview group.");
  for (const check of ["requirements_ready", "wiring_reviewed"]) if (b.nodes.filter((n) => n.kind === "condition" && n.check === check).length > 1) add("behavior", "duplicate_condition", "相同工程条件不能重复。", "A workflow condition cannot be duplicated.");
  return issues;
}
