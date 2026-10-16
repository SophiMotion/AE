# AE · Auto Engineering

AE 是从机器人需求到硬件、接线、程序和控制的本机开发工作台。默认打开空白需求入口，用户逐步说明目标、选择硬件，再生成接线、预览动作、选择 ESP32 或 ROS 程序、准备部署，最后进入控制台。

**当前完整适配 FoldBot，入口保持通用。** 其他机器人或硬件可以填写、保存为待适配需求，不会自动套用折叠机器人的接线。FoldBot 生成器复用已有 Sophicar 整机源码，保留履带底盘、双折叠板、六关节机械臂与嵌入网页。**目前不会从自然语言自动重写运动算法、标定或实机动作组**。ROS 为源码演示；动作预览不是 Gazebo 物理仿真。

## 打开工作台

- [GitHub Pages 分享体验版](https://sophimotion.github.io/AE/)
- [FoldBot 流程直达](https://sophimotion.github.io/AE/#foldbot)
- [项目说明页](https://sophimotion.github.io/AE/guide.html)
- 本机启动后：[FoldBot 工作台](http://127.0.0.1:8877/#foldbot)

GitHub Pages 从仓库 `main` 分支的 `docs` 目录发布，内容以最近一次成功部署为准。分享版展示同一套流程，草稿保存在访客自己的浏览器，可查看已有参考源码和原控制台预览。它不会调用本机 API、在线构建工程、连接 USB 或控制机器人；参考源码不会随访客输入变成一次新的生成结果。

## 从需求到控制的七步流程

### 发给微信好友体验

分享 https://sophimotion.github.io/AE/#foldbot 即可，无需启动你的电脑。好友填写“制作一个折叠机器人”，按七步引导体验需求、双画布接线、动作预览、参考源码、模拟烧录和离线控制台。烧录页沿用本机的文件、串口、板卡检查与写入确认布局：选择三项内置示例文件并核对，再选择模拟 COM3、COM5 或 macOS 串口，连接模拟板卡并确认写入，可查看进度与模拟日志，也可中途断开或重新体验。更换文件会使旧核对失效。示例条目不包含可烧录的固件数据，不检查实际电脑设备。手机也可通过元件旁的加号及端口下拉框完成接线；若微信内置浏览器加载不完整，可从右上角菜单选择在浏览器打开。

模拟烧录不会访问 USB；离线控制台只展示界面和 3D 模型，运动按钮不可用。草稿保存在各自浏览器内，不会同步给其他访客。当前未完成微信真机浏览器验收。

| 步骤 | 用户操作 | 当前结果 |
| --- | --- | --- |
| 1. 说明需求 | 用文字或语音描述，再逐题确认机器人类型、主要动作、期望结果 | 保留用户原文，提示词默认收起 |
| 2. 选择硬件 | 选择现有 Sophicar、外置折叠驱动、BusLinker 和底盘组合，或记录其他型号 | 未适配硬件可以保存，但不生成假接线 |
| 3. 生成接线 | 点击生成接线，才显示原模型与信号线路图，核对源码依据 | 需求、硬件与源码摘要绑定；改动后重新生成核对 |
| 4. 仿真预览 | 滑杆或动作组、时间游标、可选部件曲线 | 分开显示角度和角速度；扭矩无数据时保持空轨 |
| 5. 生成程序 | 选择 ESP32 + Web 或 ROS 2；填写部署配置并核对生成 | 只输出所选路线的代码及公共配置，可查看文件并下载 |
| 6. 部署程序 | ESP 路线准备本次编译文件和 USB 串口；ROS 路线查看主机部署说明 | ROS 不开放 ESP 烧录；分享版仅演示 |
| 7. 机器人控制 | ESP 路线确认使用板上固件后进入原控制台，再手动连接与使能 | ROS 显示待接入；预览不会向实机发送动作 |

需求、硬件、接线核对和动作组选择随草稿自动保存。刷新后回到通用入口，已有工程和每份浏览器草稿均可显式继续；旧版工程进入新引导时创建副本，保留旧工程和生成记录。修改需求或硬件会使旧接线和代码失效。保存、生成、编译、写入和实物验收分别记录。

### 同一个工程的两张画布

描述需求后，可以在 **流程画布 / 硬件画布 / 表单引导** 之间切换。三种界面使用同一份需求、硬件选择和程序配置，修改后自动保存草稿。

- **流程画布**：初始提供需求、硬件、接线、预览、程序、部署和控制七个阶段。拖入动作或条件节点、拖动端口连线，点击节点修改参数；也可用列表和下拉框连接节点。动作节点引用现有预览动作组，条件用于检查需求是否完整、接线是否核对。缺少步骤、非法顺序或不支持的分支会显示问题并阻止生成。
- **硬件画布**：把板卡、折叠驱动、机械臂总线和底盘电机拖入画布，连接端口，或通过下拉框完成接线。可载入现有整机的 6 个元件、17 条源码信号连接，再逐项核对。未知硬件可以记录，尚未适配时不能生成可执行接线方案。
- **恢复与交换**：支持删除、撤销、重做、自动保存以及工程 JSON 导入导出。刷新后从工程入口继续草稿；导入创建新草稿，并清除旧项目关联、审核与生成状态。
- **版本一致性**：仅移动元件位置不会使接线核对或生成版本失效；修改端口连线、需求或相关参数会要求重新核对和生成。坐标单独保存，图的内容随工程修订保存。

两张画布编辑的是工程方案，不直接发送机器人运动指令。流程图当前支持 AE 的顺序开发流程，不是任意控制逻辑或分支程序编译器。真实设备操作仍由最后的部署与控制步骤显式发起；公开分享版只编辑草稿、预览和查看参考源码。

### 开源代码复用

两张画布实际使用 MIT 许可的 [React Flow 12.12.0](https://github.com/xyflow/xyflow) 实现节点拖动、端口连接、缩放和选择。折叠驱动节点中的通用步进电机图形使用 MIT 许可的 [Wokwi Elements 1.9.2](https://github.com/wokwi/wokwi-elements)，不将该图形当作真实电机型号、Sophicar 板图或电路仿真器。来源与许可证随 `Graph-editor-NOTICE.txt`、`Wokwi-elements-LICENSE.txt` 和 `Wokwi-elements-NOTICE.txt` 一起发布。

Tinkercad、Dify、n8n、ComfyUI 的交互作为参考；本次没有复制它们的整套产品源码，也未接入它们的工作流执行服务。AE 的工程结构、硬件适配、校验和表单同步由本项目实现。

程序预览局部移植 [Seeed CodeCraft 的只读代码编辑器](https://github.com/Seeed-Studio/CodeCraft/blob/d236f3c59d33639e0006a80f2dac931ee05956fd/gui/src/lib/code-editor/code-editor.js)，保留模型创建、内容更新与语言切换结构，适配为独立 React 组件。使用固定版本 Monaco 0.57.0，提供代码高亮、行号与文件内查找；编辑器和 Worker 随网站打包，不依赖 CDN。BSD-3-Clause 许可证及变更说明保存在 `web/public/CodeCraft-code-editor-LICENSE.txt`、`web/public/CodeCraft-code-editor-NOTICE.txt`，并随 `docs` 发布。

接线生成和流程状态由 AE 实现，不嵌入 aily 的远程接线服务；没有把旧版 CodeCraft 当作现款 AI 网站，也没有复制未经核实许可的板卡包。当前适配的硬件依据仍来自项目已有整机源码。

### 模型、接线与预览

- 3D 视图复用原版 FoldBot 控制台模型，当前使用 Three.js；动作组与滑杆只改变模型预览。
- 尚未接入真实 Gazebo/gzweb 或 Spark 运行服务。预览角度、预览速度与实测数据分开标注；没有真实反馈时，实测位置、速度和扭矩保持未知。曲线不能证明动力学、碰撞或带负载能力。
- 源码引脚：折叠轴 1 的 DIR/STEP/EN 为 GPIO3/8/10，轴 2 为 GPIO4/5/9；BusLinker TX/RX 为 GPIO6/7；底盘 M1 为 GPIO38/37、M2 为 GPIO36/35。
- **GPIO35–37 与 N16R8 内部存储器的兼容性仍需现场确认。** 勾选接线核对只确认已阅读来源，不会证明驱动器、电源或实际接线已经验收。
- 当前来源固件禁用限位。上电、失联或人工移动后，须按真实位置重新确认端位，不能用开环脉冲计数冒充实测到位。

### 生成文件与版本依据

新引导工程按选择生成：ESP 路线包含 `firmware/`，ROS 路线包含 `ros2/`，两者均包含 `config/guided.json`、接线和需求修订等公共文件。下面目录展示两类路线的合并说明，并非每个项目都同时包含两类程序。旧版 14/19 文件历史快照仍可读取，不会自动升级覆盖。

```text
firmware/foldbot/
  foldbot.ino                 整机源码模板
  web_ui.h                    原嵌入控制网页
  foldbot_local_config.h       本机 AP 口令配置入口
config/
  foldbot_config.json         工程与本机控制约束
  workflow.json               ESP/ROS、主机、版本、串口与动作组选择
  guided.json                 需求问答、硬件组合与接线绑定
  wiring_graph.json           使用硬件画布时保存的元件、端口和连线
  behavior_graph.json         使用流程画布时保存的阶段、动作和条件连接
  wiring.json                 源码接线及未确认事项
  action_preview.json         仅供视觉预览的配置
ros2/foldbot_demo/
  foldbot_demo/demo.py        默认离线的 ROS 演示入口
  foldbot_demo/workflow.json  演示读取的当前配置
  ...                        Python 包与 ROS 包描述文件
prd.json                     冻结的需求修订
provenance.json              来源、脱敏变换与 SHA-256
manifest.json                文件清单、用途、类型及校验
deployment.md                本修订部署目标与操作边界
README.md                    生成工程使用说明
```

交付模板已移除原 AP 口令。自行编译前，须在 `foldbot_local_config.h` 本地设置私人口令，未设置会主动阻止编译；配置后的口令文件不适合公开上传。生成不修改原工程或 NVS 标定，导出包不包含历史 `.bin`。

ROS 演示读取包内 `workflow.json`，默认打印本修订选项并离线退出。显式 `--run-ros` 也只创建日志节点，没有机器人运动发布器。**ROS 程序部署到电脑、Jetson 或树莓派，不通过 COM 口烧录。** ROS 串口是待接入的通信配置；现有 FoldBot 控制使用 Wi-Fi WebSocket，ROS 实机控制尚未完成。

### 本机 USB 烧录接口

采用 Espressif 官方 [esptool-js](https://github.com/espressif/esptool-js)，当前依赖锁定为 `0.7.0`，许可为 Apache-2.0。接口使用浏览器 Web Serial，需要支持该能力的浏览器及本机 `localhost` / `127.0.0.1` 页面。分享页不提供设备访问。

1. 生成当前需求修订，并在确认的工具链中重新编译 ESP32-S3 工程。
2. 准备本次编译的应用 `.bin`、对应分区表 `.bin` 和构建清单，也可在页面填写构建信息后整理清单。文件哈希与格式检查不等于平台已重新编译或证明其来源。
3. 按页面要求隔离执行器供电，选择 USB 串口，读取芯片和板上分区表。仅匹配当前支持的 ESP32-S3 单应用分区布局时才能继续。
4. 明确确认后，仅更新对应应用分区并回读校验。不整片擦除、不覆盖 NVS、不重写分区表或引导程序，也不在写入后自动启动机器人动作。

当前不支持任意开发板、合并固件、修改分区布局或通用首次空片部署。旧 `.bin` 不能因为文件名相同就当作本次固件；板型、工具链、编译来源与实际硬件须由操作者核对。

烧录与机器人控制共用互斥会话。版本变化、离开页面或续租失败会取消继续操作；若 USB 是否结束无法确认，后台仍保留占用，直到原页面关闭串口后明确释放。页面丢失时，先关闭相关页面并拔下 USB、确认设备停止，再按恢复提示重启本机后台。

**当前仅完成软件接口与替身设备测试，未通过这套 AE 烧录接口执行实物烧录、ROS 控制或实机运动验收。** 写入校验通过不能证明接线正确或机器人实际到位。

### 原版完整控制台

新引导的 ESP 路线在第 7 步嵌入原控制台，也保留 [本机独立入口](http://127.0.0.1:8877/#foldbot-console)。它保留原 3D 状态视图、底盘摇杆、双板控制与维护、六关节点动、姿态示教及动作组功能。使用已有固件可以在部署步骤明确选择继续，无需冒充已完成新固件烧录。

电脑先连接 ESP 热点，关闭其他机器人控制页面，再在 AE 确认现场条件、连接并读取 `firmwareBuild` 等状态，随后单独使能。首次连接仅握手与读取状态，不自动使能、写标定或调整功率。页面隐藏、离开或失联后撤销控制，不自动恢复动作。

完整控制台保留原底盘 ±100 输入、30/60/100 功率档及机械臂长按点动，不采用旧简化面板的短点动限制。行程保存/清除、方向修改、姿态覆盖和路径确认需要逐次确认。当前无限位固件不能自动回零。3D 状态示意、协议 ACK 和步进脉冲计数均不是物理到位证据。

公开 `#foldbot-console` 使用独立只读预览，可旋转模型但不创建控制会话；Pages 打包移除本机控制 HTML。控制事件记录在本机 `.tools/workbench.sqlite3`，不随公开页面发布。

## 界面语言与语音输入

右上角 **中文 / English** 切换界面语言，偏好保存在当前浏览器；需求、工程名、代码和原始日志保留原文。

Use **中文 / English** in the top-right corner to switch the interface. Original requirements, project names, source code and logs remain unchanged.

需求输入框的 **语音输入 / Voice input** 支持普通话或英语转文字，识别后可修改，不会直接执行硬件动作。识别依赖浏览器及其服务，部分浏览器可能联网处理语音，AE 不保存音频。不支持的浏览器会显示替代提示，可使用系统输入法的麦克风。[Web Speech API 说明](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)。

## 历史模块与验证记录

以下模块和历史验收**不属于当前 FoldBot 的物理仿真或实机验收结果**。

### Sophicore 历史流程

已有五步 PRD、动作顺序编辑、ROS/ESP32 工程生成、本机构建、Gazebo 与模拟串口检查代码保留在仓库中；多机器人选择不再是默认工作台导航。

2026-10-04 的历史参考记录针对 **Sophicore** 模型“抬起右臂 → 招手三次 → 放下”，包括正常、命令失联、测量失联和取消场景：

- 原记录报告 ROS 2 与 Gazebo 实际运行，合计 112 项检查通过。
- ESP32 / ESP32-S3 目标固件编译通过，共享 C++ 通信核心在主机虚拟串口中验证。
- 导出工程在隔离目录完成本机部署复测。

这些记录仅适用于当时的模型、参数和环境。Sophicore 仿真使用固定底座、零重力、数值惯性和简化几何，未验证平衡、碰撞、强度或抓取接触。其结果不能继承给 FoldBot、任意新需求或实物电机。

历史环境：Python 3.12.10、Node.js 22.23.1、Windows + WSL2 Ubuntu 22.04、ROS 2 Humble、Gazebo Fortress、Arduino CLI 1.5.1、ESP32 core 3.3.12、ArduinoJson 7.4.3。上述版本不是 FoldBot 已确认的构建或实物环境。

### Blockly 硬件开发模块

历史 `#hardware` 入口保留，已从主导航移出。模块参考用户提供的 aily Blockly 视频，直接采用官方 [Blockly 13.3.0](https://github.com/RaspberryPiFoundation/blockly)，许可为 Apache-2.0，许可证位于 `web/public/blockly-LICENSE.txt`；未复制 aily 整套桌面代码或品牌素材。

它提供 ESP32 / ESP32-S3 通用编译目标、串口输出/延时/数字输出/有限重复积木、逻辑信号图、浏览器草稿及 JSON 导入导出、本机 AI 候选建议。数字输出默认不猜引脚；这里不是 Sophicar 针脚图，积木不会直接成为 FoldBot 动作。没有接入百种板卡库、I2C 组件库、蓝牙 OTA 或自动修复后重新烧录能力。

交付文件为 `hardware_project/hardware_project.ino`、`config.json`、`manifest.json`、`README.md`；这些新程序未完成实物验收。浏览器测试中的 AI 使用替身，不证明实际模型生成效果。

## 本机启动与软件检查

先安装 Python 3.12 和 Node.js 22，确认 `python`、`node`、`npm` 可用。在项目根目录的 PowerShell 执行：

```powershell
# 首次安装网页和后台依赖
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 启动本机后台和构建后的网页
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

安装脚本不会安装整套 ROS、Gazebo 或固件工具链。旧仿真流程的 Windows 后台调用名为 `Ubuntu-22.04` 的 WSL 发行版；FoldBot 的页面预览不依赖 ROS/Gazebo 运行。

主要软件检查：

```powershell
python -m pytest tests/test_foldbot_projects.py tests/test_foldbot_flow.py tests/test_foldbot_flash.py tests/test_foldbot_control.py tests/test_foldbot_console.py tests/test_foldbot_console_assets.py -q
npm --prefix web run test:foldbot
npm --prefix web run test:flash
node --test web/tests/foldbot-flow.test.mjs web/tests/foldbot-simulation.test.mjs
python -m pytest tests/test_foldbot_graphs.py -q
node --test web/tests/project-graphs.test.mjs web/tests/project-graph-document.test.mjs
npm --prefix web run typecheck
```

这些测试不连接机器人。修改控制台适配脚本后，运行 `python web/scripts/prepare-foldbot-console.py` 更新静态资源。公开参考工程由 `python web/scripts/prepare-foldbot-demo.py` 制作，再执行 `npm --prefix web run build:pages` 更新 `docs`。构建后仍须提交并完成 Pages 部署，访客才能看到更新。

## 使用范围与公开文件

- 本机后台面向单用户，尚无公众账户权限、任务隔离或资源配额，不适合直接作为公网生成服务。
- 轮式导航、双足/四足步态及抓取任务未完成各自完整适配，当前默认流程不承诺这些能力。
- 资料检索未部署 RAGFlow 或 Haystack + Qdrant，也未进行模型蒸馏、强化学习训练。
- 仓库保留源码、依赖清单、公开资料、参考模型和整理后的展示数据；本机数据库、API 密钥、工具缓存及完整运行目录不公开。
- Sophicore 历史结构来源：[SophiMotion / sophicore-robot-cle](https://github.com/SophiMotion/sophicore-robot-cle)。FoldBot 来源及模板变换记录见 `worker/foldbot_source_provenance.json` 与生成工程的 `provenance.json`。
