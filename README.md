 AE · Auto Engineering
从机器人动作需求，到 ROS 与 ESP32 工程的本机开发平台。
用户先说明机器人要做什么，平台引导补齐结构、动作、硬件和验收要求。拆分后的方案经人工核对，再生成两端工程，实际编译，并在本机（未在本机部署ros环境的需提前部署或者云端部署）检查 ROS 仿真与模拟串口通信。
当前已经跑通的是 Sophicore 关节动作流程。参考例子是“抬起右臂 → 招手三次 → 将手臂放到身体旁边”。走路、导航、抓取，以及真实电机驱动，仍需要各自适配和验收。

**硬件开发工作区（2026-10-12）：** 顶部“硬件开发”进入 [本机工作区](http://127.0.0.1:8877/#hardware)。交互参考用户提供的 aily Blockly 视频，编辑器直接采用官方 [Blockly 13.3.0](https://github.com/RaspberryPiFoundation/blockly)，许可为 Apache-2.0，许可证随页面资源保留于 `web/public/blockly-LICENSE.txt`。没有复制 aily 的整套桌面代码或品牌素材。

- 选择 ESP32 / ESP32-S3 通用 Arduino 编译目标；串口输出、延时、数字输出、有限重复积木可拖拽连接到初始化与循环入口，代码随有效编辑更新。
- 接线页显示逻辑信号连接图和保守可选 GPIO，数字输出默认不猜引脚。这里不是 Sophicar 扩展板针脚图，也不会改变 FoldBot 原有接线、固件或标定。
- 程序配置和未连接的积木分别自动保存在当前浏览器，支持 JSON 导入/导出。代码生成检查结构、引脚和数量限制；未连接、禁用或未知积木不会被悄悄忽略。
- 本机 AI 沿用“设置”的模型接口，返回待采用建议、修改说明及提示词记录。编辑或取消会使旧候选失效；采用后才更新程序。分享版只提供示例、提示词与浏览器内源码生成，不调用模型服务。
- 文件视图列出 `hardware_project/hardware_project.ino`、`config.json`、`manifest.json` 和 `README.md`。本机可下载完整 ZIP，分享版可下载单个文件。这里只生成源码，尚未对这些新程序执行编译、烧录或实物测试。
- “带入 PRD 需求”新建需求草稿并带入板型和配置摘要；已有 ROS 工程仍需按各自支持范围核对。完整 JSON 留在硬件工作区，积木不会直接成为机器人运动命令。FoldBot 工程及原版完整控制台仍可进入。

相关检查：`npm --prefix web run test:hardware`、`python -m pytest tests/test_hardware_workspace.py -q`。浏览器测试中的 AI 使用替身；没有证明实际模型生成效果或实机运行。本次没有添加视频展示的百种板卡库、I2C传感器组件库、蓝牙 OTA 或自动修复后重新烧录能力。

**FoldBot 接入流程（2026-10-12）：** 顶部“折叠机器人”入口增加独立的需求、工程与来源、本机控制流程。它复用现有 Sophicar 整机固件，保留底盘、双折叠板、机械臂和嵌入网页；新填的文字保存为 PRD，当前固定模板不会自行重写电机算法或标定。ROS 只生成演示源文件，尚未用于此折叠机器人的实机控制。

- 本机入口：启动 AE 后打开 `http://127.0.0.1:8877/#foldbot`，填写需求和点动限制，核对后生成源码工程。文件面板展示文件名、类型、用途、来源哈希及 14 项交付文件，可下载 ZIP。
- 本机控制：AE 后台直接通过现有 ESP32 WebSocket 协议工作。用户明确连接、现场核对并使能后，提供底盘限时点动、双板人工端位确认与折叠/展开、机械臂单轴 8 raw 小步和全停。连接会初始化 30% 底盘功率。页面隐藏、离开或停止续租后撤销控制，不自动重连或恢复动作。板上固件、限位和实时反馈不符合适配要求时拒绝运动。
- 分享入口：[FoldBot 流程展示](https://sophimotion.github.io/AE/#foldbot)。访客草稿保存在各自浏览器；参考工程固定，不调用本机 API、不连接机器人，生成与实物验收分开标注。此链接要在包含本次更新的代码部署后才能显示新入口。
- 原源码和 NVS 标定不修改。交付模板移除了原 AP 口令；打算自行编译时必须在 `foldbot_local_config.h` 设置私人口令，未设置会主动阻止编译。工程不包含旧 `.bin`。
- **本次接入没有连接机器人、烧录、驱动电机或执行 ROS。** 协议确认、缓存状态与开环脉冲计数不等于实物到位。真实板卡与 GPIO35–37/存储配置兼容性、供电、行程及标定仍须现场确认。

本机控制记录保存在 AE 自己的 `.tools/workbench.sqlite3`，可在控制页“查看操作记录 JSON”打开最近记录；停止请求记录也不会被视为物理停止验收。共享 JSON 与 ZIP 由 `python web/scripts/prepare-foldbot-demo.py` 使用同一生成服务制作，随后执行 `npm --prefix web run build:pages` 更新 `docs`，不需要访问机器人。

**原版完整控制台：** “折叠机器人 → 打开原版完整控制台”，本机直达 `http://127.0.0.1:8877/#foldbot-console`。复用原 `web_google.html` 的 3D 视图、底盘摇杆、双板控制与维护、六关节点动、姿态示教和动作组操作。它可独立连接已有机器人，不要求重新生成 PRD。电脑先连接 ESP 热点，关闭其他机器人控制网页，再在 AE 确认现场条件并连接，检查状态后单独使能。首次连接只读取握手和状态；不自动写标定、改功率或使能。

完整控制台保留原底盘 ±100 输入、30/60/100 功率档和机械臂长按点动，不采用简化面板的短点动限制。行程保存/清除、方向修改、姿态覆盖与路径确认需要逐次确认。当前适配固件为上文的无微动限位版本，自动回零不可用。两种控制入口互斥；隐藏、离开、失联后撤销控制，不自动恢复运动。3D 为状态示意，ACK 和脉冲计数均不是物理到位证据。

公开 `#foldbot-console` 使用独立只读预览文件，允许旋转模型，不创建控制会话。Pages 打包移除本机控制 HTML。ROS 仍为代码展示，本轮不运行 ROS，也不编译、烧录固件或验证实机运动。

FoldBot 软件检查：`python -m pytest tests/test_foldbot_projects.py tests/test_foldbot_control.py tests/test_foldbot_integration.py tests/test_foldbot_console.py tests/test_foldbot_console_assets.py -q` 与 `npm --prefix web run test:foldbot`。测试使用替身设备。修改原控制台适配脚本后运行 `python web/scripts/prepare-foldbot-console.py` 重新生成静态资源，再构建本机版和 Pages。
 在线体验
- [GitHub Pages 完整工作台体验版](https://sophimotion.github.io/AE/)，
- [项目说明页](https://sophimotion.github.io/AE/guide.html)。仓库 main 分支的 docs 目录为发布来源。
分享版复用完整工作台界面，支持五步 PRD、流程图、参考动作编辑、公开资料筛选和已有本机验收记录。因为环境未部署原因所以GitHub分享版不会在线生成、编译或运行 ROS。

工作台右上角可选择 **中文 / English**，本机版与分享版使用同一套界面语言设置。语言偏好自动保存在当前浏览器；切换语言保留当前填写内容和流程位置。用户需求、工程名称、资料正文、生成代码和原始日志保留原文，切换界面语言不会翻译或改写这些内容。

Use **中文 / English** in the top-right corner to switch the workbench interface. The preference is saved in your browser. Switching preserves your draft and workflow position; original requirements, project names, source material, generated code and logs remain unchanged.

需求输入框旁的 **语音输入 / Voice input** 支持浏览器语音转文字，可选择普通话或英语。允许麦克风后开始说话，再次点击即可停止；识别文字追加到现有需求，检查修改后再手动使用智能填写或保存。每次最多 2 分钟，输入上限 4000 字；超限文字会单独保留供复制。本机与分享版共用此入口。

语音识别依赖浏览器及其识别服务，部分浏览器可能联网处理语音，本项目不保存音频。网页应通过 HTTPS 或 localhost 访问；微信内置浏览器或其他不支持的浏览器会显示替代操作提示，可使用系统输入法的麦克风。英文转写不会改变分享版原有的规则推荐范围。[Web Speech API 说明](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)。

 操作流程

text
写下动作需求
  → 选择结构，补齐动作、硬件与验收条件
  → 整理 ROS / ESP32 分工与通信规则
  → 人工核对方案
  → 生成两端工程
  → 编译 ROS 工程和 ESP32 固件
  → 检查 Gazebo 仿真、模拟串口通信与异常处理
  → 查看结果、修改后重试、导出工程
修改已经核对过的参数，需要重新核对。保存需求、通过编译和通过仿真是三个不同状态。
已有功能

| 功能 | 当前能做什么 |
| --- | --- |
| PRD 引导 | 五步填写需求，使用大白话选项，保存原话和缺项 |
| 推荐填写 | 补齐能确定的内容，保留已填内容；未知硬件与接线不猜测 |
| 结构展示 | Three.js 展示 Sophicore 的 506 个部件与 18 个结构关节，区分预览关节和参与动作的关节 |
| 动作方案 | 编辑多关节姿态、顺序、重复次数、速度和误差，并逐项核对 |
| 两端工程 | 按已核对的动作规格生成 ROS 工程与 ESP32 固件，保留共同的参数与通信约定 |
| 编译与验证 | 实际调用本机工具链，记录构建、运行、测量与错误 |
| 通信 | 在主机虚拟串口中验证指令、反馈、超时和取消处理 |
| 结果与导出 | 查看日志、曲线、验收记录，导出工程并在隔离目录复测 |
| AI 接口 | 支持本机已登录的 Codex CLI，以及可切换的 OpenAI 兼容接口 |
 已验证的参考例子
2026-10-04 的本机验收记录：
- 右臂抬起、招手三次、放下的正常场景，以及命令失联、测量失联、取消场景。
- ROS 2 与 Gazebo 实际运行；验收记录共 112 项检查通过。
- ESP32 与 ESP32-S3 两种目标的固件编译通过；共享的 C++ 通信核心在主机中运行验证。
- 原工程导出后，在隔离目录完成本机部署复测。
在线体验页展示整理后的测量记录。这些结果针对已核对的模型、参数和环境，不能推断任意需求都正确。
 运行环境
本机验收使用：Python 3.12.10、Node.js 22.23.1、Windows + WSL2 Ubuntu 22.04、ROS 2 Humble、Gazebo Fortress、Arduino CLI 1.5.1、ESP32 core 3.3.12、ArduinoJson 7.4.3。
网页和后台依赖可通过安装脚本安装。ROS、Gazebo、控制器和固件工具链需要另外准备，安装脚本不会一次安装完整仿真环境。 Windows 后台当前调用名为 `Ubuntu-22.04` 的 WSL 发行版。仅有网页和 Python 依赖不能完成仿真验收。
 启动
先安装 Python 3.12 和 Node.js 22，并确认 `python`、`node`、`npm` 可用。以下命令在项目根目录的 PowerShell 中执行：
powershell
# 首次安装网页和后台依赖
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# 启动本机后台和构建后的网页
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1


普通测试不会自动证明本机 ROS 环境可用。最终验证应通过平台执行实际构建、仿真和通信流程，检查运行结果。
当前限制

- 本项目尚未连接实物 ESP32，也没有烧录、真实电机运动或带负载验收。
- 主机 C++ 核心测试不等于 ESP32 芯片上运行。
- Sophicore 仿真使用固定底座、零重力，以及数值惯性和简化几何。当前结果没有验证平衡、碰撞、强度或抓取接触。
- 尚未接通轮式导航、双足／四足步态和抓取任务的完整执行流程。
- 资料检索目前没有部署 RAGFlow、Haystack + Qdrant，也没有进行模型蒸馏或训练。
- 后台面向本机使用；没有完成面向公众的账户权限、任务隔离及资源配额，不应直接作为公网生成服务使用。
公开文件与来源
本仓库保留源码、依赖清单、公开资料、参考模型与整理后的展示数据。本机项目数据库、API 密钥、工具缓存、完整运行目录未发布
结构来源：[SophiMotion / sophicore-robot-cle](https://github.com/SophiMotion/sophicore-robot-cle)。
