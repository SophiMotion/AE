import { useI18n } from "./i18n";
import { t } from "./localeStore";
import "./i18nCore";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CircleNotch,
  Cube,
  UploadSimple,
} from "@phosphor-icons/react";
import { api, isPublicDemo, type Run, type Structure } from "./api";
import { jointBounds, snapshotStructure } from "./modelView";
const StructureView = lazy(() => import("./StructureView"));
export default function StructurePanel({
  id,
  jointName,
  jointLabel = "本轮控制的关节",
  target,
  locked,
  onChange,
  onBusyChange,
  onStructure,
}: {
  id: string | null;
  jointName: string | null;
  jointLabel?: string;
  target: number;
  locked: boolean;
  onChange: (id: string | null, jointName: string | null) => void;
  onBusyChange?: (busy: boolean) => void;
  onStructure?: (value: Structure | null) => void;
}) {
  const { locale } = useI18n();

  const [items, setItems] = useState<Structure[]>([]);
  const [structure, setStructure] = useState<Structure | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const change = useRef(onChange);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  change.current = onChange;
  useEffect(() => {
    let live = true;
    api<{ items: Structure[] }>("/structures")
      .then((data) => {
        if (live) setItems(data.items);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setStructure(null);
    setError("");
    if (!id) return;
    api<Structure>(`/structures/${encodeURIComponent(id)}`)
      .then((data) => {
        if (live) {
          setStructure(data);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    onStructure?.(structure);
  }, [structure, onStructure]);
  const selectedJoint = structure?.joints.find((j) => j.name === jointName);
  const bounds = jointBounds(selectedJoint);
  const importFile = async (selected: File) => {
    setUploading(true);
    onBusyChange?.(true);
    setError("");
    try {
      if (selected.size > 4_000_000)
        throw new Error(
          "结构配置不能超过 4 MB。请上传配置 JSON 或 URDF，而不是完整 STEP。",
        );
      const created = await api<Structure>("/structures", {
        filename: selected.name,
        content: await selected.text(),
      });
      if (!active.current) return;
      setItems((previous) => [
        ...previous.filter((x) => x.id !== created.id),
        created,
      ]);
      change.current(created.id, null);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      if (active.current) {
        setUploading(false);
        onBusyChange?.(false);
        if (file.current) file.current.value = "";
      }
    }
  };
  return (
    <div className="structure-panel">
      <div className="section-intro">
        <div>
          <h3>{t("结构与关节")}</h3>
          <p>{t("选择测试模型，或导入结构站保存的配置。")}</p>
        </div>
        <button
          className="button secondary"
          disabled={locked || uploading || isPublicDemo}
          title={
            isPublicDemo
              ? t("自定义结构导入在完整本机平台使用；此页可选择公开参考模型")
              : undefined
          }
          onClick={() => file.current?.click()}
        >
          {uploading ? (
            <CircleNotch className="spin" size={16} />
          ) : (
            <UploadSimple size={16} />
          )}
          {isPublicDemo ? t("导入结构（本机功能）") : t("导入结构")}
        </button>
        <input
          ref={file}
          hidden
          type="file"
          accept=".json,.urdf,.xml"
          aria-label={t("导入结构文件")}
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) void importFile(selected);
          }}
        />
      </div>
      <div className="structure-selectors">
        <label className="field">
          <span>{t("结构模型")}</span>
          <select
            aria-label={t("结构模型")}
            disabled={locked || loading || uploading}
            value={id || ""}
            onChange={(e) => {
              onChange(e.target.value || null, null);
            }}
          >
            <option value="">{t("还没选择结构")}</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t(jointLabel)}</span>
          <select
            aria-label={t(jointLabel)}
            disabled={
              locked || !structure?.joints?.some((j) => j.type !== "fixed")
            }
            value={jointName || ""}
            onChange={(e) => onChange(id, e.target.value || null)}
          >
            <option value="">{t("请选择关节")}</option>
            {structure?.joints
              ?.filter((j) => j.type !== "fixed")
              .map((j) => (
                <option key={j.name} value={j.name}>
                  {j.label || j.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {error && <div className="notice warning">{t(error)}</div>}
      {selectedJoint && (
        <div className="joint-facts">
          <strong>{selectedJoint.label || selectedJoint.name}</strong>
          <span>
            {t("初始姿态")}
            {(selectedJoint.initial_position || 0).toFixed(3)} rad
          </span>
          <span>
            {t("范围")}
            {bounds.lower.toFixed(3)} ～ {bounds.upper.toFixed(3)} rad
          </span>
          <small>
            {jointLabel === "参考预览关节"
              ? t(
                  "范围来自结构模型，尚未通过实物确认。这里仅预览这一轴；完整动作在第 3 步按全部参与关节的姿势程序核对。",
                )
              : t(
                  "范围来自结构模型，尚未通过实物确认。旧单关节任务只控制这一轴，其他轴保持配置姿态。",
                )}
          </small>
          {selectedJoint.source_parameter && (
            <small>
              {t("来源参数：")}
              {selectedJoint.source_parameter}
            </small>
          )}
        </div>
      )}
      {structure ? (
        <>
          <Suspense
            fallback={
              <div className="viewer-placeholder">
                <CircleNotch size={24} className="spin" />
                {t("正在准备 3D 查看器")}
              </div>
            }
          >
            <StructureView
              structure={structure}
              jointName={jointName}
              target={target}
            />
          </Suspense>
          {!!structure.warnings?.length && (
            <details className="structure-notes">
              <summary>
                {t("模型用途与待补信息 ·")}
                {structure.warnings.length}
              </summary>
              <ul>
                {structure.warnings.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <div className="viewer-placeholder">
          <Cube size={25} />
          {id && !error
            ? t("正在读取结构信息…")
            : t("尚未选择结构，可以先保存，稍后再选。")}
        </div>
      )}
      <p className="structure-help">
        {t(
          "支持带关节树的 URDF 和 SophiRobot 配置 JSON。保存时检查关节与范围，按所选模型生成本机近似仿真；缺少必要数据时会提示，实物驱动仍需确认。",
        )}
        <a
          href="https://sophimotion.github.io/sophicore-robot-cle/"
          target="_blank"
          rel="noreferrer"
        >
          {t("打开结构站")}
          <ArrowSquareOut size={13} />
        </a>
      </p>
    </div>
  );
}
export function StructureReplay({ run }: { run: Run }) {
  const { locale } = useI18n();

  const structure = useMemo(
    () => snapshotStructure(run.spec_snapshot),
    [run.spec_snapshot],
  );
  const vectorSeries = useMemo(
    () =>
      run.spec_snapshot.task_type === "joint_sequence"
        ? run.result?.series
            ?.filter((point) => !!point.positions)
            .map((point) => ({
              time: point.t ?? point.time,
              positions: point.positions!,
              stage_id: point.stage_id,
              cycle_index: point.cycle_index,
            }))
        : undefined,
    [run.spec_snapshot.task_type, run.result?.series],
  );
  const requiredJoints =
    run.result?.motion_program?.joint_names ||
    run.spec_snapshot.prd?.intake?.motion_plan?.joint_names ||
    [];
  if (
    run.spec_snapshot.task_type === "joint_sequence" &&
    run.result?.series?.length &&
    (!requiredJoints.length ||
      run.result.series.some((point) =>
        requiredJoints.some(
          (name) => !Number.isFinite(point.positions?.[name]),
        ),
      ))
  )
    return (
      <div className="notice warning">
        {t("实际反馈没有完整覆盖每个参与关节，无法回放完整动作。")}
      </div>
    );
  if (
    run.spec_snapshot.task_type === "joint_sequence" &&
    run.result?.series?.length &&
    !run.result.series.some((point) => !!point.positions)
  )
    return (
      <div className="notice warning">
        {t("缺少全组关节实际反馈，不能回放完整动作。")}
      </div>
    );
  if (
    !["joint_position", "joint_sequence"].includes(
      run.spec_snapshot.task_type || "",
    ) ||
    !run.result?.series?.length
  )
    return null;
  return (
    <div className="result-replay">
      <div className="section-intro">
        <h3>
          {run.spec_snapshot.task_type === "joint_sequence"
            ? t("本轮多关节实际轨迹回放")
            : t("本轮关节回放")}
        </h3>
        <span>{t("使用本轮冻结模型与轨迹，不代表实物动作")}</span>
      </div>
      {!structure && (
        <div className="notice">
          {t(
            "这份旧记录没有保存结构快照，因此只显示原始轨迹，不替换成其他模型。",
          )}
        </div>
      )}
      {structure && (
        <Suspense
          fallback={
            <div className="viewer-placeholder">{t("正在加载回放…")}</div>
          }
        >
          <StructureView
            structure={structure}
            jointName={
              run.spec_snapshot.execution_model?.selected_joint ||
              run.spec_snapshot.prd?.joint_name
            }
            series={
              run.spec_snapshot.task_type === "joint_sequence"
                ? undefined
                : run.result.series
            }
            vectorSeries={vectorSeries}
          />
        </Suspense>
      )}
    </div>
  );
}
