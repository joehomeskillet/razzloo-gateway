<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%9B%B0%EF%B8%8F%20Razzoozle%20Gateway-rendezvous%20%C2%B7%20discovery-8B5CF6?style=for-the-badge&labelColor=1f2430" height="56" alt="Razzoozle Gateway" />

# Razzoozle Gateway

### 面向 Razzoozle Desktop 的会合 / 发现服务（`gw.razzoozle.xyz`）——它帮助玩家的手机在同一局域网之外**找到**桌面主机。

🌐 [English](README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Italiano](README.it.md) · **中文**

[![Status: Beta](https://img.shields.io/badge/status-beta-F59E0B.svg)](#-状态)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-8B5CF6.svg)](#-鸣谢与许可)

**[🖥️ Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** · **[🎮 Razzoozle](https://github.com/joehomeskillet/Razzoozle)** · **[报告问题](https://github.com/joehomeskillet/razzloo-gateway/issues)** · *服务于 [Razzoozle](https://github.com/joehomeskillet/Razzoozle)，从 [Ralex91/Razzia](https://github.com/Ralex91/Razzia) 分叉*

</div>

---

## 🧩 这是什么？

**Razzoozle Gateway** 是 [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop) 背后那个小巧、始终在线的**会合 / 发现服务**。当主机在自己的 PC 上运行实时问答时，同一 Wi-Fi 下的手机可以**直连**它——但处在另一个网络中的手机首先得**找到**主机在哪里。这正是网关的唯一职责。

它把一个简短的**加入码**映射到主机的**连接候选**（主机声称可达的那些地址），并把它们交给手机，让手机**直接导航到主机**并直连。

> 这是**发现服务**，不是游戏本身。它是一个极小的公共目录——**不是**玩游戏的地方。

---

## ✅ 它做什么——以及**不**做什么

整个设计都围绕一条硬性规则：**仅做发现**。

- ✅ **把加入码映射到主机候选。** 主机注册一个会话；网关生成一个加入码 + 主机令牌，并存储主机所声明的候选端点。
- ✅ **让手机直连。** 它把这些候选提供给加入的玩家，使手机**直接导航到主机自身的源（origin）**并进行点对点连接。
- ✅ **跟踪存活性。** 主机心跳让会话保持 `online`；过期会话会被清除（短 TTL）。
- ✅ **回答更新闸门。** 它为桌面客户端返回一个 `go` / `hold` 决策（一个终止开关 + 分阶段发布点）——这是一个**决策**，而非下载。
- ❌ **不中继游戏。** 它从不中继或代理游戏——**没有 TURN，没有 WebSocket 代理**。手机 ↔ 主机的连接是直接的；网关**不在**这条路径上。
- ❌ **不保存游戏数据。** 它**不**存储任何问答、题目、答案、分数、玩家、排行榜或游戏状态——只有短暂的会话与候选元数据，并且**会话会过期**（短 TTL）。
- ❌ **不托管二进制文件。** 更新路径**不**托管也**不**重定向任何文件；客户端自行直接从 GitHub 获取发布版本。

被攻破的网关可以扰乱**发现**（拒绝或误导），但它无法读取或篡改任何一条游戏答案，因为游戏数据从不流经它。

```
工作原理

(A) 同一 Wi-Fi —— 简单情形，零配置

    player phone  ──── join code / QR ───►  Razzoozle Desktop
                  ◄──────── game ─────────►  (host · your PC :7777)
                                             测验数据从不离开你的局域网

(B) 手机在另一网络 —— 通过网关进行可选（opt-in）发现

    1) Razzoozle Desktop ──register CODE + addresses──►  Gateway (gw.razzoozle.xyz)
    2) phone   ──open  gw.razzoozle.xyz/j/CODE────────►  Gateway
    3) phone   ◄──────── host addresses ──────────────   Gateway
    4) phone   ═════════ connects DIRECT to host ═══════►  Razzoozle Desktop

    网关只把 CODE -> 主机地址做映射。它不保存任何游戏数据，
    也从不中继游戏 —— 一旦手机拿到地址，它便退到一旁。
```

---

## 🔒 安全态势

- **严格的候选 URL 白名单。** 候选 URL 在写入时即被校验：仅 `http`/`https`，**仅 host:port**（不含 userinfo、路径、查询或片段），其中 `lan` 候选必须是真正的 RFC1918 / 链路本地 / 唯一本地地址，而公网候选必须为非私有地址。
- **无服务端探测（无 SSRF）。** 网关**从不**抓取、ping 或解析候选 URL。它把它们当作不透明字符串——所有可达性测试都在**客户端、在玩家的浏览器中**进行。整个服务中任何地方都没有出站 HTTP 客户端。
- **按 IP 限流 + 锁定。** 每个端点都按来源 IP 限流，反复失败的加入查找会触发临时锁定。
- **高熵主机令牌。** 主机令牌是一个高熵密钥，只以 **sha256 哈希**存储，以常量时间比较，在注册时**仅显示一次**，并且**绝不**被任何读取端点回显。
- **无加入码探测信道。** 错误的码与已过期的码返回**完全相同**的 `404`——不存在「存在 vs 已过期」的旁路信道。
- **加入页的严格 CSP。** `/j` 页面发送严格的 Content-Security-Policy（无 `unsafe-inline` 脚本）、`nosniff`，以及一种 fail-closed 的 CORS 态势。

完整细节见 [`docs/protocol.md`](docs/protocol.md) 与 [`docs/threat-model.md`](docs/threat-model.md)。

---

## 📡 端点

全部位于 `/api/v1` 前缀下（协议版本 `1`）。

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `POST` | `/api/v1/sessions` | — | 注册一个主机会话；返回加入码 + 主机令牌。 |
| `PATCH` | `/api/v1/sessions/:id` | 主机令牌 | 心跳和/或更新候选。 |
| `DELETE` | `/api/v1/sessions/:id` | 主机令牌 | 拆除一个会话。 |
| `GET` | `/api/v1/join/:code` | — | 把加入码解析为其主机候选。 |
| `GET` | `/j/:code` | — | 面向人的**加入页**。 |
| `GET` | `/api/v1/update/:channel` | — | 桌面**更新闸门**决策（`go` / `hold`）。 |

---

## 📖 运行与部署

**Node.js 22+** 与 **TypeScript**（Fastify）。无数据库——会话保存在内存中并会过期。

```bash
npm install
npm run build          # tsc -> dist/
node dist/server.js    # 默认监听 127.0.0.1:8787
```

### 🐳 Docker

```bash
docker compose up -d   # 使用随附的 Dockerfile + compose.yml
```

### 🌐 置于 Caddy 之后

在生产环境中，该服务运行在 **Caddy** 之后，域名为 `gw.razzoozle.xyz`，以提供 TLS 与公共主机名——参见 [`Caddyfile.example`](Caddyfile.example)。运维说明（TTL、环境变量、终止开关）见 [`docs/operations.md`](docs/operations.md)。

---

## 🚦 状态

**Beta——开发进行中。** 会合 + 更新闸门契约已实现并经过测试；它正与 [Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop) 一同接入，后者的网关会话注册/心跳正逐步落地。

---

## 🔗 相关项目

- **[Razzoozle Desktop](https://github.com/joehomeskillet/razzoozle-desktop)** —— 本网关帮助手机发现的 Windows 桌面应用。
- **[Razzoozle](https://github.com/joehomeskillet/Razzoozle)** —— 桌面应用所运行的自托管实时问答平台。

---

## 📝 鸣谢与许可

Razzoozle Gateway 是 [**Razzoozle**](https://github.com/joehomeskillet/Razzoozle) 项目的一部分，而后者是 [**Ralex91/Razzia**](https://github.com/Ralex91/Razzia) 的一个分叉——衷心感谢上游作者。以 **MIT 许可证**发布；保留 Razzoozle/Razzia 的 MIT 传承。
