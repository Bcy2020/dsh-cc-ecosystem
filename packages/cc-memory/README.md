# dsh-cc-memory

把 Claude Code 的 **auto-memory** 搬进 DeepSeek Harness:`~/.claude/projects/<slug>/memory/` 下的 `MEMORY.md` 索引与按需读取的记忆文件。

发现规则、索引预算与截断语义都对着 Claude Code CLI 2.1.275 的内联源码核对过(见 `src/discovery.js` 顶部注释)。**默认只读**;写入必须显式打开。

## `/cc-memory`:两个开关的面板

在任意会话里输入 `/cc-memory`,弹出一个模态面板:

| 开关 | 开 / 关 | 行为 |
|---|---|---|
| **启用 Memory** | 开 | 注册系统提示段与记忆工具 |
| | 关 | **什么都不注册**:没有系统提示段、没有工具 —— DSH 完全看不到 auto-memory |
| **允许写入** | 关(默认) | 只读:只提供 `cc_memory_list` / `cc_memory_read` |
| | 开 | 可写:**额外**提供 `cc_memory_write` / `cc_memory_edit` |

**第一个开关关闭时,第二个开关置灰**(连 Memory 都关了,读写语义没有意义)。

- 改动**立即生效**,不需要重启 DSH:关掉时注销提示段与工具,打开时重新注册;只读 ↔ 可写只增删写工具。
- 状态持久化到 `$DSH_HOME/cc-memory-state.json`(可用 `statePath` 覆盖),下次启动继续生效。
- `Config` 里的 `enabled` / `mode` 是**首次运行默认值**;一旦面板写过状态文件,状态文件优先。删掉状态文件即可回到 Config 默认值。
- 面板底部会显示:当前模式、状态文件路径与来源、解析到的记忆目录、当前注册的工具。

## 记忆从哪来

1. **`autoMemoryDirectory`**:读 `<cwd>/.claude/settings.local.json`(local)与 `<全局>/.claude/settings.json`(user),local 优先,支持 `~/` 展开。
   **故意不读项目级 `settings.json`**:Claude Code 只有在交互式信任提示通过后才接受项目级路径,DSH 没有这个提示;照抄会让一个签入仓库的配置把记忆目录重定向到任意位置。
2. **默认路径**:`<全局>/.claude/projects/<slug>/memory/`
   - slug = 解析 symlink 后的绝对路径,把所有非 `[a-zA-Z0-9]` 字符替换成 `-`(大小写保留)。Windows 上 `C:\Users\me` → `C--Users-me`。
   - 目录名按**大小写不敏感**回退查找,兼容同一台机器上 `d--project` 与 `D--project` 并存。
   - 超过 200 字符的 slug 按前缀匹配已有目录。
3. `archive/`、隐藏目录、`team/`、`logs/`、`sessions/`、`proposals/` 不参与扫描;`MEMORY.md` 不当作普通记忆。

## 注入

**Memory 说明段逐字取自 Claude Code 2.1.275 的 auto-memory 提示**(`Types of memory` / `What NOT to save` / `How to save memories` / `When to access memories` / `Before recommending from memory` / `Memory and other forms of persistence`),只做四类互通性替换:

1. 工具名:`Write tool` → `cc_memory_write`,`MEMORY.md` 的编辑 → `cc_memory_edit`,并加一句 `cc_memory_list` / `cc_memory_read` 的读取指引;
2. 只读模式:删去保存段,改用 CC 自己的 `If the user asks you to remember something, explain that memory is read-only in this session.`;
3. 目录句里的工具名;
4. `{{placeholder}}` → `{placeholder}`:DSH 的系统提示把 `{{name}}` 当严格变量插值,格式不合法会**直接让整轮失败**,所以模板里的双花括号不能原样保留。返回前还会把任何 `{{` / `}}` 连续花括号折叠成单个,避免记忆正文里的 `{{…}}` 触发同样的错误。

其余句子(包括四类记忆的完整定义与例子、禁止保存清单、`[[name]]` 链接、验证规则)一律照抄,以保证 DSH 写出的记忆文件与索引能被 Claude Code 识别。

索引按 CC 的文件上下文包装注入:

```
Contents of <memoryDir>/MEMORY.md (user's auto-memory, persists across conversations):

<索引原文>
```

**Pinned 记忆**同样照 CC 注入:扫描 frontmatter `metadata.pinned: true` 的文件,按修改时间取最新 **4** 条,去掉 frontmatter 后以

```
# Pinned memories (apply to every conversation)
<pinned-memory path="…">
<body>
</pinned-memory>
```

