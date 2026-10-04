import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  CaretRight,
  CheckCircle,
  CircleNotch,
  Cpu,
  FileText,
  Folder,
  GearSix,
  Info,
  LinkSimple,
  List,
  Monitor,
  Plus,
  Robot,
  Square,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  api,
  busyStatuses,
  localTime,
  statusLabels,
  type Catalog,
  type Project,
  type Run,
  type Settings as SettingsData,
} from "./api";
import Requirements from "./Requirements";
import {
  emptyDraft,
  newDraft,
  fromProject,
  draftIsChanged,
  type Draft,
} from "./draft";
import Workflow from "./Workflow";
import PlanPanel from "./PlanPanel";
import Evidence from "./Evidence";
import ResultPanel from "./ResultPanel";
import Library from "./Library";
import Settings from "./Settings";
import ProjectTools from "./ProjectTools";
import { invalidateMotionReview } from "./motionPlan";
type Page = "workbench" | "library" | "settings";
export default function App() {
  const [page, setPage] = useState<Page>("workbench");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [environment, setEnvironment] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [stage, setStage] = useState(0);
  const [run, setRun] = useState<Run | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sidebar, setSidebar] = useState(false);
  const [projectTools, setProjectTools] = useState<"history" | "import" | null>(
    null,
  );
  const selectionVersion = useRef(0);
  const refreshVersion = useRef(0);
  const locked = !!project && busyStatuses.includes(project.status);
  const dirty = draftIsChanged(draft, project);
  const loadRuns = useCallback(async (p: Project, version: number) => {
    const data = await api<{ items: Run[] }>(`/projects/${p.id}/runs`);
    if (selectionVersion.current !== version) return;
    setRuns(data.items);
    const active = p.latest_run_id
      ? await api<Run>(`/runs/${p.latest_run_id}`)
      : null;
    if (selectionVersion.current === version) setRun(active);
  }, []);
  const selectProject = useCallback(
    async (p: Project) => {
      const version = ++selectionVersion.current;
      setProject(p);
      setDraft(fromProject(p));
      setRun(null);
      setRuns([]);
      setStage(p.status === "awaiting_approval" ? 1 : p.latest_run_id ? 3 : 0);
      setPage("workbench");
      setSidebar(false);
      setError("");
      setProjectTools(null);
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set("project", p.id);
      window.history.replaceState(null, "", currentUrl);
      try {
        await loadRuns(p, version);
      } catch (e) {
        if (selectionVersion.current === version)
          setError((e as Error).message);
      }
    },
    [loadRuns],
  );
  const refresh = useCallback(async () => {
    const refreshId = ++refreshVersion.current;
    setLoading(true);
    setError("");
    try {
      const [health, cat, config, all] = await Promise.all([
        api<{ environment: Record<string, unknown> }>("/health"),
        api<Catalog>("/catalog"),
        api<SettingsData>("/settings"),
        api<{ items: Project[] }>("/projects"),
      ]);
      if (refreshId !== refreshVersion.current) return;
      setConnected(true);
      setEnvironment(health.environment);
      setCatalog(cat);
      setSettings(config);
      setProjects(all.items);
      if (all.items.length) {
        const requestedProject = new URLSearchParams(
          window.location.search,
        ).get("project");
        await selectProject(
          all.items.find((item) => item.id === requestedProject) ||
            all.items[0],
        );
      } else
        setDraft({
          ...newDraft(),
          workflow: cat.default_workflow
            ? structuredClone(cat.default_workflow)
            : newDraft().workflow,
        });
    } catch (e) {
      if (refreshId !== refreshVersion.current) return;
      setConnected(false);
      setError(`无法连接本机后台：${(e as Error).message}`);
    } finally {
      if (refreshId === refreshVersion.current) setLoading(false);
    }
  }, [selectProject]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!project) return;
    let live = true;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await api<Project>(`/projects/${project.id}`);
        if (!live) return;
        setProject(next);
        setProjects((all) => all.map((p) => (p.id === next.id ? next : p)));
        setConnected(true);
        setError((previous) =>
          previous.startsWith("刷新工程失败：") ? "" : previous,
        );
        if (
          project.status === "planning" &&
          next.status === "awaiting_approval"
        )
          setStage(1);
        if (next.latest_run_id) {
          const active = await api<Run>(`/runs/${next.latest_run_id}`);
          if (live) {
            setRun((current) =>
              current?.id &&
              current.id !== next.latest_run_id &&
              !busyStatuses.includes(next.status)
                ? current
                : active,
            );
            setRuns((previous) => [
              active,
              ...previous.filter((r) => r.id !== active.id),
            ]);
            if (
              ["passed", "failed", "deployed"].includes(next.status) &&
              busyStatuses.includes(project.status)
            )
              setStage(3);
          }
        }
      } catch (e) {
        if (live) {
          setConnected(false);
          setError(`刷新工程失败：${(e as Error).message}`);
        }
      } finally {
        polling = false;
      }
    }, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [project?.id, project?.status]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const updateProject = (next: Project) => {
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set("project", next.id);
    window.history.replaceState(null, "", currentUrl);
    setProject(next);
    setDraft(fromProject(next));
    setProjects((all) => [next, ...all.filter((p) => p.id !== next.id)]);
  };
  const persist = async () => {
    const next = await api<Project>(
      project ? `/projects/${project.id}` : "/projects",
      draft,
      project ? "PUT" : "POST",
    );
    updateProject(next);
    setRun(null);
    return next;
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    action(async () => {
      await persist();
      setToast("需求已保存。修改后的规格需要重新核对。");
    });
  const plan = () =>
    action(async () => {
      const current = dirty ? await persist() : project!;
      const next = await api<Project>(`/projects/${current.id}/plan`, {});
      updateProject(next);
      setStage(1);
    });
  const approve = () =>
    action(async () => {
      if (!project) return;
      if (project.plan?.blocking_issues?.length)
        throw new Error(
          "这份需求还有无法执行的内容，请先修改需求并重新拆分，处理核对页列出的问题。",
        );
      if (!project.plan?.plan_id)
        throw new Error("这份拆分缺少核对标识，请重新拆分后再确认。");
      if (dirty)
        throw new Error(
          "需求有未保存修改，请先保存、重新拆分并核对，不能执行旧版规格。",
        );
      let current = project;
      if (current.status === "awaiting_approval") {
        current = await api<Project>(`/projects/${project.id}/approve`, {
          spec_revision: project.spec_revision,
          plan_id: project.plan.plan_id,
        });
        updateProject(current);
      }
      const next = await api<Run>(`/projects/${current.id}/run`, {});
      setRun(next);
      setRuns((all) => [next, ...all]);
      setProject({ ...current, status: next.status, latest_run_id: next.id });
      setStage(2);
    });
  const repair = () =>
    action(async () => {
      if (!run) return;
      if (dirty)
        throw new Error(
          "需求有未保存修改，请保存、重新拆分并核对后再执行，不能用旧版记录重试。",
        );
      const next = await api<Run>(`/runs/${run.id}/repair`, {});
      setRun(next);
      setRuns((all) => [next, ...all.filter((r) => r.id !== next.id)]);
      if (project)
        setProject({ ...project, status: next.status, latest_run_id: next.id });
      setStage(2);
    });
  const cancel = () =>
    action(async () => {
      if (project?.status === "planning") {
        const next = await api<Project>(`/projects/${project.id}/cancel`, {});
        setProject(next);
      } else if (run) {
        const next = await api<Run>(`/runs/${run.id}/cancel`, {});
        setRun(next);
        if (project) setProject({ ...project, status: next.status });
      }
      setToast("已提交取消请求，等待后台收尾。");
    });
  const deploy = () =>
    action(async () => {
      if (!run) return;
      if (dirty)
        throw new Error(
          "需求有未保存修改，请先保存并核对。当前结果属于原保存版本，不能将它作为新需求部署。",
        );
      if (!run.integrity?.fingerprint)
        throw new Error(
          "这份旧记录没有通过版本指纹，请先重新生成并检查，再部署复测。",
        );
      const next = await api<Run>(`/runs/${run.id}/deploy`, {
        confirm: true,
        fingerprint: run.integrity.fingerprint,
      });
      setRun(next);
      if (project) setProject({ ...project, status: next.status });
      setToast("已提交本机隔离环境部署复测。");
    });
  const newProject = () => {
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete("project");
    window.history.replaceState(null, "", currentUrl);
    selectionVersion.current += 1;
    setProject(null);
    setRun(null);
    setRuns([]);
    setDraft({
      ...newDraft(),
      workflow: catalog?.default_workflow
        ? structuredClone(catalog.default_workflow)
        : newDraft().workflow,
    });
    setStage(0);
    setPage("workbench");
    setError("");
    setSidebar(false);
  };
  const selectedStatus = project?.status || "draft";
  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          className="icon-button mobile-menu"
          onClick={() => setSidebar(!sidebar)}
          aria-label="打开工程列表"
        >
          <List size={23} />
        </button>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("workbench");
          }}
        >
          <strong>AE</strong>
          <span>/</span>
          <b>Auto Engineering</b>
        </a>
        <nav aria-label="主导航">
          {(
            [
              { id: "workbench", label: "工作台" },
              { id: "library", label: "资料库" },
              { id: "settings", label: "设置" },
            ] as { id: Page; label: string }[]
          ).map((item) => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className={page === item.id ? "active" : ""}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className={`connection ${connected ? "online" : ""}`}>
          <span />
          {connected ? "本机服务已连接" : "本机服务未连接"}
        </div>
      </header>
      <aside className={`sidebar ${sidebar ? "open" : ""}`}>
        <div className="sidebar-title">
          <span>工程</span>
          <button
            className="icon-button mobile-menu"
            aria-label="关闭工程列表"
            onClick={() => setSidebar(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button
          className="new-project"
          onClick={newProject}
          disabled={loading || busy}
        >
          <Plus size={19} />
          新建任务
        </button>
        <button
          className="text-button sidebar-import"
          disabled={loading || busy}
          onClick={() => {
            setPage("workbench");
            setProjectTools("import");
            setSidebar(false);
          }}
        >
          导入工程 ZIP
        </button>
        <div className="project-list">
          {projects.map((item) => (
            <button
              key={item.id}
              disabled={loading || busy}
              className={project?.id === item.id ? "selected" : ""}
              onClick={() => void selectProject(item)}
            >
              <Robot size={20} />
              <span>
                <strong>{item.name || "未命名需求"}</strong>
                <small>{statusLabels[item.status] || item.status}</small>
              </span>
              <CaretRight size={14} />
            </button>
          ))}
          {!projects.length && (
            <p className="sidebar-empty">创建第一个工程，从需求开始。</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <Folder size={17} />
          <span>所有运行记录保存在本机</span>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-overlay"
          aria-label="关闭工程列表"
          onClick={() => setSidebar(false)}
        />
      )}
      <main className={`main ${page !== "workbench" ? "secondary-page" : ""}`}>
        {error && (
          <div className="error-banner" role="alert">
            <WarningCircle size={20} />
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setError("")}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {loading ? (
          <div className="initial-loader">
            <CircleNotch size={30} className="spin" />
            <p>正在连接本机工程服务</p>
          </div>
        ) : page === "settings" ? (
          <Settings settings={settings} onSaved={setSettings} />
        ) : page === "library" ? (
          <Library project={project} />
        ) : (
          <>
            <header className="page-heading">
              <div>
                <h1>{project?.name || draft.name || "新建工程"}</h1>
                <p>
                  ROS 2 Humble <span>·</span> 本地模拟设备 <span>·</span>{" "}
                  <span className={`status ${selectedStatus}`}>
                    {statusLabels[selectedStatus]}
                  </span>
                  {project && (
                    <span className="revision">v{project.spec_revision}</span>
                  )}
                </p>
              </div>
              <div className="heading-actions">
                {project && (
                  <button
                    className="button secondary"
                    onClick={() =>
                      setProjectTools(
                        projectTools === "history" ? null : "history",
                      )
                    }
                    disabled={busy}
                  >
                    版本与复用
                  </button>
                )}
                {!connected && (
                  <button
                    className="button secondary"
                    onClick={() => void refresh()}
                  >
                    <ArrowClockwise size={17} />
                    重新连接
                  </button>
                )}
                {locked && (
                  <button
                    className="button secondary"
                    onClick={cancel}
                    disabled={busy}
                  >
                    <Square size={14} />
                    取消执行
                  </button>
                )}
                <button
                  className="button secondary"
                  onClick={() => setStage(0)}
                  disabled={busy}
                >
                  <ArrowClockwise size={17} />
                  {project?.plan ? "修改需求" : "编辑需求"}
                </button>
              </div>
            </header>
            {projectTools && (
              <ProjectTools
                mode={projectTools}
                project={project}
                run={run}
                dirty={dirty}
                onClose={() => setProjectTools(null)}
                onCreated={(next) => {
                  setProjects((all) => [
                    next,
                    ...all.filter((item) => item.id !== next.id),
                  ]);
                  void selectProject(next);
                  setProjectTools(null);
                  setToast("已创建新草稿，重新拆分并核对后才会执行。");
                }}
              />
            )}
            <Workflow
              selected={stage}
              status={selectedStatus}
              onSelect={setStage}
              hasPlan={!!project?.plan}
              hasResult={!!run?.result}
            />
            <div className="workspace-grid">
              <div className="workspace-main">
                {stage === 0 ? (
                  <Requirements
                    key={selectionVersion.current}
                    draft={draft}
                    manifest={project?.manifest}
                    manifestStale={dirty}
                    catalog={catalog}
                    setDraft={(next) =>
                      setDraft(invalidateMotionReview(draft, next))
                    }
                    tasks={
                      catalog?.tasks || [
                        {
                          id: "joint_position",
                          label: "关节位置",
                          description: "",
                          default_request: emptyDraft.request,
                          parameters: emptyDraft.parameters,
                        },
                        {
                          id: "sensor_threshold",
                          label: "传感器阈值",
                          description: "",
                          default_request:
                            "当模拟传感器的值超过阈值时，输出触发信号。",
                          parameters: emptyDraft.parameters,
                        },
                      ]
                    }
                    locked={locked || busy}
                    saving={busy || !connected}
                    onSave={save}
                    onPlan={plan}
                  />
                ) : stage === 1 ? (
                  <PlanPanel
                    key={`${project?.id}-${project?.spec_revision}-${project?.plan?.plan_id || "legacy"}`}
                    project={project}
                    environment={environment}
                    onApprove={approve}
                    dirty={dirty}
                    onSaveAndPlan={plan}
                    communication={
                      project?.communication || catalog?.communication || null
                    }
                    simulation={
                      project?.simulation || catalog?.simulation || null
                    }
                    onPlan={() => setStage(0)}
                    busy={busy}
                  />
                ) : stage === 2 ? (
                  <section className="panel generation-panel">
                    <header className="panel-heading">
                      <FileText size={24} />
                      <div>
                        <h2>程序生成</h2>
                        <p>同一份需求和通信约定，生成两端工程。</p>
                      </div>
                    </header>
                    <div className="generation-status">
                      {locked ? (
                        <CircleNotch size={38} className="spin" />
                      ) : selectedStatus === "passed" ||
                        selectedStatus === "deployed" ? (
                        <CheckCircle size={38} />
                      ) : (
                        <FileText size={38} />
                      )}
                      <h3>{statusLabels[selectedStatus]}</h3>
                      <p>
                        {project?.approval
                          ? "已确认的规格会随本轮工程保存，日志与文件在下方查看。"
                          : "先到“环境与检查”人工核对拆分结果。"}
                      </p>
                    </div>
                    <div className="two-lanes">
                      <div>
                        <Robot size={24} />
                        <h3>ROS 端</h3>
                        <p>任务程序、启动文件、参数与检查脚本</p>
                      </div>
                      <div>
                        <Cpu size={24} />
                        <h3>ESP32 端</h3>
                        <p>按所选板型编译固件；通信逻辑在主机模拟环境中检查</p>
                      </div>
                    </div>
                    {run?.error && (
                      <div className="notice warning">{run.error}</div>
                    )}
                    {!project?.approval && (
                      <button
                        className="button secondary"
                        onClick={() => setStage(1)}
                      >
                        去核对需求
                        <CaretRight size={16} />
                      </button>
                    )}
                  </section>
                ) : (
                  <ResultPanel
                    key={run?.id}
                    run={run}
                    busy={busy}
                    onRepair={repair}
                    onDeploy={deploy}
                    dirty={dirty}
                    onSaveAndPlan={plan}
                  />
                )}
              </div>
              <aside className="panel project-info">
                <header className="panel-heading">
                  <FileText size={23} />
                  <div>
                    <h2>本次工程</h2>
                    <p>需求、运行环境与版本</p>
                  </div>
                </header>
                <dl>
                  <div>
                    <dt>
                      <Robot size={19} />
                      ROS 端
                    </dt>
                    <dd>
                      {run &&
                      run.spec_snapshot?.spec_revision !==
                        project?.spec_revision
                        ? "当前版未运行"
                        : run?.result?.ros_verified
                          ? "已运行验证"
                          : run
                            ? "查看运行记录"
                            : "待生成"}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <Cpu size={19} />
                      ESP32 端
                    </dt>
                    <dd>
                      {run &&
                      run.spec_snapshot?.spec_revision ===
                        project?.spec_revision &&
                      run.result?.firmware?.passed
                        ? "固件编译通过"
                        : "待编译 / 查看记录"}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <LinkSimple size={19} />
                      通信约定
                    </dt>
                    <dd>
                      {project?.approval
                        ? "已核对"
                        : project?.plan
                          ? "待核对"
                          : "待生成"}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <Monitor size={19} />
                      运行环境
                    </dt>
                    <dd>{connected ? "本机 ROS 2 Humble" : "等待连接"}</dd>
                  </div>
                </dl>
                <div className="notice">
                  <Info size={19} />
                  <span>人工核对拆分结果后，才会生成和编译。</span>
                </div>
                <div className="info-detail">
                  <span>实物与控制板烧录</span>
                  <strong>本轮不执行</strong>
                </div>
                {project && (
                  <div className="info-detail">
                    <span>保存于</span>
                    <strong>{localTime(project.updated_at)}</strong>
                  </div>
                )}
                {!!runs.length && (
                  <label className="field run-selector">
                    <span>查看历史运行</span>
                    <select
                      value={run?.id || ""}
                      onChange={(e) => {
                        const selected = runs.find(
                          (r) => r.id === e.target.value,
                        );
                        if (selected) {
                          setRun(selected);
                          setStage(3);
                        }
                      }}
                    >
                      <option value="" disabled>
                        选择已保存的运行
                      </option>
                      {runs.map((item) => (
                        <option value={item.id} key={item.id}>
                          {localTime(item.created_at)} · v
                          {item.spec_snapshot?.spec_revision} ·{" "}
                          {statusLabels[item.status]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  className="text-button"
                  onClick={() => setPage("settings")}
                >
                  <GearSix size={16} />
                  AI：
                  {settings?.provider === "codex" ? "本机 Codex" : "API 服务"}
                  <CaretRight size={14} />
                </button>
              </aside>
            </div>
            <Evidence
              failedProvenance={
                stage === 1 || !run ? project?.plan_failure_provenance : null
              }
              run={stage === 1 ? null : run}
              plan={
                stage === 1
                  ? project?.plan || null
                  : run
                    ? run.plan_snapshot || run.spec_snapshot?.plan || null
                    : project?.plan || null
              }
            />
          </>
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle size={19} />
          {toast}
        </div>
      )}
    </div>
  );
}
