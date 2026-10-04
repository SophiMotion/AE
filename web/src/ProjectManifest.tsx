import { ClipboardText, Info } from "@phosphor-icons/react";
import type { EngineeringManifest } from "./api";
export default function ProjectManifest({
  manifest,
  stale = false,
}: {
  manifest?: EngineeringManifest | null;
  stale?: boolean;
}) {
  if (!manifest)
    return (
      <div className="manifest-empty">
        <Info size={17} />
        <span>
          保存后，后台会生成本轮工程清单，检查板型、运行环境、控制对象与通信是否配套。旧工程需重新保存。
        </span>
      </div>
    );
  const checks = manifest.preflight?.checks || [];
  return (
    <section className={`project-manifest ${stale ? "stale" : ""}`}>
      <div className="section-intro">
        <h3>
          <ClipboardText size={18} />
          本轮工程清单
        </h3>
        <span className="scope-badge">{stale ? "尚未更新" : "已保存配置"}</span>
      </div>
      {stale && (
        <p className="input-error">
          需求已有修改，下面是上次保存的清单；保存后会重新检查。
        </p>
      )}
      <div className="manifest-modules">
        {manifest.modules.map((m) => (
          <article key={m.id}>
            <strong>{m.label}</strong>
            <p>
              {m.role ||
                (m.id === "connection"
                  ? "两端收发同一关节、模型与协议标识"
                  : "本机模拟设备，不接实体引脚")}
            </p>
            <small>
              {m.runtime ||
                (m.id === "connection"
                  ? "串口消息格式 · 主机虚拟串口"
                  : "实物输入输出：本轮关闭")}
            </small>
            {m.fqbn && <small>编译目标 {m.fqbn}</small>}
            {m.ai_file && <code>{m.ai_file}</code>}
          </article>
        ))}
      </div>
      <p className="manifest-verdict">
        {stale
          ? "等待重新检查"
          : manifest.preflight?.passed === true
            ? `配置检查通过 · ${checks.filter((c) => c.passed === true).length} / ${checks.length} 项`
            : "配置检查未通过"}
        <small>只检查配置是否配套，不等于编译或运行通过。</small>
      </p>
      <details>
        <summary>查看配置检查与版本</summary>
        <ul>
          {checks.map((c) => (
            <li key={c.id}>
              <strong>
                {c.passed === true ? "✓" : "×"} {c.label}
              </strong>
              <p>{c.detail}</p>
            </li>
          ))}
        </ul>
        <p>
          ROS {manifest.dependencies?.ros_distro} · ESP32 核心{" "}
          {manifest.dependencies?.esp32_core} · ArduinoJson{" "}
          {manifest.dependencies?.arduinojson}
        </p>
        <p>
          清单标识{" "}
          <code title={manifest.hash}>{manifest.hash?.slice(0, 16)}</code>
        </p>
      </details>
      <details>
        <summary>
          接实物前还缺什么 · {manifest.missing_for_hardware.length} 项
        </summary>
        <ul>
          {manifest.missing_for_hardware.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
