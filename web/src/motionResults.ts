import type { Check } from "./api";

const stopCases: Record<string, string> = {
  command_loss: "停止发送指令",
  measurement_loss: "停止反馈测量",
  cancel: "中途取消",
};
export function motionCaseSummary(name: string, checks: Check[]) {
  const normal = /^motion_([1-3])$/.exec(name);
  const label = normal
    ? `正常动作 ${normal[1]}`
    : stopCases[name] || `其他检查：${name || "未记录"}`;
  const kind = normal ? "normal" : stopCases[name] ? "stop" : "unknown";
  const related = name
    ? checks.filter((check) => check.name.startsWith(`${name}_`))
    : [];
  const passed = related.length
    ? related.every((check) => check.passed === true)
    : null;
  const outcome =
    kind === "normal"
      ? passed === true
        ? "实际到位与往返次数检查通过"
        : passed === false
          ? "正常动作检查未通过，查看下面的实际记录"
          : "缺少本场景检查记录，尚未验证"
      : kind === "stop"
        ? passed === true
          ? "按计划中断，停机/取消检查通过"
          : passed === false
            ? "停机/取消检查未通过，查看下面的检查原因"
            : "缺少停机/取消检查记录，尚未验证"
        : passed === true
          ? "本场景检查通过"
          : passed === false
            ? "本场景检查未通过"
            : "缺少本场景检查记录";
  return { name, label, kind, checks: related, passed, outcome };
}

const checkLabels: Record<string, string> = {
  observed_all_channels: "收到全部参与关节的实际反馈",
  no_runtime_errors: "没有非预期的运行错误",
  action_identity: "执行事件与本轮冻结规格一致",
  gazebo_backend_loaded: "物理仿真正常启动",
  same_core_feedback: "固件核心反馈对应实际仿真测量",
  gazebo_measurement_path: "各通道测量值对应实际仿真记录",
  simulator_roundoff_only: "仿真边界只作允许的数值精度处理",
  measured_velocity_bound: "实际测得的关节速度符合约定上限",
  core_actuator_path: "仿真执行器采用固件核心批准的输出",
  velocity_bound: "各关节速度符合约定上限",
  acceleration_bound: "各关节加速度符合约定上限",
  jtc_succeeded: "轨迹控制器报告完成",
  all_waypoints: "全部姿势实际到位",
  all_cycles: "实际完成约定的往返次数",
  final_pose: "全部参与关节到达最后姿势",
  watchdog_zero: "中断后所有控制通道停止输出",
  simulator_stopped: "实际仿真关节停稳",
  action_cancelled: "轨迹控制器响应取消",
  cancel_hold: "取消后实际关节位置稳定",
};
export function motionCaseCheckLabel(name: string, check: Check) {
  const suffix = check.name.slice(name.length + 1);
  return checkLabels[suffix] || `检查项 ${suffix}`;
}
