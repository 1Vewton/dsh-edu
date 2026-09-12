# dsh-edu-mode — 教育模式

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加一个**教育模式**：进入这个模式后，DSH 会把「讲清楚一门课」当成任务本身——先真的去查资料，再讲明白，把课堂笔记写下来，最后出题检查你到底会不会。

它不是一个提示词模板，而是一个真正的插件：一个可切换的会话模式、一段注入到每次模型请求里的教学协议、三个模型必须遵守的工具，以及落盘的课程文件。

## 它做什么

| 阶段 | 行为 | 由什么保证 |
| --- | --- | --- |
| 1. 调研 | 用 `web_search` / `web_fetch` 找权威来源（教材、大学课程页、标准、论文），记录标题和链接；需要多来源时并行开子代理 | 教学协议 + 现有 web 工具 |
| 2. 讲解 | 先讲为什么有用 → 直觉/类比 → 精确定义（先定义符号）→ 推导 → 完整例题 → 常见误区 → 与前后知识的联系 | 教学协议 |
| 3. 笔记 | 每讲一次课就调用 `edu_notes`，把讲解、要点、易错点、来源写成 markdown 存到课程目录 | `edu_notes` 工具 |
| 4. 出题 | 每讲结束调用 `edu_quiz`，在 GUI 自带的问答界面里让你做题并自动判分；答错的点会被重新讲一遍再重考 | `edu_quiz` 工具 |
| 5. 进度 | 模块自测通过后调用 `edu_course` 打勾，跨会话保留课程进度 | `edu_course` 工具 |

三个工具：

- **`edu_course`** — `open` 建立/改写课程大纲（目标、水平、模块清单、参考来源）并把课程设为当前课程；`status` 报告进度和下一个模块；`complete` 给某个模块打勾。
- **`edu_notes`** — 为某一讲写课堂笔记（正文 + 要点 + 常见误区 + 来源），写入课程笔记文件。同一讲重复写会被拒绝，除非显式 `replace: true`。
- **`edu_quiz`** — 出题、通过对话内问答组件收答案、判分、把结果写进测验记录。选择题自动判分（单选/多选），开放题标记为「需要模型自己判」。没有可交互问答通道时（headless、ACP、子代理）不会报错，而是把题目交回给模型在对话里问。

## 课程文件

默认写在会话工作区的 `edu-notes/<课程名>/`：

```
edu-notes/线性代数/
├── syllabus.md   # 课程目标、水平、模块清单（- [ ] / - [x]）、参考来源
├── notes.md      # 课堂笔记，一讲一节
└── quizzes.md    # 测验记录，一次一节，含得分与错题
```

课程名会做安全化处理（保留中文，去掉路径分隔符），所以 `/edu 线性代数` 会得到 `edu-notes/线性代数/`。

## 安装

插件是一个标准的 DSH 组合包（`dsh.bundle` + `cordis.patch.yml`）。`lib/` 是构建产物并已随仓库提交，因此**不需要授权任何构建脚本**。

```sh
# 1) 从 npm 安装（有 release 之后可用）
dsh plugin --profile web add dsh-edu-mode

# 2) 从 GitHub Release 下载的 tarball
dsh plugin --profile web add ./dsh-edu-mode-0.1.0.tgz

# 3) 直接装 git 仓库
dsh plugin --profile web add github:1Vewton/dsh-edu
```

> **注意安装方式。** 请用 npm / tarball / git 安装（安装到 profile 的 `node_modules` 里的是一份真实目录）。不要用 `dsh plugin add <目录路径>`：那是 pnpm 的 `link:`，Node 会把它解析到源目录的真实路径，于是插件的 `@deepseek-ai/*` 导入会命中源码仓库自己的 `node_modules`，从而加载**第二份 cordis / dsh-tools 实例**，DSH 就无法把它识别成插件了。DSH 源码检出内开发（`pnpm dsh` + `--patch`）不受影响。

用源码检出运行时，把上面的 `dsh` 换成 `pnpm dsh`。验证层已生效（不启动服务）：

```sh
dsh --profile web --dump-config     # 应能看到 "# == dsh-edu-mode" 这一段
```

装完需要**重启**该 profile 的服务（例如 `pnpm dsh web`）才会加载。卸载：`dsh plugin --profile web remove dsh-edu-mode`。

## 配置

`cordis.patch.yml` 里的 `config`（插件加载时会严格校验，写错会直接报错而不是静默取默认值）：

```yaml
- insert:
    - id: edu-mode
      name: 'dsh-edu-mode'
      config:
        notesDir: edu-notes        # 课程文件根目录（工作区相对路径）
        maxQuizQuestions: 6        # 一次 edu_quiz 最多几道题
        passRatio: 0.8             # 自测通过线（自动判分部分的比例）
        # policy: |                # 需要的话，用整段自定义教学协议覆盖内置的
```

## 使用

会话里用 `/edu` 命令开关模式：

