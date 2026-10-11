import { registerTranslations } from "./localeStore";

// Exact UI copy only. User-authored requirements and stored values are not translated.
registerTranslations({
  "按上面填写的单个动作测试。不会自动加入前后步骤、同时控制多个关节，或把招手改成只转到一个位置。":
    "Test the single action entered above. This does not automatically add surrounding steps, coordinate multiple joints, or reduce a wave to one target position.",
  "手动启动。从模型初始角度开始，其他关节保留模型姿态；这不是实物回零。通信就绪后观察给定时长，到位后继续观察；结束或取消会停止本轮进程，不代表实物刹车。":
    "Start manually from the model’s initial angle; other joints retain their model pose. This is not physical homing. Observe for the specified duration once communication is ready, including after reaching the target. Finishing or cancelling stops this run’s processes; it does not demonstrate physical braking.",
  "本轮在电脑里测试，不连接真实电机，也不驱动 GPIO。实物型号、地址和引脚可以另存资料；平台不会猜这些信息。":
    "This run uses simulated devices on the computer, without real motors or GPIO output. Physical device models, addresses and pins can be saved as reference information; the platform will not guess them.",
  "关节零位、正方向和范围来自选中的结构。位置反馈用 rad，速度指令用 rad/s；页面可用度数填写。模型零位不是实物已校准的零位。阈值任务使用 0–1 的模拟数值，输出 0 或 1。":
    "Joint zero, positive direction and limits come from the selected structure. Position feedback uses rad and velocity commands use rad/s; the form also accepts degrees. Model zero is not a calibrated physical zero. Threshold tasks use simulated values from 0 to 1 and output either 0 or 1.",
  "ROS 根据反馈计算速度或开关指令；ESP32 工程处理通信与限幅。本轮在电脑上测试共享固件核心，不连接板子。使用虚拟串口 JSONL，115200，名义每秒 20 次；超过 600 毫秒没有有效消息时归零。":
    "ROS calculates velocity or switch commands from feedback; the ESP32 project handles communication and limits. This run tests the shared firmware core on the computer without a board. It uses virtual serial JSONL at 115200 baud, nominally 20 messages per second; output returns to zero after 600 ms without a valid message.",
  "超过 600 毫秒没有有效消息时归零；格式不对或过期的消息会被拒绝，不是任意一个坏包都立即停车。检查批准的模型范围并限制速度；这里没有实物急停、断电或自动恢复。":
    "Output returns to zero after 600 ms without a valid message. Malformed or expired messages are rejected; an individual bad packet does not always cause an immediate stop. Approved model limits and velocity limits are checked. Physical emergency stop, power isolation and automatic recovery are not included.",
  "定点任务检查末尾 5 个反馈位置是否都在误差范围内；阈值任务检查达到条件时开、低于时关。另检查两端编译、身份、通信、速度与失联。本轮不检查轨迹、往返次数或连续稳定几秒。":
    "Position tasks check that the last five position samples are within tolerance. Threshold tasks check on/off behavior above and below the threshold. Builds, identity, communication, velocity and connection loss are checked separately. This test does not verify trajectories, cycle counts or a continuous settling interval.",
  "关节仿真使用固定基座、零重力和理想速度，不做实物负载或碰撞验收；阈值任务使用合成数值。3D 外观不代表真实受力情况。":
    "Joint simulation uses a fixed base, zero gravity and ideal velocity, without physical load or collision acceptance. Threshold tasks use synthetic values. The 3D appearance does not establish actual forces.",
  "采用已明确选择的逐关节姿势程序，依次到位，按展开的区段往返。未采用的原始草稿和补充仍保留并接受后台检查。":
    "Use the explicitly adopted joint-by-joint pose program, reach each pose in sequence and repeat the expanded segments. Unadopted original drafts and additional requirements remain stored and subject to backend checks.",
  "手动启动，从冻结模型初始姿态进入程序；累计时间使用仿真时钟，通信看门狗使用单调时钟。完成最后一个已核对姿势后结束；取消会停止本轮控制。":
    "Start manually from the frozen model’s initial pose. Elapsed motion time uses the simulation clock; the communication watchdog uses a monotonic clock. Finish after the final reviewed pose. Cancelling stops control for this run.",
  "全部参与关节的位置统一用 rad；速度用 rad/s、加速度用 rad/s²。每个关节范围来自冻结模型。模型姿态不等于实物已校准零位。":
    "All participating joint positions use rad, velocity uses rad/s and acceleration uses rad/s². Joint limits come from the frozen model. A model pose is not a calibrated physical zero.",
  "轨迹控制器的全组位置目标先经共享固件核心审核，再写入仿真设备。紧凑批量协议绑定本轮会话、模型和全部关节；频率、带宽和超时以冻结合同与运行记录为准。":
    "The shared firmware core checks the trajectory controller’s complete set of position targets before writing them to simulated devices. The compact batch protocol binds the session, model and every joint. Frequency, bandwidth and timeout follow the frozen contract and run records.",
  "全组目标一起检查；缺轴、越界、错身份、过期与乱序帧被拒绝。取消、通信中断和控制器异常分别检查，不等于实物急停或刹车。":
    "All joint targets are checked together. Missing joints, out-of-range values, incorrect identity, expired frames and out-of-order frames are rejected. Cancellation, connection loss and controller faults are checked separately; these are not physical emergency-stop or braking tests.",
  "逐阶段检查全部关节的实际位置是否到位；用实际位置到达往返端点计算次数，并核对最后姿势。速度、加速度、完整编译、异常和取消记录独立检查。":
    "Check the actual position of every joint at each stage. Count cycles from actual arrivals at their endpoints and verify the final pose. Velocity, acceleration, complete builds, faults and cancellation records are checked separately.",
  "Sophicore 参考仿真使用固定基座、零重力和模型近似惯量。实际反馈用于本机动作验收；不证明实物负载、碰撞、平衡或板上通信。":
    "Sophicore reference simulation uses a fixed base, zero gravity and approximate model inertia. Actual simulation feedback is used for local motion acceptance. This does not establish physical load, collision, balance or onboard communication performance.",
  "按上面填写的阈值测试：模拟值达到阈值时输出 1，低于阈值时输出 0。不会自动添加前后动作或多条件控制。":
    "Test the threshold entered above: output 1 at or above the threshold and 0 below it. Extra actions and multi-condition control are not added automatically.",
  "手动启动。通信就绪后，按固定顺序提供 0–1 的合成测试值并观察给定时长；结束或取消会停止本轮进程。不涉及关节起始姿态，也不是实物开关断电。":
    "Start manually. Once communication is ready, provide synthetic values from 0 to 1 in a fixed sequence and observe for the specified duration. Finishing or cancelling stops the run’s processes. There is no initial joint pose or physical switch power isolation in this test.",
  "传感器反馈是 0–1 的模拟数值，开关指令只能是 0 或 1；不使用关节角度或电机速度。这些数值尚未对应真实传感器的温度、距离等单位。":
    "Sensor feedback is a simulated value from 0 to 1; switch commands are only 0 or 1. Joint angles and motor velocity are not used. These values are not yet mapped to physical sensor units such as temperature or distance.",
  "ROS 根据模拟值计算开关指令；ESP32 工程处理通信和指令。本轮在电脑上测试共享固件核心，不连接板子。使用虚拟串口 JSONL，115200，名义每秒 20 次。":
    "ROS calculates switch commands from simulated values; the ESP32 project handles communication and commands. This run tests the shared firmware core on the computer without a board, using virtual serial JSONL at 115200 baud and nominally 20 messages per second.",
  "超过 600 毫秒没有有效消息时归零；格式不对或过期的消息会被拒绝，不是任意一个坏包都立即停车。只接受约定的数值和开关指令；没有实物急停、断电或自动恢复。":
    "Output returns to zero after 600 ms without a valid message. Malformed or expired messages are rejected; an individual bad packet does not always cause an immediate stop. Only agreed values and switch commands are accepted. Physical emergency stop, power isolation and automatic recovery are not included.",
  "检查达到阈值时输出 1、低于阈值时输出 0，以及两端编译、身份、通信与失联。不验证真实传感器精度或实物开关效果。":
    "Check output 1 at or above the threshold and 0 below it, plus builds, identity, communication and connection loss. This does not verify physical sensor accuracy or switch operation.",
  "使用固定顺序的合成数值和虚拟开关，不模拟真实温度、距离或周围环境，也不做实物负载与碰撞验收。":
    "Use synthetic values in a fixed sequence and a virtual switch. Real temperature, distance and surroundings are not simulated, and physical load and collision acceptance are not included.",
  "只按上方填写的一个测试任务检查，不另加步骤。":
    "Check only the test task entered above, without adding steps.",
  "手动开始模拟测试，观察到设定时间后结束；取消时停止本轮程序。":
    "Start the simulated test manually and finish after the observation period. Cancelling stops the current program.",
  "手动开始，从模型初始姿势测试；到设定时间结束，取消时停止本轮程序。":
    "Start manually from the model’s initial pose and finish after the observation period. Cancelling stops the current program.",
  "先用电脑里的模拟设备，不需要猜实物接线。":
    "Use simulated devices on the computer first; no physical wiring needs to be guessed.",
  "模拟传感器用 0 到 1 的数值，输出 0 表示关、1 表示开。":
    "The simulated sensor uses values from 0 to 1. Output 0 means off and 1 means on.",
  "使用所选模型的零位和转动方向。页面填度数，程序自动换成弧度。":
    "Use the selected model’s zero position and rotation direction. Enter degrees in the form; the program converts them to radians.",
  "先让两端在电脑里通过虚拟串口收发消息，每秒 20 次，失联 0.6 秒后输出归零。":
    "Exchange virtual serial messages between both sides on the computer at 20 per second. Return output to zero after 0.6 seconds without communication.",
  "拒绝格式不对的消息；失联 0.6 秒后输出归零，检查约定范围，不自动恢复运行。":
    "Reject malformed messages, return output to zero after 0.6 seconds without communication, check agreed limits and do not resume automatically.",
  "检查模拟值到达阈值时开、低于阈值时关，以及编译和通信结果。":
    "Check on/off behavior at the threshold, plus build and communication results.",
  "检查单个关节是否到达目标、误差是否合格，以及编译和通信结果。":
    "Check that the single joint reaches its target within tolerance, plus build and communication results.",
  "先用电脑生成的数值测试，不需要填写真实传感器周围的环境。":
    "Test with computer-generated values first; real sensor surroundings are not required.",
  "先在电脑里使用固定基座、零重力的模型，不把仿真当作实物负载或碰撞验证。":
    "Start with a fixed-base, zero-gravity model on the computer. Simulation does not establish physical load or collision performance.",
  "记录先做什么、后做什么，以及哪些动作同时做。":
    "Record what happens first, next and at the same time.",
  "比如见到人后开始、结束后放下手臂、取消后停在哪里。":
    "For example: start when a person is detected, lower the arm at the end, or define where to stop after cancellation.",
  "按照实物资料记录关节、电机、驱动器和接线。":
    "Record joints, motors, drivers and wiring from physical device documentation.",
  "比如实际电机的正方向相反，或传感器反馈需要换算；以真实资料为准。":
    "For example: an opposite motor direction or a sensor conversion. Use actual documentation.",
  "比如需要真实串口或 CAN、改变发送频率，先记录所需方式。":
    "Record requirements such as physical serial or CAN communication and a different message rate.",
  "比如出现异常后必须人工确认，或者需要另外的停止规则。":
    "For example: require manual confirmation after a fault or specify another stop rule.",
  "比如招手三次、最后放下手臂、整个动作没有漏掉步骤，分别写清怎样检查。":
    "Define separate checks for three waves, the final lowered arm and completion of every step.",
  "比如需要带负载、有桌面或人员、活动空间受限；只填已知条件。":
    "Record known conditions such as a load, a table, people nearby or limited movement space.",
  采用当前本机设置: "Use current local settings",
  " 这些规则只覆盖现有单项测试，还不能说明整套动作的结果。":
    " These rules cover the existing individual tests only, not the outcome of the complete action.",
  我要补充要求: "Add requirements",
  "本轮只按平台现有方式在电脑里测试？":
    "Use the platform’s existing local test settings for this run?",
  "可以一次确认下列设置。只补没有额外内容的空白组，不改已写要求，不确认任何实物接线。":
    "Confirm the settings below together. Only empty groups without extra content are filled. Existing requirements stay unchanged, and no physical wiring is confirmed.",
  查看将采用的具体设置: "View the settings to be adopted",
  采用当前本机测试设置: "Adopt current local test settings",
  不知道可以先留空: "Leave blank if unknown",
  还没确认: "Not confirmed",
  需求记录: "Requirement record",
  "平台当前怎么做 · 已知设置": "Current platform behavior · Known settings",
  "来源：平台通信约定、模型和现有检查规则；不是实物验证结果。":
    "Source: platform communication contract, model and existing checks; not physical validation results.",
  "额外要求会保存，但当前执行器还不支持。改回“本机设置”也不会忽略下面的内容。":
    "Additional requirements are saved, but the current executor does not support them. Switching back to local settings does not discard the content below.",
  清空本组补充并采用本机设置:
    "Clear additions in this group and use local settings",
  确认清空本组: "Confirm clearing this group",
  保留内容: "Keep content",
  "是只做上面这个动作，还是还要先后、同时做别的事？":
    "Only this action, or are other actions needed before, after or at the same time?",
  动作怎样安排: "How the actions are arranged",
  只做上面这个任务: "Only the task above",
  "按模拟值是否达到阈值来开关，不另外添加动作。":
    "Switch according to whether the simulated value reaches the threshold, without additional actions.",
  "使用上面填写的动作参数，不另外添加步骤。":
    "Use the action parameters above without adding steps.",
  按顺序做几步: "Several steps in sequence",
  "比如先抬手、再招手、最后放下。完整保留这些要求，先作为草稿核对。":
    "For example: raise the hand, wave, then lower it. Preserve all requirements for draft review.",
  有些动作同时做: "Some actions happen together",
  "比如一边抬手一边转头；需要写清哪些步骤一起开始、怎样结束。":
    "For example: raise a hand while turning the head. Specify which steps start together and when they finish.",
  什么时候算这组动作完成: "When is this group of actions complete?",
  每一步都做完: "Every step is complete",
  "上面写到的动作和次数都要完成，不能只完成其中一步。":
    "Complete all listed actions and repetitions, not just one step.",
  还有别的结束条件: "Another completion condition",
  "比如收到停止指令才结束。选择后在下面写清楚。":
    "For example: finish only after a stop command. Describe the condition below.",
  整组动作完成的条件: "Completion condition for the whole action",
  "例如：三个关节都回到指定位置，才算结束":
    "For example: finish only when all three joints return to their specified positions",
  "这里收集完整步骤，不会把它们自动变成已支持的单关节任务。需要同时做的动作，请在各步骤说明里写清与谁一起开始、何时结束。":
    "Record the complete sequence here. It is not automatically reduced to the supported single-joint task. For simultaneous actions, describe which steps start together and when they finish.",
  步骤: "Step ",
  转到一个位置: "Move to a position",
  等待一段时间: "Wait for a duration",
  等待某个条件: "Wait for a condition",
  其他步骤: "Other step",
  秒: "s",
  "比如和哪一步同时开始、结束时保持什么姿态":
    "For example: which step starts together, and what pose to hold at the end",
  超时和失败时怎么处理: "Timeout and failure behavior",
  增加一个步骤: "Add a step",
  "什么时候开始、做完后怎样停下、中途取消时怎么办？":
    "When does it start, how does it stop after completion, and what happens if cancelled?",
  开始条件和开始前的状态: "Start condition and initial state",
  "谁来触发？启动前各部位在哪里？":
    "What triggers it? Where are the parts before starting?",
  结束后要保持什么状态: "State to keep after completion",
  中途取消时怎么处理: "Behavior when cancelled",
  "把模型里的关节和将来使用的电机、驱动器、反馈对应起来。":
    "Map model joints to the motors, drivers and feedback devices you intend to use.",
  这些设备对应关系用在哪里: "How these device mappings are used",
  先用模拟设备: "Use simulated devices first",
  "没有实物也能先整理需求；不需要填写电机地址、引脚或接线。":
    "Organize requirements without hardware. Motor addresses, pins and wiring are not required.",
  先把实物资料存好: "Save physical device references first",
  "已经有手册或接线资料，可以记在下面；这轮仍不连接实物。":
    "Record available manuals and wiring information below. This run still does not connect to hardware.",
  这轮必须用实物: "Physical devices are required for this run",
  "记录真实设备要求；目前不能执行这种任务，资料缺失时不会猜测。":
    "Record the physical device requirements. This task is not currently executable; missing information will not be guessed.",
  "每行独立记录一个关节。模型或关节变了，原记录仍保留，需要手动重新关联；地址、引脚和电压不要猜。":
    "Each row records one joint. Existing records remain after model or joint changes and must be linked again manually. Do not guess addresses, pins or voltages.",
  设备对应: "Device mappings",
  还没关联结构: "No structure linked yet",
  "来源摘要：": "Source hash: ",
  关联当前结构与所选关节: "Link the current structure and selected joint",
  "这行记录的结构与当前选择不一致，请核对后重新关联。":
    "This record’s structure differs from the current selection. Review it before linking again.",
  "先在第 2 步选结构与关节，再回来关联。":
    "Select a structure and joint in Step 2, then return to link them.",
  "例如：某个串口、CAN 通道": "For example: a serial port or CAN channel",
  "已填写，待核对": "Entered, awaiting review",
  已填资料出处: "Source provided",
  增加设备对应: "Add device mapping",
  "零点在哪里、哪边算正方向，收到的数字又代表什么？":
    "Where is zero, which direction is positive, and what do the received values mean?",
  "当前结构：": "Current structure: ",
  "；关节：": "; joint: ",
  待选: "Select a joint",
  "。模型方向与范围可在第 2 步查看，实物安装方向仍需单独确认。":
    " Model direction and limits are shown in Step 2. Physical mounting direction needs separate confirmation.",
  零位怎么确定: "How zero is defined",
  哪边算正方向: "Positive direction",
  指令的数值和单位: "Command values and units",
  反馈数值和单位: "Feedback values and units",
  实物数值怎样换成模型数值: "Convert physical values to model values",
  零位和单位的资料出处: "References for zero and units",
  "让 ROS 和 ESP32 各做什么，两端怎样传指令和反馈？":
    "What should ROS and ESP32 each do, and how should commands and feedback be exchanged?",
  两端通过什么连接: "Connection between both sides",
  "ROS 负责什么": "ROS responsibilities",
  "ESP32 负责什么": "ESP32 responsibilities",
  指令和反馈要包含什么: "Required command and feedback fields",
  每秒发送多少次: "Messages per second",
  "次/秒": "per second",
  多久没有消息算失联: "Time without a message before connection loss",
  毫秒: "ms",
  "负载、安装方式和周围环境都会影响真实效果。":
    "Load, mounting and surroundings affect physical behavior.",
  机器人怎么安装: "Robot mounting",
  需要带多重的负载: "Required payload mass",
  周围有什么障碍或人: "Nearby obstacles or people",
  可活动的空间: "Available movement space",
  其他环境条件: "Other environmental conditions",
  "不要只写“出错就停止”，还要说明什么算出错、之后能不能继续。":
    "Specify what counts as a fault and whether operation can resume, rather than only saying “stop on error”.",
  通信断开时怎么办: "Behavior on connection loss",
  反馈不对或丢失时怎么办: "Behavior on invalid or missing feedback",
  碰到限制或超出范围时怎么办: "Behavior at limits or out of range",
  出错后怎样恢复: "Recovery after a fault",
  "把成功标准写成能检查的条件，而不是只写“运行正常”。":
    "Write success criteria that can be checked, rather than only “runs normally”.",
  检查条件: "Acceptance criteria",
  "例如：完成往返的次数": "For example: the number of completed cycles",
  "例如：完整往返 3 次": "For example: 3 complete cycles",
  "例如：查看关节位置记录，数 A→B→A":
    "For example: inspect joint position records and count A → B → A",
  增加检查条件: "Add acceptance criterion",
  已确认本机设置: "Local settings confirmed",
  只存参考资料: "Reference information only",
  待补充: "Needs information",
  当前不能执行: "Not currently executable",
  详细需求汇总: "Detailed requirement summary",
  这八类问题是否说明白了: "Are these eight topics clear?",
  "下面是当前填写和支持范围。信息齐全只表示可以核对，不能替代后续代码检查。":
    "This shows the entered requirements and current support. Complete information enables review; it does not replace subsequent code checks.",
  查看这组填写内容: "View this group’s entries",
  动作安排: "Action arrangement",
  完成方式: "Completion mode",
  完成条件: "Completion condition",
  动作步骤: "Action steps",
  步骤类型: "Step type",
  关节: "Joint",
  "目标角度（rad）": "Target angle (rad)",
  "时长（秒）": "Duration (s)",
  等待条件: "Wait for condition",
  "最多等待（秒）": "Maximum wait (s)",
  失败时处理: "Failure behavior",
  说明: "Description",
  采用方式: "Settings source",
  开始条件与状态: "Start condition and state",
  结束状态: "Final state",
  取消时处理: "Cancellation behavior",
  使用范围: "Scope",
  记录的结构: "Recorded structure",
  结构来源摘要: "Structure source hash",
  电机或舵机: "Motor or servo",
  驱动器: "Driver",
  连接接口: "Connection interface",
  地址或通道: "Address or channel",
  接线: "Wiring",
  反馈: "Feedback",
  资料出处: "Reference source",
  资料状态: "Reference status",
  零位: "Zero position",
  正方向: "Positive direction",
  指令单位: "Command units",
  换算方式: "Conversion",
  连接方式: "Connection",
  ROS分工: "ROS responsibilities",
  ESP32分工: "ESP32 responsibilities",
  消息内容: "Message content",
  每秒发送次数: "Messages per second",
  "失联时间（毫秒）": "Connection timeout (ms)",
  断开通信: "Connection loss",
  异常反馈: "Invalid feedback",
  超出范围: "Out of range",
  恢复方式: "Recovery",
  检查什么: "Metric",
  期望结果: "Expected result",
  检查办法: "Check method",
  安装方式: "Mounting",
  "负载（kg）": "Payload (kg)",
  周围障碍: "Nearby obstacles",
  活动空间: "Movement space",
  其他条件: "Other conditions",
  采用本机设置: "Use local settings",
  额外要求: "Additional requirements",
  按上方填写的动作: "Use the action entered above",
  按顺序执行: "Sequential execution",
  包含同时动作: "Includes simultaneous actions",
  填写的动作全部完成: "All entered actions completed",
  只用模拟设备: "Simulated devices only",
  本轮必须使用这些设备: "These devices are required for this run",
  转到位置: "Move to position",
  等待时间: "Wait for duration",
  其他: "Other",
  待确认: "To be confirmed",
  已填写待核对: "Entered, awaiting review",
  无补充条目: "No additional entries",
  未填写: "Not entered",
  单关节动作: "Single-joint action",
  多个关节配合: "Multiple joints working together",
  其他动作: "Other action",
  参与部位还需核对: "Participating parts need review",
  "放下手臂，垂在身体旁边": "Lower the arm to the side",
  "表达结束时的姿势要求；各关节应到多少度还需要结合模型确认。":
    "Describe the final pose. Individual joint angles still need to be checked against the model.",
  回到动作开始前: "Return to the starting pose",
  "需要记住开始时各关节的位置；不是一律回到 0 度。":
    "Record each joint’s starting position. This does not always mean returning to 0°.",
  保持最后的姿势: "Keep the final pose",
  "最后一步完成后停在那一姿势；具体位置由最后一步说明。":
    "Hold the pose reached in the last step. That step defines the exact positions.",
  参与完整动作的关节: "Joints in the complete action",
  完整动作安排: "Complete action sequence",
  完整动作概览: "Complete action overview",
  "需求草稿 · 需要人工核对": "Requirement draft · Manual review needed",
  "这里保留原始动作说明和待核对项。实际执行还需要逐关节姿势程序与后台能力检查；未确定的原始角度继续留空。":
    "Original action descriptions and review items remain here. Execution also requires a joint pose program and backend capability checks. Leave uncertain original angles blank.",
  关节待确定: "Joints to be selected",
  " · 仍需核对": " · Review needed",
  "结束姿势：": "Final pose: ",
  "相关关节：": "Related joints: ",
  相关关节: "Related joint ",
  "· 当前结构找不到": " · Not found in the current structure",
  负责什么: "Role in the action",
  增加相关关节: "Add related joint",
  完整动作说明: "Complete action description",
  做什么: "Action name",
  怎么做: "How it works",
  这一步用到哪些关节: "Joints used in this step",
  "先在第 2 步选择相关关节。": "Select related joints in Step 2 first.",
  "这一步只做一次，适合抬起、放下等阶段。":
    "Perform this step once, suitable for raising or lowering the arm.",
  "次数只针对这一阶段。准备、抬起、放下通常做 1 次；招手几次以原话为准。推荐不会改动已填次数，请核对后再选。":
    "This count applies only to this stage. Preparation, raising and lowering usually run once; wave repetitions follow the original request. Suggestions do not overwrite a filled count. Review before choosing.",
  "只有一个关节时可填写。先用结构预览核对姿势与转动范围；不知道角度就留空，不能把‘放下’直接写成 0°。":
    "Available for a single joint only. Check the pose and range in the structure preview first. Leave unknown angles blank; “lower the arm” does not automatically mean 0°.",
  "多个关节分别需要角度；请在说明里记录，不能用一个数代替整套姿势。":
    "Each participating joint needs its own angle. Record them in the description; one number cannot represent the whole pose.",
  "之前填写的单关节角度还在，不能用于这些关节。":
    "The previously entered single-joint angle is retained, but cannot apply to these joints.",
  清除这一个不适用的角度: "Clear this inapplicable angle",
  待核对: "Needs review",
  已核对: "Reviewed",
  "请看清这一步的关节、动作、次数和角度。有不确定的地方先保留，核对后再确认。":
    "Check this step’s joints, action, count and angles. Keep uncertain items pending and confirm after review.",
  "你已确认这一步的需求。修改动作内容后，需要重新核对。":
    "You have confirmed this step’s requirements. Editing its action requires another review.",
  我已核对这一步: "I have reviewed this step",
  重新标为待核对: "Mark as needing review again",
  增加动作阶段: "Add action stage",
  结束姿势可以这样选: "Choose a final pose",
  "这里只改结束姿势的文字，不会填写关节角度或清除待确认项。若与最后阶段的说明不同，请一起修改。仍可在下面写自己的要求。":
    "This changes only the final-pose text. It does not fill joint angles or resolve review items. If it differs from the final stage, update both. You can still enter your own requirements below.",
  动作结束后是什么姿势: "Pose after the complete action",
  完整动作结束姿势: "Complete action final pose",
  完整动作待确认清单: "Complete action review checklist",
  完整动作还有哪些事情没核对: "What still needs review in this action?",
  "这些是 AI 整理需求时留下、或你后来补充的待核对提醒，不是要求再找一组隐藏的数字框。先核对上方动作阶段、相关关节或结束姿势，再逐项整理。":
    "These are review reminders left by AI when organizing requirements or added later by you, not a hidden set of numeric fields. Review the stages, related joints and final pose above, then address each item.",
  "填写速度、误差不会自动消除这些提醒。只有你确实核对过，才点击“这项已核对，移出清单”；这不代表动作已经可以执行或实物验证通过。":
    "Entering velocity or tolerance does not resolve these reminders. Select “Reviewed, remove from list” only after you have checked the item. This does not establish that the action is executable or physically validated.",
  待核对事项: "Review item ",
  "确认你已经核对这条要求？只会移出这条提醒，其他需求和执行限制仍保留。":
    "Have you reviewed this requirement? Only this reminder will be removed. Other requirements and execution limits remain.",
  继续保留: "Keep this item",
  "目前没有单独列出的待核对提醒。上方各阶段仍需按实际情况检查。":
    "No separate review reminders are listed. Still check the stages above against the actual requirements.",
  增加待核对事项: "Add review item",
  "手动批量整理（每行一项）": "Edit in bulk (one item per line)",
  完整动作待确认项: "Complete action review items",
  还需要确认: "Still to confirm",
  多关节可执行姿势程序: "Executable multi-joint pose program",
  "本机参考仿真 · V5": "Local reference simulation · V5",
  将执行的完整动作: "Complete action to execute",
  把整套动作变成逐关节姿势: "Turn the action into joint poses",
  已人工核对: "Manually reviewed",
  需要人工核对: "Manual review needed",
  建议尚未采用: "Suggestion not adopted",
  "每行是一个完整姿势：所有参与关节同时运动到这一行角度。累计时间从动作开始计时；相同姿势可以用来停留。往返必须有明确端点，最后一行是结束姿势。阶段代号只使用英文字母、数字、下划线或短横线，如 prepare、wave_a、finish。":
    "Each row is a complete pose: all participating joints move to the row’s angles together. Time is measured from the start; repeated poses can create a hold. Cycles need explicit endpoints, and the last row is the final pose. Stage IDs use only letters, digits, underscores or hyphens, such as prepare, wave_a and finish.",
  "更换模型或左右手臂时，先明确清除当前执行程序":
    "Clear the current execution program before changing the model or arm",
  "原始需求、动作草稿、补充要求和已保留的来源历史继续保留；重新查看并采用参考配方后再人工核对。":
    "Original requirements, action drafts, additions and retained source history are preserved. View and adopt a reference recipe again, then review it manually.",
  "确认清除当前执行程序，保留原始需求":
    "Clear this execution program and keep original requirements",
  取消清除: "Cancel clearing",
  清除执行程序后重新选择配方:
    "Clear execution program and select another recipe",
  "撤销清除，恢复上一套执行程序（需重新核对）":
    "Undo clearing and restore the previous program (review required)",
  参考动作: "Reference action",
  参考手臂: "Reference arm",
  "右臂抬起、招手、放下": "Raise, wave and lower the right arm",
  "左臂抬起、招手、放下": "Raise, wave and lower the left arm",
  参考招手次数: "Reference wave count",
  "正在读取模型动作配方…": "Reading the model’s action recipe…",
  "查看 Sophicore 参考姿势建议": "View Sophicore reference poses",
  取消建议: "Dismiss suggestion",
  "先在第 2 步选择 Sophicore 参考模型，再查看该模型的姿势与范围。":
    "Select the Sophicore reference model in Step 2 first, then view its poses and limits.",
  推荐来源与模型依据: "Recommendation source and model basis",
  "已有姿势程序保留。要比较新建议，请核对来源；不会覆盖你的角度和时间。":
    "The existing pose program is retained. Review the source to compare a new suggestion; your angles and timings will not be overwritten.",
  "采用这套参考姿势，随后人工核对":
    "Adopt these reference poses, then review manually",
  "先前参考姿势来源，需要重新核对":
    "Previous reference-pose source; review required",
  已采用姿势的来源与请求记录: "Source and request record for the adopted poses",
  "当时原话：": "Original request: ",
  "工具：": "Tool: ",
  真实参考接口响应: "Original reference API response",
  "姿势来源：": "Pose source: ",
  "用户编辑的程序；参考配方数值已变化，需重新核对":
    "User-edited program; reference values have changed and need review",
  "· 配置摘要": " · Configuration hash ",
  "。模型限位只用于本机检查，实物零位与负载未确认。":
    ". Model limits are for local checks only. Physical zero and load are unconfirmed.",
  "在 3D 中核对每个完整目标姿势（预览）":
    "Review each complete target pose in 3D (preview)",
  查看哪一行姿势: "Pose row to preview",
  完整目标姿势预览: "Complete target pose preview",
  "正在准备目标姿势预览…": "Preparing target pose preview…",
  "阶段 / 往返编号": "Stage / cycle ID",
  "累计时间 (s)": "Elapsed time (s)",
  编辑顺序: "Edit order",
  范围: "Range",
  上移: "Move up",
  删除: "Delete",
  "调整参与关节（每行都要包含这些关节）":
    "Edit participating joints (required in every row)",
  "新增关节必须明确填写一个角度，暂时将这一角度应用到所有行，再逐行调整。不会猜测实物零位。":
    "To add a joint, enter an explicit angle. It is initially applied to every row, which you can then adjust individually. Physical zero is never guessed.",
  新增关节: "Add joint",
  新增程序关节: "Add program joint",
  请选择: "Select a joint",
  "各行初始填写角度 (°)": "Initial angle for every row (°)",
  新增关节各行角度: "New joint angle for all rows",
  将该关节加入全部姿势: "Add this joint to every pose",
  "从程序移除（原始需求保留）":
    "Remove from program (keep original requirements)",
  "在末尾增加姿势（复制上一行供修改）":
    "Add a pose at the end (copy the previous row)",
  "自定义往返：重复已闭合的姿势区段":
    "Custom cycles: repeat a closed pose segment",
  "从 A 经 B 回 A 才是一次完整往返。选择起止行（从 1 计数），两端角度必须一致，不能截断现有往返组。所选区段作为一次往返；前后动作全部保留并按完整程序重新编号。累计时间与超时同步增加，请逐行核对。":
    "A → B → A is one complete cycle. Choose start and end rows (numbered from 1) with matching endpoint angles, without splitting an existing cycle group. The selected segment counts as one cycle. Actions before and after it remain, and the whole program is renumbered. Elapsed time and timeout increase together; review every row.",
  开始行: "Start row",
  结束行: "End row",
  所选区段执行次数: "Segment repetition count",
  "请选择包含一个完整往返的闭合 A → B → A 区段和 2～20 次执行；不能截断现有编号组或合并多个编号组。":
    "Select one closed A → B → A cycle and 2–20 repetitions. Do not split an existing numbered group or combine multiple groups.",
  先选择一个完整闭合往返区段: "Select one complete closed cycle first",
  到位允许误差: "Position tolerance",
  最大角速度: "Maximum angular velocity",
  最大角加速度: "Maximum angular acceleration",
  整套动作超时: "Whole-action timeout",
  已人工核对完整姿势程序: "Complete pose program manually reviewed",
  "我已核对全部参与关节、逐阶段角度、往返次数、最后姿势与时间限位。这些值只用于本机参考仿真。原话、模型或参数修改后需要重新核对。":
    "I have checked all participating joints, stage angles, cycle counts, final pose and timing limits. These values are for local reference simulation only. Changes to the request, model or parameters require another review.",
  "尚未采用完整姿势程序。第 3 步可以查看模型参考建议；保存需求草稿与采用执行程序是两个操作。":
    "No complete pose program has been adopted. View model reference suggestions in Step 3. Saving a requirement draft and adopting an execution program are separate actions.",
  "开始、结束和取消": "Start, finish and cancel",
  关节与设备对应: "Joint and device mapping",
  "零位、方向和单位": "Zero, direction and units",
  "ROS / ESP32 分工与通信": "ROS / ESP32 responsibilities and communication",
  出错以后怎么办: "Fault behavior",
  怎样检查结果: "Acceptance checks",
  在什么条件下测试: "Test environment",
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
  "只执行上面所填的一项动作；所有固定检查都需通过，不编排多个动作。":
    "Execute only the single action entered above. Every predefined check must pass; multiple actions are not sequenced.",
  "步骤、相关关节和次数按上面的完整动作草稿检查；当前执行器还不能执行这套动作。":
    "Review steps, related joints and repetitions against the complete action draft above. The current executor cannot run this action sequence.",
  "从模型初始角度开始，其他关节保持源姿态；不是实物回零。手动启动；端点就绪后观察给定时长，到位不提前结束。结束或取消停止本轮进程，不代表实物刹车、卸力或返回起点。":
    "Start manually from the model’s initial angles while other joints retain their source pose; this is not physical homing. Once endpoints are ready, observe for the specified duration, including after reaching the target. Finishing or cancelling stops this run’s processes, without establishing physical braking, torque release or return to the starting pose.",
  "从固定的 0–1 合成数值开始，不读取实物传感器。手动启动；端点就绪后观察给定时长，到位不提前结束。结束或取消停止本轮进程，不代表实物刹车、卸力或返回起点。":
    "Start manually with fixed synthetic values from 0 to 1; physical sensors are not read. Once endpoints are ready, observe for the specified duration without ending early at the target. Finishing or cancelling stops this run’s processes, without establishing physical braking, torque release or return to the starting pose.",
  "本轮只对应模拟设备；ESP32 是编译目标，不连接板子、不驱动真实电机或 GPIO。":
    "This run uses simulated devices only. ESP32 is a build target; no board, real motor or GPIO is driven.",
  "沿用模型转轴及初始角度偏移；位置反馈用 rad，速度指令用 rad/s，不做真实编码器校零或减速比换算。":
    "Use the model’s joint axes and initial angle offsets. Position feedback uses rad and velocity commands use rad/s. Physical encoder calibration and gear-ratio conversion are not performed.",
  "输入是 0–1 模拟数值，输出为 0 或 1；不换算温度、距离等实物单位。":
    "Input is a simulated value from 0 to 1, and output is 0 or 1. No conversion to physical units such as temperature or distance is performed.",
  "ROS 根据反馈计算速度或开关；ESP32 工程负责限幅和通信。在电脑上通过虚拟串口测试共享固件核心：JSONL、115200、名义 20 Hz。没有板上执行。":
    "ROS calculates velocity or switch commands from feedback; the ESP32 project handles limits and communication. The shared firmware core is tested on the computer over virtual serial: JSONL, 115200 baud, nominally 20 Hz. Nothing runs on a physical board.",
  "超过 600 ms 没收到有效状态或指令时归零；坏包拒绝，不保证任意坏包立即停车。重复指令不重新执行；没有实物急停、断电或自动重连恢复。":
    "Output returns to zero after 600 ms without valid status or commands. Bad packets are rejected, but an individual bad packet does not always stop motion immediately. Duplicate commands are not executed again. Physical emergency stop, power isolation and automatic reconnection recovery are not included.",
  "观察结束时最后 5 个反馈位置都在允许误差内；不是持续稳定指定秒数。另检查 ROS 与固件编译、两端身份、通信、指令范围及失联。所有检查须在实际运行后通过。":
    "At the end of observation, the last five position samples must be within tolerance; this does not measure a continuous settling interval. ROS and firmware builds, endpoint identity, communication, command limits and connection loss are also checked. All checks require an actual run to pass.",
  "模拟值达到或超过阈值输出 1，否则输出 0；检查阈值上下及等于边界，没有迟滞或滤波。另检查 ROS 与固件编译、两端身份、通信、指令范围及失联。所有检查须在实际运行后通过。":
    "Output 1 when the simulated value reaches or exceeds the threshold, otherwise output 0. Check above, below and exactly at the threshold; hysteresis and filtering are not included. ROS and firmware builds, endpoint identity, communication, command limits and connection loss are also checked. All checks require an actual run to pass.",
  "固定基座、零重力、理想速度的单关节仿真，无额外负载或碰撞验收；三维外观不证明真实动力学。":
    "Single-joint simulation uses a fixed base, zero gravity and ideal velocity, without extra load or collision acceptance. The 3D appearance does not establish physical dynamics.",
  "固定软件产生的 0–1 数值；不验证实物传感器噪声、负载、碰撞或现场条件。":
    "Use fixed software-generated values from 0 to 1. Physical sensor noise, load, collisions and site conditions are not verified.",
  "尚未确认，请补齐这一组。": "Not yet confirmed. Complete this group.",
  "补充内容已保留，暂不进入生成；请查看本组具体待补或未支持项。":
    "Additional requirements are saved, but generation is not available yet. Review this group’s missing or unsupported items.",
  补充要求需另行适配: "Additional requirements need separate implementation",
  "硬件对应仅保存参考，不参与本轮控制或作为已接线证明。":
    "Hardware mappings are saved for reference only. They are not used for control in this run or proof of completed wiring.",
  "采用本次 V5 多关节软件契约；实际运行后才判定通过":
    "Use this run’s V5 multi-joint software contract. Success is determined only after an actual run.",
  "这些是现有单项测试的设置，不代表完整动作已能运行或通过验收。":
    "These are settings for the existing single-action test, not confirmation that the complete action can run or has passed acceptance.",
});

