# Contributing to dsh-cc-ecosystem

感谢你的贡献!这个仓库把 Claude Code 的 `.claude/` 资产与插件加载进 DeepSeek Harness(DSH)。提交 PR 前请读一遍本文。

## 架构速览(改动前必读)

- **内存 IR,默认零写路径**:`dsh-cc-loader` 把 `.claude`(项目 + 全局)+ 插件(`plugin.json`/`marketplace.json`)解析成内存 IR,不落盘、不写 `.claude`。单一事实来源永远是 `.claude` 原文。唯一例外是 auto-memory 的**显式可写模式**(`cc-memory`,默认只读)。
- **适配器只消费 IR**:`cc-skills`/`cc-permissions`/`cc-agents`/`cc-hooks`/`cc-mcp` 各自把 IR 的一个组件映射到 DSH(cordis 插件)。适配器**不直接解析 `.claude` 文件**——解析都在 loader。`cc-memory` 是唯一例外:为了能作为一个文件夹独立挂载,它的 auto-memory 发现层与读写原语放在包内(`src/discovery.js`),但仍照抄 Claude Code 的规则,不改变 `.claude` 语义。
- **权限是只读桥**:CC `settings.json` 规则在 DSH 上强制,DSH 侧审批**不写回** `.claude`。
- **不改 DSH 宿主代码(硬约束)**:本生态通过用户 profile 的 `cordis.patch.yml` 以 `file:///` 或 npm 包挂载,依赖 DSH 官方发布包(`@deepseek-ai/*`)只读。任何需要改 `D:\deepseek-harness` 才能工作的改动都不会被接受。
- 组件分类词汇:DIRECT / ADAPTED / UNSUPPORTED / BLOCKED;UNSUPPORTED 与 BLOCKED 不进适配器。

## 尊重 Claude Code 语义(硬约束)

这个生态的全部价值建立在「和 Claude Code 行为一致」上。凡是 CC 已经定义的行为,我们照抄,不发明。

所以最容易走偏的一条路是:对 CC 语义只有部分了解,再按自己的直觉把剩下的补全。这样的 PR 通常不是「写错了」,而是「实现了一条 CC 并不存在的规则」——在一两个用例上看着对,却和真实的 CC 分叉。这种分叉往往要等某个用户踩到才暴露,修起来比一开始就问清楚贵得多。

因此:

- **改语义之前先确认语义。** 有疑问就在 issue 里问,带上你看到的证据(文档、实际行为、报错原文),不要先写代码再倒推理由。
- **新功能优先由维护者实现。** 如果一项能力需要新增一套语义,而不是把 CC 已有的语义接过来,开 issue 描述需求即可,由我们判断该不该做、怎么做。未经确认就提交的实现很可能被拒。
- **需要核对 CC 内部行为时,可以来信索取源码。** 发邮件到 `baoxuanming_2020@qq.com`,说明你想确认的具体问题。从我们手上获取的源码,**用途仅限于语义探测**。用于其他用途并因此受到处罚的,与我们无关,由使用者自行负责。

## 认领任务

issue 就是任务列表,但**认领要写下来**,不是心里想好就开始做。

- **先评论,再动手。** 在你要做的 issue 下留一句:打算做什么、大概什么时候能给 PR。
- **已经有人认领的,不要重复做。** 先翻一遍评论;想接手就在 issue 里和对方商量分工。两个人改同一个文件,两份 PR 只有一份能被合并,另一份的工作就白费了。
- **做不动就回来说一声**,把位置让出来,别让 issue 一直挂着「有人在做」。
- 维护者通常周末才看仓库,当天没回复是正常的。不必干等——按自己的节奏做,有疑问继续在 issue 里问。

## 环境要求

- Node.js >= 20(纯 ESM,无构建步骤,源码直接跑)
- 依赖按包安装:`cd packages/<pkg> && npm install`(包内 peerDeps 声明为 optional)
- 测试:`npm test`(根;详见下文)

## 代码规范

### 通用
- 纯 ESM(`import`/`export`),不用 CommonJS;文件 UTF-8、2 空格缩进(见 `.editorconfig`)
- 每个源文件顶部有块注释说明该模块的职责与 CC 语义依据(参考现有 `src/` 文件)
- 新功能必须带 JSDoc;导出函数说明参数、返回值、抛错与状态分类
- 组件/技能名 kebab-case;变量 camelCase;常量 UPPER_SNAKE

