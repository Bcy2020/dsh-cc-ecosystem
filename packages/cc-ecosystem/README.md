# dsh-cc-ecosystem

One install brings the whole [dsh-cc](https://github.com/Bcy2020/dsh-cc-ecosystem) ecosystem into a DSH profile: the shared parse layer plus all five Claude Code adapters, mounted in a single profile layer.

把整个 dsh-cc 生态装进一个 DSH profile:共享解析层 + 五个 Claude Code 适配器,由**一个 profile 层**全部挂载。

```sh
dsh plugin --profile <name> add dsh-cc-ecosystem
```

Web GUI 里粘贴包名同样有效。

## 它挂载什么

| 包 | 作用 |
|---|---|
| [dsh-cc-loader](https://www.npmjs.com/package/dsh-cc-loader) | 共享解析层(`.claude` → 内存 IR)。**纯库,不挂载任何插件行** —— 它只是被其余五个包 import |
| [dsh-cc-skills](https://www.npmjs.com/package/dsh-cc-skills) | 技能 / 斜杠命令 / rules |
| [dsh-cc-permissions](https://www.npmjs.com/package/dsh-cc-permissions) | CC 权限规则(deny → ask → allow)强制 |
| [dsh-cc-agents](https://www.npmjs.com/package/dsh-cc-agents) | `.claude/agents` 子代理 + `cc_agent` 派发 |
| [dsh-cc-hooks](https://www.npmjs.com/package/dsh-cc-hooks) | 全部五类 CC hooks |
| [dsh-cc-mcp](https://www.npmjs.com/package/dsh-cc-mcp) | CC MCP 配置 + `/mcp` 管理面板 |

## 为什么需要单独一个包

DSH 的 `dsh plugin` 把 `dsh.profile.bundles` 与 **profile 自己的直接依赖**对账 ——
依赖的依赖(transitive)不会加入 `bundles`,它们的 patch 也永远不会被加载。装
`dsh-cc-ecosystem` 时,五个适配器都是它的传递依赖,所以**只有这个包自己的 patch 能挂载它们**。

因此本包的 `cordis.patch.yml` 里那五行是各适配器自身 patch 的**副本**。两份配置会各自演化,
所以 [test/umbrella.test.mjs](../test/umbrella.test.mjs) 逐行比对二者,任何一处 config 漂移
都会让测试失败(已做变异验证:改动一个值即可让该断言失败)。

想只装其中几个,仍然直接装对应的包 —— 每个适配器自己也是合法的 bundle。

## 兼容性

与家族其余包一致:**DSH `0.1.5-rc.2` 与 `0.2.0-rc.2` 双宿主**。

本包自身不声明 `dsh-*` peer:适配器的兼容性由宿主的 `bundleComponentManifests` 顺着 patch
里插入的行逐个读出并校验,所以这里再加一道闸只会产生第二份、可能互相打架的判定。

## License

MIT
