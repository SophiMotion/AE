import { useEffect, useId, useRef, useState } from "react";
import { formatDisplayNumber, parseDisplayNumber } from "./intakeGuide";
import { matchesNumberChoice, type NumberChoice } from "./intakeChoices";
export default function GuideNumber({
  label,
  value,
  unit,
  suffix,
  disabled,
  hint,
  suggested,
  source,
  choices = [],
  onChange,
}: {
  label: string;
  value: number | null;
  unit: "deg" | "rad" | "number";
  suffix: string;
  disabled: boolean;
  hint?: string;
  suggested: boolean;
  source?: { label: string; reason: string } | null;
  choices?: NumberChoice[];
  onChange: (value: number | null) => void;
}) {
  const inputId = useId();
  const [text, setText] = useState(() => formatDisplayNumber(value, unit));
  const emitted = useRef(value),
    previousUnit = useRef(unit);
  useEffect(() => {
    if (previousUnit.current !== unit || !Object.is(value, emitted.current)) {
      setText(formatDisplayNumber(value, unit));
      emitted.current = value;
    }
    previousUnit.current = unit;
  }, [value, unit]);
  return (
    <div className="field guide-number-field">
      <label className="guide-number-label" htmlFor={inputId}>
        {label}
        <small>{suffix}</small>
      </label>
      {!!choices.length && (
        <>
          <div
            className="guide-choice-list numeric-choices"
            role="group"
            aria-label={`${label}的选项`}
          >
            {choices.map((choice) => (
              <button
                key={choice.value}
                type="button"
                disabled={disabled}
                className={`guide-choice ${matchesNumberChoice(value, choice.value) ? "selected" : ""}`}
                aria-pressed={matchesNumberChoice(value, choice.value)}
                onClick={() => {
                  emitted.current = choice.value;
                  setText(formatDisplayNumber(choice.value, unit));
                  onChange(choice.value);
                }}
              >
                <span className="guide-choice-heading">
                  <strong>{choice.label}</strong>
                  {choice.recommended && (
                    <small className="choice-recommended">推荐</small>
                  )}
                </span>
                <span className="guide-choice-description">
                  {choice.description}
                </span>
                {matchesNumberChoice(value, choice.value) && (
                  <span className="choice-current">当前值</span>
                )}
              </button>
            ))}
          </div>
          <small className="guide-choice-help">
            可修改的本机草稿示例，点击后填入。也可以在下面直接输入自己的数值。
          </small>
        </>
      )}
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        aria-label={label}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const next = parseDisplayNumber(e.target.value, unit);
          emitted.current = next;
          onChange(next);
        }}
        placeholder="待填写"
      />
      {hint && <small>{hint}</small>}
      <small className="guide-value-source">
        {value === null
          ? "还没确定"
          : source
            ? source.label
            : suggested
              ? "已采用平台建议"
              : "你填写的"}
        {value !== null && unit === "deg"
          ? ` · 程序值 ${Number(value.toPrecision(8))} rad${suffix.endsWith("/s") ? "/s" : ""}`
          : ""}
      </small>
      {source && (
        <small className="recommendation-reason">{source.reason}</small>
      )}
    </div>
  );
}
