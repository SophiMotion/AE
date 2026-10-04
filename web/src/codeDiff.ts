export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
  before?: number;
  after?: number;
}

/** Compare actual saved source; never use the model's explanation as a diff. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const lines = (source: string) =>
    source === "" ? [] : source.replace(/\r\n/g, "\n").split("\n");
  const a = lines(before),
    b = lines(after);
  // Large imported sources still get an exact, bounded replace-all display.
  if (a.length * b.length > 1_000_000)
    return [
      ...a.map((text, index) => ({
        kind: "removed" as const,
        text,
        before: index + 1,
      })),
      ...b.map((text, index) => ({
        kind: "added" as const,
        text,
        after: index + 1,
      })),
    ];
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i * width + j] =
        a[i] === b[j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
  const result: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      result.push({ kind: "same", text: a[i], before: ++i, after: ++j });
    } else if (
      i < a.length &&
      (j === b.length ||
        lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
    ) {
      result.push({ kind: "removed", text: a[i], before: ++i });
    } else {
      result.push({ kind: "added", text: b[j], after: ++j });
    }
  }
  return result;
}

export function deploymentConfirmationKey(
  run: {
    id: string;
    integrity?: { fingerprint?: string } | null;
    approval?: { spec_hash?: string; plan_id?: string } | null;
    spec_snapshot?: {
      spec_revision?: number;
      manifest?: { hash?: string } | null;
    };
  } | null,
): string {
  return run
    ? JSON.stringify([
        run.id,
        run.integrity?.fingerprint || "",
        run.approval?.spec_hash || "",
        run.approval?.plan_id || "",
        run.spec_snapshot?.spec_revision,
        run.spec_snapshot?.manifest?.hash,
      ])
    : "";
}
