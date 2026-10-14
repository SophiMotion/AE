import type { FoldBotDraft } from "./foldbotApi.ts";
import { normalizeGuidedConfig } from "./guidedFlow.ts";
import { normalizeFoldBotDraftFlow } from "./foldbotFlow.ts";
import {
  defaultProjectGraphs,
  validateProjectGraphs,
} from "./projectGraphs.ts";

export type CanvasPositions = Record<string, { x: number; y: number }>;
export type ProjectEditorLayout = {
  wiring: CanvasPositions;
  behavior: CanvasPositions;
};
export const emptyEditorLayout = (): ProjectEditorLayout => ({
  wiring: {},
  behavior: {},
});
export const graphLayoutKey = (cacheKey: string) =>
  `ae.graph.layout.v1.${cacheKey}`;

export function validateEditorLayout(
  value: unknown,
): value is ProjectEditorLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join() !== "behavior,wiring") return false;
  return [object.wiring, object.behavior].every((positions) => {
    if (!positions || typeof positions !== "object" || Array.isArray(positions))
      return false;
    const entries = Object.entries(positions);
    return (
      entries.length <= 600 &&
      entries.every(([id, position]) => {
        if (
          !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
          ["__proto__", "constructor", "prototype"].includes(id)
        )
          return false;
        if (
          !position ||
          typeof position !== "object" ||
          Array.isArray(position)
        )
          return false;
        const point = position as Record<string, unknown>;
        return (
          Object.keys(point).sort().join() === "x,y" &&
          [point.x, point.y].every(
            (number) =>
              typeof number === "number" &&
              Number.isFinite(number) &&
              Math.abs(number) <= 100000,
          )
        );
      })
    );
  });
}

export function readEditorLayout(cacheKey: string): ProjectEditorLayout {
  try {
    const value = JSON.parse(
      localStorage.getItem(graphLayoutKey(cacheKey)) ?? "null",
    );
    return validateEditorLayout(value) ? value : emptyEditorLayout();
  } catch {
    return emptyEditorLayout();
  }
}

export function exportGraphDocument(
  draft: FoldBotDraft,
  editor_layout: ProjectEditorLayout,
) {
  return {
    kind: "ae_project_graphs",
    schema_version: 1,
    draft: { ...draft, graphs: draft.graphs ?? defaultProjectGraphs(draft) },
    editor_layout,
  };
}

/** Import plans as new drafts; imported approval and live-device evidence are never trusted. */
export function parseGraphDocument(text: string): {
  draft: FoldBotDraft;
  editor_layout: ProjectEditorLayout;
} {
  if (text.length > 1024 * 1024) throw new Error("graph_document_too_large");
  const document = JSON.parse(text);
  if (
    !document ||
    Object.keys(document).sort().join() !==
      "draft,editor_layout,kind,schema_version" ||
    document.kind !== "ae_project_graphs" ||
    document.schema_version !== 1 ||
    !validateEditorLayout(document.editor_layout)
  )
    throw new Error("invalid_graph_document");
  const value = document.draft;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "name",
          "request",
          "drive_level",
          "drive_duration_ms",
          "workflow",
          "guided",
          "graphs",
        ].includes(key),
    ) ||
    !validateProjectGraphs(value.graphs) ||
    typeof value.name !== "string" ||
    typeof value.request !== "string" ||
    value.name.length > 120 ||
    value.request.length > 12000 ||
    value.name.includes("\0") ||
    value.request.includes("\0") ||
    !Number.isInteger(value.drive_level) ||
    value.drive_level < 1 ||
    value.drive_level > 20 ||
    !Number.isInteger(value.drive_duration_ms) ||
    value.drive_duration_ms < 1 ||
    value.drive_duration_ms > 2000
  )
    throw new Error("invalid_graph_draft");
  const draft: FoldBotDraft = {
    name: value.name,
    request: value.request,
    drive_level: value.drive_level,
    drive_duration_ms: value.drive_duration_ms,
    workflow: {
      ...normalizeFoldBotDraftFlow(value.workflow),
      wiring_reviewed: false,
    },
    guided: {
      ...normalizeGuidedConfig(value.guided),
      wiring_binding_sha256: null,
    },
    graphs: value.graphs,
  };
  return { draft, editor_layout: document.editor_layout };
}
