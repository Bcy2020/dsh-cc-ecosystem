# Contributing to dsh-cc-ecosystem

感谢你的贡献!这个仓库把 Claude Code 的 `.claude/` 资产与插件加载进 DeepSeek Harness(DSH)。提交 PR 前请读一遍本文。

## 架构速览(改动前必读)

- **内存 IR,零写路径**:`dsh-cc-loader` 把 `.claude`(项目 + 全局)+ 插件(`plugin.json`/`marketplace.json`)解析成内存 IR,不落盘、不写 `.claude`。单一事实来源永远是 `.claude` 原文。
- **适配器只消费 IR**:`cc-skills`/`cc-permissions`/`cc-agents`/`cc-hooks`/`cc-mcp` 各自把 IR 的一个组件映射到 DSH(cordis 插件)。适配器**不直接解析 `.claude` 文件**——解析都在 loader。
- **权限是只读桥**:CC `settings.json` 规则在 DSH 上强制,DSH 侧审批**不写回** `.claude`。
- **不改 DSH 宿主代码(硬约束)**:本生态通过用户 profile 的 `cordis.patch.yml` 以 `file:///` 或 npm 包挂载,依赖 DSH 官方发布包(`@deepseek-ai/*`)只读。任何需要改 `D:\deepseek-harness` 才能工作的改动都不会被接受。
- 组件分类词汇:DIRECT / ADAPTED / UNSUPPORTED / BLOCKED;UNSUPPORTED 与 BLOCKED 不进适配器。

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
- 分类优先级与 CC 语义一致(deny > ask > allow 等),改语义必须先核对官方文档
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
- PR 分支从最新 `main` 切出;PR 描述:问题 / 方案 / 测试结果
- 合并前 CI 必须绿;改动涉及发布元数据时 `npm pack --dry-run` 验证
- 涉及 npm 发布顺序:`dsh-cc-loader` 先发(其余包 `^0.1.0` 依赖它)

## 文档策略

- `docs/` 是**内部工作文档,gitignored,不提交**(含恢复快照、研究笔记)
- 公开文档:根 `README.md` + 各包 `README.md` + `DSHCCECO-INSTALL-SKILL.md`(实装指南)
- 新包必须带 README;新配置项同步更新对应 README 表格

## CI / 发布

- `.github/workflows/ci.yml`:每次 push/PR 跑单元测试(node 20)
- `.github/workflows/release.yml`:打 `v*` tag 触发 npm 发布 6 包(需仓库 Secret `NPM_TOKEN`,granular token + 2FA bypass)
- 本地预检:`npm test` + `npm run check` + 需要的 `npm pack --dry-run`

## 提问

改动前想确认方向,开 issue 或 PR 里问。核心原则:**读源码、尊重 CC 官方语义、不破坏零写路径**。