### cordis 插件(适配器包)
- **`apply()` 永不同步抛错**(宿主进程会终止)——全部 try/catch
- **Config schema 全字段带默认值**(宿主在 schema 校验失败时启动失败)
- **waterfall 事件纪律**:只观察/标注的 listener 必须调用 `next()`;pre-execute 是洋葱链,先注册在最外层
- 事件语义先查 DSH 源码再写(`packages/core/*`、`packages/skill/*` 等);不确定就只读研究,不猜
- 宿主 API 缺失时优雅降级(log + 跳过),绝不把宿主当自己的

### 解析层(cc-loader)
- 解析失败一律 warn 不 throw(单个坏文件不能炸掉整个加载)
- 分类优先级与 CC 语义一致(deny > ask > allow 等),改语义必须先核对官方文档;不确定就先问,见上文「尊重 Claude Code 语义」
- 新字段提取进 IR 时,同时更新分类(DIRECT/ADAPTED/UNSUPPORTED)与报告

### 测试
- 测试框架:`node:test` + `node:assert/strict`(不用 vitest/jest)
- 位置约定:
  - 只需 cc-loader 依赖(根可解析)→ 根 `test/*.test.mjs`
  - 需要包自身依赖(`@deepseek-ai/cordis` 等)→ 包内 `packages/<pkg>/test/*.test.mjs`
- 临时目录模式:`mkdtempSync` + `try/finally` cleanup(参考 `test/plugin.test.mjs`)
- 每个修复/功能带测试;跑全量:`npm test`(当前 153+ 用例)

### 提交与 PR
- Conventional Commits:`feat:` `fix:` `docs:` `chore:` `test:` `refactor:` `revert:`
- 提交信息说明"为什么",不只"改了什么"
- PR 分支从最新 `main` 切出;PR 描述:问题 / 方案 / 测试结果 / 端到端验证记录
- 合并前 CI 必须绿;改动涉及发布元数据时 `npm pack --dry-run` 验证
- 涉及 npm 发布顺序:`dsh-cc-loader` 先发(其余包 `^0.1.0` 依赖它)

## 端到端验证(合并前提)

单元测试和 CI 只能证明代码在 fixture 上成立,证明不了这个包在你的 DSH 里真的挂上了、真的在起作用。所以**只跑过单元测试的 PR 不会被合并**。

每份 PR 里写清四件事:

1. **设备与系统**:机型 + 系统版本,例如 `Windows 11 23H2 (22631)`、`macOS 15.1 (M2)`
2. **DSH 版本**:DSH 启动页可见
3. **包版本与挂载方式**:registry 上的发布版(写明版本号),还是 `file:///` 指向本地 checkout
4. **操作步骤与实际结果**:你做了什么、看到什么

涉及界面的改动附截图;纯行为改动贴终端输出或日志片段。**截图请遮掉个人信息**——项目路径、对话内容、token。

本地 checkout 怎么挂进 DSH,见各适配器 README 里的 `cordis.patch.yml` 片段(如 `packages/cc-hooks/README.md`、`packages/cc-mcp/README.md`、`packages/cc-memory/README.md`)。挂上之后**必须重启 DSH**才生效;改完不重启就下结论,是这个生态里最常见的误判来源。

### 关于 AI 参与的代码

AI 写的代码可以接受,与手写的按同一套标准验收,不必特别声明。条件只有一个:**你对结果负责**——你亲手跑过上面这套验证,维护者追问时你能解释这段改动为什么成立,出了问题你回来修。

### 没法端到端验证时

可以合并,但要在 PR 里先说明:哪部分没验、为什么没验(例如只能在 CI 的 Linux 上覆盖、需要特定硬件、依赖尚未发布的宿主版本)。由维护者补验,并在合并前记录结果。**不要用「本地跑通了」代替没做过的验证。**

## 文档策略

- `docs/` 是**内部工作文档,gitignored,不提交**(含恢复快照、研究笔记)
- 公开文档:根 `README.md` + 各包 `README.md`
- 新包必须带 README;新配置项同步更新对应 README 表格

## CI / 发布

- `.github/workflows/ci.yml`:每次 push/PR 在 Ubuntu 与 Windows 上跑单元测试(Node 20 与 22,共四条)
- `.github/workflows/release.yml`:打 `v*` tag 触发 npm 发布 8 包(按依赖顺序,`dsh-cc-loader` 最先、`dsh-cc-ecosystem` 最后;需仓库 Secret `NPM_TOKEN`,granular token 需覆盖全部 8 个包 + 2FA bypass)
- 本地预检:`npm test` + `npm run check` + 需要的 `npm pack --dry-run`

## 提问

改动前想确认方向,开 issue 或 PR 里问。核心原则:**读源码、尊重 CC 官方语义、不破坏零写路径**。
