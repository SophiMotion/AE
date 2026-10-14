import { CircleNotch, Microphone, Stop } from "@phosphor-icons/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import {
  appendSpeechText,
  createSpeechSession,
  getSpeechRecognitionConstructor,
  type SpeechEndReason,
  type SpeechState,
} from "./speechInput";

type Props = {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  rows?: number;
  note?: string;
  hint?: string;
  overflow: string;
  onOverflowChange: (text: string) => void;
};

/** Only final speech text enters the existing draft update path. */
export default function RequestInput({
  value,
  onChange,
  disabled,
  placeholder,
  rows = 4,
  note,
  hint,
  overflow,
  onOverflowChange,
}: Props) {
  const { locale, t } = useI18n();
  const id = useId();
  const latest = useRef({ value, onChange, disabled, onOverflowChange });
  const session = useRef<ReturnType<typeof createSpeechSession> | null>(null);
  const overflowRef = useRef(overflow);
  const [state, setState] = useState<SpeechState>("idle");
  const [reason, setReason] = useState<SpeechEndReason | null>(null);
  const [interim, setInterim] = useState("");
  const [language, setLanguage] = useState("auto");
  const [sessionLanguage, setSessionLanguage] = useState("zh-CN");
  const active = state !== "idle";
  const Recognition = getSpeechRecognitionConstructor(window);
  const secure = window.isSecureContext !== false;
  const available = secure && !!Recognition;

  useLayoutEffect(() => {
    latest.current = { value, onChange, disabled, onOverflowChange };
    overflowRef.current = overflow;
    if (disabled) session.current?.cancel();
  }, [value, onChange, disabled, overflow, onOverflowChange]);

  useEffect(() => {
    const cancel = () => session.current?.cancel();
    const onVisibility = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", cancel);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", cancel);
      session.current?.dispose();
      session.current = null;
    };
  }, []);

  function update(next: string) {
    latest.current.value = next;
    latest.current.onChange(next);
  }

  function toggleVoice() {
    if (session.current) {
      session.current.stop();
      return;
    }
    if (!available || !Recognition || disabled || overflowRef.current) return;
    const lang =
      language === "auto" ? (locale === "en" ? "en-US" : "zh-CN") : language;
    setSessionLanguage(lang);
    setReason(null);
    setInterim("");
    const next = createSpeechSession({
      createRecognition: () => new Recognition(),
      onState: setState,
      onInterim: setInterim,
      onFinal: (text) => {
        if (latest.current.disabled) return false;
        const appended = appendSpeechText(latest.current.value, text);
        if (overflowRef.current || appended.overflow) {
          overflowRef.current = [overflowRef.current, text.trim()]
            .filter(Boolean)
            .join("\n");
          latest.current.onOverflowChange(overflowRef.current);
          return false;
        }
        if (appended.value !== latest.current.value) update(appended.value);
        return true;
      },
      onEnd: (endReason) => {
        if (session.current === next) session.current = null;
        setReason(endReason);
      },
    });
    session.current = next;
    next.start(lang);
  }

  function statusText() {
    if (state === "starting")
      return t(
        "正在请求麦克风，请允许浏览器使用麦克风。",
        "Requesting the microphone. Allow microphone access in your browser.",
      );
    if (state === "listening")
      return sessionLanguage === "zh-CN"
        ? t(
            "正在听普通话，再点按钮结束。",
            "Listening in Mandarin. Press the button again to finish.",
          )
        : t(
            "正在听英语，再点按钮结束。",
            "Listening in English. Press the button again to finish.",
          );
    if (state === "stopping")
      return t(
        "正在结束，等待最后的识别文字…",
        "Finishing and waiting for the final words…",
      );
    if (overflow)
      return t(
        "已停止语音输入，请先处理下方未填入的文字。",
        "Voice input stopped. Review the words below that could not be added.",
      );
    switch (reason) {
      case "done":
        return t(
          "语音文字已填入，请检查并修改后再继续。",
          "Speech text added. Review and edit it before continuing.",
        );
      case "cancelled":
        return t(
          "语音输入已停止，已填入的文字已保留。",
          "Voice input stopped. Text already added has been kept.",
        );
      case "not-allowed":
      case "service-not-allowed":
        return t(
          "麦克风或语音服务权限未获允许。请检查浏览器权限，或使用输入法的语音输入。",
          "Microphone or speech-service access was denied. Check browser permissions or use your keyboard's dictation.",
        );
      case "audio-capture":
        return t(
          "未能使用麦克风。请检查连接、系统权限和其他应用是否占用。",
          "The microphone is unavailable. Check its connection, system permissions and other apps using it.",
        );
      case "network":
        return t(
          "语音识别服务连接失败。请检查网络，或使用输入法的语音输入。",
          "The speech service could not connect. Check your network or use your keyboard's dictation.",
        );
      case "no-speech":
        return t(
          "没有识别到清晰的语音，请靠近麦克风再试一次。",
          "No clear speech was recognized. Move closer to the microphone and try again.",
        );
      case "language-not-supported":
        return t(
          "当前语音服务不支持所选语言，请更换语言或使用输入法。",
          "The speech service does not support this language. Choose another language or use keyboard dictation.",
        );
      case "start-timeout":
        return t(
          "浏览器没有启动语音服务。请检查权限；微信内可尝试在系统浏览器打开，或使用输入法语音输入。",
          "The browser did not start its speech service. Check permissions; in WeChat, try your system browser or keyboard dictation.",
        );
      case "stop-timeout":
        return t(
          "语音服务未及时结束，已停止监听。请检查已填入的文字，必要时重试。",
          "The speech service did not finish in time and listening was stopped. Review the text and retry if needed.",
        );
      case "unsupported":
      case "unknown":
        return t(
          "当前浏览器未能完成语音输入。可以重试，或使用系统输入法的语音功能。",
          "Voice input could not complete in this browser. Retry or use your system keyboard's dictation.",
        );
      default:
        return "";
    }
  }

  return (
    <div className="field request-field voice-request-field">
      <div className="request-input-heading">
        <label htmlFor={id} className="request-input-label">
          {t("你希望机器人做什么", "What should the robot do?")}
          {note && <small>{note}</small>}
        </label>
        <div className="voice-controls">
          <label className="sr-only" htmlFor={`${id}-language`}>
            {t("语音识别语言", "Speech language")}
          </label>
          <select
            id={`${id}-language`}
            value={language}
            disabled={disabled || active || !available}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="auto">
              {t("跟随界面语言", "Interface language")}
            </option>
            <option value="zh-CN">{t("普通话", "Mandarin")}</option>
            <option value="en-US">English</option>
          </select>
          <button
            type="button"
            className={`button secondary voice-button${active ? " listening" : ""}`}
            aria-pressed={active}
            aria-controls={id}
            disabled={
              disabled ||
              !available ||
              state === "stopping" ||
              (!active && !!overflow)
            }
            onClick={toggleVoice}
          >
            {state === "stopping" ? (
              <CircleNotch size={18} className="spin" />
            ) : active ? (
              <Stop size={18} weight="fill" />
            ) : (
              <Microphone size={18} />
            )}
            {active
              ? t("停止语音", "Stop dictation")
              : t("语音输入", "Voice input")}
          </button>
        </div>
      </div>
      <textarea
        id={id}
        data-intake-path="request"
        aria-label={t("你希望机器人做什么", "What should the robot do?")}
        aria-describedby={`${id}-help ${id}-status`}
        rows={rows}
        maxLength={4000}
        value={value}
        disabled={disabled}
        onChange={(e) => update(e.target.value)}
        placeholder={placeholder}
      />
      <small className="char-count">{value.length} / 4000</small>
      {hint && <small>{hint}</small>}
      <p id={`${id}-help`} className="voice-help">
        {!secure
          ? t(
              "请通过 HTTPS 或本机 localhost 地址打开，才能使用麦克风。",
              "Open this page over HTTPS or localhost to use the microphone.",
            )
          : !available
            ? t(
                "此浏览器不支持网页语音识别。可以点输入框，使用手机输入法的麦克风，或尝试系统浏览器。",
                "This browser does not support web speech recognition. Use the microphone on your phone keyboard or try your system browser.",
              )
            : t(
                "每次最多听写 2 分钟，文字追加到现有需求。识别由浏览器提供，可能联网处理语音；本站不保存音频。",
                "Dictate up to 2 minutes at a time and append to your request. Your browser may use an online speech service; this site does not save audio.",
              )}
      </p>
      <p
        id={`${id}-status`}
        className="voice-status"
        role="status"
        aria-live="polite"
      >
        {statusText()}
      </p>
      {interim && (
        <div className="voice-preview">
          <small>
            {t("正在识别，尚未填入", "Recognizing — not added yet")}
          </small>
          <p>{interim}</p>
        </div>
      )}
      {overflow && (
        <div className="voice-overflow">
          <label htmlFor={`${id}-overflow`}>
            {t(
              "输入框已满，以下文字尚未填入",
              "The request is full. These words have not been added",
            )}
          </label>
          <textarea id={`${id}-overflow`} value={overflow} readOnly rows={3} />
          <small>
            {t(
              "可以选中文字复制，整理需求后再粘贴。暂存文字未保存，刷新或关闭页面前请先处理。",
              "Copy these words, then edit your request before pasting. These remaining words are not saved; handle them before reloading or closing the page.",
            )}
          </small>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              overflowRef.current = "";
              onOverflowChange("");
              setReason(null);
            }}
          >
            {t("已处理，清空暂存文字", "Handled — clear remaining words")}
          </button>
        </div>
      )}
    </div>
  );
}