放在 `MEMORY.md` 之前;正文里的 `<` 会转义成 `<\`,防止提前闭合标签。单条正文同样受 200 行 / 25,000 字符预算约束(警告文案为 `this memory file is …`)。扫描结果缓存 5 秒,写入/编辑记忆会立即失效缓存。

`MEMORY.md` 通过 `ctx.systemPrompt.section()` 进入系统提示,**每次 assembly 重新读盘**(与 Claude Code「每次请求重读」一致)。

- 行数上限 **200 行**、字符上限 **25,000 字符**(按 JS 字符串长度,不是 UTF-8 字节),先到者生效。
- 超限按**整行截断**,并追加一行 `> WARNING: …`,写明被截掉的行数与第一条被截的行 —— 与 Claude Code 的语义一致。
- 索引**按文件原文注入**,不按 `feedback > project > reference > user` 重排:Claude Code 也是原文注入,顺序由索引作者决定。
- 目录解析结果按 cwd 缓存在进程内(Claude Code 同样会 memoize 路径);索引内容不缓存。

## 工具

| 工具 | 模式 | 作用 |
|---|---|---|
| `cc_memory_list` | 只读 + 可写 | 列出记忆文件(名称、描述、类型、修改时间),最多 200 条,新的在前 |
| `cc_memory_read` | 只读 + 可写 | 按相对路径读取一条记忆(含 `MEMORY.md`) |
| `cc_memory_write` | **仅可写** | 新建 / 覆盖一条记忆;自动生成 frontmatter(`metadata.type` / `modified` / 可选 `pinned`) |
| `cc_memory_edit` | **仅可写** | 对一条记忆或 `MEMORY.md` 做字符串替换;自动刷新 `metadata.modified` |

可写模式沿用 Claude Code 的两步法:**先写文件,再用 `cc_memory_edit` 往 `MEMORY.md` 加一行指针**(`- [标题](file.md) — 一句话钩子`)。插件不会替你改索引,也不会碰 `archive/`。

所有路径都被限制在记忆目录内:拒绝绝对路径、`..`、隐藏段、`archive/`、保留目录,以及不以 `.md` 结尾的名字。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | **首次运行默认值**;之后由 `/cc-memory` / 状态文件决定 |
| `mode` | `read-only` | **首次运行默认值**;`read-only` / `read-write` |
| `statePath` | — | 运行时状态文件;空 = `$DSH_HOME/cc-memory-state.json` |
| `enablePanel` | `true` | 是否注册 `/cc-memory` 面板与其 host 路由 |
| `homeDir` | `os.homedir()` | 家目录覆盖 |
| `globalClaudeDir` | `<homeDir>/.claude` | 全局 `.claude` 根 |
| `memoryDirectory` | — | 直接指定记忆目录(绝对路径或 `~/…`),跳过 slug 发现;适合测试或会话 cwd 与目标项目不一致时 |
| `maxIndexLines` | `200` | 索引行数上限 |
| `maxIndexChars` | `25000` | 索引字符上限 |
| `maxFiles` | `200` | 列出条数上限 |
| `maxFileBytes` | `1048576` | 单条记忆读取/扫描上限 |
| `maxPinned` | `4` | 每次注入的 pinned 正文条数上限(0 = 关闭 pinned 注入) |
| `includeArchive` | `false` | 是否把 `archive/` 计入列表(默认不) |

## 挂载

本地路径挂载(推荐,包内的 `cordis.patch.yml` 会作为 bundle 层生效):

```sh
dsh plugin --profile <profile> add <本包绝对路径>
```

也可以在自己的 profile `cordis.patch.yml` 里直接加一行(按包名或 `file:///` 绝对 URL):

```yaml
- insert:
    - id: cc-memory
      name: 'dsh-cc-memory'
      config:
        # 首次运行默认值;之后由 /cc-memory 的状态文件接管
        enabled: true
        mode: 'read-only'
```

挂载/改配置后**重启 DSH**(客户端半个 `/cc-memory` 命令随包一起加载)。之后改开关不用再动 profile —— 用 `/cc-memory` 面板即可,改动立即生效。

`/cc-memory` 依赖宿主提供 `commandUi`(客户端命令)与 `webServer`(面板路由)。两者缺失时插件主体仍可用,面板会显示「面板路由不可用」。

## 与 Claude Code 的两处有意偏离

1. `archive/` 不仅不进索引,也不进 `cc_memory_list`。Claude Code 只是不再索引它;issue 的验收要求归档内容完全不出现。
2. 不读项目级 `settings.json` 的 `autoMemoryDirectory`(理由见上)。其余发现与预算语义照抄 Claude Code。

## 不做什么

- 不实现 Claude Code 的 `autoMemoryEnabled` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY`:**DSH 的 `enabled` 开关是唯一决定项**,避免 UI 显示「开」而实际不生效。
- 除开关状态文件 `$DSH_HOME/cc-memory-state.json` 外,不写记忆目录之外的用户资产;只读模式下本插件**不注册任何写入路径**。DSH 自带的 `write` / `edit` / shell 工具仍由宿主的沙箱与权限规则约束,不在本插件的开关范围内。
- 不注入 `CLAUDE.md`(DSH 原生已有该能力,再注入会重复)。
