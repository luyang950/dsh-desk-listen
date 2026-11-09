# dsh-desk-listen

[中文](#中文) · [English](#english)

---

## 中文

把工位股市的「一起听」搬进 DeepSeek Harness（DSH）的**会话流里**：输入 `/listen`，一张看起来像普通回复的卡片出现在这一轮，跟房间里的人同步听歌、点歌、聊天。**不进模型上下文、不产生任何 token**，游戏服务器也不用改。

适配 DSH `>=0.2.1-0 <0.3.0-0`（在桌面版 0.2.2-rc.1 运行时的 Web UI 上实测）。

### 特性

- **长在会话里**：卡片是一个自定义 chat node，位置就是 `/listen` 那一轮；平时只有一行小字歌名、一行当前歌词和聊天记录，鼠标移上去才浮出按钮。
- **零 token**：`/listen` 只产生只写日志的 `command/run` / `command/done`，结果只有房间号和房间名。
- **和房间同步**：按游戏服务器的时钟对位置（先测时钟差，偏 0.5 秒以上直接跳，偏一点就 0.97/1.03 倍速追上），和网页版一起听的做法一样。
- **切会话不断歌**：播放器是整个页面一份，不属于哪张卡片；切到别的会话照样放，回来卡片接着显示。
- **在卡片里打字**：
  - 直接打字回车 = 在房间里说话
  - `/点 歌名`（或 `/搜`）搜歌，结果里点「点歌」或「下一首」
  - `/切` 切歌（房主或点歌的人）、`/停` `/放` 暂停继续（房主）、`/队列` 看队列（可置顶、删自己点的）、`/静音`、`/离开`
- **老板键**（默认 `Ctrl + Alt + M`，可改）：所有卡片折叠成一行 `···`，内容**从 DOM 移除**；设置里可以让它同时静音。刷新后保持。
- **会话名不显眼**：在新会话里 `/listen` 后，会话默认叫「随手记」（可改成「整理周报」之类），并且常驻侧边栏（跑一个被拒掉的空轮次，不调用模型）。
- **继续听**：侧边栏 **More** 菜单顶部有「继续听 · 房间名」，一点回到那个会话；老板键模式下隐藏。

### 用法

```
/listen            # 打开卡片：在房间里就接着听，不在就列出房间（也可以开新房间）
/listen 3          # 进 3 号房间
/listen 摸鱼       # 进名字里有「摸鱼」的那个房间
```

第一次用：卡片里（或 设置 → 一起听）填游戏服务器地址（`http://地址:端口`）、账号、密码登录。

### 登录和安全

- 插件在 DSH 的本机进程里替你登录游戏，**只保存游戏发的会话 cookie**（`$DSH_HOME/dsh-desk-listen/account.json`，权限 0600），密码不落盘。退出登录会同时让游戏那边注销这个 cookie。
- 游戏那边看起来就像多了一台登录设备；网页版一起听照常用，两边是同一个账号同一个房间。
- 插件只转发到游戏的 `/api/mods/listen/*`（一起听的接口）和 `/api/mod-media/listen/*`（房间正在放的歌），别的接口一律不碰。
- 写操作要带插件自己的请求头，并且拒收其他网站的 Origin，所以别的网页没法借你的登录在房间里说话。
- 游戏的 https 地址用的是内网 CA，Node 不认，**请用 http 地址**（30418 那个端口）。

### 安装

**命令行（Web 版 profile）：**

```bash
dsh plugin --profile web add github:luyang950/dsh-desk-listen
```

本地开发可以 `add link:/绝对路径/dsh-desk-listen`。安装后重启 `dsh web`。

**桌面版：** 左侧 **Plugins** 页用 GitHub spec 安装，按提示重启。

预构建分发：没有构建脚本、没有 TypeScript。

### HTTP 接口

前缀 `/dsh-desk-listen/`，统一返回 `{ ok, ... }` 或 `{ ok:false, error }`。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `api/status` | GET | 配置、登录的账号 |
| `api/config` | GET / POST | 读取 / 局部更新配置 |
| `api/login` | POST `{server,username,password}` | 登录游戏，只留 cookie |
| `api/logout` | POST | 退出登录 |
| `api/sessions` | GET / POST `{forget}` | 打开过卡片的会话 |
| `api/game/<路径>` | GET/POST/PUT/DELETE | 转发到游戏的 `/api/mods/listen/<路径>`，返回 `{ ok, data }` |
| `media/<歌曲 id>` | GET / HEAD | 房间正在放的歌，带 Range |

POST/PUT/DELETE 都要带 `x-dsh-desk-listen: 1`。

### 开发

```bash
npm test        # node --test，零依赖
```

测试用一个假的工位股市（登录、版本号、Origin 校验、一起听接口、带 Range 的音频）覆盖登录只存 cookie、转发带的 cookie/Origin/两个版本号、游戏更新后自动重试、登录过期清 cookie、写操作防护、`/listen` 解析房间，以及前端 bundle 的加载契约和 `/listen` 折叠成卡片。

```
index.mjs           host 半边：/listen 命令 + 路由
lib/game.mjs        以玩家身份调游戏：登录、转发、音频
lib/store.mjs       config / account / sessions
lib/session.mjs     /listen 后用空轮次让会话常驻侧边栏、起标题
lib/client.js       client 半边（ModuleLoader bundle，仅依赖 react）
```

---

## English

工位股市's 「一起听」 (listen-together rooms) inside the DeepSeek Harness transcript. `/listen` drops a card that reads like an ordinary reply into the conversation: hear the room's song in sync, pick songs, chat — zero tokens, no change to the game server.

- Sign in once (card or Settings → 一起听); only the game's session cookie is stored (0600), never the password. Use the game's http address.
- In the card: type to chat; `/点 <title>` to search and pick; `/切` skip, `/停` `/放` pause/resume, `/队列` queue, `/静音`, `/离开`.
- One player per page: music keeps playing across Sessions. The boss key (`Ctrl+Alt+M` by default) folds every card to `···` and can also mute.
- Calls go only to the game's `/api/mods/listen/*` and `/api/mod-media/listen/*`; writes need the plugin's own header and a same-site Origin.

```bash
dsh plugin --profile web add github:luyang950/dsh-desk-listen
npm test
```

## License

MIT
