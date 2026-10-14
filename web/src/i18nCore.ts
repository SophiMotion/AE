import { registerTranslations, t } from "./localeStore";
registerTranslations({
  分享版资源读取失败: "Unable to load demo resources",
  无法连接本机后台: "Unable to connect to the local service",
  "刷新工程失败：": "Project refresh failed: ",
  "草稿已保存在此浏览器。已有验收结果不会套用到新需求。":
    "Draft saved in this browser. Existing results do not apply to new requirements.",
  "需求已保存。修改后的规格需要重新核对。":
    "Requirements saved. Changed specifications need another review.",
  "已进入流程说明。在线分享版不调用 AI、不生成代码，也不运行 ROS。":
    "Workflow guide opened. The online demo does not call AI, generate code or run ROS.",
  "这份需求还有无法执行的内容，请先修改需求并重新拆分，处理核对页列出的问题。":
    "Some requirements cannot be executed. Resolve the review issues and create a new plan.",
  "这份拆分缺少核对标识，请重新拆分后再确认。":
    "This plan has no review identifier. Create a new plan before approving it.",
  "需求有未保存修改，请先保存、重新拆分并核对，不能执行旧版规格。":
    "Save your changes, create a new plan and review it before executing.",
  "修改和重新运行需要启动完整本机平台。这里展示已有验收记录。":
    "Editing and rerunning require the full local platform. This page displays existing results.",
  "需求有未保存修改，请保存、重新拆分并核对后再执行，不能用旧版记录重试。":
    "Save your changes, create a new plan and review it before retrying. Old results cannot be reused.",
  "已提交取消请求，等待后台收尾。":
    "Cancellation requested. Waiting for the service to finish.",
  "分享版没有 ROS 执行环境，部署复测需要在完整本机平台进行。":
    "The demo has no ROS runtime. Deployment validation requires the full local platform.",
  "需求有未保存修改，请先保存并核对。当前结果属于原保存版本，不能将它作为新需求部署。":
    "Save and review your changes first. These results belong to an older version and cannot validate new requirements.",
  "这份旧记录没有通过版本指纹，请先重新生成并检查，再部署复测。":
    "This record has no verified version fingerprint. Regenerate and check it before deployment validation.",
  "已提交本机隔离环境部署复测。":
    "Deployment validation requested in the isolated local environment.",
  跳至主要内容: "Skip to main content",
  关闭工程列表: "Close project list",
  打开工程列表: "Open project list",
  主导航: "Main navigation",
  工作台: "Workbench",
  资料库: "Library",
  设置: "Settings",
  完整界面体验版: "Interactive demo",
  本机服务已连接: "Local service connected",
  本机服务未连接: "Local service offline",
  工程列表: "Projects",
  工程: "Projects",
  新建任务: "New project",
  "已下载当前需求草稿；这不是生成后的 ROS／ESP32 工程。":
    "Requirements draft downloaded. This is not a generated ROS / ESP32 project.",
  下载当前需求草稿: "Download current draft",
  "导入工程 ZIP": "Import project ZIP",
  未命名需求: "Untitled requirements",
  已有本机验收示例: "Recorded local validation",
  "创建第一个工程，从需求开始。":
    "Create your first project and describe your requirements.",
  草稿仅保存在你的浏览器: "Drafts stay in your browser",
  所有运行记录保存在本机: "Run records are stored locally",
  "完整工作台 · 分享体验版": "Full workbench · Shared demo",
  "可填写 PRD、查看流程、旋转模型和回放已有结果。生成、编译与 ROS 运行需要完整本机平台；新草稿没有验收结果。":
    "Explore PRDs, workflows, 3D models and recorded results. Generation, builds and ROS execution require the full local platform. New drafts have no validation results.",
  项目说明: "Project guide",
  项目源码: "Source code",
  关闭提示: "Dismiss message",
  正在读取公开示例与工作台: "Loading public examples and workbench",
  正在连接本机工程服务: "Connecting to the local project service",
  新建工程: "New project",
  已有本机记录: "Recorded local run",
  浏览器需求草稿: "Browser draft",
  本地模拟设备: "Local simulated device",
  版本与复用: "Versions & reuse",
  "下载 PRD 草稿": "Download PRD draft",
  重新连接: "Reconnect",
  取消执行: "Cancel execution",
  修改需求: "Revise requirements",
  编辑需求: "Edit requirements",
  "已创建新草稿，重新拆分并核对后才会执行。":
    "New draft created. Plan and review it before execution.",
  关节位置: "Joint position",
  传感器阈值: "Sensor threshold",
  程序生成: "Code generation",
  "查看两端工程如何配套；这一步的实际生成在本机完成。":
    "Explore how both projects work together. Actual generation runs locally.",
  "同一份需求和通信约定，生成两端工程。":
    "Generate both projects from the same requirements and communication contract.",
  已有示例的两端程序: "Programs from the recorded example",
  生成流程说明: "Generation workflow guide",
  "完整平台在人工核对后，按冻结的需求与通信约定生成 ROS 工程和 ESP32 固件。当前网页不会启动生成、编译或仿真。":
    "After human review, the full platform generates ROS and ESP32 projects from the frozen requirements and protocol. This demo does not run generation, builds or simulation.",
  "已确认的规格会随本轮工程保存，日志与文件在下方查看。":
    "Approved specifications are saved with this run. See logs and files below.",
  "先到“环境与检查”人工核对拆分结果。":
    "Review the plan in Environment & checks first.",
  "ROS 端": "ROS",
  "任务程序、启动文件、参数与检查脚本":
    "Task code, launch files, parameters and check scripts",
  "ESP32 端": "ESP32",
  "按所选板型编译固件；通信逻辑在主机模拟环境中检查":
    "Firmware is compiled for the selected board; communication logic is checked in a host simulation.",
  去核对需求: "Review requirements",
  本次工程: "This project",
  "需求、运行环境与版本": "Requirements, environment and version",
  当前版未运行: "This version has not run",
  已运行验证: "Runtime verified",
  查看运行记录: "View run records",
  待生成: "Not generated",
  固件编译通过: "Firmware build passed",
  "待编译 / 查看记录": "Not built / view records",
  通信约定: "Communication contract",
  已核对: "Reviewed",
  待核对: "Needs review",
  运行环境: "Runtime environment",
  "公开记录 / 浏览器体验": "Public records / browser demo",
  "本机 ROS 2 Humble": "Local ROS 2 Humble",
  等待连接: "Waiting for connection",
  "核对体验只改变浏览器草稿，不会生成、编译或刷新已有结果。":
    "Reviewing changes only the browser draft. It does not generate, build or update recorded results.",
  "人工核对拆分结果后，才会生成和编译。":
    "Generation and builds start only after human review of the plan.",
  实物与控制板烧录: "Physical device & flashing",
  本轮不执行: "Not performed in this run",
  保存于: "Saved",
  查看历史运行: "Run history",
  选择已保存的运行: "Choose a saved run",
  分享版不调用: "Disabled in demo",
  "本机 Codex": "Local Codex",
  "API 服务": "API service",
  "已保存。下一次 AI 调用使用这套设置。":
    "Saved. These settings apply to the next AI call.",
  "AI 服务与使用范围": "AI services & capabilities",
  "完整平台支持切换服务；分享版展示配置方法。":
    "Switch services on the full platform. This demo explains the configuration.",
  "本机 Codex / 兼容 OpenAI 的 API 服务": "Local Codex / OpenAI-compatible API",
  "在完整本机平台中选择服务、填写模型，再由后台调用。这里不连接你的电脑，也不接收或保存 API 密钥。":
    "Choose a service and model in the full local platform. This demo does not connect to your computer or accept or store API keys.",
  此分享版可以做什么: "What you can explore here",
  "体验 PRD、保存浏览器草稿、查看分工与通信说明、回放已有模型轨迹、浏览公开资料和源码。":
    "Explore PRDs, save browser drafts, review responsibilities and protocols, replay recorded model trajectories, and browse public sources.",
  "实际生成、编译和运行": "Actual generation, builds and execution",
  "下载仓库源码，按 README 在本机部署 Python 后台、ROS 和编译环境，完成填写、人工核对和验收。":
    "Download the source and follow the README to set up the local Python service, ROS and build environment, then fill in, review and validate your requirements.",
  查看本机部署说明: "Local setup guide",
  "AI 服务": "AI service",
  "界面与工程流程保持一致，模型服务可以切换。":
    "Switch model services while keeping the same interface and engineering workflow.",
  "复用这台电脑已有的 CLI 登录":
    "Use the existing CLI sign-in on this computer",
  "兼容 OpenAI 的接口": "OpenAI-compatible API",
  "填写服务地址、模型和密钥": "Set the endpoint, model and API key",
  "已检测到本机 Codex CLI。实际调用结果以任务日志为准。":
    "Local Codex CLI detected. Consult task logs for actual call results.",
  "暂未检测到可用的 Codex CLI，请检查本机安装与登录。":
    "No available Codex CLI detected. Check your local installation and sign-in.",
  "适合先在本机把流程跑通；之后可切换 API 服务。":
    "Start with a local workflow; you can switch to an API service later.",
  服务地址: "Service endpoint",
  "API 密钥": "API key",
  "已有配置，留空则保留": "Configured; leave blank to keep",
  尚未配置: "Not configured",
  留空保留已有密钥: "Leave blank to keep the current key",
  "仅在这里输入，不会在界面回显": "Enter here; the key will not be displayed",
  模型名称: "Model name",
  "留空使用 Codex 默认模型": "Leave blank for the default Codex model",
  "填写服务提供商支持的模型 ID": "Enter a model ID supported by your provider",
  "每次调用都会记录实际工具、模型、提示词和资料来源，便于复查。":
    "Each call records the tool, model, prompt and sources for review.",
  "密钥只在当前后台进程中保留，重启后需要重新输入。":
    "The key is kept only in the current service process. Enter it again after restarting.",
  保存设置: "Save settings",
  机器人与需求: "Robot & requirements",
  明确任务与硬件: "Define the task and hardware",
  环境与检查: "Environment & checks",
  核对拆分和通信: "Review the plan and protocol",
  "生成 ROS 与 ESP32 工程": "Generate ROS and ESP32 projects",
  运行与评估: "Run & evaluate",
  "编译、运行、修改": "Build, run and revise",
  工程流程: "Engineering workflow",
  工程阶段: "Project stages",
  "根据检查结果修改，再跑一遍": "Revise based on results, then run again",
  核对通过才能继续: "Review required to continue",
  "固定步骤 · 可拖动位置": "Required step · drag to position",
  "浏览器连线检查通过；这只检查流程图，不会执行任务。":
    "Browser graph check passed. This checks the workflow only; it does not execute tasks.",
  "后台检查通过。保存后，执行程序会按这份连线安排顺序。":
    "Service check passed. Save to use these connections for execution order.",
  "连线决定先后，拖动只改变位置。审核和必要检查不能跳过。":
    "Connections define order; dragging changes position only. Review and required checks cannot be skipped.",
  收起流程图: "Collapse workflow",
  编辑流程图: "Edit workflow",
  "十个必要步骤已连通，可保存并交给后台核对。":
    "All ten required steps are connected. Save and submit for service validation.",
  编译先后: "Build order",
  "先 ROS，再 ESP32": "ROS, then ESP32",
  "先 ESP32，再 ROS": "ESP32, then ROS",
  检查先后: "Check order",
  "先通信，再仿真": "Communication, then simulation",
  "先仿真，再通信": "Simulation, then communication",
  恢复默认: "Restore defaults",
  "正在检查…": "Checking…",
  后台核对连线: "Validate connections",
  可编辑工程流程图: "Editable workflow graph",
  "这两个步骤已经连在一起了。": "These steps are already connected.",
  "拖动圆点连线；点选线后可移除。拖动画布空白处平移，手机可双指缩放。":
    "Drag between dots to connect. Select a line to remove it. Drag the background to pan; pinch to zoom on mobile.",
  移除选中连线: "Remove selected connection",
  本轮控制的关节: "Joint to control",
  "结构配置不能超过 4 MB。请上传配置 JSON 或 URDF，而不是完整 STEP。":
    "Structure configurations must be under 4 MB. Upload configuration JSON or URDF, not a full STEP file.",
  结构与关节: "Structure & joints",
  "选择测试模型，或导入结构站保存的配置。":
    "Choose a test model or import a saved structure configuration.",
  "自定义结构导入在完整本机平台使用；此页可选择公开参考模型":
    "Custom structures require the full local platform. Choose a public reference model here.",
  "导入结构（本机功能）": "Import structure (local only)",
  导入结构: "Import structure",
  导入结构文件: "Import structure file",
  结构模型: "Robot model",
  还没选择结构: "No structure selected",
  请选择关节: "Choose a joint",
  初始姿态: "Initial pose",
  范围: "Range",
  参考预览关节: "Joint to preview",
  "范围来自结构模型，尚未通过实物确认。这里仅预览这一轴；完整动作在第 3 步按全部参与关节的姿势程序核对。":
    "Limits come from the model and are not physically verified. This previews one axis; review the full multi-joint pose program in step 3.",
  "范围来自结构模型，尚未通过实物确认。旧单关节任务只控制这一轴，其他轴保持配置姿态。":
    "Limits come from the model and are not physically verified. A legacy single-joint task controls this axis while the others keep their saved pose.",
  "来源参数：": "Source parameter: ",
  "正在准备 3D 查看器": "Preparing 3D viewer",
  "模型用途与待补信息 ·": "Model scope & missing information · ",
  "正在读取结构信息…": "Loading structure…",
  "尚未选择结构，可以先保存，稍后再选。":
    "No structure selected. You can save now and choose it later.",
  "支持带关节树的 URDF 和 SophiRobot 配置 JSON。保存时检查关节与范围，按所选模型生成本机近似仿真；缺少必要数据时会提示，实物驱动仍需确认。":
    "Supports URDF with joint trees and SophiRobot JSON configurations. Joints and limits are checked on save for local approximate simulation. Missing data is flagged; physical actuation still needs verification.",
  打开结构站: "Open structure site",
  "实际反馈没有完整覆盖每个参与关节，无法回放完整动作。":
    "Actual feedback does not cover every participating joint. Full motion cannot be replayed.",
  "缺少全组关节实际反馈，不能回放完整动作。":
    "Full-joint feedback is missing. Full motion cannot be replayed.",
  本轮多关节实际轨迹回放: "Recorded multi-joint trajectory",
  本轮关节回放: "Joint replay",
  "使用本轮冻结模型与轨迹，不代表实物动作":
    "Uses this run's frozen model and trajectory; not physical motion",
  "这份旧记录没有保存结构快照，因此只显示原始轨迹，不替换成其他模型。":
    "This record has no structure snapshot. Only the original trajectory is shown, without substituting a model.",
  "正在加载回放…": "Loading replay…",
  模型没有可显示的网格: "The model contains no displayable meshes",
  "当前浏览器无法开启 3D 显示。结构信息仍可查看。":
    "3D rendering is unavailable in this browser. Structure information is still accessible.",
  "3D 显示连接已中断，请重新选择结构。":
    "The 3D context was lost. Select the structure again.",
  "Sophicore 关节结构": "Sophicore joint structure",
  原站结构参考: "Source structure reference",
  内置测试模型: "Built-in test model",
  导入结构预览: "Imported structure preview",
  重置3D视角: "Reset 3D view",
  正在读取原站结构: "Loading source structure",
  "首次加载约 10 MB 显示模型；保留全部部件和三角面。":
    "Initial model download is about 10 MB, retaining all parts and triangles.",
  "首次需加载约 58 MB 网格。": "Initial mesh download is about 58 MB.",
  "拖动旋转 · 滚轮缩放": "Drag to rotate · Scroll to zoom",
  "结构预览，未驱动实物": "Structure preview; no physical actuation",
  暂停轨迹回放: "Pause trajectory replay",
  播放轨迹回放: "Play trajectory replay",
  运行轨迹时间: "Trajectory time",
  未记录: "Not recorded",
  "全组目标姿势预览 · 仅供人工核对，尚未运行":
    "Full target pose preview · For review only, not executed",
  关节预览: "Joint preview",
  "· 只看姿态，不修改任务目标":
    " · Preview only; does not change the task target",
  本轮控制对象与顺序: "Controlled model & execution order",
  模型与关节: "Model & joints",
  全组关节见冻结程序: "See frozen program for all joints",
  初始与目标: "Initial & target pose",
  未读取: "Not loaded",
  允许范围: "Allowed range",
  "每个关节分别按冻结模型限位校验，未做实物确认":
    "Each joint is checked against frozen model limits; not physically verified",
  模型标识: "Model identifier",
  "参与关节按完整姿势程序运动，其余保持模型姿态":
    "Participating joints follow the full pose program; others keep the model pose",
  其他轴保持保存姿态: "Other axes keep the saved pose",
  通信协议标识: "Protocol identifier",
  "· 两端必须一致": " · Must match on both ends",
  模型依据与本轮仿真假设: "Model sources & simulation assumptions",
  "本机近似运动检查，不验证实体负载、碰撞、力控或引脚。":
    "Local approximate motion checks do not validate physical loads, collisions, force control or pins.",
  本轮记录的执行顺序: "Recorded execution order",
  已保存的流程顺序: "Saved workflow order",
  尚未拆分: "Not planned",
  正在拆分需求: "Planning requirements",
  等待人工核对: "Awaiting human review",
  "已核对，待生成": "Reviewed, ready to generate",
  等待执行: "Queued",
  正在生成程序: "Generating code",
  正在编译: "Building",
  正在运行检查: "Running checks",
  正在修改程序: "Revising code",
  检查通过: "Checks passed",
  检查失败: "Checks failed",
  已取消: "Cancelled",
  执行中断: "Interrupted",
  正在部署复测: "Validating deployment",
  本地部署已复测: "Local deployment validated",
  需求与设备: "Requirements & hardware",
  查开发资料: "Research sources",
  "AI 拆分工作": "AI task planning",
  人工核对: "Human review",
  生成两端代码: "Generate both programs",
  "编译 ROS": "Build ROS",
  "编译 ESP32": "Build ESP32",
  检查两端通信: "Check communication",
  所选关节仿真: "Simulate selected joints",
  汇总结果: "Summarize results",
  "十个必要步骤都要保留，每个步骤只能出现一次。":
    "Keep all ten required steps, with each appearing exactly once.",
  "有一条连线的步骤不存在，请移除这条线。":
    "A connection references a missing step. Remove that connection.",
  "步骤不能连回自己。": "A step cannot connect to itself.",
  "两个步骤之间保留一条连线即可。":
    "Keep only one connection between each pair of steps.",
  "连线绕成了圈，请移除反向连线，让流程从需求走向结果。":
    "The graph contains a cycle. Remove backward connections so it flows from requirements to results.",
});

/** Local UI error wrappers; the backend or network detail remains original. */
export function coreErrorText(source: string): string {
  for (const [zh, en] of [
    ["分享版资源读取失败：", "Unable to load demo resources: "],
    ["无法连接本机后台：", "Unable to connect to the local service: "],
    ["刷新工程失败：", "Project refresh failed: "],
  ])
    if (source.startsWith(zh)) return t(source, en + source.slice(zh.length));
  const mesh = source.match(/^(结构模型读取失败|模型几何读取失败)（(\d+)）$/);
  if (mesh)
    return t(
      source,
      `${mesh[1] === "结构模型读取失败" ? "Structure model" : "Model geometry"} loading failed (${mesh[2]})`,
    );
  return t(source);
}
