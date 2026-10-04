import { printable, type RequirementCoverage as Coverage } from "./api";

const labels = {
  covered: "有自动检查",
  manual_review: "仅人工核对",
  unsupported: "当前不支持",
  conflict: "与参数冲突",
};

export default function RequirementCoverage({
  coverage,
}: {
  coverage?: Coverage;
}) {
  if (!coverage)
    return (
      <div className="notice">
        这份历史计划未保存逐条验收对应关系。重新拆分后可以查看。
      </div>
    );
  return (
    <section className="coverage-panel" aria-label="需求与验收对应表">
      <div className="section-intro">
        <div>
          <h3>这些要求，程序会检查哪些</h3>
          <p>{coverage.scope}</p>
        </div>
      </div>
      <div className="coverage-items ai-content">
        <p className="ai-label">
          AI 对文字需求的逐项对照 · 请人工核对，不是已经通过的结果
        </p>
        {coverage.items.map((item) => (
          <article key={item.id} className={`coverage-item ${item.status}`}>
            <span className="coverage-status">{labels[item.status]}</span>
            <div>
              <strong>{item.text}</strong>
              <p>{item.reason}</p>
              {!!item.check_ids.length && (
                <small>
                  对应检查：
                  {item.check_ids
                    .map(
                      (id) =>
                        coverage.checks.find((check) => check.id === id)
                          ?.label || id,
                    )
                    .join("、")}
                </small>
              )}
            </div>
          </article>
        ))}
      </div>
      <p className="field-hint">
        {coverage.review_note ||
          "列入自动检查只代表有检查办法，还需等实际运行结果。仅人工核对的文字要求不能算自动验收通过。"}
      </p>
      <details className="source-details">
        <summary>本轮工具实际检查什么 · 后台固定条件</summary>
        {coverage.checks.map((check) => (
          <div key={check.id}>
            <strong>{check.label}</strong>
            <pre>{printable(check.expected)}</pre>
          </div>
        ))}
      </details>
    </section>
  );
}
