import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Cube,
  Info,
  Link,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import { isPublicDemo } from "./api";
import { useI18n } from "./i18n";
import {
  createConsoleApi,
  FoldBotConsoleSession,
  initialConsoleSnapshot,
  readConsoleEvents,
  type ConsoleEventRecord,
} from "./foldbotConsoleClient";
import "./foldbotConsole.css";

const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
const consoleUrl = `${env?.BASE_URL ?? "/"}foldbot-console-${isPublicDemo ? "preview" : "local"}.html`;

export default function FoldBotConsole({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState(initialConsoleSnapshot);
  const [address, setAddress] = useState("192.168.4.1");
  const [confirmed, setConfirmed] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [mounted, setMounted] = useState(isPublicDemo);
  const [events, setEvents] = useState<ConsoleEventRecord[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const session = useRef<FoldBotConsoleSession | null>(null);

  useEffect(() => {
    if (isPublicDemo) return;
    const controller = new FoldBotConsoleSession({
      publicMode: false,
      api: createConsoleApi({
        publicMode: false,
        beacon: (url, body) => navigator.sendBeacon(url, body),
      }),
      origin: window.location.origin,
      frame: () => frame.current?.contentWindow ?? null,
      resetFrame: () => setFrameKey((value) => value + 1),
      notify: (value) => {
        setSnapshot(value);
        if (value.phase === "closed" || value.phase === "stopping")
          setConfirmed(false);
      },
    });
    session.current = controller;
    const receive = (event: MessageEvent) => controller.receive(event);
    const leave = () => {
      setConfirmed(false);
      void controller.stop("page_left");
    };
    const hide = () => {
      if (document.hidden) leave();
    };
    window.addEventListener("message", receive);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hide);
    // Install listeners before mounting the iframe so its ready message cannot be lost.
    setMounted(true);
    return () => {
      window.removeEventListener("message", receive);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hide);
      controller.dispose();
      if (session.current === controller) session.current = null;
    };
  }, []);

  const connected = snapshot.phase === "connected";
  const active =
    connected ||
    snapshot.phase === "attaching" ||
    snapshot.phase === "reserving";
  const canConnect =
    !isPublicDemo &&
    snapshot.ready &&
    confirmed &&
    !active &&
    !snapshot.busy &&
    !!address.trim();
  const status = isPublicDemo
    ? t("公开预览 · 无控制连接", "Public preview · no control connection")
    : connected
      ? t("已连接 · 实物未验收", "Connected · hardware not verified")
      : snapshot.phase === "stopping"
        ? t("正在撤销控制会话…", "Revoking control session…")
        : active
          ? t("正在核验设备连接…", "Checking device connection…")
          : t("仅预览 · 未连接", "Preview only · disconnected");
  const reasons: Record<string, [string, string]> = {
    stopped: [
      "已撤销本页控制并请求停止；再次控制需重新确认和连接。",
      "Control revoked and STOP requested. Confirm and connect again to continue.",
    ],
    page_left: [
      "页面已隐藏或离开，已请求停止；恢复页面不会自动重连。",
      "The page was hidden or left; STOP was requested. Returning will not reconnect automatically.",
    ],
    connection_closed: [
      "设备连接已结束，已撤销本页会话。",
      "The device connection ended and this session was revoked.",
    ],
    connection_failed: [
      "连接未完成或已失联，请检查本机服务、热点与其他控制端。",
      "Connection failed or was lost. Check the local service, hotspot and other controllers.",
    ],
    connection_timeout: [
      "连接核验超时，已撤销会话；没有自动重连。",
      "Connection verification timed out. Session revoked; automatic reconnect is disabled.",
    ],
    frame_reloaded: [
      "原控制台重新加载，已撤销会话；需要手动重新连接。",
      "The embedded console reloaded. Session revoked; connect again manually.",
    ],
  };
  const note = reasons[snapshot.reason];

  return (
    <div className="foldbot-console">
      <div className="console-heading">
        <div>
          <button
            type="button"
            className="console-back"
            onClick={() => {
              void session.current?.stop("page_left");
              onBack();
            }}
          >
            <ArrowLeft size={17} />
            {t("返回需求与工程", "Back to requirements & engineering")}
          </button>
          <p className="console-eyebrow">
            FOLDBOT / {t("原版完整控制台", "ORIGINAL CONSOLE")}
          </p>
          <h1>{t("完整控制台", "Full robot console")}</h1>
          <p className="console-intro">
            {t(
              "保留原有 3D、手动控制、维护与示教界面。无需重新生成需求，即可从这里明确连接现有机器人。",
              "The original 3D, manual control, maintenance and teaching interface. Connect your existing robot here without regenerating requirements.",
            )}
          </p>
        </div>
        <span
          className={`console-status ${connected ? "connected" : ""}`}
          role="status"
        >
          <span />
          {status}
        </span>
      </div>

      {isPublicDemo ? (
        <div className="console-notice preview">
          <Info size={21} />
          <p>
            {t(
              "GitHub 公开版只展示原控制台和 3D 视角，操作按钮不可用，不会连接 ESP32。真实控制请在本机 AE 中打开此页。",
              "The public GitHub version displays the original console and 3D view. Controls are unavailable and it cannot connect to ESP32. Open this page in local AE for robot control.",
            )}
          </p>
        </div>
      ) : (
        <section
          className="console-connect"
          aria-label={t("连接现场机器人", "Connect the on-site robot")}
        >
          <div className="console-connect-copy">
            <strong>
              {t(
                "先连接 ESP 热点，再确认现场",
                "Join the ESP hotspot, then confirm the site",
              )}
            </strong>
            <p>
              {t(
                "关闭原机器人网页和其他控制端。此入口保留原功能范围；连接仅核验状态，不自动写入功率或使能。",
                "Close the original robot page and other controllers. This entry retains the original control range. Connection checks status without automatically changing power or enabling motion.",
              )}
            </p>
            <label className="console-check">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={active || snapshot.busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                {t(
                  "我已核对实物板卡、固件、电源、驱动接线与行程参考，运动区域已清空，可在现场立即断电，且只有本页控制。",
                  "I checked the physical board, firmware, supply, driver wiring and travel reference. The motion area is clear, I can cut power on site, and this page is the only controller.",
                )}
              </span>
            </label>
          </div>
          <div className="console-connect-actions">
            <label htmlFor="console-address">
              {t("ESP32 私网 IPv4 地址", "ESP32 private IPv4 address")}
            </label>
            <input
              id="console-address"
              value={address}
              disabled={active || snapshot.busy}
              onChange={(event) => setAddress(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              inputMode="decimal"
            />
            <button
              type="button"
              className="button primary"
              disabled={!canConnect}
              onClick={() => {
                if (!document.hidden)
                  void session.current?.connect(address, confirmed);
              }}
            >
              <Link size={18} />
              {active && !connected
                ? t("连接中…", "Connecting…")
                : t("确认并连接机器人", "Confirm & connect robot")}
            </button>
            <small>
              {t(
                "隐藏、离开或断线会撤销控制；不会自动重连。",
                "Hiding, leaving or disconnecting revokes control. No automatic reconnect.",
              )}
            </small>
          </div>
        </section>
      )}

      <div className="console-capabilities">
        <span>
          {t(
            "摇杆 ±100 · 功率 30 / 60 / 100%",
            "Joystick ±100 · power 30 / 60 / 100%",
          )}
        </span>
        <span>{t("六轴持续点动", "Continuous six-axis jogging")}</span>
        <span>
          {t("双板校准与维护", "Dual-panel calibration & maintenance")}
        </span>
        <span>
          {t("五姿态示教与动作组", "Five-pose teaching & action groups")}
        </span>
      </div>

      <div className="console-safety-row">
        <div>
          <WarningCircle size={20} />
          <p>
            {t(
              "维护和示教中的部分操作会修改 NVS；每次写入需单独确认。接入不会自动写标定，当前无外部限位版本不提供回零。",
              "Some maintenance and teaching actions modify NVS and require confirmation for each write. Integration never writes calibration automatically. Homing is unavailable for the current build without external limit switches.",
            )}
          </p>
        </div>
        {!isPublicDemo && (
          <button
            type="button"
            className="console-stop"
            disabled={!active && !snapshot.busy}
            onClick={() => {
              setConfirmed(false);
              void session.current?.stop();
            }}
          >
            <Stop size={20} weight="fill" />
            {t("全停 / 断开", "STOP / disconnect")}
          </button>
        )}
      </div>

      {!isPublicDemo && (note || snapshot.error || snapshot.stopResult) && (
        <div
          className={`console-feedback ${snapshot.error ? "warning" : ""}`}
          role="status"
        >
          {note && <p>{t(...note)}</p>}
          {snapshot.error === "stop_unconfirmed" && (
            <strong>
              {t(
                "停止请求未确认，设备停止状态未知。请在现场确认，必要时切断动力电源。",
                "STOP is unconfirmed and the physical stop state is unknown. Verify on site and cut motor power if needed.",
              )}
            </strong>
          )}
          {snapshot.error && snapshot.error !== "stop_unconfirmed" && (
            <p>
              {t(
                "会话未建立，请检查地址、服务和设备状态后重新确认。",
                "No session was established. Check the address, service and device before confirming again.",
              )}
            </p>
          )}
          {snapshot.stopResult && (
            <p className="console-evidence">
              {snapshot.stopResult.stop_command_sent === true
                ? t("协议记录：STOP 已发送。", "Protocol record: STOP sent.")
                : t(
                    "协议记录：未确认向设备发送 STOP。",
                    "Protocol record: device STOP delivery unconfirmed.",
                  )}{" "}
              {snapshot.stopResult.transport_closed === true
                ? t("连接已关闭。", "Connection closed.")
                : t("连接关闭未确认。", "Connection closure unconfirmed.")}{" "}
              {t(
                "实物停止仍需现场确认。",
                "Physical stopping still requires on-site verification.",
              )}
            </p>
          )}
        </div>
      )}

      <section
        className="console-frame-shell"
        aria-label={t("原版中文控制台", "Original Chinese console")}
      >
        <div className="console-frame-heading">
          <strong>
            <Cube size={19} />
            {t("原版操作界面", "Original control interface")}
          </strong>
          <span>
            {t(
              "原界面操作标签保留中文",
              "Original control labels remain in Chinese",
            )}
          </span>
        </div>
        {mounted && (
          <iframe
            key={frameKey}
            ref={frame}
            src={consoleUrl}
            title={t(
              "FoldBot 原版完整控制台与 3D 示意",
              "FoldBot original full console and illustrative 3D view",
            )}
            onLoad={() => session.current?.frameLoaded()}
          />
        )}
      </section>
      <p className="console-boundary">
        <Info size={17} />
        <span>
          {t(
            "3D 为姿态示意。ACK、反馈值和动画均不能证明机构真实到位；本次接入尚未进行实机运动验收。ROS 仅提供演示源码。",
            "3D is illustrative. ACKs, feedback and animation do not prove physical position. This integration has not passed real-hardware motion acceptance. ROS is supplied as demo source only.",
          )}
        </span>
      </p>
      {!isPublicDemo && (
        <details className="console-events">
          <summary>
            {t("查看本机操作记录", "Inspect local operation records")}
          </summary>
          <div className="console-events-heading">
            <p>
              {t(
                "最近 100 条协议记录，仅手动刷新；命令记录不代表实物执行成功。",
                "The latest 100 protocol records, refreshed manually. Command records do not prove successful physical execution.",
              )}
            </p>
            <button
              type="button"
              className="button secondary"
              disabled={eventsLoading}
              onClick={async () => {
                if (isPublicDemo || eventsLoading) return;
                setEventsLoading(true);
                setEventsError(false);
                try {
                  setEvents(
                    await readConsoleEvents({ publicMode: isPublicDemo }),
                  );
                } catch {
                  setEventsError(true);
                } finally {
                  setEventsLoading(false);
                }
              }}
            >
              {eventsLoading
                ? t("读取中…", "Loading…")
                : t("刷新记录", "Refresh records")}
            </button>
          </div>
          {eventsError && (
            <p role="status">
              {t(
                "操作记录读取失败，请检查本机服务。",
                "Could not read operation records. Check the local service.",
              )}
            </p>
          )}
          {events?.length === 0 && (
            <p>{t("当前没有记录。", "No records yet.")}</p>
          )}
          {!!events?.length && (
            <div className="console-events-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("时间", "Time")}</th>
                    <th>{t("操作", "Operation")}</th>
                    <th>{t("协议结果", "Protocol result")}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event, index) => (
                    <tr key={index}>
                      <td>
                        {event.time_ms === null
                          ? "—"
                          : new Date(event.time_ms).toLocaleString()}
                      </td>
                      <td>
                        <code>{event.operation}</code>
                      </td>
                      <td>
                        <code>{event.reason}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
