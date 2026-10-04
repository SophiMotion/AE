import { useEffect, useState } from "react";
import {
  CheckCircle,
  CircleNotch,
  GearSix,
  Key,
  Terminal,
} from "@phosphor-icons/react";
import { api, isPublicDemo, type Settings as SettingsData } from "./api";
export default function Settings({
  settings,
  onSaved,
}: {
  settings: SettingsData | null;
  onSaved: (value: SettingsData) => void;
}) {
  const [provider, setProvider] = useState<"codex" | "openai">(
    settings?.provider || "codex",
  );
  const [model, setModel] = useState(settings?.model || "");
  const [url, setUrl] = useState(settings?.base_url || "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (settings) {
      setProvider(settings.provider);
      setModel(settings.model || "");
      setUrl(settings.base_url || "");
    }
  }, [settings]);
  const save = async () => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const next = await api<SettingsData>(
        "/settings",
        { provider, model, base_url: url, ...(key ? { api_key: key } : {}) },
        "PUT",
      );
      onSaved(next);
      setKey("");
      setMessage("已保存。下一次 AI 调用使用这套设置。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (isPublicDemo) return <div className="settings-page">
    <header className="page-heading"><div><h1>AI 服务与使用范围</h1><p>完整平台支持切换服务；分享版展示配置方法。</p></div><GearSix size={28} /></header>
    <section className="panel settings-panel">
      <h2>本机 Codex / 兼容 OpenAI 的 API 服务</h2>
      <p>在完整本机平台中选择服务、填写模型，再由后台调用。这里不连接你的电脑，也不接收或保存 API 密钥。</p>
      <div className="notice"><div><strong>此分享版可以做什么</strong><p>体验 PRD、保存浏览器草稿、查看分工与通信说明、回放已有模型轨迹、浏览公开资料和源码。</p></div></div>
      <div className="notice"><div><strong>实际生成、编译和运行</strong><p>下载仓库源码，按 README 在本机部署 Python 后台、ROS 和编译环境，完成填写、人工核对和验收。</p></div></div>
      <a className="button primary" href="https://github.com/SophiMotion/AE#readme" target="_blank" rel="noreferrer">查看本机部署说明</a>
    </section>
  </div>;
  return (
    <div className="settings-page">
      <header className="page-heading">
        <div>
          <h1>AI 服务</h1>
          <p>界面与工程流程保持一致，模型服务可以切换。</p>
        </div>
        <GearSix size={28} />
      </header>
      <section className="panel settings-panel">
        <div className="provider-choices">
          <button
            className={provider === "codex" ? "selected" : ""}
            onClick={() => setProvider("codex")}
          >
            <Terminal size={24} />
            <strong>本机 Codex</strong>
            <span>复用这台电脑已有的 CLI 登录</span>
          </button>
          <button
            className={provider === "openai" ? "selected" : ""}
            onClick={() => setProvider("openai")}
          >
            <Key size={24} />
            <strong>兼容 OpenAI 的接口</strong>
            <span>填写服务地址、模型和密钥</span>
          </button>
        </div>
        {provider === "codex" ? (
          <div className="notice">
            <Terminal size={19} />
            <span>
              {settings?.codex_available
                ? "已检测到本机 Codex CLI。实际调用结果以任务日志为准。"
                : "暂未检测到可用的 Codex CLI，请检查本机安装与登录。"}
              <br />
              适合先在本机把流程跑通；之后可切换 API 服务。
            </span>
          </div>
        ) : (
          <>
            <label className="field">
              <span>服务地址</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>
                API 密钥{" "}
                <small>
                  {settings?.key_configured
                    ? "已有配置，留空则保留"
                    : "尚未配置"}
                </small>
              </span>
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={
                  settings?.key_configured
                    ? "留空保留已有密钥"
                    : "仅在这里输入，不会在界面回显"
                }
                autoComplete="new-password"
              />
            </label>
          </>
        )}
        <label className="field">
          <span>模型名称</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={
              provider === "codex"
                ? "留空使用 Codex 默认模型"
                : "填写服务提供商支持的模型 ID"
            }
          />
        </label>
        <p className="field-hint">
          每次调用都会记录实际工具、模型、提示词和资料来源，便于复查。
          {provider === "openai" && (
            <>
              <br />
              {settings?.key_storage ||
                "密钥只在当前后台进程中保留，重启后需要重新输入。"}
            </>
          )}
        </p>
        {error && <div className="notice warning">{error}</div>}
        {message && (
          <div className="notice success">
            <CheckCircle size={19} />
            {message}
          </div>
        )}
        <div className="form-actions">
          <button className="button primary" disabled={busy} onClick={save}>
            {busy ? <CircleNotch className="spin" size={17} /> : null}保存设置
          </button>
        </div>
      </section>
    </div>
  );
}
