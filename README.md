# dsh-auto-goal-resume

> DeepSeek Harness 插件 —— **DSH 重启后,自动续跑有活跃目标(goal)的会话,无需人工说"继续"。**

当你在 DSH 里让 AI 执行一个长任务(多阶段、跨多轮),中途进程重启或升级后,任务会默认停在原地——因为 DSH 的 goal 系统刻意不持久化"继续执行的授权"。本插件把这个授权步骤自动化:重启后自动扫描、恢复 agent、重新武装目标,让 `goal-round-driver` 无缝接续剩余工作。

---

## 目录

- [背景:为什么需要这个插件](#背景为什么需要这个插件)
- [功能特性](#功能特性)
- [工作原理](#工作原理)
- [安装](#安装)
- [验证与日志](#验证与日志)
- [端到端测试示例](#端到端测试示例)
- [安全与限制](#安全与限制)
- [常见问题 FAQ](#常见问题-faq)
- [许可证](#许可证)

---

## 背景:为什么需要这个插件

DSH 的 goal 系统(同会话目标)把**目标本身**——目标文本、生命周期阶段(active / paused / blocked / complete)、已跑轮次——作为 `goal/change` 事件持久化到会话日志。这部分跨重启存活。

但**"继续执行的授权"(activation)永不持久化**,这是刻意的安全设计:

- 每次进程重启、会话恢复(`agent/session-start`)、或 fork,目标都会被 **disarm**(解除武装);
- disarm 之后,`goal-round-driver`(自动轮次驱动)不会启动任何新轮次;
- 必须有一次**显式 `resume`**(人工授权)才能 rearm,之后 driver 才会在 agent 空闲时自动驱动剩余轮次,直到完成 / 阻塞 / 轮次上限。

因此默认行为是:**任务目标还在,但重启后停在原地,等你发一句"继续"**。

本插件消除的正是这一步:它扮演"部署策略级的自动恢复",在 DSH 启动后代替人工执行那一次 resume。

> 设计取舍说明:DSH 官方选择"人工授权"是为了防止自动继续一个环境已变、目标过时或可能产生副作用(写文件、调外部 API)的任务。启用本插件 = 你明确接受"重启后自动继续"这一策略。建议配合目标自身的轮次上限(`maxGoalRounds`)使用。

---

## 功能特性

- **自动续跑**:重启后无需任何人工指令,自动恢复仍在进行中的目标;
- **冷恢复 agent**:目标所属会话的 agent 不在内存时,从持久化自动恢复,并复用该会话记录的 preset 组合(工具集、人设一致,不会跑偏);
- **幂等**:已 armed 或 phase 已变化的会话直接跳过,重复扫描无副作用;
- **容错**:单个会话失败不影响其他会话;服务未就绪时自动重试(最多 15 次,间隔 60 秒);
- **零依赖**:逻辑自包含,不 import 任何包,不引入依赖解析链路;
- **护栏保留**:轮次上限由目标定义,自动恢复不会无限执行;blocked / paused / complete 的目标一律不碰。

---

## 工作原理

插件提供**两层自动恢复**:

```
① 实时层(agent/session-start 事件)
   任何会话被打开/恢复 → 立即检查该会话活跃目标 → resume
   (覆盖:重启后你打开会话;运行中 apiproxy 冷恢复 agent)

② 兜底层(启动扫描)
   DSH 启动约 20 秒后,扫描全部持久化会话
     sessionQuery.listSessions()
     sessionQuery.readSession(id)  →  解析日志中的 goal/change 事件
   对每个命中会话:
     1. agent 不在内存 → 冷恢复(带 preset 组合)
           sessionPersistence.inspect(id)
           → 解析会话记录的 preset(agent-preset/selected 事件)
           → ctx.agents.resume({ resumeSessionId, agentOptions, setup })
     2. tryResumeGoal:校验目标 active / 未 armed / 轮次未满
     3. ctx.goals.resume(agent, { id, revision })  → 重新武装
     4. goal-round-driver 在 agent 空闲时自动驱动下一轮
           → 目标轮次自动执行,直到 complete / blocked / 轮次上限
```

关键点:

- **preset 一致性**:恢复 agent 时从**日志**解析 preset(而不是创建时的 header),因为会话可能在空白期切换过 preset——这与 DSH 官方 `session.create` / `resume` 的语义一致;
- **实时兜底**:启动扫描与 apiproxy 并发冷恢复同一会话的竞态由实时层天然化解——apiproxy 恢复完成后触发 `session-start`,插件随即 resume,无需等下次重启;
- **可配置**:时序参数与总开关可在 cordis.yml 的 `config` 覆盖(见下文「配置」)。

---

## 配置

插件接受可选的 `config` 块(省略时用默认值):

```yaml
- id: auto-goal-resume
  name: auto-goal-resume
  config:
    enabled: true        # 总开关,false 时插件不加载任何逻辑
    firstDelayMs: 20000  # 启动后首次扫描延迟(毫秒)
    retryDelayMs: 60000  # 服务未就绪时的重试间隔(毫秒)
    maxRetries: 15       # 最大重试次数
```

---

## 安装

插件已发布到 npm: **`auto-goal-resume`**([npmjs.com/package/auto-goal-resume](https://www.npmjs.com/package/auto-goal-resume))。

### 方式一:DSH 原生快捷指令(最快)

```bash
dsh plugin --profile web add auto-goal-resume
```

这条指令会在 web profile 目录中转发 `pnpm add`,从 npm 安装依赖。装完后再注册 bundle(一行),然后重启:

```bash
# 1. 注册 bundle:把插件加入 profile 的 bundle 层
#    编辑 ~/.dsh/profiles/web/package.json,在 dsh.profile.bundles 数组追加一行:
#    "auto-goal-resume"

# 2. 重启生效(按你实际的 DSH 启动方式重启,例如 systemd: systemctl restart dsh-web.service,
#    或 Termux / 容器 / 前台进程等各自的启动命令)
```

### 方式二:一键脚本(全自动,推荐)

不想手动改配置就用这个,自动完成「安装依赖 + 注册 bundle + 校验」:

```bash
# npm 模式(默认)
bash <(curl -s https://gitee.com/okmyapp/dsh-auto-goal-resume/raw/master/install.sh)

# 或本地执行
bash install.sh

# 本地开发模式(link 引用,改代码即时生效)
bash install.sh --local
```

完成后重启 DSH(按你实际的启动方式,例如 systemd 服务 `systemctl restart dsh-web.service`,或你使用的其他方式)。

### 方式三:手动(等价于方式一的拆解)

```bash
cd ~/.dsh/profiles/web && pnpm add auto-goal-resume
```

然后在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组**追加**一行(保持你已有的 bundle 不变,示例仅为结构示意):

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "…你已有的 bundle…",
        "auto-goal-resume"
      ]
    }
  }
}
```

> 卸载 = 从 `bundles` 数组移除该行,再 `dsh plugin --profile web remove auto-goal-resume`(或 `pnpm remove auto-goal-resume`)即可。

### 验证组合

```bash
dsh --profile web --dump-config | grep auto-goal-resume
```

确认插件行已进入组合树后重启生效。

---

## 验证与日志

插件加载后,DSH 日志中会出现:

```
auto-goal-resume: services not ready, will retry      # 服务未就绪,稍后重试(正常)
auto-goal-resume: N active-goal session(s) checked, M resumed
auto-goal-resume: scan complete
```

各条日志的含义:

| 日志 | 含义 |
|---|---|
| `session X: goal already armed, skip` | 目标已武装,无需重复操作(幂等) |
| `session X: goal phase=paused, skip` | 目标是暂停态,不自动恢复(尊重人工暂停) |
| `session X: goal changed or missing, skip` | 恢复过程中目标被修改/清除,放弃 |
| `session X: goal armed (...)` | **成功重新武装**,driver 将自动驱动后续轮次 |
| `session X: agent could not be resumed` | 冷恢复失败,该会话跳过,不影响其他会话 |

检查日志(按你实际的日志查看方式,例如 systemd 环境):

```bash
journalctl -u dsh-web.service | grep auto-goal-resume   # systemd 示例,服务名按实际调整
```

---

## 端到端测试示例

以本仓库验证场景为例,构造一个"重启后自动续跑"的完整流程:

```bash
# 1. 准备测试目录
rm -rf /tmp/auto-goal-test && mkdir -p /tmp/auto-goal-test

# 2. (在 GUI 中)让 AI 创建目标:
#    "在 /tmp/auto-goal-test/ 下创建 step1.txt ~ step5.txt,
#     每轮至少创建 1 个,全部完成后验证并 complete"

# 3. 第一轮执行一部分(step1、step2),然后重启 DSH(按你实际的启动方式重启,
#    例如 systemd: systemctl restart dsh-web.service):

# 4. 重启后 —— 无需任何人工指令:
#    - 插件自动扫描 → 发现活跃目标 → 冷恢复 agent → resume
#    - goal-round-driver 自动驱动下一轮
#    - AI 自动创建 step3、step4、step5 并 complete
```

观察要点:

- 重启后**没有**用户消息,会话里自动出现新的执行记录;
- `/tmp/auto-goal-test/` 下 5 个文件齐全,时间戳跨越重启点(重启前 vs 重启后);
- 目标最终 `phase: complete`。

---

## 安全与限制

**保留的护栏**

- **轮次上限**:自动恢复仅在 `roundsStarted < maxGoalRounds` 时生效,不会无限执行;
- **阶段过滤**:只恢复 `active` 目标;`paused` / `blocked` / `complete` 一律跳过——人工暂停和阻塞仍然有效;
- **幂等与去重**:armed 会话跳过;失败按会话隔离。

**已知限制**

- **只处理有目标的任务**:没有活跃目标(或未使用 goal 工具)的普通对话不会自动恢复,这是刻意的——普通对话由你发起的上下文驱动;
- **不跨机器/实例**:恢复发生在同一 DSH 实例的持久化会话上;
- **自动继续有副作用风险**:自动续跑的任务可能继续产生副作用(写文件、调用外部 API)。使用前请确认任务本身可安全自动继续;
- **并发边缘**:插件冷恢复与用户同时打开同一会话的极端并发窗口未做专门加锁,DSH 的 agent 注册去重可兜底,但建议避免在重启瞬间同时人工打开同一会话。

---

## 常见问题 FAQ

**Q: 重启后日志显示 "0 active-goal session(s) checked, 0 resumed" 是正常的吗?**
A: 正常。说明当前没有任何"进行中"的目标。等你有活跃目标时重启,才会看到恢复动作。

**Q: 我不想让某个会话自动恢复怎么办?**
A: 在目标层面处理:暂停(`pause`)或完成(`complete`)该目标,插件不会碰非 active 的目标。

**Q: 插件和 DSH 官方行为冲突吗?**
A: 不冲突。插件只是代替人工执行那一次 `resume`(DSH 服务本身允许任意有权限的调用方执行);`goal-round-driver` 的轮次驱动、轮次上限、阻塞语义全部保持官方行为。

**Q: 升级 DSH 会影响插件吗?**
A: 插件只依赖 DSH 的公开服务契约(`sessionQuery` / `sessionPersistence` / `agents` / `goals` / `agentPresets`),这些是稳定接口。若 DSH 未来变更契约,插件会给出明确日志而不是静默失败。

---

## 许可证

MIT
