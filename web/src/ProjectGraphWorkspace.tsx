import { lazy, Suspense, useMemo } from "react";
import {
  Circuitry,
  FlowArrow,
  ListChecks,
  DownloadSimple,
} from "@phosphor-icons/react";
import { useI18n } from "./i18n";
import type { FoldBotDraft } from "./foldbotApi";
import { defaultProjectGraphs, type ProjectGraphs } from "./projectGraphs";
import type { ProjectEditorLayout } from "./projectGraphDocument";
import "./projectGraphWorkspace.css";

const HardwareGraphCanvas = lazy(() => import("./HardwareGraphCanvas"));
const ProcessGraphCanvas = lazy(() => import("./ProcessGraphCanvas"));
export type GraphWorkspaceView = "process" | "hardware" | "form";

export default function ProjectGraphWorkspace({
  draft,
  layout,
  view,
  disabled,
  onViewChange,
  onDraftPatch,
  onGraphsChange,
  onLayoutChange,
  onOpenStage,
  onExport,
}: {
  draft: FoldBotDraft;
  layout: ProjectEditorLayout;
  view: GraphWorkspaceView;
  disabled: boolean;
  onViewChange: (view: GraphWorkspaceView) => void;
  onDraftPatch: (patch: Partial<FoldBotDraft>) => void;
  onGraphsChange: (graphs: ProjectGraphs) => void;
  onLayoutChange: (layout: ProjectEditorLayout) => void;
  onOpenStage: (index: number) => void;
  onExport: () => void;
}) {
  const { t } = useI18n();
  const graphs = useMemo(
    () => draft.graphs ?? defaultProjectGraphs(draft),
    [draft],
  );
  return (
    <section
      className="project-graph-workspace"
      aria-label={t("工程画布", "Project canvases")}
    >
      <div className="project-graph-toolbar">
        <div
          role="group"
          aria-label={t("编辑方式", "Editing view")}
          className="project-graph-tabs"
        >
          <button
            type="button"
            aria-pressed={view === "process"}
            disabled={disabled}
            onClick={() => onViewChange("process")}
          >
            <FlowArrow size={18} />
            {t("流程画布", "Process canvas")}
          </button>
          <button
            type="button"
            aria-pressed={view === "hardware"}
            disabled={disabled}
            onClick={() => onViewChange("hardware")}
          >
            <Circuitry size={18} />
            {t("硬件画布", "Hardware canvas")}
          </button>
          <button
            type="button"
            aria-pressed={view === "form"}
            disabled={disabled}
            onClick={() => onViewChange("form")}
          >
            <ListChecks size={18} />
            {t("表单引导", "Guided forms")}
          </button>
        </div>
        <button
          type="button"
          className="project-graph-export"
          onClick={onExport}
        >
          <DownloadSimple size={17} />
          {t("导出工程 JSON", "Export project JSON")}
        </button>
      </div>
      {view !== "form" && (
        <>
          <p className="project-graph-intro">
            {view === "process"
              ? t(
                  "拖入步骤，连接顺序，点击节点填写参数。画布与表单使用同一份需求。",
                  "Drag in steps, connect them and click a node to edit. The canvas and forms share one requirement.",
                )
              : t(
                  "拖入元件，连接端口，检查每根线。元件名称和连接随工程自动保存。",
                  "Drag in components, wire their ports and inspect each connection. Components and wires autosave with the project.",
                )}
          </p>
          <Suspense
            fallback={
              <div className="project-graph-loading" role="status">
                {t("正在打开画布…", "Opening canvas…")}
              </div>
            }
          >
            {view === "process" ? (
              <ProcessGraphCanvas
                draft={draft}
                graphs={graphs}
                layout={layout.behavior}
                disabled={disabled}
                onDraftPatch={onDraftPatch}
                onGraphsChange={onGraphsChange}
                onLayoutChange={(behavior) =>
                  onLayoutChange({ ...layout, behavior })
                }
                onOpenStage={onOpenStage}
              />
            ) : (
              <HardwareGraphCanvas
                draft={draft}
                graphs={graphs}
                layout={layout.wiring}
                disabled={disabled}
                onDraftPatch={onDraftPatch}
                onGraphsChange={onGraphsChange}
                onLayoutChange={(wiring) =>
                  onLayoutChange({ ...layout, wiring })
                }
              />
            )}
          </Suspense>
          <p className="project-graph-boundary">
            {t(
              "画布编辑方案；程序部署和真机操作在后续步骤明确执行。",
              "The canvas edits the plan. Deployment and physical operation are explicit actions in later stages.",
            )}
          </p>
        </>
      )}
    </section>
  );
}
