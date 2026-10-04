import { CaretDown, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { printable, type Check } from "./api";

const names: Record<string, string> = {
  bounded_ast_policy: "生成代码范围检查",
  bounded_device_logic_policy: "ESP32 生成代码范围检查",
  device_logic_independent_numerical: "ESP32 控制算法独立计算检查",
  device_logic_fixed_boundaries: "ESP32 输出不超过约定范围",
  measurement_loss_firmware_safe_zero: "收不到测量值时，固件逻辑停止输出",
  protocol_v3_fragmented_frame: "分段消息能够完整接收",
  protocol_v3_duplicate_command: "重复指令不会执行两次",
  protocol_v3_identity_and_malformed_rejected:
    "模型不匹配或格式错误的消息被拒绝",
  protocol_v3_no_internal_joint_integration:
    "关节位置来自仿真测量，不由通信程序自算",
  protocol_v3_measurement_watchdog_zero: "测量超时后停止输出",
  protocol_v3_measurement_recovery: "测量恢复后能继续收发",
  protocol_v3_watchdog_zero: "指令超时后停止输出",
  protocol_v3_frame_identity: "消息携带正确的关节、模型和协议标识",
  model_source_initial_position: "仿真从所选模型的保存姿态开始",
  workflow_execution_order: "实际执行顺序与已批准流程一致",
  model_protocol_identity: "运行的模型与通信约定和批准版本一致",
  colcon_build: "ROS 工程编译",
  firmware_cross_compile: "ESP32 固件交叉编译",
  serial_state_loss_safe_zero: "串口收不到状态后停止输出",
  serial_alternate_threshold_behavior: "更换阈值后，触发与解除仍正确",
  protocol_fragment_waits_for_newline: "消息未收完整时，等待下一段",
  protocol_fragment_reassembly: "分段收到的消息能重新拼合",
  protocol_duplicate_and_old_rejected: "重复或过期消息被拒绝",
  protocol_invalid_frames_rejected: "错误格式的消息被拒绝",
  protocol_oversize_recovery: "超长消息被丢弃后，通信能恢复",
  protocol_watchdog_safe_zero: "指令超时后停止输出",
  protocol_reconnect_higher_seq: "重新连接后接收新序号",
  protocol_state_contract: "状态消息符合两端约定",
  state_loss_safe_zero: "ROS 收不到状态后输出零",
  duplicate_command_not_reapplied: "重复指令不会执行两次",
  device_watchdog_safe_zero: "模拟设备失联后停止",
  malformed_command_rejected: "错误格式的指令被拒绝",
  gazebo_physics_backend_loaded: "物理仿真引擎正常启动",
  gazebo_physics_measurements: "收到物理仿真的关节位置",
};
export function checkName(name: string) {
  if (names[name]) return names[name];
  const logic = name.match(/^logic_(joint|sensor)_case_(\d+)$/);
  if (logic)
    return `${logic[1] === "joint" ? "关节控制" : "传感器触发"}逻辑 · 情形 ${Number(logic[2]) + 1}`;
  const prefixes: Record<string, string> = {
    primary: "当前目标",
    alternate_target: "更换目标",
    already_at_target: "起点已在目标位置",
    alternate_threshold: "更换触发阈值",
    gazebo_primary: "关节物理仿真",
    serial_primary: "虚拟串口",
    communication_loop: "两端通信闭环",
    model_primary: "所选关节当前目标",
    model_alternate: "所选关节更换目标",
    model_already: "所选关节起点已在目标位置",
    serial_alternate_threshold: "虚拟串口更换阈值",
  };
  const suffixes: Record<string, string> = {
    message_contract: "通信格式与收发",
    state_frequency: "反馈频率",
    position_tolerance: "位置误差",
    threshold_behavior: "阈值触发与解除",
    firmware_applied: "固件逻辑收到并采用指令",
    device_logic_preservation: "执行的是本轮生成的 ESP32 算法",
    same_model_feedback: "反馈来自本轮所选模型",
    firmware_drives_gazebo: "固件逻辑的输出驱动物理仿真",
    gazebo_backend_loaded: "物理仿真引擎正常启动",
  };
  for (const [prefix, label] of Object.entries(prefixes))
    for (const [suffix, description] of Object.entries(suffixes))
      if (name === `${prefix}_${suffix}`) return `${label}：${description}`;
  return "其他执行检查";
}
export function engineName(engine: string) {
  if (engine.includes("gazebo")) return "Gazebo 关节物理仿真 + ROS 通信检查";
  if (engine.includes("sensor")) return "传感器数值模拟 + ROS 通信检查";
  if (engine.includes("ros") || engine.includes("numerical"))
    return "ROS 通信与数值模拟";
  return "本机程序执行与检查";
}
export function espStatus(value: string) {
  if (value.includes("not_compiled") || value.includes("reference_only"))
    return "参考代码，未编译烧录";
  if (value.includes("sim")) return "模拟设备，未烧录";
  return "查看原始记录确认";
}
function groupOf(check: Check) {
  if (
    ["workflow_execution_order", "model_protocol_identity"].includes(check.name)
  )
    return "模型与流程一致性";
  if (
    check.name.startsWith("gazebo") ||
    check.name.startsWith("model_") ||
    check.name.endsWith("firmware_drives_gazebo") ||
    check.name.endsWith("gazebo_backend_loaded")
  )
    return "物理仿真";
  if (
    check.name === "bounded_ast_policy" ||
    check.name === "bounded_device_logic_policy" ||
    check.name.startsWith("device_logic_") ||
    check.name === "colcon_build" ||
    check.name === "firmware_cross_compile" ||
    check.name.startsWith("logic_")
  )
    return "代码与编译";
  if (
    check.name.includes("position_tolerance") ||
    check.name.includes("threshold_behavior")
  )
    return "任务效果";
  return "通信与失联处理";
}
export default function ChecksView({ checks }: { checks: Check[] }) {
  return (
    <div className="checks-groups">
      {[
        "代码与编译",
        "任务效果",
        "通信与失联处理",
        "物理仿真",
        "模型与流程一致性",
      ].map((group) => {
        const items = checks.filter((check) => groupOf(check) === group);
        if (!items.length) return null;
        const failed = items.some((item) => !item.passed);
        return (
          <details className="check-group" key={group} open={failed}>
            <summary>
              {failed ? (
                <WarningCircle size={19} className="bad-text" />
              ) : (
                <CheckCircle size={19} className="good-text" />
              )}
              <strong>{group}</strong>
              <span>
                {items.filter((item) => item.passed).length} / {items.length}{" "}
                项通过
              </span>
              <CaretDown className="check-disclosure" size={14} />
            </summary>
            <div>
              {items.map((item, index) => (
                <details
                  className="check-detail"
                  key={index}
                  open={!item.passed}
                >
                  <summary>
                    {item.passed ? (
                      <CheckCircle className="good-text" size={15} />
                    ) : (
                      <WarningCircle className="bad-text" size={15} />
                    )}
                    <span>{checkName(item.name)}</span>
                    <small>{item.passed ? "通过" : "失败"}</small>
                  </summary>
                  <pre>
                    {item.name}
                    {"\n"}
                    {printable(item.detail)}
                  </pre>
                </details>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}
