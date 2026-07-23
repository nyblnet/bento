<p align="center">
  <a href="https://bento.page" title="bento.page——在浏览器中试用">
    <img src="docs/assets/bento-logo.svg" alt="Bento" width="96" height="96">
  </a>
</p>

# [Bento——装进一个文件的办公套件](https://bento.page/)

[English](README.md) · 简体中文 · [日本語](README.ja.md)

**这个 PowerPoint 替代方案就是一个 HTML 文件。** 每份 Bento 演示文稿都在文档中
自带查看器、演示器和编辑器——用任意浏览器打开，即可编辑、演示和发送。接收者
什么都不需要安装：文件本身*就是*软件。

**10 秒上手：**打开 [bento.page/slides](https://bento.page/slides)——这就是完整的
应用，它会运行一份入门演示文稿，同时也是功能导览。你也可以从
[模板库](https://bento.page/) 获取精心设计的模板，再按需修改。

**下载应用：**从 [GitHub Releases](https://github.com/nyblnet/bento/releases) 页面
下载单个 `Bento_Slides.bento.html` 文件，或直接前往
[bento.page](https://bento.page/releases/slides/Bento_Slides.bento.html) 下载
（约 560 KB，无需账号，无需安装程序）。用任意现代浏览器打开，它*就是*
编辑器。保存时，文件会将你的演示文稿写回自身。

## 为什么要做 Bento

办公文档曾经是你真正*拥有*的东西，如今却变成了租用的服务——锁在别人的云端，
藏在别人的登录界面之后，而且只有在某家公司保持服务器运行时才能读取。Bento
选择了另一条路：

- **一个文件，永久可用。** 演示文稿、字体、图片、图表、动画和完整编辑器
  全部随文件同行。2026 年创建的副本，到 2036 年仍然可以打开。
- **源码透明。** 数据位于文件顶部一个明文、可读的 JSON 块中。没有二进制格式，
  没有厂商锁定，也不必进行格式考古。
- **自行保存。** 保存时，文件会重写自身的数据块（优先使用 File System Access API，
  并提供下载回退方案）。永远无需安装应用。
- **本地优先，而且可以验证。** 开启离线模式后，任何内容都不会离开你的设备——
  更新和协作会被硬性禁用，应用也会明确告知这一点。

## 包含哪些功能

| 功能 | 说明 |
|---|---|
| **形变演示** | 共享同一 id 的元素可在幻灯片之间产生动画——位置、大小、颜色，甚至渐变都能过渡。复制一张幻灯片并重新排列元素，动效便会自动形成。 |
| **实时协作** | 使用 E2EE（AES-GCM），密钥只存在于你的文件中，绝不会存放在服务器上。文件本身就是邀请：任何打开副本的人都能加入。离线编辑可以精确合并回来——其中包括项目自研的 CRDT 和字符级文本合并。 |
| **盲中继** | 可选的同步中继（[`server/sync-worker/`](server/sync-worker/)）只存储密文，无法获知内容。源码就在这里，而且只涉及一个文件。 |
| **内置图表** | 柱状图、折线图、饼图和散点图由项目自研的零依赖引擎绘制，并可在演示期间实时交互：支持工具提示、缩放，以及柱状图变成饼图时的数据形变动画。 |
| **为 AI 而设计** | 文档在文件中以明文 JSON 存储，因此代理可以就地编辑 `.bento.html` 文件，聊天机器人也可以往返处理 JSON（`window.bento.loadDoc`）。参见 [docs/agents.md](docs/agents.md)。 |
| **签名自更新** | 发布版本经 ECDSA 签名并在应用内提供。更新会写入一个*新*文件，旧文件则保留作为回滚点。服务器永远不会接触你的文档。 |
| **其他功能** | 演讲者视图、评论、版式、隐藏交互状态、悬停显示、运动路径、PDF 导出、页面尺寸和 8 种界面语言——全部装在约 560 KB 的外壳中。 |

## 与 AI 配合使用

文档是位于文件顶部附近一个明文块中的普通 JSON，因此任何能读写文件的助手都可以
编辑你的演示文稿——无需插件，也无需 API。有两种使用方式：

- **文件操作型工具**可就地编辑 `#bento-doc` JSON：
  [Claude Code](https://claude.com/claude-code)、Cursor、Aider，或任何能够访问
  文件系统的代理。Claude Code 用户还可使用打包好的 `bento-slides` Skill（可从
  本仓库的插件市场安装：`/plugin marketplace
  add nyblnet/bento`），它甚至能自行下载最新的 Bento 应用。
- **聊天往返处理**适用于任何聊天机器人：复制文档 JSON（*About → Copy document
  JSON*），让助手重写内容，再粘贴回来。

**使用本地开放权重模型时也能完全离线运行**——让 [Ollama](https://ollama.com)、
llama.cpp 或 LM Studio 处理演示文稿，任何内容都不会离开你的设备。代理指南只有一页，
可以直接放进任意模型的上下文中：[bento.page/agents.md](https://bento.page/agents.md)
（仓库内也有一份：[docs/agents.md](docs/agents.md)）。

## 一段话了解架构

`slides/src/model.ts` 定义 JSON 文档模型；单一渲染器（`render.ts`）负责编辑器画布、
缩略图和演示模式的绘制（Reveal.js 负责导航；形变根据模型计算，而不是 DOM）。动画使用
自研引擎（`anim.ts`），图表同样由项目实现（`charts.ts`），协作则采用自研 CRDT
（`sync/crdt.ts`——纯数据，并通过 `scripts/test-sync.ts` 进行数十万次收敛模糊测试）。
外壳压缩后约为 560 KB，文档块保持明文，因此旧文件和外部工具始终可以对其进行拼接。
深入介绍见 [docs/architecture.md](docs/architecture.md)。

## 坦诚说明安全模型

- 协作密钥在创建文档时由客户端生成，并且只存在于文件中。持有文件就等于拥有成员资格；
  “Rotate keys”即撤销访问权限。
- 中继能够看到密文、连接时间和房间密钥的哈希值，但无法读取内容、姓名或结构。
- 在线状态中的姓名只是声明，并非身份证明——在共享密钥的房间中足够使用；企业身份
  则需要签名帧（已设计，尚未实现）。
- 更新检查只获取静态清单，不会发送任何与你或文档有关的信息。应用内会验证签名、
  哈希值和版本单调性。
- 已知权衡：实时协作中的撤销基于快照，可能会恢复协作者对同一属性的并发编辑；编辑体验
  以桌面端为先（手机端适合查看和演示）。

## 从源码构建

只需 Node 20+ 和 npm——该应用采用单页构建，不需要启动后端。

```bash
cd slides
npm install
npm run dev            # dev server (http://localhost:5173)
npm run build:single   # → dist-single/Bento_Slides.bento.html (the product)
```

`node scripts/test-sync.ts` 用于运行 CRDT 收敛测试。发布版本在本地构建，确保签名密钥
永远不会离开维护者的设备——参见 [docs/RELEASING.md](docs/RELEASING.md)。

## 延伸阅读

- [CLAUDE.md](CLAUDE.md)——深入的架构与开发指南（也是 AI 代理在本仓库中工作时
  阅读的文档）。
- [docs/architecture.md](docs/architecture.md)——`.bento.html` 文件的构建方式、
  磁盘格式和运行时布局。
- [docs/format.md](docs/format.md)——规范性的 `bento/slides` 文档模型说明（涵盖每种
  元素类型、幻灯片/状态/版式结构和协作字段）。
- [docs/collab-design.md](docs/collab-design.md)——CRDT、E2EE 中继和签名写入 RBAC
  的设计与威胁模型。
- [docs/agents.md](docs/agents.md)——面向 AI 代理的文档格式说明。
- [CHANGELOG.md](CHANGELOG.md)——版本历史。
- **目录结构：**`slides/` 是应用（源码位于 `slides/src/`）；
  `server/sync-worker/` 是盲中继；`docs/` 和 `scripts/` 包含指南与构建工具。

欢迎贡献——请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。发现安全问题？请参阅
[SECURITY.md](SECURITY.md)。

## 路线图

**Bento/Slides** 是 Bento/Suite 的首个应用——一款已经推出的 PowerPoint 替代方案。
后续将推出 **Docs**（`bento/docs`）和 **Sheets**（`bento/sheets`），每个应用都将以
独立、完备的 `.bento.html` 文件发布。当前版本位于 [bento.page](https://bento.page)，
并通过签名更新通道覆盖所有现有文件。

## 许可证

Bento 是采用 [MIT 许可证](LICENSE)的开源软件——这里的所有软件均采用 MIT 许可证，
© 2026 The Bento/Suite authors。随附的运行时组件（Reveal.js、Moveable、Selecto）采用
MIT 许可证；嵌入字体（Fraunces、Instrument Sans）采用 OFL；模板库图片属于公有领域
（参见 `scripts/gallery-photos/SOURCES.md`）。每个组件均保留各自的许可证。
