# AI 人 · 人扮 AI 双人文字聊天

一个轻量 Web 应用：一方以「问 AI」的方式提问，另一方以「AI」身份回复。双方都清楚对面是真人，「AI 人」可以用 AI 口吻逗对方。系统负责在线匹配、会话粘性分配，并持久化问答记录。

基于 [PRD](docs/prd-human-ai-chat.md) 实现。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 HTML / CSS / JS（无构建步骤） |
| 后端 | Cloudflare Worker + Durable Objects（TypeScript） |
| 实时通信 | WebSocket（Durable Object 原生支持） |
| 持久化 | Durable Object SQLite |
| 部署 | Cloudflare Pages + Workers（免费档） |

## 功能

- **双角色入口**：首页选择「我要提问」或「我要扮 AI」
- **在线匹配**：提问者首问随机分配给在线 AI 人
- **会话粘性**：同一 session 的追问优先保持同一 AI 人
- **离线重分配**：绑定 AI 人离线后，追问自动分配给其他在线 AI 人
- **排队等待**：无 AI 人在线时，提问进入 FIFO 队列，有人上线后自动分配
- **消息持久化**：刷新页面后可恢复当前 session 历史记录
- **心跳保活**：30s 心跳，90s 超时自动标记离线
- **匿名昵称**：自动生成，可修改
- **多会话并发**：AI 人最多同时处理 5 个会话

## 快速开始

### 前置要求

- Node.js 18+
- npm 或其他包管理器

### 安装

```bash
cd fake-ai
npm install
```

### 本地开发

```bash
npm run dev
```

Wrangler 会在 `http://localhost:8787` 启动本地开发服务器，支持 Durable Objects 和 SQLite。

打开两个浏览器标签页（或一个普通窗口 + 一个无痕窗口）：
1. 标签 A → 点击「我要扮 AI」→ 打开「在线」开关
2. 标签 B → 点击「我要提问」→ 发送消息 → 即可收到回复

### 部署

```bash
npx wrangler deploy
```

部署后会得到一个 `*.workers.dev` 域名，可直接使用。

如需绑定自定义域名，在 Cloudflare Dashboard 中配置。

## 项目结构

```
fake-ai/
├── src/
│   ├── index.ts          # Worker 入口，路由 + WebSocket 升级
│   ├── chat-lobby.ts     # Durable Object：匹配、会话、WebSocket 管理
│   └── types.ts          # 共享类型定义
├── public/               # 前端静态资源
│   ├── index.html        # SPA 入口
│   ├── style.css         # 样式（暗色主题）
│   └── app.js            # 前端逻辑（WebSocket 客户端 + 视图渲染）
├── wrangler.toml         # Cloudflare 配置
├── package.json
├── tsconfig.json
└── README.md
```

## 核心流程

### 提问与分配

```
提问者发送消息
  → 若为 session 首问：创建 session，随机分配在线 AI 人
  → 若为 session 追问：优先分给已绑定的 AI 人（粘性）
  → 若绑定 AI 人已离线：重新分配，提示「对接人已更换」
  → 若无人在线：进入等待队列
```

### AI 人上线

```
AI 人上线
  → 标记在线
  → 检查等待队列，按 FIFO 顺序领取待处理会话
  → 推送历史消息
```

## 限制与约定

- 消息长度上限：2000 字
- 数据保留：7 天后自动清理
- AI 人并发会话上限：5
- 身份：本地生成 clientId + 昵称，无登录
- 离线消息：不补发（仅在线推送），历史仍可查

## 许可

MIT
