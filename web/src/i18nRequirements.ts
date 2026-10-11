// UI text only. User entries, stored values and source records are preserved.
import { registerTranslations, t } from "./localeStore";
import { numberChoices } from "./intakeChoices";
import { detailLabels } from "./intakeDetails";
import type { AssistProvenance, IntakeIssue } from "./api";

// These are platform messages, not translations of user/AI content. Templates
// below match the exact validation grammar and preserve embedded user values.
const platformMessages: Record<string, string> = {
  "这是完整界面分享版。需求和流程草稿只保存在当前浏览器；验收结果属于原始示例，不会在线调用 AI、编译或运行 ROS。":
    "This is the full-interface sharing demo. Requirement and workflow drafts are saved only in this browser. Results belong to the original example; this site does not call AI, compile code or run ROS online.",
  "信息够用只表示可以开始拆分；还需人工核对，再生成、编译和检查仿真与通信。硬件资料有出处不代表已适配或实测。":
    "Complete information allows planning to begin. Human review, generation, compilation, simulation and communication checks are still required. Documented hardware has not necessarily been integrated or tested.",
  "分享版可整理需求和预览分工；实际 AI、代码生成、编译与 ROS 验收需要完整本机平台。":
    "The sharing demo supports requirements and a division-of-work preview. AI, code generation, compilation and ROS validation require the full local platform.",
  "浏览器需求草稿；信息齐全只允许预览分工，不证明代码或动作正确":
    "Browser requirement draft; complete information enables a work-plan preview and does not validate code or motion",
  "查看已填写的误差、动作阶段与检查条件":
    "See the entered tolerance, action stages and validation conditions",
  "选中的关节不在当前模型可动关节中。":
    "The selected joint is not movable in the current model.",
  "模拟传感器阈值必须在 0～1 之间。":
    "The simulated sensor threshold must be between 0 and 1.",
  "填写的角度超出当前模型关节范围，请调整。":
    "The entered angle is outside the model joint limits. Adjust it.",
  "这个角度超出当前模型关节范围；请修改角度或重新选择部位。":
    "This angle is outside the model joint limits. Change the angle or select another joint.",
  "未知实物信息不能由分享版推测，请补充厂家资料或保留待确认。":
    "The sharing demo cannot infer unknown hardware information. Add manufacturer documentation or leave it pending.",
  "已选择补充需求，请填写具体内容。":
    "You selected additional requirements. Enter the details.",
  "请选择先做本机仿真，还是整理实物资料。":
    "Choose local simulation or hardware documentation first.",
  "当前只整理实物资料；尚未提供真实设备驱动，不能生成并执行实物控制。":
    "This mode records hardware information. A real device driver is not available, so physical control cannot be generated or executed.",
  "请选择这次想做什么。": "Choose the intended action.",
  "来回摆动可以保存需求，当前没有往返动作执行器；不会改成只到一个位置。":
    "Oscillation requirements can be saved. This executor does not support repeated motion; the request will not be reduced to a single target.",
  "这类任务可以保存说明，当前执行器尚未支持。":
    "This task can be documented, but the current executor does not support it.",
  "标为有出处时，请同时填写资料内容与出处；否则改为待确认。":
    "A documented entry needs both content and a source. Otherwise mark it as pending.",
  "参与关节不能为空或重复。":
    "Participating joints must not be empty or duplicated.",
  "姿势程序与当前模型配置不一致，请重新关联并核对。":
    "The pose program does not match the current model configuration. Reassociate it and review again.",
  "至少需要起始姿势和一个目标姿势。":
    "An initial pose and at least one target pose are required.",
  "误差、速度、加速度和超时必须为正数。":
    "Tolerance, velocity, acceleration and timeout must be positive.",
  "超时应大于完整动作累计时间。":
    "Timeout must exceed the total action duration.",
  "十个必要步骤都要保留，每个步骤只能出现一次。":
    "Keep all ten required steps, with each appearing exactly once.",
  "有一条连线的步骤不存在，请移除这条线。":
    "A connection references a missing step. Remove that connection.",
  "步骤不能连回自己。": "A step cannot connect to itself.",
  "两个步骤之间保留一条连线即可。":
    "Keep only one connection between each pair of steps.",
  "连线绕成了圈，请移除反向连线，让流程从需求走向结果。":
    "The graph contains a cycle. Remove backward connections so it flows from requirements to results.",
};
registerTranslations(platformMessages);
registerTranslations({
  在线生成与运行: "Online generation and execution",
  机器人要做什么: "What the robot should do",
  本轮用途: "Purpose of this run",
  逐关节姿势程序: "Per-joint pose program",
  姿势程序人工核对: "Human review of the pose program",
  完整动作待核对事项: "Complete-action review items",
  其他动作说明: "Other action details",
  固件编译目标: "Firmware build target",
  关节角度: "Joint angle",
  工程流程: "Engineering workflow",
  "实物型号、供电、驱动和接线": "Hardware model, power, driver and wiring",
  姿势程序: "Pose program",
  要控制的关节: "Joint to control",
  计划最高速度: "Planned maximum velocity",
  计划允许角度误差: "Planned angular tolerance",
  允许角度误差: "Angular tolerance",
  其他任务说明: "Other task details",
  "ESP32 编译目标": "ESP32 build target",
  硬件资料出处: "Hardware documentation source",
});

