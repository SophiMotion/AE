export type GuideOption = {
  value: string;
  label: string;
  description: string;
  recommended?: boolean;
};

export default function GuideOptions({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  options: GuideOption[];
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="guide-choice-field">
      <span className="guide-choice-label">{label}</span>
      <div className="guide-choice-list" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`guide-choice ${value === option.value ? "selected" : ""}`}
            aria-pressed={value === option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            <span className="guide-choice-heading">
              <strong>{option.label}</strong>
              {option.recommended && (
                <small className="choice-recommended">推荐</small>
              )}
            </span>
            <span className="guide-choice-description">
              {option.description}
            </span>
            {value === option.value && (
              <span className="choice-current">已选</span>
            )}
          </button>
        ))}
        <button
          type="button"
          className={`guide-choice guide-choice-unknown ${value === null ? "selected" : ""}`}
          aria-pressed={value === null}
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          <strong>还不确定</strong>
          <span className="guide-choice-description">
            先留待确认，之后再补。
          </span>
          {value === null && <span className="choice-current">已选</span>}
        </button>
      </div>
    </div>
  );
}
