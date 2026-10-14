import { useId } from "react";
import { Circuitry, Cube, WarningCircle } from "@phosphor-icons/react";
import { FoldBotModelPreview } from "./FoldBotSimulation";
import type { GuidedWiringPreview } from "./guidedFlow";
import { useI18n } from "./i18n";
import "./guidedWiring.css";

type Props = {
  preview: GuidedWiringPreview;
  reviewed: boolean;
  onReviewedChange: (reviewed: boolean) => void;
  disabled: boolean;
};

const signalColors: Record<string, string> = {
  fold1: "#4285f4",
  fold2: "#34a853",
  arm: "#aa7b00",
  chassis: "#ea4335",
};

/** Displays only a generated source snapshot; no USB, socket or hardware session is opened. */
export function GuidedWiring({
  preview,
  reviewed,
  onReviewedChange,
  disabled,
}: Props) {
  const { t, locale } = useI18n();
  const id = useId();
  const modules = preview.connections.filter((connection) =>
    Object.hasOwn(signalColors, connection.id),
  );
  const height = 66 + modules.length * 116;
  const label = (connection: GuidedWiringPreview["connections"][number]) =>
    locale === "en" ? connection.label_en : connection.label;
  const description = (
    connection: GuidedWiringPreview["connections"][number],
  ) => (locale === "en" ? connection.connection_en : connection.connection);
  const knownWarnings: Record<string, string> = {
    "此接线来自已选硬件的现有源码，是待核对方案，不代表实物已连接或验证。":
      "This wiring comes from the selected hardware's existing source. It is a draft for review, not proof of physical wiring or validation.",
    "GPIO35–37 与 ESP32-S3 N16R8 内部存储器的兼容性待确认。":
      "GPIO35–37 compatibility with ESP32-S3 N16R8 internal memory is unconfirmed.",
    "外置驱动型号、电流与电源、舵机波特率及实际行程须现场核对；不推测未知参数。":
      "Verify the external driver model, current, supply, servo baud rate and actual travel on site. Unknown parameters are not inferred.",
  };

  return (
    <section
      className="guided-wiring"
      aria-label={t("已生成的硬件接线草稿", "Generated hardware wiring draft")}
    >
      <div className="guided-wiring-grid">
        <article className="guided-wiring-model">
          <div className="guided-wiring-heading">
            <div>
              <span className="guided-wiring-eyebrow">
                <Cube size={15} aria-hidden="true" />
                {t("所选方案", "Selected design")}
              </span>
              <h2>{t("折叠机器人", "Folding robot")}</h2>
            </div>
            <small>{t("模型预览", "Model preview")}</small>
          </div>
          <FoldBotModelPreview />
          <p className="guided-wiring-caption">
            {t(
              "根据你选择的现有整机方案显示模型；此处不连接或移动机器人。",
              "The model represents the existing robot design you selected. This view does not connect to or move a robot.",
            )}
          </p>
        </article>

        <article className="guided-wiring-diagram">
          <div className="guided-wiring-heading">
            <div>
              <span className="guided-wiring-eyebrow">
                <Circuitry size={15} aria-hidden="true" />
                {t("接线草稿已生成", "Wiring draft generated")}
              </span>
              <h2>{t("硬件连接方式", "Hardware connections")}</h2>
            </div>
            <small>{t("待核对", "For review")}</small>
          </div>
          <p className="guided-wiring-caption">
            {t(
              "显示信号关系与源码引脚；实际端子位置以你的开发板为准。",
              "Signal paths and source pins are shown here. Check physical terminal positions on your board.",
            )}
          </p>
          <div
            className="guided-wiring-svg-scroll"
            tabIndex={0}
            role="region"
            aria-label={t(
              "接线图，可横向滚动查看",
              "Wiring diagram, scroll horizontally to inspect",
            )}
          >
            <svg
              viewBox={`0 0 660 ${Math.max(height, 160)}`}
              className="guided-wiring-svg"
              role="img"
              aria-labelledby={`${id}-title ${id}-description`}
            >
              <title id={`${id}-title`}>
                {t(
                  "Sophicar ESP32-S3 与折叠轴、机械臂及底盘的信号接线",
                  "Signal connections from Sophicar ESP32-S3 to the panels, arm and chassis",
                )}
              </title>
              <desc id={`${id}-description`}>
                {modules
                  .map(
                    (connection) => `${label(connection)}: ${connection.pins}`,
                  )
                  .join("; ")}
              </desc>
              <rect
                x="12"
                y="12"
                width="156"
                height={Math.max(height - 24, 132)}
                rx="14"
                fill="#edf3ff"
                stroke="#b8cbed"
              />
              <rect
                x="12"
                y="12"
                width="156"
                height="8"
                rx="4"
                fill="#002fa7"
              />
              <text x="28" y="48" className="guided-svg-board-name">
                Sophicar
              </text>
              <text x="28" y="71" className="guided-svg-board-chip">
                ESP32-S3
              </text>
              {modules.map((connection, index) => {
                const row = 91 + index * 116;
                const signals = connection.pins.split(" · ").filter(Boolean);
                const color = signalColors[connection.id];
                return (
                  <g key={connection.id}>
                    <text x="28" y={row + 11} className="guided-svg-output">
                      {t(`接口 ${index + 1}`, `Link ${index + 1}`)}
                    </text>
                    <rect
                      x="388"
                      y={row - 18}
                      width="260"
                      height="89"
                      rx="11"
                      fill="#ffffff"
                      stroke="#d6dfec"
                    />
                    <rect
                      x="399"
                      y={row - 3}
                      width="4"
                      height="26"
                      rx="2"
                      fill={color}
                    />
                    <text x="415" y={row + 7} className="guided-svg-module">
                      {label(connection)}
                    </text>
                    <text
                      x="415"
                      y={row + 31}
                      className="guided-svg-module-kind"
                    >
                      {connection.id === "arm"
                        ? "BusLinker TTL"
                        : connection.id === "chassis"
                          ? "M1 / M2"
                          : "DIR+ / PUL+ / ENA+"}
                    </text>
                    {signals.map((signal, signalIndex) => {
                      const y = row + 4 + signalIndex * 22;
                      return (
                        <g key={`${connection.id}-${signalIndex}`}>
                          <path
                            d={`M168 ${y + 10} H388`}
                            fill="none"
                            stroke={color}
                            strokeWidth="1.8"
                          />
                          <circle cx="168" cy={y + 10} r="3" fill={color} />
                          <circle cx="388" cy={y + 10} r="3" fill={color} />
                          <text x="184" y={y + 3} className="guided-svg-pin">
                            {signal}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </svg>
          </div>
          <p className="guided-wiring-footnote">
            {t(
              "图中连线为控制信号。逻辑共地、驱动和动力电源见下方说明；未推测电压或电流。",
              "Lines represent control signals. Logic ground, drivers and actuator supply are described below; voltage and current are not inferred.",
            )}
          </p>
        </article>
      </div>

      <div className="guided-wiring-warning">
        <WarningCircle size={20} aria-hidden="true" />
        <p>
          {t(
            "GPIO35–37 与 N16R8 的兼容性仍待确认。驱动器供电、电流、舵机波特率和实际行程也需核对。",
            "GPIO35–37 compatibility with N16R8 remains unconfirmed. Also verify driver supply, current, servo baud rate and actual travel.",
          )}
        </p>
      </div>

      <details className="guided-wiring-details">
        <summary>
          {t(
            `查看全部 ${preview.connections.length} 组接线、限位与来源说明`,
            `View all ${preview.connections.length} connection groups, limits and source notes`,
          )}
        </summary>
        <div className="guided-wiring-connection-list">
          {preview.connections.map((connection) => (
            <article
              key={connection.id}
              className={connection.id === "limits" ? "is-disabled-source" : ""}
            >
              <div className="guided-wiring-connection-title">
                <h3>{label(connection)}</h3>
                {connection.id === "limits" && (
                  <span>{t("源码中禁用", "Disabled in source")}</span>
                )}
              </div>
              <code>{connection.pins}</code>
              <p>{description(connection)}</p>
            </article>
          ))}
        </div>
        {preview.warnings.length > 0 && (
          <ul className="guided-wiring-source-notes">
            {preview.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>
                {locale === "en"
                  ? (knownWarnings[warning] ?? warning)
                  : warning}
              </li>
            ))}
          </ul>
        )}
        <div className="guided-wiring-provenance">
          <span>
            {t("接线来源", "Wiring source")}: <code>{preview.source_key}</code>
          </span>
          <span>
            {t("本次草稿标识", "Draft identifier")}:{" "}
            <code>{preview.binding_sha256.slice(0, 12)}</code>
          </span>
        </div>
      </details>

      <label
        className={`guided-wiring-review ${reviewed ? "is-reviewed" : ""}`}
      >
        <input
          type="checkbox"
          checked={reviewed}
          disabled={disabled}
          onChange={(event) =>
            !disabled && onReviewedChange(event.target.checked)
          }
        />
        <span>
          <strong>
            {t(
              "我已核对所选硬件与这份接线草稿",
              "I have reviewed the selected hardware and this wiring draft",
            )}
          </strong>
          <small>
            {t(
              "仅记录草稿核对，不代表实物已接线或通过验收。修改需求或硬件后需要重新生成和核对。",
              "This records a draft review, not physical wiring or acceptance. Generate and review it again after changing requirements or hardware.",
            )}
          </small>
        </span>
      </label>
    </section>
  );
}

export default GuidedWiring;
