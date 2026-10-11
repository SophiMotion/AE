// Fixed panel UI only. Source documents, generated code, and recorded evidence remain unchanged.
import { registerTranslations } from "./localeStore.ts";

registerTranslations({
  "浏览器公开资料筛选（不是服务器 RAG 检索）":
    "Browser filtering of public references (not server-side RAG)",
  停止发送指令: "Stop sending commands",
  停止反馈测量: "Stop feedback measurements",
  中途取消: "Cancel during execution",
  实际到位与往返次数检查通过: "Measured arrivals and cycle count checks passed",
  "正常动作检查未通过，查看下面的实际记录":
    "Normal action checks failed; see the actual records below",
  "缺少本场景检查记录，尚未验证":
    "Scenario check records are missing; unverified",
  "按计划中断，停机/取消检查通过":
    "Interrupted as planned; stop / cancellation checks passed",
  "停机/取消检查未通过，查看下面的检查原因":
    "Stop / cancellation checks failed; see the reasons below",
  "缺少停机/取消检查记录，尚未验证":
    "Stop / cancellation records are missing; unverified",
  本场景检查通过: "Scenario checks passed",
  本场景检查未通过: "Scenario checks failed",
  缺少本场景检查记录: "Scenario check records are missing",
  收到全部参与关节的实际反馈:
    "Measured feedback received for all participating joints",
  没有非预期的运行错误: "No unexpected runtime errors",
  执行事件与本轮冻结规格一致: "Execution events match the frozen specification",
  物理仿真正常启动: "Physics simulation started correctly",
  固件核心反馈对应实际仿真测量:
    "Firmware core feedback matches simulation measurements",
  各通道测量值对应实际仿真记录: "Channel measurements match simulation records",
  仿真边界只作允许的数值精度处理:
    "Simulation boundaries apply only permitted numerical rounding",
  实际测得的关节速度符合约定上限:
    "Measured joint velocity stays within the agreed limit",
  仿真执行器采用固件核心批准的输出:
    "Simulation actuators use firmware-approved output",
  各关节速度符合约定上限: "Joint velocities stay within the agreed limits",
  各关节加速度符合约定上限: "Joint accelerations stay within the agreed limits",
  轨迹控制器报告完成: "Trajectory controller reports completion",
  全部姿势实际到位: "All poses were measurably reached",
  实际完成约定的往返次数: "The agreed cycles were measurably completed",
  全部参与关节到达最后姿势: "All participating joints reached the final pose",
  中断后所有控制通道停止输出:
    "All control channels stopped output after interruption",
  实际仿真关节停稳: "Simulated joints came to rest",
  轨迹控制器响应取消: "Trajectory controller responded to cancellation",
  取消后实际关节位置稳定:
    "Measured joint positions are stable after cancellation",
  多关节顺序动作: "Multi-joint sequence",
  "该文档已从资料库移除。": "The document has been removed from the library.",
  资料库: "Library",
  "浏览与筛选公开参考资料；本机平台的 RAG 会在生成前检索适用资料。":
    "Browse and filter public references. The local platform retrieves relevant material before generation.",
  "把适用板型、版本和来源一起交给 AI。":
    "Give AI the applicable board, version, and source references.",
  "完整本机平台会运行检索评估；此分享版提供公开资料筛选":
    "Retrieval evaluation runs in the local platform. This demo supports filtering public references.",
  "检索评估（本机功能）": "Retrieval evaluation (local)",
  检查检索效果: "Evaluate retrieval",
  资料导入在完整本机平台进行:
    "Import reference material in the local platform.",
  "导入资料（本机功能）": "Import references (local)",
  导入资料: "Import references",
  "资料已导入，可按关键词、板型和任务查找。":
    "References imported. Search by keyword, board, or task.",
  公开参考资料与已有检索记录: "Public references and recorded retrievals",
  本机资料与检索记录: "Local references and retrieval records",
  查看索引信息: "View index details",
  按资料来源筛选: "Filter by source",
  全部来源: "All sources",
  已核对的运行经验: "Reviewed run experience",
  内置资料: "Built-in references",
  上传资料: "Uploaded references",
  搜索资料: "Search references",
  "搜索串口、失联停车、ESP32…":
    "Search serial ports, disconnect handling, ESP32…",
  按任务筛选资料: "Filter references by task",
  全部任务: "All tasks",
  关节位置: "Joint position",
  传感器阈值: "Sensor threshold",
  按板型筛选资料: "Filter references by board",
  全部板型: "All boards",
  "按 ROS 版本筛选资料": "Filter references by ROS version",
  "全部 ROS 版本": "All ROS versions",
  "不涉及 ROS": "ROS not applicable",
  版本未核对: "Version not reviewed",
  "生成程序前，后台会查适用的资料。没有明确版本的资料可供浏览，是否用于生成以检索记录为准。":
    "Before generation, the backend retrieves applicable references. Material without a confirmed version can be browsed; retrieval records show whether it was used.",
  关闭资料提示: "Dismiss library notice",
  "正在读取原文…": "Loading original content…",
  关闭资料原文: "Close original content",
  "这份经验由工具整理运行结果；其中程序摘录来自原运行的 AI 源码，已单独标注。工具、提示词与完整回答保留在原运行的“AI 记录”中。":
    "This experience summarizes recorded run results. Excerpts from AI-generated source are marked separately. Tools, prompts, and full responses remain in the original run's AI records.",
  经验摘要与程序摘录: "Experience summary and code excerpts",
  原始文本: "Original text",
  适用范围和来源记录: "Scope and source records",
  检索检查结果: "Retrieval evaluation results",
  "个问题检索通过，": "retrieval queries passed;",
  "个未通过。此检查只验证能否找到资料，不验证生成代码。":
    "failed. This checks reference retrieval, not generated code.",
  查看测试问题与结果: "View test queries and results",
  预期不使用不匹配资料: "Expected to exclude incompatible references",
  通过: "Passed",
  未通过: "Failed",
  原始评测记录: "Original evaluation record",
  查看完整内容: "View full content",
  查看原文: "View original",
  "本项目约定，见核对页": "Project contract; see the review page",
  本机导入资料: "Locally imported reference",
  通过记录: "Successful run",
  "失败教训 · 仅供排错": "Failure lesson · troubleshooting only",
  修复与复测: "Repair and retest",
  版本未填写: "Version not specified",
  原文资料: "Original reference",
  整理摘要: "Compiled summary",
  通用资料: "General reference",
  板型未核对: "Board not reviewed",
  "不限定 ROS 版本": "Any ROS version",
  "ROS 版本未标注": "ROS version not specified",
  相关得分: "Relevance score",
  "这份记录包含工具检查摘要和 AI 程序摘录。请点“查看完整内容”，按来源分别查看；失败记录仅供排错。":
    "This record includes tool-check summaries and AI code excerpts. Select “View full content” to inspect each source. Failure records are for troubleshooting only.",
  展开这段资料: "Expand reference excerpt",
  来源标识: "Source ID",
  许可见来源: "See source for license",
  "从本机资料库移除整份文档及其片段？":
    "Remove this document and all its excerpts from the local library?",
  取消: "Cancel",
  确认移除: "Confirm removal",
  没有匹配的资料: "No matching references",
  "换一个关键词、取消筛选，或导入对应版本的资料。":
    "Try another keyword, clear filters, or import references for the relevant version.",
  "AI 生成程序摘录 · 原运行记录保留工具与提示词":
    "AI-generated code excerpt · tools and prompts are retained in the original run",
  "全文检索（BM25）": "Full-text search (BM25)",
  "索引状态来自后台，展开可查看当前资料和检索方式。":
    "Index status comes from the backend. Expand to view current references and retrieval methods.",
  "文件不能超过 10 MB（10,000,000 字节）。":
    "The file must be no larger than 10 MB (10,000,000 bytes).",
  文件读取失败: "Could not read the file",
  导入开发资料: "Import development references",
  "支持文字、含文字的 PDF、源码和机器人配置；导入只读取内容，不执行文件。":
    "Supports text, text-based PDFs, source code, and robot configurations. Import reads content without executing files.",
  关闭资料导入: "Close reference import",
  更换文件: "Change file",
  选择文件: "Choose file",
  "TXT / MD / PDF / Python / C++ / Arduino / YAML / JSON / URDF · 最大 10 MB":
    "TXT / MD / PDF / Python / C++ / Arduino / YAML / JSON / URDF · up to 10 MB",
  选择知识资料文件: "Choose reference file",
  资料名称: "Reference title",
  适用版本: "Applicable version",
  "例如：Arduino-ESP32 3.3.12；不清楚填待确认":
    "Example: Arduino-ESP32 3.3.12; enter “unconfirmed” if unknown",
  适用板型: "Applicable board",
  "适用 ROS 版本": "Applicable ROS version",
  "通用，不限定版本": "General; any version",
  "来源网址（可选）": "Source URL (optional)",
  用于哪些任务: "Applicable tasks",
  "资料适用的结构与软件 ·": "Applicable structure and software ·",
  "尚未确认，先存档": "Unconfirmed; archive only",
  已确认通用: "Confirmed as general",
  待填写: "Not specified",
  "结构资料必须和项目模型对应。没有确认版本或适用结构时，只保存资料供查看，不交给 AI 生成程序。":
    "Structure references must match the project model. Without a confirmed version or structure, references are saved for browsing and excluded from AI generation.",
  适用结构: "Applicable structure",
  资料适用结构: "Reference structure scope",
  "尚未确认（只保存和查看）": "Unconfirmed (save and browse only)",
  "通用资料（确认不限制结构）": "General (confirmed for any structure)",
  当前工程结构: "Current project structure",
  "（先选择工程）": "(select a project first)",
  其他指定结构: "Another specific structure",
  模型: "Model",
  "· 源文件校验值": "· source file checksum",
  "。来自当前工程已保存的结构，不从资料内容猜测。":
    ". Taken from the project's saved structure, not inferred from reference content.",
  模型标识: "Model identifier",
  资料模型标识: "Reference model ID",
  填写结构的准确编号: "Enter the exact structure ID",
  "源模型 SHA256（64位）": "Source model SHA256 (64 characters)",
  源模型校验值: "Source model checksum",
  "从结构来源记录复制，用于匹配同一份模型":
    "Copy from the structure source record to match the same model",
  "指定结构需要准确的模型标识和 64 位源文件校验值；还不清楚时请选择“尚未确认”。":
    "A specific structure requires its exact model ID and 64-character source checksum. Select “Unconfirmed” if these are unknown.",
  "文档版本与程序依赖版本分开填写。以下两项尚未确认时也只存档；资料确实不涉及该依赖时，明确选“通用资料”。":
    "Enter document versions separately from software dependencies. Unconfirmed dependencies allow archiving only. Explicitly select “General” when a dependency does not apply.",
  "ESP32 核心版本": "ESP32 core version",
  "ArduinoJson 版本": "ArduinoJson version",
  "尚未确认（只存档）": "Unconfirmed (archive only)",
  "通用资料（不限制该依赖）": "General (any version of this dependency)",
  "当前工程 ·": "Current project ·",
  未读取: "Not loaded",
  填写准确版本: "Enter exact version",
  具体值: "Exact value",
  "例如 3.3.12": "Example: 3.3.12",
  "例如 7.4.3": "Example: 7.4.3",
  "请填写明确的数字版本；不知道版本时请选择“尚未确认”。":
    "Enter a specific numeric version. Select “Unconfirmed” if unknown.",
  "只填写资料实际适用的版本和板型。空白、unknown、待确认、latest 等不视为已核对版本，只能保存和浏览，不用于生成程序。扫描图片类 PDF 需先转成文字；本次导入不训练模型。":
    "Enter only verified applicable versions and boards. Blank, unknown, unconfirmed, or latest values allow saving and browsing but are excluded from generation. Convert scanned PDFs to text first. Import does not train a model.",
  导入并建立索引: "Import and index",
  运行与评估: "Run & evaluate",
  "展示已有本机执行记录；当前网页没有再次运行。编译通过与实物验证分别记录。":
    "Showing existing local execution records; this page has not rerun them. Compilation and physical validation are recorded separately.",
  "结果来自实际执行。编译通过与实物验证分别记录。":
    "Results come from actual execution. Compilation and physical validation are recorded separately.",
  下载公开示例记录: "Download public example records",
  导出工程: "Export project",
  需求有尚未保存的修改: "Requirements have unsaved changes",
  "这里是原保存版本的结果，不能据此重试或部署新需求。":
    "These results belong to the saved version and cannot be used to retry or deploy changed requirements.",
  保存修改并重新拆分: "Save changes and regenerate plan",
  "当前查看：规格 v": "Viewing: specification v",
  "· 运行": "· run",
  等待这轮检查结果: "Waiting for this run's results",
  还没有运行结果: "No run results yet",
  "浏览器草稿没有运行结果，可选择左侧公开示例查看历史验收。":
    "Browser drafts have no run results. Select a public example on the left to view recorded acceptance results.",
  "日志会记录编译、启动和检查过程。":
    "Logs record compilation, startup, and checks.",
  "核对拆分结果后，生成程序并开始第一轮检查。":
    "Review the plan, then generate code and start the first checks.",
  本轮运行检查通过: "Run checks passed",
  本轮运行检查未通过: "Run checks failed",
  第: "Step ",
  次执行: "execution",
  "ROS 通信": "ROS communication",
  已验证: "Verified",
  "未通过 / 未验证": "Failed / unverified",
  固件编译通过: "Firmware build passed",
  固件编译未通过: "Firmware compilation failed",
  实物: "Physical hardware",
  未验证: "Unverified",
  "通过版本指纹 ·": "Passed-version fingerprint ·",
  "用于确认部署复测采用哪一版源码、模型、协议和工具模板。这项校验不代替实物验收。":
    "Identifies the source, model, protocol, and tool-template versions used for deployment retesting. This check does not replace physical acceptance.",
  "ESP32 固件": "ESP32 firmware",
  编译通过: "Compilation passed",
  编译未通过: "Compilation failed",
  本次没有固件编译记录: "No firmware compilation record for this run",
  以后台编译记录为准: "Refer to backend compilation records",
  "未烧录 · 未验证实体引脚": "Not flashed · physical pins unverified",
  两端通信: "End-to-end communication",
  主机通信测试通过: "Host communication test passed",
  主机通信测试未通过: "Host communication test failed",
  本次没有独立通信记录: "No separate communication record for this run",
  "ROS ↔ 虚拟串口 ↔ 主机运行的固件通信逻辑":
    "ROS ↔ virtual serial port ↔ firmware communication logic running on the host",
  "不等同于 ESP32 板上通信已验证":
    "This does not verify communication on an ESP32 board",
  "查看独立通信检查 ·": "View independent communication checks ·",
  固件编译记录与产物: "Firmware build records and artifacts",
  "本轮代码、完整轨迹与构建产物 ·":
    "Run source, full trajectories, and build artifacts ·",
  个文件: "files",
  "这是已有示例公开的源码与轨迹清单。可在下方“生成文件”查看；下载的是公开记录，不是新需求的工程。完整项目源码见页面顶部链接。":
    "This is the published source and trajectory manifest for an existing example. View it under “Generated files”. Downloads contain public records, not a newly generated project. Full project source is linked at the top.",
  "文件与当前运行及冻结规格绑定。上方“导出工程”包含 ROS 工程、固件工程、构建日志和全部运行轨迹；“生成文件”可逐份查看源码。":
    "Files are bound to this run and its frozen specification. “Export project” includes ROS and firmware projects, build logs, and all trajectories. Browse individual source files under “Generated files”.",
  公开检查记录: "Public check records",
  原始检查记录: "Original check records",
  "用这轮记录修改程序，保留原来的验收标准。":
    "Use this run's records to update the code while retaining the acceptance criteria.",
  修改并重试: "Repair and retry",
  重新执行: "Run again",
  "这份历史记录没有通过版本指纹，可以查看和导出；重新生成并检查后才能部署复测。":
    "This historical record has no passed-version fingerprint. It can be viewed and exported; regenerate and check it before deployment retesting.",
  "已检查规格 v": "Reviewed results for specification v",
  "的结果，同意在本机隔离 ROS 环境中部署复测":
    "and approve deployment retesting in an isolated local ROS environment",
  运行: "Run",
  "· 版本指纹": "· version fingerprint",
  "· 只运行模拟设备，不连接实物或烧录 ESP32":
    "· simulated devices only; no hardware connection or ESP32 flashing",
  部署并复测: "Deploy and retest",
  本机部署复测: "Local deployment retest",
  等待检查结果: "Waiting for check results",
  "· 模拟设备": "· simulated device",
  原始部署记录: "Original deployment record",
  运行轨迹: "Run trajectory",
  "实际值（实线）": "Actual (solid)",
  "目标 / 阈值（虚线）": "Target / threshold (dashed)",
  "时间（s）": "Time (s)",
  全组关节动作实际结果: "Measured results for all joints",
  全组关节的实际动作与往返次数: "Measured joint motion and completed cycles",
  "曲线来自第一轮正常运行的实际位置采样。每个关节分别显示，其他运行与计划中断测试见完整轨迹文件；发送了目标不表示已经到位。停机测试故意中断动作，不要求做完整套招手。":
    "Curves use measured position samples from the first normal run, shown separately for each joint. Full trajectory files contain other runs and interruption tests. Sending a target does not prove arrival. Stop tests deliberately interrupt motion and do not require a complete wave.",
  实际运行: "Actual run",
  本场景检查结果: "Scenario check result",
  到位姿势: "Reached poses",
  "实际 / 要求往返次数": "Completed / required cycles",
  "最后反馈时刻（仿真秒）": "Last feedback time (simulation seconds)",
  完整数据: "Full data",
  未记录: "Not recorded",
  "不适用（停机测试）": "Not applicable (stop test)",
  检查类型待确认: "Check type unconfirmed",
  测量中断后反馈时间戳冻结: "Feedback timestamp freezes after measurement loss",
  "最后反馈时刻按每轮动作的仿真时间从 0 计数，表示采样记录到了哪里；停止反馈测量后时间戳会冻结。它不表示整个停机场景在现实中耗费了多少秒。":
    "Last feedback time starts at zero for each simulated action and indicates the last recorded sample. It freezes when feedback measurements stop. It is not the scenario's elapsed real-world time.",
  "停机/取消检查": "Stop / cancellation check",
  本场景检查: "Scenario checks",
  "本场景核对中断后的停机或取消行为，不以完成招手次数为标准。":
    "This scenario checks stop or cancellation behavior after interruption, not completed wave cycles.",
  查看实际检查依据: "View recorded check evidence",
  "本场景没有可核对的检查记录。":
    "No reviewable check records for this scenario.",
  "· 各姿势实际到位检查": "· measured pose arrival checks",
  "按约定路点时间附近的实际反馈计算全部参与关节最大位置误差，并与冻结容差比较；计划阶段随时间变化不表示已经到位。":
    "Maximum position error across participating joints is calculated from feedback near each waypoint time and compared with the frozen tolerance. A changing planned stage does not prove arrival.",
  路点: "Waypoint",
  "计划阶段 / 往返编号": "Planned stage / cycle",
  "全部关节最大位置误差 (rad)": "Maximum joint position error (rad)",
  实际到位检查: "Measured arrival check",
  缺少检查窗口内反馈: "No feedback in the check window",
  "本轮没有全组关节实际采样，无法显示多关节曲线或回放。不会使用单条标量曲线代表整套动作。":
    "No measured samples for all joints are available. Multi-joint plots and replay cannot be shown; a scalar curve does not represent the full action.",
  采样时对应的计划阶段: "Planned stage at sample time",
  计划往返编号: "Planned cycle",
  "时间 (s)": "Time (s)",
  "实际角度 (rad)": "Measured angle (rad)",
  缺少反馈: "No feedback",
  "缺少实际位置或目标采样，无法绘图。":
    "Measured position or target samples are missing; the plot cannot be shown.",
  核对拆分结果: "Review the plan",
  "体验核对两端分工、通信约定和检查条件；实际生成在本机进行。":
    "Explore responsibilities, communication contracts, and checks. Actual generation runs locally.",
  "确认两端分工和通信约定，再开始生成、编译。":
    "Confirm responsibilities and communication contracts before generation and compilation.",
  "下面仍是旧版拆分，不能用它生成程序。先保存新需求，重新拆分并核对。":
    "The plan below is outdated and cannot be used for generation. Save the new requirements, regenerate the plan, and review it.",
  "AI 正在整理需求": "AI is organizing the requirements",
  这次拆分没有完成: "This planning attempt did not finish",
  先填写并拆分需求: "Enter requirements and generate a plan first",
  "后台会查询资料，并保存这次使用的提示词和来源。":
    "The backend retrieves references and saves the prompts and sources used.",
  "这里将显示 ROS 和 ESP32 各自做什么、双方怎么通信。":
    "This will show the ROS and ESP32 responsibilities and how they communicate.",
  返回需求: "Back to requirements",
  这份旧拆分需要重新核对: "This older plan needs review",
  "缺少本轮核对标识，请重新拆分后再确认。":
    "The review identifier is missing. Regenerate the plan before confirming.",
  "分享范围说明 · 实际生成需要本机平台":
    "Demo scope · actual generation requires the local platform",
  "AI 提出的阻止项 · 请结合实际规格核对":
    "AI-reported blockers · review against the actual specification",
  先处理这些问题: "Resolve these issues first",
  "以下是分享版的使用范围，补齐表单也不会新增在线执行服务。":
    "The following describes this demo's scope. Completing the form does not enable online execution.",
  "以下要求尚不能按当前方案完成，先修改需求，再重新拆分。":
    "These requirements cannot yet be fulfilled by the current plan. Update them and regenerate the plan.",
  返回修改需求: "Back to edit requirements",
  这份规格说明什么: "What this specification describes",
  这轮实际按什么执行: "What this run executes",
  "以下是已有本机验收示例的冻结规格，修改草稿不会改变历史结果。":
    "This is the frozen specification of an existing local acceptance example. Draft changes do not alter historical results.",
  "以下来自当前浏览器草稿，尚未生成或运行验证。":
    "This is the current browser draft. It has not been generated or verified by execution.",
  "以下参数直接来自执行程序，请与需求一起核对。":
    "These parameters come directly from the execution program. Review them against the requirements.",
  需求用途: "Intended use",
  目标控制板: "Target board",
  控制与反馈: "Control and feedback",
  "全组虚拟关节 / 仿真测量反馈":
    "All virtual joints / simulated measurement feedback",
  "虚拟关节 / 模拟编码器": "Virtual joint / simulated encoder",
  "虚拟开关 / 模拟传感器": "Virtual switch / simulated sensor",
  "，不接实体设备": "; no physical device connected",
  任务目标: "Task objective",
  "按上方全部关节的姿势、顺序与往返编号执行；最后一行是结束姿势":
    "Execute all joint poses, sequence, and cycle indices above. The final row is the ending pose.",
  观察时长: "Observation duration",
  "反馈频率 / 失联": "Feedback rate / disconnection",
  "频率、带宽、反馈年龄与失联处理以冻结批量协议和本轮检查为准":
    "Rate, bandwidth, feedback age, and disconnect handling follow the frozen batch protocol and this run's checks.",
  秒收不到有效消息就输出零:
    "seconds without a valid message triggers zero output",
  消息格式: "Message format",
  "会话、序号、阶段、时间和全组通道目标 / 反馈；整组校验后接受":
    "Session, sequence, stage, time, and all channel targets / feedback; accepted after validating the whole batch",
  "；包含 seq、time、value": "; includes seq, time, and value",
  "，并核对关节名、模型标识与协议标识":
    "; validates joint name, model ID, and protocol ID",
  序号与单位: "Sequence numbers and units",
  "序号严格递增，重复或过期指令不执行。":
    "Sequence numbers must increase. Duplicate or outdated commands are not executed.",
  "位置用 rad、速度用 rad/s、加速度用 rad/s²；同一关节只有一个仿真写入者。":
    "Position uses rad, velocity rad/s, and acceleration rad/s². Each joint has one simulation writer.",
  "位置用 rad，速度用 rad/s。": "Position uses rad; velocity uses rad/s.",
  "传感器值为 0–1，指令为 0 或 1。":
    "Sensor values range from 0 to 1; commands are 0 or 1.",
  "ESP32 范围": "ESP32 scope",
  "生成并编译所选板型的固件；串口收发逻辑在主机测试。编译是否通过见本轮结果，不烧录控制板。":
    "Generate and compile firmware for the selected board. Serial communication logic is tested on the host. See the run results for compilation status. The board is not flashed.",
  通信通道: "Communication channel",
  "批量紧凑协议通过主机虚拟串口测试，实物串口吞吐未验证":
    "The compact batch protocol is tested through a host virtual serial port. Physical serial throughput is unverified.",
  "ROS 模拟设备通信": "ROS simulated-device communication",
  结构用途: "Structure use",
  "按本轮冻结关节树进行近似运动检查，未做实物标定":
    "Approximate motion checks use the frozen joint tree; no physical calibration has been performed.",
  内置测试台架: "Built-in test fixture",
  "导入 / 参考结构只用于预览，未作为动力学模型运行":
    "Imported / reference structures are preview-only and have not run as dynamics models.",
  必须遵守: "Required constraints",
  验收要求: "Acceptance requirements",
  展开完整通信与模拟约定: "Expand communication and simulation contracts",
  "公开示例 / 浏览器摘要 · ": "Public example / browser summary · ",
  "AI 生成 · ": "AI-generated · ",
  已记录工具: "Tool recorded",
  "以下是公开示例说明或浏览器规则摘要，不是新的 AI 拆分或执行结果。":
    "These are public example descriptions or browser rule summaries, not newly generated AI plans or execution results.",
  "以下分工、通信建议、检查建议和缺失项均由 AI 生成 · 完整工具与提示词见下方“AI 记录”":
    "Responsibilities, communication suggestions, checks, and missing items below were generated by AI. Full tools and prompts are under “AI records”.",
  "ROS 端": "ROS",
  "ESP32 端": "ESP32",
  两端共同的通信约定: "Shared communication contract",
  怎样检查是否完成: "How completion is checked",
  还要留意: "Additional considerations",
  "本次参考资料 ·": "References for this plan ·",
  "本项目通信约定，见上方“这轮实际按什么执行”。":
    "Project communication contract; see “What this run executes” above.",
  "已核对本版需求、两端分工和通信参数":
    "I have reviewed this version's requirements, responsibilities, and communication parameters",
  规格版本: "Specification version",
  "我已阅读，查看生成流程": "Reviewed; view generation workflow",
  "确认，生成并检查": "Confirm, generate, and check",
  "本版规格已人工核对。修改需求后，需要重新核对。":
    "This specification has been reviewed. Changes to requirements require another review.",
  "本次拆分暂不可执行，请查看工程状态。":
    "This plan cannot be executed yet. Check the project status.",
  查看生成流程: "View generation workflow",
  生成并检查: "Generate and check",
  "示例验证环境 / 分享范围": "Example validation environment / demo scope",
  本机环境信息: "Local environment",
  "正在读取本机环境…": "Loading local environment…",
  生成代码范围检查: "Generated code scope check",
  "ESP32 生成代码范围检查": "ESP32 generated code scope check",
  "ESP32 控制算法独立计算检查":
    "Independent ESP32 control algorithm calculation",
  "ESP32 输出不超过约定范围": "ESP32 output stays within the agreed range",
  "收不到测量值时，固件逻辑停止输出":
    "Firmware logic stops output when measurements are unavailable",
  分段消息能够完整接收: "Fragmented messages are received in full",
  重复指令不会执行两次: "Duplicate commands are not applied twice",
  模型不匹配或格式错误的消息被拒绝:
    "Messages with mismatched models or invalid formats are rejected",
  "关节位置来自仿真测量，不由通信程序自算":
    "Joint position comes from simulation measurements, not the communication program",
  测量超时后停止输出: "Output stops after measurement timeout",
  测量恢复后能继续收发: "Communication resumes when measurements recover",
  指令超时后停止输出: "Output stops after command timeout",
  "消息携带正确的关节、模型和协议标识":
    "Messages carry the correct joint, model, and protocol IDs",
  仿真从所选模型的保存姿态开始:
    "Simulation starts from the selected model's saved pose",
  实际执行顺序与已批准流程一致: "Execution order matches the approved workflow",
  运行的模型与通信约定和批准版本一致:
    "The running model and communication contract match the approved version",
  "ROS 工程编译": "ROS project build",
  "ESP32 固件交叉编译": "ESP32 firmware cross-compilation",
  串口收不到状态后停止输出: "Output stops when serial state feedback is lost",
  "更换阈值后，触发与解除仍正确":
    "Trigger and release behavior remains correct with another threshold",
  "消息未收完整时，等待下一段":
    "Incomplete messages wait for the next fragment",
  分段收到的消息能重新拼合: "Message fragments are reassembled",
  重复或过期消息被拒绝: "Duplicate or outdated messages are rejected",
  错误格式的消息被拒绝: "Malformed messages are rejected",
  "超长消息被丢弃后，通信能恢复":
    "Communication recovers after discarding an oversized message",
  重新连接后接收新序号: "New sequence numbers are accepted after reconnection",
  状态消息符合两端约定: "State messages follow the shared contract",
  "ROS 收不到状态后输出零": "ROS outputs zero when state feedback is lost",
  模拟设备失联后停止: "The simulated device stops after disconnection",
  错误格式的指令被拒绝: "Malformed commands are rejected",
  物理仿真引擎正常启动: "The physics simulation engine starts correctly",
  收到物理仿真的关节位置:
    "Joint position measurements are received from physics simulation",
  关节控制: "Joint control",
  传感器触发: "Sensor trigger",
  当前目标: "Current target",
  更换目标: "Alternate target",
  起点已在目标位置: "Already at target initially",
  更换触发阈值: "Alternate trigger threshold",
  关节物理仿真: "Joint physics simulation",
  虚拟串口: "Virtual serial port",
  两端通信闭环: "End-to-end communication loop",
  所选关节当前目标: "Selected joint current target",
  所选关节更换目标: "Selected joint alternate target",
  所选关节起点已在目标位置: "Selected joint initially at target",
  虚拟串口更换阈值: "Virtual serial port alternate threshold",
  通信格式与收发: "Message format and exchange",
  反馈频率: "Feedback rate",
  位置误差: "Position error",
  阈值触发与解除: "Threshold trigger and release",
  固件逻辑收到并采用指令: "Firmware logic receives and applies commands",
  "执行的是本轮生成的 ESP32 算法": "The generated ESP32 algorithm is executed",
  反馈来自本轮所选模型: "Feedback comes from the selected model",
  固件逻辑的输出驱动物理仿真: "Firmware logic output drives physics simulation",
  其他执行检查: "Other execution checks",
  "Gazebo 关节物理仿真 + ROS 通信检查":
    "Gazebo joint physics simulation + ROS communication checks",
  "传感器数值模拟 + ROS 通信检查":
    "Sensor numerical simulation + ROS communication checks",
  "ROS 通信与数值模拟": "ROS communication and numerical simulation",
  本机程序执行与检查: "Local execution and checks",
  "参考代码，未编译烧录": "Reference code; not compiled or flashed",
  "模拟设备，未烧录": "Simulated device; not flashed",
  查看原始记录确认: "Check original records to confirm",
  模型与流程一致性: "Model and workflow consistency",
  物理仿真: "Physics simulation",
  代码与编译: "Code and compilation",
  任务效果: "Task outcome",
  通信与失联处理: "Communication and disconnection handling",
  项通过: "passed",
  失败: "Failed",
  运行日志: "Run logs",
  生成文件: "Generated files",
  两端代码: "ROS and ESP32 code",
  检查结果: "Check results",
  生成与工具记录: "Generation and tool records",
  "AI 记录": "AI records",
  工程记录: "Project records",
  下载完整工程: "Download complete project",
  本机原始运行日志未公开: "Original local run logs are not public",
  "生成和运行后，这里会保留真实记录。":
    "Actual records will appear here after generation and execution.",
  "可在“检查结果”“生成文件”查看公开证据；本页面不会伪造运行过程。":
    "Public evidence is available under “Check results” and “Generated files”. This page does not fabricate execution logs.",
  "编译输出、启动过程和报错都可以在这里查看。":
    "View compiler output, startup details, and errors here.",
  选择左侧文件查看: "Select a file on the left",
  "可下载完整工程，在本机继续开发。":
    "Download the complete project to continue development locally.",
  还没有生成文件: "No generated files yet",
  "程序、通信约定和检查结果都会保存到这一轮工程。":
    "Code, communication contracts, and check results are saved with this run's project.",
  还没有检查结果: "No check results yet",
  "只有后台真正执行之后，才会显示通过或失败。":
    "Pass or fail results appear only after actual backend execution.",
  "工具说明 · ": "Tool details · ",
  工具已记录: "Tool recorded",
  "整理方式 / 使用的提示词": "Method / prompt used",
  使用的提示词: "Prompt used",
  "该公开示例采用固定模板生成，此分享页面不进行新的 AI 调用。":
    "This public example was generated from a fixed template. This demo does not make new AI calls.",
  本轮未提供提示词记录: "No prompt record provided for this run",
  原始回答: "Original response",
  参考来源: "References",
  "还没有调用 AI": "No AI calls yet",
  "拆分需求和写代码的工具、模型、提示词与来源会保留在这里。":
    "Tools, models, prompts, and references used for planning and code generation are retained here.",
  两端代码还没有生成: "ROS and ESP32 code has not been generated yet",
  "这里保留每次生成或修复的 Python 与 C++ 原文。":
    "Original Python and C++ source from each generation or repair is retained here.",
  生成版本: "Generated version",
  选择代码版本: "Select code version",
  次: "times",
  " · 检查拒绝": " · rejected by checks",
  "已有模板生成源码 · ": "Existing template-generated source · ",
  "· 编译与执行结果另行查看":
    "· compilation and execution results are shown separately",
  "这版 AI 源码未通过代码检查，没有当作可执行程序使用。":
    "This AI-generated source failed code checks and was not used as an executable program.",
  "上一轮源码读取失败：": "Could not load previous source:",
  "比较来源：运行": "Comparison source: run",
  "的最后一版保存源码。": "'s last saved source version.",
  完整源码: "Full source",
  与上一版比较: "Compare with previous version",
  增加: "Added",
  "行 · 删除": "lines · removed",
  行: "lines",
  " · 源码未改动": " · source unchanged",
  "这是当前记录中的第一版，没有可比较的上一版。":
    "This is the first version in the current record; no previous version is available for comparison.",
  真实源码差异: "Actual source differences",
  这份历史记录没有保存: "This historical record does not contain",
  "生成片段，请在“生成文件”中查看当时的完整工程。":
    "generated excerpts. See “Generated files” for the original complete project.",
  "AI 对这次改动的说明": "AI explanation of these changes",
  把这轮结果留给下一次: "Keep this run's lessons for future work",
  "先核对适用范围和证据，再存入资料库；成功、失败与修复分别标记。":
    "Review scope and evidence before saving to the library. Successes, failures, and repairs are labeled separately.",
  收起经验: "Collapse experience",
  查看并保存经验: "Review and save experience",
  "正在读取记录…": "Loading records…",
  失败教训: "Failure lesson",
  "· 实物未验证": "· physical hardware unverified",
  适用任务: "Applicable task",
  关节位置控制: "Joint position control",
  检查记录: "Check records",
  失败项: "Failed checks",
  源码版本和证据: "Source versions and evidence",
  "以下程序摘录来自本轮 AI 生成源码 · 工具和提示词见页面下方“AI 记录” · 摘录不包含完整驱动":
    "The following excerpts come from this run's AI-generated source. Tools and prompts are under “AI records” below. Excerpts do not contain complete drivers.",
  次保存: "save",
  "已存入资料库。后续匹配任务可查到此记录；如不再适用，可在资料库移除。已有运行引用不会改变。":
    "Saved to the library for future matching tasks. Remove it from the library if no longer applicable. Existing run references remain unchanged.",
  "已核对范围、代码和结果，允许后续匹配任务作为参考":
    "I reviewed the scope, code, and results and approve this as a reference for matching tasks",
  核对后存入资料库: "Save reviewed experience",
  "这份记录暂不满足入库条件，请查看上方说明。":
    "This record does not yet meet library requirements. See the explanation above.",
  "请选择不超过 30 MB 的工程 ZIP。":
    "Choose a project ZIP no larger than 30 MB.",
  "文件读取失败，请重新选择。":
    "Could not read the file. Please choose it again.",
  工程版本历史: "Project version history",
  导入工程包: "Import project archive",
  "保留原记录，创建新的草稿。生成、编译前仍需重新核对。":
    "Create a new draft while keeping the original records. Review is still required before generation and compilation.",
  关闭工程工具: "Close project tools",
  "当前页面有未保存内容。打开新草稿会离开这些修改；需要保留时，请先关闭这里并保存。":
    "This page has unsaved changes. Opening a new draft leaves them behind. Close this dialog and save first if you want to keep them.",
  以当前查看的运行开始下一轮: "Start the next iteration from the viewed run",
  "· 规格 v": "· specification v",
  复制本轮为新草稿: "Copy this run to a new draft",
  "先选择一个已保存的工程。": "Select a saved project first.",
  "正在读取版本…": "Loading versions…",
  "这份历史工程尚未保存需求版本；之后每次保存和拆分都会留下记录。已执行的版本仍可从历史运行查看。":
    "This historical project has no saved requirement versions. Future saves and planning attempts will be recorded. Executed versions remain available in run history.",
  未命名需求: "Untitled requirements",
  板型待选: "Board not selected",
  模拟传感器: "Simulated sensor",
  控制对象待选: "Control target not selected",
  当时的参数和需求: "Parameters and requirements at that time",
  "这版拆分由 AI 生成 ·": "This plan was generated by AI ·",
  "这版失败调用 · 工具、提示词与原回答":
    "Failed call · tool, prompt, and original response",
  从这个版本新建: "Create draft from this version",
  更换工程包: "Change archive",
  "选择工程 ZIP": "Choose project ZIP",
  "选择工程 ZIP 文件": "Choose project ZIP file",
  "正在检查工程包…": "Checking project archive…",
  "任务 / 板型": "Task / board",
  "待整理 / 仅保存需求": "Unplanned / requirements only",
  控制对象: "Control target",
  来源运行: "Source run",
  包内未提供: "Not included in archive",
  版本记录: "Version records",
  "包内文件 SHA256 校验通过；作为新草稿仍需重检":
    "Archive SHA256 checks passed; a new draft still requires rechecking",
  "历史包没有逐文件 SHA256 清单":
    "This older archive has no per-file SHA256 manifest",
  "已核对，作为新草稿导入；不继承旧批准或通过状态":
    "Reviewed; import as a new draft without inheriting prior approvals or pass status",
  导入为新草稿: "Import as new draft",
  "只读取本平台导出的工程。不会执行包内程序、烧录固件或自动开始任务。":
    "Only projects exported by this platform are read. Archive contents are not executed, firmware is not flashed, and tasks are not started automatically.",
  创建: "Create",
  修改前保留: "Snapshot before changes",
  保存需求: "Save requirements",
  开始拆分: "Start planning",
  拆分前保留: "Snapshot before planning",
  拆分完成: "Planning completed",
  拆分失败: "Planning failed",
  拆分取消: "Planning cancelled",
  人工核对: "Human review",
  导入工程: "Import project",
  复制工程: "Copy project",
  从已有版本创建: "Created from existing version",
  "保存后，后台会生成本轮工程清单，检查板型、运行环境、控制对象与通信是否配套。旧工程需重新保存。":
    "After saving, the backend generates a project manifest and checks board, runtime, control target, and communication compatibility. Older projects must be saved again.",
  本轮工程清单: "Project manifest",
  尚未更新: "Not updated",
  已保存配置: "Saved configuration",
  "需求已有修改，下面是上次保存的清单；保存后会重新检查。":
    "Requirements have changed. The manifest below is from the last save; saving again reruns the checks.",
  "两端收发同一关节、模型与协议标识":
    "Both sides exchange the same joint, model, and protocol IDs",
  "本机模拟设备，不接实体引脚":
    "Local simulated device; no physical pins connected",
  "串口消息格式 · 主机虚拟串口":
    "Serial message format · host virtual serial port",
  "实物输入输出：本轮关闭": "Physical I/O: disabled for this run",
  编译目标: "Build target",
  等待重新检查: "Waiting for recheck",
  配置检查未通过: "Configuration checks failed",
  "只检查配置是否配套，不等于编译或运行通过。":
    "Checks configuration compatibility only, not successful compilation or execution.",
  查看配置检查与版本: "View configuration checks and versions",
  "· ESP32 核心": "· ESP32 core",
  清单标识: "Manifest ID",
  "接实物前还缺什么 ·": "Missing before hardware connection ·",
  项: "items",
  有自动检查: "Automated check available",
  仅人工核对: "Human review only",
  当前不支持: "Currently unsupported",
  与参数冲突: "Conflicts with parameters",
  "这份历史计划未保存逐条验收对应关系。重新拆分后可以查看。":
    "This older plan has no saved requirement-to-check mapping. Regenerate the plan to view it.",
  需求与验收对应表: "Requirements and acceptance mapping",
  "这些要求，程序会检查哪些":
    "Which requirements will be checked automatically?",
  "AI 对文字需求的逐项对照 · 请人工核对，不是已经通过的结果":
    "AI mapping of individual requirements · review required; this is not a passed result",
  "对应检查：": "Related checks:",
  "列入自动检查只代表有检查办法，还需等实际运行结果。仅人工核对的文字要求不能算自动验收通过。":
    "An automated check entry only means a check is available; actual run results are still required. Requirements marked for human review do not count as automated acceptance passes.",
  "本轮工具实际检查什么 · 后台固定条件":
    "What the tools check · fixed backend conditions",
});
