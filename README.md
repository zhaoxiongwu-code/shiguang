# 时光 · 网页收藏到 GitHub

一个 Chrome / Edge 扩展：把当前网页的**文字和图片**存进你的 GitHub 仓库，
每篇一目录，同时生成 Markdown 和可离线打开的 HTML。

![图标](icons/icon128.png)

## 保存出来的样子

收藏一篇《时间》会在仓库里生成：

```
2026-10-31-时间-103045/
├── index.md        ← 标题、来源、时间、标签 + 正文（图片走 assets/）
├── index.html      ← 单文件存档，离线可开
└── assets/
    ├── 001.png
    ├── 002.jpg
    └── …
```

`index.md` 开头是这样的：

```markdown
# 时间

- 来源：<https://zh.wikipedia.org/wiki/时间>
- 收藏时间：2026-10-31 10:30:45
- 标签：`待读` `物理`
- 网页存档：[index.html](index.html)

---

正文从这里开始…
```

## 安装

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选中本目录（含 `manifest.json` 的那一层）

## 配置

点击扩展图标 → 「设置」，按提示填：

| 字段 | 说明 |
| --- | --- |
| 访问令牌 | Fine-grained token，只需勾选这一个仓库 |
| 仓库 | `https://github.com/你的用户名/shiguang` |
| 分支 | 一般 `main` |
| 子目录 | 可选。留空则归档目录放在仓库根目录 |
| 保存图片 | 关掉后只保留图片外链 |
| 保存 HTML | 关掉后只提交 `index.md` |
| 默认标签 | 每次收藏会被写进 front matter，可在弹窗里临时改 |

### 创建令牌

1. 打开 [Fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
2. **Repository access** → `Only select repositories` → 勾选 `shiguang`
3. **Permissions → Repository permissions → Contents** → `Read and write`
4. 生成后复制，粘进设置页

令牌只存在 `chrome.storage.local`，不会同步到别的设备，也不会发往 GitHub 以外的地址。

## 使用

打开任意网页 → 点扩展图标 → 「保存到 GitHub」。

- 页面标题、正文、列表、引用、代码块、表格、链接都会保留
- 导航栏、页脚、侧边栏、广告、「编辑」这类噪音会被剔除
- 懒加载图片会被识别（`data-src` / `srcset`）
- 图片按内容而不是后缀判断真实格式（换 CDN 后 `.jpg` 其实是 webp 也能纠正）
- 图片有防盗链时自动带 `Referer` 重试
- 下载失败的图片保留原始外链，收藏不会因此失败
- 一次收藏 = 一个 commit（Git Data API 批量写入），不会刷屏

## 开发

```bash
npm install
npm test                 # 12 项测试：抽取、渲染、GitHub 提交流水线
npm run icons            # 重新生成图标
node tools/try-extract.mjs <url>   # 在 Node 里试跑抽取，看 Markdown 预览
```

### 代码结构

```
manifest.json
src/
  background.js            service worker：编排抓取 → 下载 → 提交，播报进度
  popup.html / popup.js    弹窗：预览标题、填标签、显示进度与结果
  options.html / options.js 设置页：令牌、仓库、开关
  shared/
    page-extractor.js      注入网页执行的抽取函数（必须自包含，无外部引用）
    render.js              document model → Markdown / HTML
    save.js                图片下载、文件名、目录名、saveSnapshot 主流程
    github.js              Git Data API 封装 + commitFiles
    settings.js            chrome.storage 读写、仓库地址解析
tests/extract.test.mjs     jsdom 里跑注入函数 + 假 GitHub 做端到端
tools/                     图标生成、手动试跑
```

### 为什么抽取逻辑放在注入函数里

MV3 的 `chrome.scripting.executeScript({ func })` 只序列化函数体本身，
函数里引用的外部变量不会跟着走。所以 `page-extractor.js` 里的
`pageExtractor()` 是一个自包含的闭包，把全部辅助函数都写在里面。
测试时用 jsdom 把同一个函数 `eval` 出来跑，保证测试和线上是同一条代码路径。

### 为什么用 Git Data API

逐文件调 Contents API 会产生 N 个 commit。这里先并行创建 blob，再建一棵 tree，
再建一个 commit，最后推 ref——一次收藏只留一条提交记录。

## 已知限制

- 无法用于 `chrome://`、扩展商店、PDF 阅读器等禁止注入脚本的页面
- 需要登录或滚动懒加载的页面，请先滚动到想保存的位置再点保存
- 单次收藏请求量较大时（图很多）可能碰到 GitHub 速率限制，稍等再试
- 不抓取视频、iframe 内容

