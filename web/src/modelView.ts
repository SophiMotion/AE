import type { Project, Structure } from "./api";
export function jointBounds(joint?: Structure["joints"][number]) {
  return {
    lower: Math.max(
      -2 * Math.PI,
      joint?.lower ?? joint?.limits?.lower ?? -2 * Math.PI,
    ),
    upper: Math.min(
      2 * Math.PI,
      joint?.upper ?? joint?.limits?.upper ?? 2 * Math.PI,
    ),
  };
}
export function snapshotStructure(spec: Project): Structure | null {
  const model = spec.execution_model;
  if (!model) return spec.structure || null;
  return {
    ...spec.structure,
    id: model.model_id,
    name: spec.structure?.name || model.model_id,
    format: spec.structure?.format || "execution-snapshot",
    links: model.links,
    joints: model.joints.map((j) => ({
      ...j,
      xyz: j.origin?.xyz || j.xyz,
      rpy: j.origin?.rpy || j.rpy,
      lower: j.limits?.lower ?? j.lower,
      upper: j.limits?.upper ?? j.upper,
    })),
    warnings: spec.structure?.warnings || [],
    assumptions: model.assumptions,
    provenance: model.provenance,
    model_sha256: model.model_sha256,
  };
}