const browserMessages: Record<string, string> = {
  "浏览器规则推荐（非 AI）。建议均可修改，实际生成与运行请使用完整本机平台。":
    "Browser-rule suggestions (not AI). Every suggestion is editable. Use the full local platform for generation and execution.",
  "推荐只补空白。陌生动作没有规则时保留原话和待填写内容；已有记录不会成为你修改后需求的验收结果。":
    "Suggestions fill blank fields only. If no rule matches an action, your wording and pending fields are preserved. Existing records do not validate your modified requirement.",
  根据你的原话生成可修改的草稿标题:
    "Editable draft title based on your wording",
  保留你的原话: "Your original wording is preserved",
  "仅识别页面内置关键词，没有调用 AI":
    "Uses only built-in keywords; no AI was called",
  "分享版的电脑仿真需求示例；不是实物确认":
    "A computer-simulation example for this demo; it does not confirm physical hardware",
  "公开 Sophicore 模型参考，可自行更改":
    "Public Sophicore reference model; you can change it",
  "只选择模型预览关节，完整动作仍保留全部相关关节":
    "Selects a preview joint only; the full action retains all participating joints",
  "来自你的原话，完整往返算一次":
    "Taken from your wording; one complete return trip counts as one cycle",
  来自用户明确给出的角度:
    "Taken from the angle explicitly provided by the user",
  "浏览器规则整理公开示例，阶段和关节仍需核对；没有运行或验证":
    "Browser rules organize a public example. Stages and joints still need review; nothing has been executed or validated",
  公开演示边界: "Public demo scope",
  "采用可修改的平台仿真说明；不确认任何未知实物参数":
    "Uses editable platform simulation notes; no unknown physical parameters are confirmed",
  "缺少实物和厂家资料，不能猜测。":
    "Hardware and manufacturer documentation are missing and cannot be guessed.",
  "需主动选择参考配方并核对每个姿势，不根据招手文字自动确认角度。":
    "Select a reference recipe and review each pose. Waving instructions do not automatically confirm joint angles.",
  "分享版浏览器规则（非 AI）": "Sharing-demo browser rules (not AI)",
  公开参考配方与固定选项: "Public reference recipes and fixed options",
};

/** Translate only evidence explicitly attributed to the built-in browser rules. */
export function displayBrowserRuleText(
  source: string,
  provenance?: AssistProvenance | null,
): string {
  if (
    provenance?.tool !== "分享版浏览器规则（非 AI）" ||
    provenance.status !== "browser_rule_preview"
  )
    return source;
  if (Object.hasOwn(browserMessages, source))
    return t(source, browserMessages[source]);
  for (const key of [
    "max_velocity_rad_s",
    "tolerance_rad",
    "duration_s",
    "repetitions",
    "dwell_s",
    "threshold",
  ])
    for (const choice of numberChoices(key))
      if (source === `可修改的草稿示例：${choice.label}；${choice.description}`)
        return t(
          source,
          `Editable draft example: ${t(choice.label)}; ${t(choice.description)}`,
        );
  return source;
}

export function displayRequirementMessage(source: string): string {
  if (Object.hasOwn(platformMessages, source))
    return t(source, platformMessages[source]);
  const joint = source.match(/^关节 (.+) 不在当前可动关节中。$/u);
  if (joint)
    return t(
      source,
      `Joint ${joint[1]} is not in the current movable-joint list.`,
    );
  const remaining = source.match(/^(\d+) 项待核对内容仍需逐项整理。$/u);
  if (remaining)
    return t(
      source,
      `${remaining[1]} review items still need to be checked individually.`,
    );
  const pose = source.match(
    /^第 (\d+) 个姿势(的累计时间必须递增。|的阶段代号需为 1～80 个英文字母、数字、下划线或短横线。|的往返编号应为非负整数。|必须包含全部参与关节。)$/u,
  );
  if (pose) {
    const suffixes: Record<string, string> = {
      "的累计时间必须递增。": "must have a strictly increasing elapsed time.",
      "的阶段代号需为 1～80 个英文字母、数字、下划线或短横线。":
        "needs a stage ID of 1–80 letters, digits, underscores or hyphens.",
      "的往返编号应为非负整数。": "needs a non-negative integer cycle index.",
      "必须包含全部参与关节。": "must include every participating joint.",
    };
    return t(source, `Pose ${pose[1]} ${suffixes[pose[2]]}`);
  }
  const angle = source.match(
    /^第 (\d+) 个姿势的 (.+) 超出模型范围或缺少角度。$/u,
  );
  if (angle)
    return t(
      source,
      `Pose ${angle[1]}: ${angle[2]} is outside the model limits or has no angle.`,
    );
  const board = source.match(/^(esp32s3|esp32) 编译目标（不是实物型号确认）$/u);
  if (board)
    return t(
      source,
      `${board[1]} build target (physical board model not confirmed)`,
    );
  return source;
}

export function displayRequirementIssueLabel(issue: IntakeIssue): string {
  if (
    /^prd\.intake\.action_draft\.stages\.\d+$/u.test(issue.path) &&
    issue.label.endsWith("核对")
  )
    return t(issue.label, `Review ${issue.label.slice(0, -2)}`);
  if (
    /^prd\.intake\.hardware_notes\.[a-z_]+$/u.test(issue.path) &&
    issue.label.startsWith("硬件资料：")
  )
    return t(issue.label, `Hardware documentation: ${issue.label.slice(5)}`);
  for (const [group, label] of Object.entries(detailLabels))
    if (
      issue.path === `prd.intake.details.${group}` &&
      issue.label === `${label}的补充`
    )
      return t(issue.label, `Additional details: ${t(label)}`);
  return t(issue.label);
}