type Translate = (source: string, english?: string) => string;

/** Translate only known validator templates; preserve interpolated model names. */
export function motionIssueText(message: string, t: Translate): string {
  const templates: [RegExp, (...parts: string[]) => string][] = [
    [
      /^第 (\d+) 个姿势的累计时间必须递增。$/,
      (row) => `Elapsed time must increase at pose ${row}.`,
    ],
    [
      /^第 (\d+) 个姿势的阶段代号需为 1～80 个英文字母、数字、下划线或短横线。$/,
      (row) =>
        `Pose ${row}: stage ID must contain 1–80 letters, digits, underscores or hyphens.`,
    ],
    [
      /^第 (\d+) 个姿势的往返编号应为非负整数。$/,
      (row) => `Pose ${row}: cycle ID must be a nonnegative integer.`,
    ],
    [
      /^第 (\d+) 个姿势必须包含全部参与关节。$/,
      (row) => `Pose ${row} must contain all participating joints.`,
    ],
    [
      /^关节 (.+) 不在当前可动关节中。$/,
      (joint) => `Joint ${joint} is not among the current movable joints.`,
    ],
    [
      /^第 (\d+) 个姿势的 (.+) 超出模型范围或缺少角度。$/,
      (row, joint) =>
        `Pose ${row}: ${joint} is outside the model limits or has no angle.`,
    ],
  ];
  for (const [pattern, english] of templates) {
    const match = message.match(pattern);
    if (match) return t(message, english(...match.slice(1)));
  }
  return t(message);
}

/** UI summaries from the backend remain unchanged in the underlying payload. */
export function detailSummaryText(message: string, t: Translate): string {
  const records = message.match(
    /^保存 (\d+) 条设备对应资料；不参与本轮控制，不表示已适配或实测。$/,
  );
  if (records)
    return t(
      message,
      `${records[1]} device mapping records saved for reference. They are not used for control and do not establish compatibility or physical testing.`,
    );
  const suffix =
    " 这些是现有单项测试的设置，不代表完整动作已能运行或通过验收。";
  if (message.endsWith(suffix))
    return t(
      message,
      `${t(message.slice(0, -suffix.length))} ${t(suffix.trim())}`,
    );
  return t(message);
}
