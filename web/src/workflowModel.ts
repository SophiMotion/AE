import type { EngineeringWorkflow, WorkflowStep } from "./api";
export const workflowSteps: WorkflowStep[] = [
  "requirements",
  "rag",
  "plan",
  "review",
  "generate",
  "ros_build",
  "esp_build",
  "communication",
  "simulation",
  "report",
];
export const stepLabels: Record<string, string> = {
  requirements: "需求与设备",
  rag: "查开发资料",
  plan: "AI 拆分工作",
  review: "人工核对",
  generate: "生成两端代码",
  ros_build: "编译 ROS",
  esp_build: "编译 ESP32",
  communication: "检查两端通信",
  simulation: "所选关节仿真",
  report: "汇总结果",
};
export function defaultWorkflow(): EngineeringWorkflow {
  return {
    schema_version: 1,
    nodes: workflowSteps.map((type, i) => ({
      id: type,
      type,
      position: { x: (i % 5) * 220, y: Math.floor(i / 5) * 160 },
    })),
    edges: workflowSteps
      .slice(1)
      .map((target, i) => ({
        id: `${workflowSteps[i]}-${target}`,
        source: workflowSteps[i],
        target,
      })),
  };
}
export function validateWorkflow(graph: EngineeringWorkflow): {
  error: string;
  order: string[];
} {
  const ids = graph.nodes.map((n) => n.id);
  if (
    ids.length !== 10 ||
    new Set(ids).size !== 10 ||
    workflowSteps.some((id) => !ids.includes(id)) ||
    graph.nodes.some((n) => n.id !== n.type)
  )
    return { error: "十个必要步骤都要保留，每个步骤只能出现一次。", order: [] };
  if (
    graph.edges.some(
      (e) =>
        !ids.includes(e.source as WorkflowStep) ||
        !ids.includes(e.target as WorkflowStep),
    )
  )
    return { error: "有一条连线的步骤不存在，请移除这条线。", order: [] };
  const adjacent = new Map<string, string[]>(ids.map((id) => [id, []]));
  const degree = new Map<string, number>(ids.map((id) => [id, 0]));
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (e.source === e.target)
      return { error: "步骤不能连回自己。", order: [] };
    const key = `${e.source}:${e.target}`;
    if (seen.has(key))
      return { error: "两个步骤之间保留一条连线即可。", order: [] };
    seen.add(key);
    adjacent.get(e.source)!.push(e.target);
    degree.set(e.target, degree.get(e.target)! + 1);
  }
  const order: string[] = [];
  while (order.length < ids.length) {
    const next = workflowSteps.find(
      (id) => !order.includes(id) && degree.get(id) === 0,
    );
    if (!next)
      return {
        error: "连线绕成了圈，请移除反向连线，让流程从需求走向结果。",
        order: [],
      };
    order.push(next);
    for (const to of adjacent.get(next)!) degree.set(to, degree.get(to)! - 1);
  }
  const reaches = (start: string, target: string): boolean => {
    const pending = [start],
      visited = new Set<string>();
    while (pending.length) {
      const at = pending.pop()!;
      if (at === target) return true;
      if (visited.has(at)) continue;
      visited.add(at);
      pending.push(...adjacent.get(at)!);
    }
    return false;
  };
  const required = [
    ["requirements", "rag"],
    ["rag", "plan"],
    ["plan", "review"],
    ["review", "generate"],
    ["generate", "ros_build"],
    ["generate", "esp_build"],
    ...["ros_build", "esp_build"].flatMap((build) =>
      ["communication", "simulation"].map((check) => [build, check]),
    ),
    ["communication", "report"],
    ["simulation", "report"],
  ];
  for (const [before, after] of required)
    if (!reaches(before, after))
      return {
        error: `“${stepLabels[after]}”之前必须完成“${stepLabels[before]}”，请补好连线。`,
        order: [],
      };
  return { error: "", order };
}
export function sequenceWorkflow(
  graph: EngineeringWorkflow,
  espFirst: boolean,
  simulationFirst: boolean,
): EngineeringWorkflow {
  const order = [
    ...workflowSteps.slice(0, 5),
    ...(espFirst ? ["esp_build", "ros_build"] : ["ros_build", "esp_build"]),
    ...(simulationFirst
      ? ["simulation", "communication"]
      : ["communication", "simulation"]),
    "report",
  ];
  return {
    schema_version: 1,
    nodes: graph.nodes,
    edges: order
      .slice(1)
      .map((target, i) => ({
        id: `${order[i]}-${target}`,
        source: order[i],
        target,
      })),
  };
}