export function displayRequirementIssue(issue: IntakeIssue): string {
  const source = issue.message;
  const label = displayRequirementIssueLabel(issue);
  if (source === `请填写或明确选择${issue.label}。`)
    return t(source, `Complete or explicitly select: ${label}.`);
  if (source.startsWith(issue.label)) {
    const suffix = source.slice(issue.label.length);
    const number = suffix.match(
      /^必须是(整数|有效数值)，且不能小于 (-?(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|Infinity))。$/u,
    );
    if (number)
      return t(
        source,
        `${label} must be ${number[1] === "整数" ? "an integer" : "a valid number"} and at least ${number[2]}.`,
      );
    const length = suffix.match(/^至少需要 (\d+) 个字。$/u);
    if (length)
      return t(source, `${label} needs at least ${length[1]} characters.`);
    const range = suffix.match(/^需在 (-?[\d.]+) 到 (-?[\d.]+) (.*?) 之间。$/u);
    if (range)
      return t(
        source,
        `${label} must be between ${range[1]} and ${range[2]} ${range[3] === "次" ? "times" : range[3]}.`,
      );
  }
  return displayRequirementMessage(source);
}

const sourceLabels: Record<string, string> = {
  从原话提取: "Extracted from your request",
  来自参考模型: "From the reference model",
  平台开发设置: "Platform development setting",
  可修改的示例: "Editable example",
  "AI 整理建议": "AI suggestion",
  从需求提取: "Extracted from the requirement",
  示例建议: "Example suggestion",
};
registerTranslations(sourceLabels);
registerTranslations(
  Object.fromEntries(
    Object.entries(sourceLabels).map(([source, english]) => [
      `先前建议，需重新核对 · ${source}`,
      `Previous suggestion; review again · ${english}`,
    ]),
  ),
);
registerTranslations({
  "本草稿已保留 20 次不同建议的来源。为避免丢失来源，本次未填入；可直接手动编辑。":
    "This draft already retains 20 suggestion sources. Nothing was applied to avoid losing history. You can edit it directly.",
  "ESP32-S3 通用编译目标": "ESP32-S3 generic build target",
  "ESP32 通用编译目标": "ESP32 generic build target",
  关节位置控制: "Joint position control",
  传感器触发: "Sensor trigger",
  多关节动作程序: "Multi-joint motion program",
  这是一份已有工程: "Existing project",
  "仍按原表单查看和修改。切换到新引导会保留原话与现有参数，之后需要重新拆分、核对。":
    "You can keep using the original form. Switching to the new guide preserves your wording and current parameters; planning and review must then be repeated.",
  按新表单整理: "Use the guided form",
  "已取消，本次建议没有填入": "Cancelled. No suggestions were applied.",
  "这项内容已变化，或包含你填写的补充；请直接编辑后重新推荐":
    "This content has changed or includes your additions. Edit it directly, then request new suggestions.",
  结构模型: "Robot model",
  参考预览关节: "Joint to preview",
  本轮控制的关节: "Joint to control",
  你希望机器人做什么: "What should the robot do?",
  工程名称: "Project name",
  怎样才算完成: "What counts as complete?",
  必须遵守的限制: "Required constraints",
  目标控制板: "Target board",
  秒: "s",
  次: "times",
  "这个角度取决于所选关节和姿势，没有通用推荐值。先看模型；不清楚就留待确认。":
    "This angle depends on the selected joint and pose. There is no universal recommendation. Inspect the model, or leave it pending if unsure.",
  "这是观察时长，不保证所有动作会在这段时间内做完。":
    "This is an observation period, not a guarantee that the whole action will finish within it.",
  需求引导表单: "Requirements guide",
  "把需求说明白，再生成程序":
    "Define the requirements, then generate the program",
  "先选看得懂的选项；不知道的留空。保存不会调用 AI，也不会启动机器人。":
    "Choose the options you understand and leave unknowns blank. Saving does not call AI or start the robot.",
  需求准备: "Requirements preparation",
  这份需求仍使用原来的五步表单:
    "This requirement still uses the original five-step form",
  "可以继续查看和保存。需要补充动作顺序、设备对应、异常和环境时，再明确升级；原话和已有答案会保留，新问题先留空。":
    "You can continue viewing and saving it. Upgrade when you need action sequencing, device mapping, fault handling and environment details. Existing wording and answers are preserved; new questions start blank.",
  补全详细需求: "Add detailed requirements",
  填写步骤: "Form steps",
  项待补: " to complete",
  按需求智能填写: "Fill with AI suggestions",
  "说出需求，帮你整理能确定的内容":
    "Describe your goal and fill in what can be determined",
  "可推荐参考模型、相关关节、动作步骤和测试参数。已有内容保留，冲突由你决定。":
    "Suggestions can cover a reference model, related joints, action steps and test parameters. Existing content is preserved; you decide on conflicts.",
  "正在整理需求…": "Organizing requirements…",
  按需求填写参考建议: "Fill with reference suggestions",
  取消本次推荐: "Cancel suggestions",
  "请先点击上方“补全详细需求”。":
    "First select “Add detailed requirements” above.",
  "先在第 1 步用自己的话写出需求。":
    "Write your request in your own words in step 1 first.",
  "使用浏览器内的参考规则整理草稿，不调用 AI。仅推荐可识别的任务；已有内容保留，未知硬件不猜。":
    "Browser-based reference rules organize this draft without calling AI. Only recognized tasks receive suggestions. Existing content is preserved and unknown hardware is left blank.",
  "调用当前配置的 AI，可能需要一点时间。建议填入草稿后可以改；未知实物接线和姿势角度不会猜。":
    "Uses the configured AI and may take a moment. You can edit suggestions after they are added. Unknown physical wiring and pose angles are not guessed.",
  "正在结合需求和模型目录整理内容。期间不会保存、编译或运行程序。":
    "Combining your request with the model catalog. Nothing is saved, compiled or run during this step.",
  "本次没有可直接补入的空白，请查看下面的说明":
    "No blank fields could be filled directly. Review the notes below.",
  "这些建议与已填内容不同，先由你确认":
    "These suggestions differ from your entries. Please review them first.",
  "目前：": "Current: ",
  "→ 建议：": "→ Suggested: ",
  采用前查看建议的完整动作:
    "Review the complete suggested action before applying",
  "采用此建议：": "Apply this suggestion: ",
  "草稿已修改，请重新推荐后再采用纠正建议。":
    "The draft has changed. Request new suggestions before applying corrections.",
  还需要你确认: "Still needs your confirmation",
  去查看: "View field",
  "这次用的工具、模型和提示词": "Tool, model and prompt used",
  "工具：": "Tool: ",
  "· 模型：": " · Model: ",
  "· 状态：": " · Status: ",
  "已采用的智能建议 ·": "Applied AI suggestions · ",
  项: "items",
  这项建议的工具与提示词: "Tool and prompt for this suggestion",
  "这条历史建议没有对应的调用记录，不归到最近一次提示词。":
    "This historical suggestion has no matching invocation record and is not attributed to the latest prompt.",
  "查看 / 修改": "View / edit",
  "最近一次采用建议的工具：": "Tool for the most recently applied suggestion: ",
  查看最近一次采用建议的提示词: "View the most recently applied prompt",
  "以前采用的规则建议 ·": "Previously applied rule-based suggestions · ",
  "参考结构已变化或仍在读取，请重新核对完整动作里的关节；旧动作不会自动套到新模型。":
    "The reference model has changed or is still loading. Review all joints in the complete action. Existing actions are not automatically mapped to the new model.",
  第: "Step ",
  "步 / 共 5 步": " / 5",
  先说你想实现什么: "Describe what you want to achieve",
  选出要控制的对象: "Choose what to control",
  把动作说具体一点: "Make the action specific",
  "准备在哪儿运行，用什么板": "Choose the environment and board",
  检查这份需求是否说清楚: "Review whether the requirements are clear",
  "正在查看：": "Viewing: ",
  "请整理下方待核对清单，不需要另找一组隐藏的参数。":
    "Review the checklist below. There is no hidden set of parameters to find.",
  "已定位到相关填写位置，改完后可以回第 5 步重新检查。":
    "The relevant field is highlighted. Return to step 5 after editing to check again.",
  先用自己的话说清动作: "Describe the action in your own words",
  "可以照这个顺序写：哪一边、做什么、做几次、最后停在哪里。例如“右臂抬起，招手三次，最后放到身体旁边”。不需要先知道专业名词。":
    "A useful order is: which side, what action, how many times, and the final pose. For example, “Raise the right arm, wave three times, then lower it beside the body.” Technical terms are not required.",
  "“推荐”是可选的填写建议；点击选项后才会改变草稿。AI 整理需求和保存仍是分开的操作。":
    "Recommendations are optional. The draft changes only when you select an option. AI assistance and saving remain separate actions.",
  保留你的原话: "Your original wording is preserved",
  "例如：让机器人抬起右手，来回招手三次，最后放回原位。":
    "For example: Raise the robot’s right hand, wave back and forth three times, then return it to the original position.",
  "先描述意图。后面再选部位、填动作细节；AI 不会仅凭一句话猜接线。":
    "Start with your intent. Choose the body part and action details next. AI will not infer wiring from a single sentence.",
  "它更接近哪类动作？": "Which action type is closest?",
  动作类型: "Action type",
  "只做一次定位，例如抬起一个关节后停住。":
    "One positioning action, such as raising a joint and holding it.",
  "例如数值升到某个大小后，把开关打开。":
    "For example, turn on a switch when a value reaches a threshold.",
  "例如招手、摆动；要说明次数和结束姿势。":
    "For example, waving or oscillating. Specify the repetitions and final pose.",
  "例如几个部位依次配合；先保留完整需求。":
    "For example, multiple parts moving in sequence. Keep the full request.",
  可接现有本机测试: "Supported by existing local tests",
  "已采用逐关节程序，核对后检查执行条件":
    "Joint pose program adopted; review execution conditions next",
  "Sophicore 动作可转换为逐关节姿势程序":
    "Sophicore actions can be converted to joint pose programs",
  "拿不准时，先保留原话，再点“按需求智能填写”整理；不用把完整动作硬改成单个关节。":
    "If unsure, keep your original wording and use AI suggestions. You do not need to reduce a complete action to one joint.",
  给这份需求起个名字: "Name this requirement",
  可以稍后再填: "You can fill this in later",
  "例如：右手招手需求": "For example: Right-hand wave",
  "补充使用场景（选填）": "Add a use case (optional)",
  用在什么场景: "Where will it be used?",
  使用场景: "Use case",
  "例如：迎宾时打招呼": "For example: Greeting visitors",
  "先选动作类型，才能知道需要哪种控制对象。":
    "Choose an action type first to determine the control target.",
  返回选动作: "Back to action type",
  "先核对参考模型和涉及的关节。预览关节只用来查看模型，完整动作可以涉及多个关节。":
    "Check the reference model and related joints first. The preview joint is for inspecting the model; a complete action can involve multiple joints.",
  "从已有结构中选择一个关节。可以先查看 3D，再确认部位；没选清楚也能保存。":
    "Choose a joint from an existing model. Inspect it in 3D before confirming the part. You can save before deciding.",
  "还没有自己的模型，也能先整理需求":
    "You can define requirements before having your own model",
  "可以用下方参考结构看部位，再核对左右侧和关节名称。参考结构可用于核对部位并生成本机仿真程序，不代表你的实物尺寸或接线。":
    "Use the reference model below to identify parts, then check left/right sides and joint names. It supports local simulation generation but does not establish your hardware dimensions or wiring.",
  "招手等动作可由多个关节配合；预览下拉框只决定你正在看哪个关节。":
    "Actions such as waving may use several joints. The preview selector only chooses the joint you are viewing.",
  "更换模型后需要重新选关节；已填角度会保留，后台会检查是否超出新模型范围。":
    "After changing models, select a joint again. Entered angles are preserved; the backend checks them against the new model limits.",
  本轮使用模拟传感器和虚拟开关:
    "This test uses a simulated sensor and virtual switch",
  "传感器提供 0–1 的测试数值。达到阈值输出 1，低于阈值输出 0；无需选择机械关节。":
    "The sensor supplies values from 0 to 1. Output is 1 at or above the threshold and 0 below it. No mechanical joint is required.",
  平台固定设置: "Fixed platform setting",
  "真实传感器型号可在“硬件与资料”记录；填写型号不会自动适配驱动。":
    "Record physical sensor models under Hardware and references. Entering a model does not automatically adapt its driver.",
  先记录要控制的对象: "Record the control target first",
  "请在动作描述中写清机器人、部位和设备。Sophicore 的多关节顺序和往返动作可以在第 3 步显式采用逐关节姿势程序；其他要求继续保留并交给后台检查支持范围。":
    "Specify the robot, body part and device in the action description. Sophicore multi-joint sequences and oscillations can use a joint pose program explicitly adopted in step 3. Other requirements are preserved for backend capability checks.",
  继续写动作细节: "Continue to action details",
  "来源记录达到容量上限或已有程序，当前姿势保留；不能覆盖原有内容。":
    "The source history is full or a program already exists. Current poses are preserved; existing content cannot be overwritten.",
  角度显示: "Angle display",
  角度单位: "Angle unit",
  "度 °": "Degrees °",
  "弧度 rad": "Radians rad",
  "不熟悉弧度可以用“度”。只改变通用参数的显示，程序统一使用 rad；阶段角度会注明自己的单位。":
    "Use degrees if you are unfamiliar with radians. This only changes how common parameters are displayed; programs use radians. Stage angles show their own units.",
  "执行采用上面的逐关节姿势程序。下面仍保留原始动作草稿和补充要求；有冲突或未决项需要人工处理。":
    "Execution uses the joint pose program above. The original action draft and additional requirements remain below; conflicts and unresolved items require human review.",
  "这份需求按完整动作保存。可以显式采用上面的逐关节姿势建议并核对，再检查能否执行。":
    "This requirement is saved as a complete action. Explicitly adopt and review the joint pose suggestions above, then check whether it can run.",
  "保留的旧草稿通用参数（只读，不用于当前执行）":
    "Preserved draft parameters (read-only, not used for execution)",
  "当前执行速度、误差、加速度和超时均以上方“逐关节姿势程序”为准；下面仅保留以前填写的草稿值。":
    "Execution speed, tolerance, acceleration and timeout come from the joint pose program above. The values below are preserved from an earlier draft.",
  "旧最快转速 (rad/s)": "Previous maximum speed (rad/s)",
  未填写: "Not entered",
  "旧允许误差 (rad)": "Previous tolerance (rad)",
  "旧观察时长 (s)": "Previous observation time (s)",
  整套动作的通用参数建议:
    "Common parameter suggestions for the complete action",
  "不知道数字怎么填，可以点下面的选项。推荐只用于本机需求草稿；每个阶段和关节的具体参数还要核对。":
    "If you are unsure about numbers, choose an option below. Suggestions are for the local requirement draft only. Review the parameters for every stage and joint.",
  最快每秒转多少: "Maximum angular speed",
  允许多大误差: "Allowed position error",
  预计观察多久: "Observation time",
  "先在第 1 步选择动作类型。": "Choose an action type in step 1 first.",
  动作还需要哪些步骤和条件: "What other steps and conditions are needed?",
  其他动作细节: "Other action details",
  "谁来触发、先做什么、后做什么、什么情况下停下……不知道的写待确认。":
    "What triggers it, what happens first and next, and when should it stop? Mark anything unknown as pending.",
  "这里保留单轴 A / B 的原始描述。Sophicore 招手可以显式采用上方逐关节姿势建议，并核对全部关节、时间和结束姿势；这组原始描述不会自动升级成完整执行程序。":
    "This preserves the original single-axis A/B description. For Sophicore waving, explicitly adopt the joint pose suggestions above and review every joint, timing and final pose. This description is not automatically upgraded to an executable program.",
  转到哪个角度: "Target angle",
  "相对模型的零位，不是“再转多少度”。":
    "Relative to the model’s zero position, not an additional rotation.",
  "位置 A": "Position A",
  "位置 B": "Position B",
  来回几次: "Number of cycles",
  "A → B → A 算一次。": "A → B → A counts as one cycle.",
  每到一个位置停多久: "Dwell time at each position",
  结束姿态: "Final pose",
  "回到位置 A": "Return to position A",
  "只表示回到你填写的位置 A，不等于手臂自然下垂。":
    "Returns to the entered position A. This does not necessarily mean the arm hangs beside the body.",
  "停在位置 B": "Hold position B",
  "动作做完后停在你填写的位置 B。":
    "Hold the entered position B after completing the action.",
  停在另一个位置: "Stop at another position",
  "在下方填写最后的角度；不知道可以先留空。":
    "Enter the final angle below, or leave it blank if unsure.",
  结束角度: "Final angle",
  达到多少时触发: "Trigger threshold",
  "数值 ≥ 阈值时输出 1，低于时输出 0。":
    "Output 1 when the value is at or above the threshold, otherwise output 0.",
  本轮观察多久: "Observation time for this test",
  "归一化数值的测试误差。": "Test tolerance for normalized values.",
  "想先填一组参考值？": "Start with a set of reference values?",
  "普通演示：30°/秒，允许差 2°；": "Standard demo: 30°/s, tolerance 2°; ",
  "模拟触发值 0.5；": "Simulated trigger threshold 0.5; ",
  观察: "observe for ",
  "秒。": " seconds. ",
  "往返 3 次，端点不停留。": "3 round trips with no dwell at endpoints. ",
  "只补本组空白，保留已填内容。":
    "Only blank fields in this group are filled; existing entries are preserved.",
  "这是可修改的本机草稿示例，不是实物参数。不会填写目标角度、改变动作步骤或确认未知信息。":
    "These editable examples are for a local draft, not physical hardware parameters. They do not set target angles, change action stages or confirm unknown information.",
  采用本组推荐参数: "Apply these recommended parameters",
  这次准备做什么: "What will you do this time?",
  先在电脑里验证: "Validate on the computer first",
  "推荐从这里开始：受支持的任务可以编译并用模拟设备检查；不接真实电机。":
    "Recommended starting point: supported tasks can be compiled and checked with simulated devices, without physical motors.",
  先整理实物资料: "Collect hardware details first",
  "记录板子、电机、供电与接线。本轮只保存资料，暂不执行。":
    "Record the board, motors, power and wiring. This mode only saves references and does not execute them.",
  为哪种板型编译程序: "Which board should the program target?",
  还没确定: "Not decided",
  " · 无实物时可用作编译参考":
    " · Compilation reference when no board is available",
  "还没有板子时，推荐先选 ESP32-S3 作为本机编译参考。已有实物就按实物选，不确定可以留空。这里不能确定具体开发板型号、Flash / PSRAM 或接线。":
    "Without a board, ESP32-S3 is a suggested local compilation reference. If you have hardware, choose its actual type or leave it blank if unsure. This does not establish the exact development board, Flash/PSRAM or wiring.",
  电脑环境和通信由平台提供:
    "The platform provides the host environment and communication",
  "ROS 2 Humble；串口消息格式；主机虚拟串口测试。确认拆分后，两端会按同一份通信约定生成。":
    "ROS 2 Humble, serial message format and host virtual serial tests. After plan approval, both sides are generated from the same communication contract.",
  "实物资料档案 · 可以先留空":
    "Physical hardware references · optional for now",
  "模拟模式不要求填写电机型号或引脚。有出处只表示资料已提供，不表示驱动已适配或实物验证通过。":
    "Simulation does not require motor models or pins. A cited source means information was provided, not that drivers were adapted or hardware was verified.",
  待补: "Pending",
  已填资料出处: "Source provided",
  "你填写的，待核对": "Your entry, pending review",
  "不知道先留空，不用猜": "Leave unknowns blank; no guessing needed",
  资料出处: "Reference source",
  "手册链接、文件名或实物标签": "Manual link, filename or physical label",
  "先检查动作结果，再看程序能不能运行":
    "Check the action outcome before checking execution",
  "写清做了几次、最后停在哪里、误差允许多少。下面的选项可以帮助你补充检查方式；没有把握的条件保留待确认。":
    "Specify repetitions, final pose and allowed error. The options below help define checks. Keep uncertain conditions pending.",
  保留你的要求: "Your requirements are preserved",
  "例如：往返三次后回到原位。不要只写‘效果正常’。":
    "For example: Return to the starting pose after three round trips. Avoid vague criteria such as “works normally”.",
  选填: "Optional",
  "例如：其他关节不动；暂时不连接实物。":
    "For example: Keep other joints still; do not connect physical hardware yet.",
  "正在检查这份需求…": "Checking requirements…",
  暂时无法检查: "Unable to check right now",
  "可以预览需求摘要；实际生成需在本机核对":
    "Ready to preview the summary; generation requires local review",
  "必要信息已齐，可以交给 AI 拆分":
    "Required information is complete and ready for AI planning",
  "这份需求可以保存，当前还不能执行":
    "This requirement can be saved, but cannot run yet",
  还需要补充一些信息: "More information is needed",
  "只检查填写内容，不调用 AI，也不启动程序。":
    "Only checks the entries; does not call AI or start a program.",
  还需要填写或核对: "Still needs information or review",
  "还需要填写或核对 ·": "Still needs information or review · ",
  "这些是可以补充或需要人工核对的内容。点击按钮会定位到对应位置。":
    "These items can be completed or need human review. Select a button to jump to the relevant field.",
  "填写 / 核对": "Complete / review",
  当前功能还不支持: "Currently unsupported",
  "当前功能还不支持 ·": "Currently unsupported · ",
  "下面说明的是平台现阶段做不到的部分。继续补数值、移除待核对提醒，都不会自动增加这些执行能力；完整需求仍然可以保存。":
    "These capabilities are not yet supported. Filling in numbers or dismissing review reminders does not add execution support. Your full request can still be saved.",
  查看相关要求: "View related requirements",
  动作: "Action",
  结构与部位: "Model and body part",
  硬件与范围: "Hardware and scope",
  完成标准: "Acceptance criteria",
  还没填写: "Not entered yet",
  "查看字段和来源 ·": "View fields and sources · ",
  你填写的: "Your entry",
  结构提供: "From the model",
  平台设置: "Platform setting",
  已采用建议: "Suggestion applied",
  "资料齐全只表示可以拆分。拆分后还要人工核对 ROS / ESP32 分工、通信和检查标准，确认后才生成、编译。":
    "Complete information only makes the request ready for planning. Review ROS/ESP32 responsibilities, communication and checks before generation and compilation.",
  查看工程设置与执行顺序: "View project settings and execution order",
  "这些设置用于受支持的本机任务。修改后也要重新核对，不会让未适配动作自动变成可执行。":
    "These settings apply to supported local tasks. Changes require another review and do not automatically make unsupported actions executable.",
  "保存可执行需求后，后台才会生成对应的工程清单。":
    "Save executable requirements before the backend can create the corresponding project manifest.",
  本步待核对清单: "Review checklist for this step",
  本步还有: "This step has ",
  项需要填写或核对: " items to complete or review",
  去核对: "Review item",
  "可以先保存，之后再补。这份清单不包含平台暂未支持的功能。":
    "You can save now and complete these later. This list excludes capabilities the platform does not yet support.",
  本步填写和核对已完成: "This step is complete and reviewed",
  "这只表示本步没有待填、待改或待核对项。还需到第 5 步查看整份需求和执行范围。":
    "There are no missing, invalid or pending-review items in this step. Check the full requirement and execution scope in step 5.",
  保存需求: "Save requirements",
  空白项和未支持的动作都能保留:
    "Blank fields and unsupported actions are preserved",
  上一步: "Previous",
  下一步: "Next",
  预览分工与核对流程: "Preview responsibilities and review",
  "让 AI 拆分": "Plan with AI",
  目标位置: "Target position",
  触发阈值: "Trigger threshold",
  允许误差: "Tolerance",
  运行时长: "Run duration",
  最高速度: "Maximum speed",
  需求与硬件: "Requirements and hardware",
  "先选清楚用什么、做什么，再让 AI 拆分工作。":
    "Choose what to use and what to do before asking AI to plan the work.",
  本机仿真: "Local simulation",
  选择任务和设备: "Choose the task and devices",
  "当前支持两个可运行的测试场景。":
    "Two executable test scenarios are currently supported.",
  "用途 / 控制任务": "Use case / control task",
  "旧工程未选板型，请重新选择":
    "No board selected in this older project. Please choose one.",
  控制对象: "Control target",
  "虚拟关节（不接真实电机）": "Virtual joint (no physical motor)",
  "虚拟开关（不接真实设备）": "Virtual switch (no physical device)",
  反馈传感器: "Feedback sensor",
  "模拟编码器：返回关节位置": "Simulated encoder: reports joint position",
  "模拟数值：范围 0–1": "Simulated value: range 0–1",
  两端怎么通信: "Communication between both sides",
  "串口消息格式 · 主机虚拟串口测试":
    "Serial message format · host virtual serial test",
  "旧通信模式，请重新选择": "Old communication mode. Please choose again.",
  运行环境: "Runtime environment",
  "ROS 2 Humble · 本机模拟": "ROS 2 Humble · local simulation",
  "编译选定板型的程序；本轮不烧录。":
    "Compiles for the selected board; does not flash it in this test.",
  编译目标: "Build target",
  这轮实际能完成: "What this test can do",
  "选择一个有角度上下限的关节，让它到达指定位置，并检查位置误差、速度和通信。其他关节保持源姿态。":
    "Move one joint with finite angle limits to a target position, then check position error, speed and communication. Other joints remain in their source poses.",
  "读取 0–1 范围的模拟数值，达到阈值输出 1，低于阈值输出 0，并检查收发和失联处理。":
    "Read a simulated value from 0 to 1, output 1 at or above the threshold and 0 below it, and check communication and disconnection handling.",
  "整机走路、导航、抓取、多关节动作编排和真实驱动尚未适配。额外文字要求会逐条核对，不能仅靠选择这些任务就声称完成。":
    "Whole-robot walking, navigation, grasping, multi-joint choreography and physical drivers are not adapted in this older task. Additional written requirements are reviewed individually; selecting a task does not establish completion.",
  "先选 ESP32 或 ESP32-S3，再保存并重新拆分旧工程。":
    "Choose ESP32 or ESP32-S3, then save and re-plan this older project.",
  "旧工程需要选择串口消息格式，再保存并重新拆分。":
    "Select the serial message format, then save and re-plan this older project.",
  写清楚要求: "Describe the requirements",
  "描述动作、触发条件，以及怎样算成功":
    "Describe the action, trigger conditions and success criteria",
  归一化值: "normalized value",
  "例如：失联停止，不允许接实物":
    "For example: Stop on disconnect; no physical hardware allowed",
  写清需要检查的结果: "Specify the results to check",
  "这份需求将交给 AI": "These requirements will be sent to AI",
  待选板型: "Board not selected",
  "虚拟关节 + 模拟编码器": "Virtual joint + simulated encoder",
  "虚拟开关 + 模拟传感器": "Virtual switch + simulated sensor",
  "AI 拆分后，会让你核对 ROS / ESP32 分工、消息格式和验收标准。核对通过才生成、编译。":
    "After AI planning, review ROS/ESP32 responsibilities, message formats and acceptance criteria. Generation and compilation start only after approval.",
  "请选择一个要控制的关节，等结构信息加载完成再保存。":
    "Select a joint to control and wait for the model to load before saving.",
  "当前角度控制需要有上下限的旋转关节，请选择受支持的关节。":
    "Angle control requires a rotational joint with finite limits. Select a supported joint.",
  需在: " must be between ",
  到: " and ",
  "之间。": ".",
  "保存需求不会启动编译或烧录。":
    "Saving does not start compilation or flashing.",
  保存: "Save",
  拆分需求: "Plan requirements",
  推荐: "Recommended",
  已选: "Selected",
  还不确定: "Not sure yet",
  "先留待确认，之后再补。": "Leave it pending and fill it in later.",
  当前值: "Current value",
  "可修改的本机草稿示例，点击后填入。也可以在下面直接输入自己的数值。":
    "Editable local draft examples. Select one to fill the value, or enter your own number below.",
  待填写: "Not specified",
  已采用平台建议: "Platform suggestion applied",
  想做什么: "Your goal",
  控制哪里: "Control target",
  动作细节: "Action details",
  硬件与资料: "Hardware and references",
  成功标准与核对: "Acceptance and review",
  转到一个位置: "Move to a position",
  "来回摆动 / 招手": "Oscillate / wave",
  达到条件后触发: "Trigger on a condition",
  其他动作: "Other action",
  实物控制板的完整型号: "Full physical controller model",
  "板载 Flash / PSRAM": "Onboard Flash / PSRAM",
  电机或舵机型号: "Motor or servo model",
  驱动器型号: "Driver model",
  反馈传感器型号: "Feedback sensor model",
  供电电压和电源: "Supply voltage and power source",
  接线记录: "Wiring record",
  "说明书、代码或资料链接": "Manual, code or reference links",
  慢慢转: "Slow movement",
  "15°/秒；转过 90° 最快约 6 秒，方便看清动作。":
    "15°/s; a 90° turn takes at least about 6 seconds, making it easier to observe.",
  普通演示: "Standard demo",
  "30°/秒；转过 90° 最快约 3 秒。":
    "30°/s; a 90° turn takes at least about 3 seconds.",
  较快演示: "Faster demo",
  "60°/秒；转过 90° 最快约 1.5 秒。":
    "60°/s; a 90° turn takes at least about 1.5 seconds.",
  更接近目标: "Closer to the target",
  "允许差 1°；目标 30° 时，29–31° 算到位。":
    "Tolerance 1°; for a 30° target, 29–31° counts as reached.",
  普通动作: "Standard action",
  "允许差 2°；目标 30° 时，28–32° 算到位。":
    "Tolerance 2°; for a 30° target, 28–32° counts as reached.",
  只看大致位置: "Approximate position only",
  "允许差 5°；目标 30° 时，25–35° 算到位。":
    "Tolerance 5°; for a 30° target, 25–35° counts as reached.",
  看一个短动作: "Watch a short action",
  "观察 8 秒，适合查看单个关节的一次动作。":
    "Observe for 8 seconds, suitable for one movement of a single joint.",
  多看几个步骤: "Watch multiple steps",
  "观察 15 秒，给抬起、摆动、放下留出观察时间。":
    "Observe for 15 seconds to cover raising, waving and lowering.",
  留更长时间: "Allow more time",
  "观察 30 秒；动作慢或步骤多时可选。":
    "Observe for 30 seconds for slower or longer sequences.",
  "先做 1 次": "Try 1 cycle",
  "先看清一次完整动作。": "Inspect one complete action first.",
  "做 3 次": "Repeat 3 times",
  "适合观察重复动作是否一致。": "Useful for checking repeatability.",
  "做 5 次": "Repeat 5 times",
  "多重复几次，需要更长观察时间。":
    "More repetitions require a longer observation period.",
  不停留: "No dwell",
  "到达一个位置后接着运动。":
    "Continue moving as soon as a position is reached.",
  稍停一下: "Brief pause",
  "每到一个位置停 0.5 秒。": "Pause for 0.5 seconds at each position.",
  停一下看清楚: "Pause to inspect",
  "每到一个位置停 1 秒。": "Pause for 1 second at each position.",
  较早触发: "Earlier trigger",
  "模拟读数达到 0.25 时打开。":
    "Switch on when the simulated value reaches 0.25.",
  到一半触发: "Trigger halfway",
  "模拟读数达到 0.5 时打开。":
    "Switch on when the simulated value reaches 0.5.",
  较晚触发: "Later trigger",
  "模拟读数达到 0.75 时打开。":
    "Switch on when the simulated value reaches 0.75.",
});
