import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Link,
  Lock,
  Plug,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import { isPublicDemo } from "./api";
import { useI18n } from "./i18n";
import {
  foldbotApi,
  FoldBotSession,
  type FoldBotProject,
  type FoldBotSessionSnapshot,
} from "./foldbotApi";

const idle: FoldBotSessionSnapshot = {
  active: false,
  busy: false,
  state: null,
  reason: "",
  error: "",
};
// Explicit button activation is supported; holding Enter/Space must never repeat a motion.
function noRepeat(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.repeat && (event.key === "Enter" || event.key === " "))
    event.preventDefault();
}

export default function FoldBotControls({
  project,
  ready,
}: {
  project: FoldBotProject | null;
  ready: boolean;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState(idle);
  const [address, setAddress] = useState("192.168.4.1");
  const [checked, setChecked] = useState([false, false, false]);
  const [endpoint, setEndpoint] = useState<"folded" | "unfolded">("unfolded");
  const [axis, setAxis] = useState<1 | 2>(1);
  const [endpointObserved, setEndpointObserved] = useState(false);
  const [joint, setJoint] = useState(1);
  const controller = useRef<FoldBotSession | null>(null);

  useEffect(() => {
    if (isPublicDemo) return;
    const session = new FoldBotSession(foldbotApi, setSnapshot);
    controller.current = session;
    const leave = () => {
      void session.stop("page_left");
    };
    const hide = () => {
      if (document.hidden) leave();
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hide);
      session.dispose();
      if (controller.current === session) controller.current = null;
    };
  }, []);
  useEffect(() => {
    setChecked([false, false, false]);
    setEndpointObserved(false);
    if (!isPublicDemo) void controller.current?.stop("project_changed");
  }, [project?.id, project?.revision, ready]);

  if (isPublicDemo) return null;
  const state = snapshot.state;
  const enabled =
    !!state?.enabled &&
    !!state.connected &&
    state.phase === "connected" &&
    !!state.fresh &&
    !state.fault;
  const available = ready && snapshot.active && enabled && !snapshot.busy;
  const canEnable =
    ready &&
    snapshot.active &&
    !!state?.connected &&
    state.phase === "connected" &&
    !!state.fresh &&
    !state.fault &&
    !snapshot.busy &&
    !state.enabled;
  const firmware =
    typeof state?.firmware === "string"
      ? state.firmware
      : state?.firmware?.firmwareBuild
        ? String(state.firmware.firmwareBuild)
        : "—";
  const level = project?.drive_level ?? 10;
  const duration = project?.drive_duration_ms ?? 200;
  const notices: Record<string, [string, string]> = {
    connecting: [
      "正在连接并初始化；尚未使能。",
      "Connecting and initializing; not enabled yet.",
    ],
    connected_disabled: [
      "连接初始化已完成，尚未使能。现场核对后可点击显式使能。",
      "Connection initialization finished; motion is disabled. Enable explicitly after the on-site checks.",
    ],
    stopped: [
      "控制权已撤销，已请求全停。再次操作需要重新连接并使能。",
      "Control revoked and STOP requested. Reconnect and enable explicitly to continue.",
    ],
    page_left: [
      "页面已离开或隐藏，控制权已撤销。",
      "The page was hidden or left. Control has been revoked.",
    ],
    lease_lost: [
      "续租失败，控制权已撤销。不会自动重连。",
      "Lease renewal failed. Control revoked; automatic reconnect is disabled.",
    ],
    command_failed_no_retry: [
      "命令失败或结果未知，已撤销控制；没有重发命令。",
      "Command failed or its outcome is unknown. Control revoked; the command was not retried.",
    ],
    project_changed: [
      "连接前请完成下面的现场核对。",
      "Complete the on-site checks below before connecting.",
    ],
  };
  const note = notices[snapshot.reason];

  return (
    <div className="foldbot-control">
      <div className="foldbot-notice warning">
        <WarningCircle size={22} />
        <div>
          <strong>
            {t(
              "本机直连 ESP32 · 实物尚未验收",
              "Local ESP32 connection · hardware not verified",
            )}
          </strong>
          <p>
            {t(
              "连接会初始化底盘功率为 30%，不等于只读查询。当前磁盘源码不代表板上固件；控制 ACK、开环结束和反馈值都不能证明机构真实到位。",
              "Connecting initializes chassis power to 30%; it is not read-only. Source files do not prove what is flashed. ACKs, open-loop completion and feedback do not prove physical position.",
            )}
          </p>
        </div>
      </div>
      {!ready && (
        <div className="foldbot-notice">
          <Lock size={20} />
          <p>
            {t(
              "先在“工程与来源”核对并生成当前修订，才能连接。修改需求后需要重新核对、生成。",
              "Review and generate the current revision in Engineering & sources before connecting. Edits require a new review and generation.",
            )}
          </p>
        </div>
      )}
      <div className="foldbot-control-grid">
        <section className="foldbot-card">
          <div className="foldbot-card-heading">
            <span className="foldbot-kicker">
              01 / {t("连接准备", "Prepare connection")}
            </span>
            <Plug size={23} />
          </div>
          <h2>{t("先核对现场，再连接", "Check the robot, then connect")}</h2>
          <div className="foldbot-checklist">
            {[
              t(
                "我已关闭原机器人控制网页和其他控制端，确保只有本页操作。",
                "I closed the original robot web page and other controllers; this page is the only operator.",
              ),
              t(
                "我已按实物核对板卡、固件版本、电源、驱动接线及 GPIO35–38 与存储配置的兼容性。",
                "I checked the physical board, firmware, supply, drivers and GPIO35–38 compatibility with its memory configuration.",
              ),
              t(
                "我已核对限位状态、行程与参考点，现场无人或物体处于运动范围，且了解连接会写入 30% 功率。",
                "I checked limits, travel and reference points, cleared the motion area and understand that connection writes 30% power.",
              ),
            ].map((text, i) => (
              <label className="foldbot-check" key={i}>
                <input
                  type="checkbox"
                  checked={checked[i]}
                  disabled={snapshot.active || snapshot.busy}
                  onChange={(e) =>
                    setChecked((values) =>
                      values.map((value, n) =>
                        n === i ? e.target.checked : value,
                      ),
                    )
                  }
                />
                <span>{text}</span>
              </label>
            ))}
          </div>
          <label className="foldbot-field">
            <span>{t("ESP32 私网地址", "ESP32 private address")}</span>
            <input
              value={address}
              disabled={snapshot.active || snapshot.busy}
              onChange={(e) => setAddress(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
          </label>
          <button
            type="button"
            className="button primary foldbot-wide"
            disabled={
              !ready ||
              !checked.every(Boolean) ||
              snapshot.active ||
              snapshot.busy ||
              !address.trim()
            }
            onClick={() => {
              if (project)
                void controller.current?.connect({
                  project_id: project.id,
                  revision: project.revision,
                  address: address.trim(),
                  confirmed: true,
                });
            }}
          >
            <Link size={18} />
            {snapshot.busy && !snapshot.active
              ? t("连接中…", "Connecting…")
              : t("连接并初始化 30% 功率", "Connect & initialize 30% power")}
          </button>
        </section>
        <section className="foldbot-card">
          <div className="foldbot-card-heading">
            <span className="foldbot-kicker">
              02 / {t("控制会话", "Control session")}
            </span>
            <span className={`foldbot-pill ${snapshot.active ? "blue" : ""}`}>
              {snapshot.active
                ? t("单操作者租约", "Single-operator lease")
                : t("未连接", "Disconnected")}
            </span>
          </div>
          <h2>{t("状态与使能", "Status & enable")}</h2>
          <dl className="foldbot-status-grid">
            <div>
              <dt>{t("设备连接", "Connection")}</dt>
              <dd>
                {state?.connected
                  ? t("已连接", "Connected")
                  : state?.phase === "connecting"
                    ? t("初始化中", "Initializing")
                    : t("未连接", "Disconnected")}
              </dd>
            </div>
            <div>
              <dt>{t("运动使能", "Motion enable")}</dt>
              <dd>
                {state?.enabled
                  ? t("已使能", "Enabled")
                  : t("未使能", "Disabled")}
              </dd>
            </div>
            <div>
              <dt>{t("反馈新鲜度", "Feedback age")}</dt>
              <dd>
                {state?.fresh
                  ? `${state.frame_age_ms ?? "—"} ms`
                  : t("无新鲜反馈", "No fresh feedback")}
              </dd>
            </div>
            <div>
              <dt>{t("实物验收", "Hardware acceptance")}</dt>
              <dd>{t("未验证", "Not verified")}</dd>
            </div>
          </dl>
          <div className="foldbot-firmware">
            <span>{t("设备报告的固件", "Device-reported firmware")}</span>
            <code>{firmware}</code>
          </div>
          {snapshot.reason && (
            <p className="foldbot-protocol-result">
              {t("最近协议结果", "Latest protocol result")}:{" "}
              <code>{snapshot.reason}</code>
            </p>
          )}
          {state?.fault ? (
            <p className="foldbot-error">
              {t("故障反馈：", "Fault: ")}
              {typeof state.fault === "string"
                ? state.fault
                : JSON.stringify(state.fault)}
            </p>
          ) : null}
          <button
            type="button"
            className="button primary foldbot-wide"
            disabled={!canEnable}
            onKeyDown={noRepeat}
            onClick={() =>
              void controller.current?.command({
                operation: "enable",
                confirmed: true,
              })
            }
          >
            {t("确认现场安全，显式使能", "Confirm area is clear & enable")}
          </button>
          <p className="foldbot-caption">
            {t(
              "后台每 500 ms 接收本页续租。隐藏、离开页面或失联将撤销控制；重新连接不会自动使能。",
              "This page renews the lease every 500 ms. Hiding, leaving or losing the page revokes control. Reconnection never enables motion automatically.",
            )}
          </p>
        </section>
      </div>
      <div className="foldbot-stop-bar">
        <div>
          <strong>{t("全停优先", "STOP takes priority")}</strong>
          <small>
            {t(
              "撤销本页控制权，并向设备请求停止。",
              "Revoke this page’s control and request device STOP.",
            )}
          </small>
        </div>
        <button
          className="foldbot-stop"
          type="button"
          disabled={!snapshot.active && !snapshot.busy}
          onClick={() => void controller.current?.stop()}
        >
          <Stop size={22} weight="fill" />
          {t("全停 / 断开", "STOP / disconnect")}
        </button>
      </div>
      {(note || snapshot.error) && (
        <div
          className={`foldbot-notice ${snapshot.error ? "warning" : ""}`}
          role="status"
        >
          <div>
            {note && <p>{t(...note)}</p>}
            {snapshot.error && (
              <>
                <p>
                  {snapshot.error === "stop_unconfirmed_lease_expiry"
                    ? t(
                        "停止请求未确认；设备停止状态未知，租约到期将撤销后台控制。请在现场确认。",
                        "STOP was not acknowledged; device state is unknown. Lease expiry will revoke server control. Verify on site.",
                      )
                    : t(
                        "操作未完成，请先检查连接和设备状态。错误详情：",
                        "The action did not complete. Check the connection and device state. Details: ",
                      )}
                </p>
                {snapshot.error !== "stop_unconfirmed_lease_expiry" && (
                  <code>{snapshot.error}</code>
                )}
              </>
            )}
          </div>
        </div>
      )}
      <div className="foldbot-motion-grid">
        <section className="foldbot-card">
          <span className="foldbot-kicker">{t("底盘", "Chassis")}</span>
          <h2>{t("一次点击，一次短点动", "One click, one short drive")}</h2>
          <p className="foldbot-caption">
            {t("使用已核对工程的限制：", "Reviewed limits: ")}
            {level} / 20 · {duration} ms
          </p>
          <div className="foldbot-dpad">
            {[
              {
                key: "forward",
                label: t("前进", "Forward"),
                icon: ArrowUp,
                linear: level,
                turn: 0,
              },
              {
                key: "left",
                label: t("左转", "Left"),
                icon: ArrowLeft,
                linear: 0,
                turn: -level,
              },
              {
                key: "right",
                label: t("右转", "Right"),
                icon: ArrowRight,
                linear: 0,
                turn: level,
              },
              {
                key: "back",
                label: t("后退", "Reverse"),
                icon: ArrowDown,
                linear: -level,
                turn: 0,
              },
            ].map(({ key, label, icon: Icon, linear, turn }) => (
              <button
                type="button"
                className={`foldbot-drive ${key}`}
                key={key}
                disabled={!available}
                onKeyDown={noRepeat}
                onClick={() =>
                  void controller.current?.command({
                    operation: "drive",
                    linear,
                    turn,
                    duration_ms: duration,
                  })
                }
              >
                <Icon size={21} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <p className="foldbot-caption">
            {t(
              "不会持续连发；每次动作由后台限时停止。",
              "No repeated drive stream; each motion is time-limited by the server.",
            )}
          </p>
        </section>
        <section className="foldbot-card">
          <span className="foldbot-kicker">
            {t("双折叠板", "Dual folding panels")}
          </span>
          <h2>{t("人工端位确认", "Confirm a physical endpoint")}</h2>
          <div className="foldbot-two-fields">
            <label className="foldbot-field">
              <span>{t("板轴", "Panel axis")}</span>
              <select
                value={axis}
                disabled={!available}
                onChange={(e) => {
                  setAxis(Number(e.target.value) as 1 | 2);
                  setEndpointObserved(false);
                }}
              >
                <option value={1}>{t("板 1", "Panel 1")}</option>
                <option value={2}>{t("板 2", "Panel 2")}</option>
              </select>
            </label>
            <label className="foldbot-field">
              <span>{t("已观察的端位", "Observed endpoint")}</span>
              <select
                value={endpoint}
                disabled={!available}
                onChange={(e) => {
                  setEndpoint(e.target.value as typeof endpoint);
                  setEndpointObserved(false);
                }}
              >
                <option value="unfolded">
                  {t("完全展开", "Fully unfolded")}
                </option>
                <option value="folded">{t("完全折叠", "Fully folded")}</option>
              </select>
            </label>
          </div>
          <label className="foldbot-check">
            <input
              type="checkbox"
              checked={endpointObserved}
              disabled={!available}
              onChange={(e) => setEndpointObserved(e.target.checked)}
            />
            <span>
              {t(
                "我已在现场确认所选板真实处于这个端位。",
                "I observed this panel physically at the selected endpoint.",
              )}
            </span>
          </label>
          <button
            type="button"
            className="button secondary foldbot-wide"
            disabled={!available || !endpointObserved}
            onKeyDown={noRepeat}
            onClick={() => {
              setEndpointObserved(false);
              void controller.current?.command({
                operation: "confirm_endpoint",
                axis,
                endpoint,
                confirmed: true,
              });
            }}
          >
            {t("记录人工确认", "Record confirmation")}
          </button>
          <div className="foldbot-button-row">
            <button
              type="button"
              className="button secondary"
              disabled={!available}
              onKeyDown={noRepeat}
              onClick={() =>
                void controller.current?.command({
                  operation: "fold",
                  direction: "fold",
                })
              }
            >
              {t("折叠双板", "Fold panels")}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!available}
              onKeyDown={noRepeat}
              onClick={() =>
                void controller.current?.command({
                  operation: "fold",
                  direction: "unfold",
                })
              }
            >
              {t("展开双板", "Unfold panels")}
            </button>
          </div>
          <p className="foldbot-caption">
            {t(
              "后台检查端位参考。脉冲计数属于开环估计，完成反馈不等于实测到位。",
              "The server checks endpoint references. Pulse counts are open-loop estimates; completion is not measured arrival.",
            )}
          </p>
        </section>
        <section className="foldbot-card">
          <span className="foldbot-kicker">{t("机械臂", "Robot arm")}</span>
          <h2>{t("单轴小步", "Small single-joint steps")}</h2>
          <label className="foldbot-field">
            <span>{t("选择关节", "Choose joint")}</span>
            <select
              value={joint}
              disabled={!available}
              onChange={(e) => setJoint(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5, 6].map((value) => (
                <option value={value} key={value}>
                  {t("关节", "Joint")} {value}
                </option>
              ))}
            </select>
          </label>
          <div className="foldbot-button-row">
            <button
              type="button"
              className="button secondary"
              disabled={!available}
              onKeyDown={noRepeat}
              onClick={() =>
                void controller.current?.command({
                  operation: "arm_step",
                  joint,
                  direction: -1,
                })
              }
            >
              −8 {t("原始单位", "raw units")}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!available}
              onKeyDown={noRepeat}
              onClick={() =>
                void controller.current?.command({
                  operation: "arm_step",
                  joint,
                  direction: 1,
                })
              }
            >
              +8 {t("原始单位", "raw units")}
            </button>
          </div>
          <p className="foldbot-caption">
            {t(
              "舵机原始单位不是角度。未推断零点、传动比或标定；动作组本轮未适配。",
              "Servo raw units are not degrees. Zero points, gearing and calibration are not inferred. Action groups are not adapted in this version.",
            )}
          </p>
          <div className="foldbot-inline-boundary">
            <Lock size={18} />
            <span>
              {t(
                "ROS 仅提供演示源码，不参与当前控制链。",
                "ROS demo source is provided; ROS is not in this control path.",
              )}
            </span>
          </div>
        </section>
      </div>
      {project && (
        <a
          className="foldbot-event-link"
          href={`/api/foldbot/projects/${encodeURIComponent(project.id)}/control-events`}
          target="_blank"
          rel="noreferrer"
        >
          {t("查看操作记录 JSON", "View operation log JSON")} ↗
        </a>
      )}
      {state && (
        <details className="foldbot-raw">
          <summary>
            {t(
              "查看设备反馈原文（不代表实物验收）",
              "Inspect device feedback (not hardware acceptance)",
            )}
          </summary>
          <pre>{JSON.stringify(state, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
