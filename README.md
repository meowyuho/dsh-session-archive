# dsh-session-archive

给 DeepSeek Harness 的归档会话一个能管的地方：列出来、恢复、或者彻底删除。

dsh 本身只能归档。官方明确写着 *No Session deletion — sessions can be archived but never deleted*，`sessionPersistence` 只有 `create/open/flush/stat/list`，`ctx.fs` 连删除动词都没有——归档之后再想清掉一个会话，没有出口。这个插件把出口补上。

![设置里的「归档会话」页面](https://raw.githubusercontent.com/meowyuho/dsh-session-archive/main/docs/archived-sessions.png)

## 安装

已发布到 npm。**先把 DeepSeek Harness 完全退出**——应用运行时 profile 的 `package.json` 是被锁住的，命令会拿不到锁：

```bash
dsh plugin --profile desktop add dsh-session-archive
```

profile 不叫 `desktop` 的话，把 `--profile` 后面的名字换掉。不想用命令行，也可以走界面：侧边栏 → **Plugins** → **Add plugin**，填包名。

装完**刷新页面**。以后更新时：只改 `client.js` 刷新页面就够；改了 `index.js`（Host 半边）要重启应用——插件的 Host 模块不会因为重新组合而重新加载。

### 从源码装

clone 下来按目录装。装进去的是 `link:` 依赖，所以目录别装完又挪走：

```bash
git clone https://github.com/meowyuho/dsh-session-archive.git
dsh plugin --profile desktop add link:<clone 下来的绝对路径>
```

路径必须是绝对路径；`link:` 也可以写成 `file:`，或者直接裸给绝对路径。

也可以不 clone，直接按仓库装：

```bash
dsh plugin --profile desktop add github:meowyuho/dsh-session-archive
```

这两种和上面那条一样，都会顺手把它注册进 profile 的 bundle 层栈。本包没有构建步骤，所以不会碰到 git 安装那种 `allowBuilds` 提示。

## 用法

设置 → 左侧导航 → **归档会话**。

- **恢复**：会话回到侧边栏原来的位置。
- **彻底删除**：点行内「彻底删除」，展开一张确认卡片（写明是哪个会话、日志在哪儿），确认之后才动手。卡片可以按 `Esc` 取消。

![彻底删除的确认卡片](https://raw.githubusercontent.com/meowyuho/dsh-session-archive/main/docs/delete-confirm.png)

## 删除会删掉什么

- 会话自己的**日志目录**：`<dsh home>/sessions/<项目目录>/<会话 id>/`。里面可能并存 v0–v4 多个格式世代，所以删的是整个目录，不是某个文件。
- 投影缓存记录：`<dsh home>/storages/session_projcache/sessions/<id>.json`。
- 工作区里的会话占位，以及归档集合、置顶集合里的记录。

不碰：`attachments/` 和它的请求缓存（内容是寻址的，一个对象可能被好几个会话共用，删了会连带弄坏别的会话）、spill 临时文件、会话查询索引、`workspace.json` 整体，以及工作区目录里你自己的文件。

删的过程是三步：**删文件 → 让浏览器重拉一次会话目录 → 最后才移出归档集合**。

顺序不是讲究。如果一次做完，中间会出现一个瞬间：它已经不在归档集合里了，但客户端目录还记着它——侧边栏就会把它画成一行，点开报 `session/not-found`。分三步走，中间那步做完时它仍然处于归档状态，没有任何界面会画它；等身份从客户端清掉之后再移出归档集合，就一帧都不露。任何一步失败都停在可以直接重试的状态。

## 几个要注意的地方

- **排序用的是「最后活动」，不是归档时间。** dsh 的归档集合里只有一个 id 数组，不带时间戳，所以没有真正的归档时间可用。列表按最后活动时间从新到旧排；行尾的「第 N 个归档」才是归档先后。
- **「有活儿在跑」和「在内存里」是两回事。** 能不能删看的是有没有正在进行的 turn / job / subagent / schedule；被加载过、但闲着的会话可以删。早期版本把两者混为一谈，结果一大批本该能删的会话都删不掉。
- **subagent 世系的会话不能单独删**，它的日志归拥有它的那个会话管。
- **正开在主视图里的会话不能删**，先切到别的会话。这是唯一一种「删完可能又被唤醒、把日志重新写出来」的情况，所以在动手前拦住。
- **没有回收站**，删除不可撤销。
- **侧边栏那边插件一点没动。** dsh 默认就隐藏归档会话；宿主的「全部会话（显示已归档）」「仅显示已归档」还是你自己的开关，插件不会把它改回去。
- 日志已经不在、但归档记录还在的行会被标出来，可以直接点删除把登记清干净。

## 实现

- Host 半边就是两个同源路由：`GET /dsh-session-archive/archived`、`POST /dsh-session-archive/delete`。浏览器同源 `fetch`；路由自己带同源校验（Host 必须是回环、Origin 要和它一致，额外放行桌面宿主的 `dsh-app:` 协议），因为宿主 Web carrier 官方声明没有认证和来源策略。
- 删文件直接走 `node:fs`：`ctx.fs` 没有删除动词，`sessionPersistence` 也没有删除 API，而插件本来就跑在 Host 进程里。
- 界面半边没有 import 任何宿主 Client 包（官方插件规范要求），样式照抄宿主、只引用 `--dsw-*` 主题令牌，所以深浅色自动跟随。

## 验证

`_verify-session-archive.mjs` 跟着包一起发布，只依赖 Node 内置模块。它全程把 `DSH_HOME` 指到一个临时目录，不会碰你真实的会话数据：

```bash
node _verify-session-archive.mjs
```

覆盖 bundle 声明、浏览器半边的注册契约、同源与各类拒绝路径、真实的文件删除（在临时 HOME 里核对磁盘结果）、活动判据、分步协议，以及样式只用主题令牌。失败以非零退出码结束。

## 许可

MIT，见 [LICENSE](https://github.com/meowyuho/dsh-session-archive/blob/main/LICENSE)。

---

仓库：https://github.com/meowyuho/dsh-session-archive
