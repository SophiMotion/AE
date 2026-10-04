import assert from "node:assert/strict";
import test from "node:test";
import { lineDiff, deploymentConfirmationKey } from "../src/codeDiff.ts";

test("修复分号保留准确的增加删除行，未改Python无虚构差异", () => {
  const rows = lineDiff(
    "double f(){\n  return 0\n}",
    "double f(){\n  return 0;\n}",
  );
  assert.deepEqual(
    rows.filter((x) => x.kind !== "same"),
    [
      { kind: "removed", text: "  return 0", before: 2 },
      { kind: "added", text: "  return 0;", after: 2 },
    ],
  );
  assert.equal(
    lineDiff("return 1", "return 1").filter((x) => x.kind !== "same").length,
    0,
  );
});
test("空文档、CRLF、重复行和末行换行能重建真实两版", () => {
  for (const [a, b] of [
    ["", "a"],
    ["a\r\na\r\n", "a\nb\na\n"],
    ["a", ""],
    ["a\n", "a"],
  ]) {
    const rows = lineDiff(a, b);
    assert.equal(
      rows
        .filter((x) => x.kind !== "added")
        .map((x) => x.text)
        .join("\n"),
      a.replace(/\r\n/g, "\n"),
    );
    assert.equal(
      rows
        .filter((x) => x.kind !== "removed")
        .map((x) => x.text)
        .join("\n"),
      b,
    );
  }
});
test("部署勾选必须绑定运行、规格摘要和批准，不能跨版本复用", () => {
  const run = {
    id: "one",
    approval: { spec_hash: "approved", plan_id: "plan" },
    spec_snapshot: { spec_revision: 1, manifest: { hash: "manifest" } },
  };
  for (const changed of [
    { ...run, id: "two" },
    { ...run, approval: { ...run.approval, spec_hash: "new" } },
    { ...run, approval: { ...run.approval, plan_id: "new" } },
    { ...run, spec_snapshot: { ...run.spec_snapshot, spec_revision: 2 } },
  ])
    assert.notEqual(
      deploymentConfirmationKey(run),
      deploymentConfirmationKey(changed),
    );
});