| 命令 | 效果 |
| --- | --- |
| `/edu 线性代数` | 打开教育模式并把这门课设为当前课程，同时把你这句话作为请求发给模型 |
| `/edu` | 打开教育模式（课程待定，模型会先问你想学什么） |
| `/edu status` | 查看当前状态和课程 |
| `/edu off` | 退出教育模式 |

典型开场：

```
/edu 线性代数，我从行列式开始，基础一般
```

之后模型会按教学协议走：先检索 MIT 18.06 / 教材等来源 → 讲清一个模块 → 写笔记 → 出题 → 根据错题回炉。你也可以随时插话：「这块再讲一遍」「出难一点的题」「跳过这节」。

状态存在会话日志里（`edu/mode` 事件，最后一个生效），所以会话恢复、分叉都会自动带上模式和当前课程；课程进度则落在工作区的课程文件里，跨会话可用。

## 发布

发布由 GitHub Actions 完成（`.github/workflows/release.yml`）：推一个版本 tag 就会构建、测试、发 npm，并创建带 tarball 附件的 GitHub Release。

```sh
# 1) 改版本号并提交
npm version patch --no-git-tag-version     # 或手改 package.json
pnpm build && pnpm test                    # 确保 lib/ 与 src/ 一致
git commit -am "chore: release v0.1.1"
git push

# 2) 打 tag 触发发布
git tag v0.1.1 && git push origin v0.1.1
```

**一次性配置**：在 npm 生成一个 **Automation** token（npmjs.com → Access Tokens），加到仓库 Settings → Secrets and variables → Actions，名字用 `NPM_TOKEN`。没有这个 secret 时 workflow 会在发布步骤明确报错，不会静默跳过。

workflow 会拦住这些情况：tag 与 `package.json` 版本不一致、提交的 `lib/` 与 `src/` 不一致（防止发出去的构建产物是旧的）、单元测试失败、该版本已经在 npm 上存在。发布走 `npm publish --access public --provenance`，所以在 npm 页面能看到该包由这次 GitHub Actions 运行构建的出处证明，GitHub Release 上也会附上同一个 tarball。

也可在 Actions 页面手动 dispatch：默认 `dry_run = true`，只跑构建/测试/打包，不发版。

> 之后可选升级到 npm 的[可信发布（OIDC）](https://docs.npmjs.com/trusted-publishers/)：包在 npm 上存在后，在包的 Settings → Trusted publishing 里填 `1Vewton` / `dsh-edu` / `release.yml`，之后就能删掉 `NPM_TOKEN`（workflow 已经带了 `id-token: write`）。首次发布仍需要 token，因为可信发布只能在包已存在时配置。

## 开发

```sh
pnpm install
pnpm build      # src/*.ts -> lib/*.js（lib/ 已提交，改了要重新 build 并重新打包）
pnpm test       # 35 个单元测试：判分、路径、课程文件渲染、模式状态折叠、配置校验
```

源码结构：

```
src/index.ts   插件入口：EduMode 服务、edu:policy 提示段、/edu 命令、状态机
src/policy.ts  默认教学协议文本（可被 config.policy 覆盖）
src/course.ts  edu_course / edu_notes 工具
src/quiz.ts    判分逻辑（纯函数）+ edu_quiz 工具
src/store.ts   课程文件读写（走 ctx.fs，受沙箱约束）
src/paths.ts   纯函数：课程名安全化、文件布局、markdown 渲染
```

改完代码后，profile 里装的是一份拷贝，必须重新 `remove` + `add` 才会更新。

## 设计取舍

- **状态放会话日志**，而不是插件内存：恢复/分叉会话不需要额外镜像。在回合内切换模式时，选择会挂起到下一个 step 边界再落盘（借用 plan-mode 的成熟做法），避免在 append 发布期间重入会话。
- **写文件走 `ctx.fs`**，并按会话解析 sandbox 策略，因此写入受部署的沙箱模式约束（`workspace-write` 下写不到工作区外）。本插件对自己的文件只做追加/精确替换，所以不申请读写前置意图，而是补发 `fs/observed`，让模型自己的 `write`/`edit` 看到最新版本。
- **判分是纯函数**，规则集中在一处：单选命中任一可接受答案即对；多选需完全一致，真子集半分；无选项的开放题永不自动判分，交回模型；未作答计入分母。
- **不做 UI 卡片**：测验直接复用界面自带的问答组件，所以无需客户端构建；模式状态通过 `/edu` 命令回执和会话记录可见（后续可以再加输入栏 chip，需要客户端插件）。

## 限制

- 模式状态的作用范围是单个会话；`/edu off` 不影响其它会话。
- 判分只覆盖可机判的题型；开放题依赖模型自己的判断（工具会把参考答案一并返回）。
- 笔记文件按课程名分目录，同名课程视为同一门课；重命名课程等于另起一门。
- 教育模式不会限制其它工具，模型仍可能被要求做别的任务——协议里明确要求它把「讲懂」当作交付物。

## 许可证

MIT
