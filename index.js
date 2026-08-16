/**
 * auto-goal-resume — 实时自动续跑有活跃目标(goal)的会话。
 *
 * DSH 的 goal 系统把"目标"(目标文本、阶段、轮次)持久化到会话日志,但"继续执行
 * 的授权"(activation)永不持久化:每次进程重启或会话恢复都会 disarm,需要一次显式
 * resume 之后,goal-round-driver 才会在 agent 空闲时自动驱动剩余轮次。
 *
 * 本插件提供两层自动恢复:
 *   1. 实时层:监听 `agent/session-start` —— 任何会话被打开/恢复时,立即检查该
 *      会话的活跃目标并 resume。这覆盖"重启后用户打开会话"和"运行中 agent 被
 *      apiproxy 冷恢复"两种场景,也天然化解与 apiproxy 并发恢复同一会话的竞态
 *      (apiproxy 恢复完成后触发 session-start,由这里完成 resume)。
 *   2. 兜底层:启动稳定后扫描全部持久化会话,冷恢复 agent 并 resume —— 覆盖
 *      "重启后无人打开会话"的场景。
 *
 * 幂等:已 armed / 非 active / 轮次已满的会话一律跳过;单个会话失败不影响其他。
 * 零依赖:不 import 任何包,逻辑自包含。
 */

/** 可配置默认值(可在 cordis.yml 的 config 覆盖,零依赖手动合并)。 */
const DEFAULTS = {
  /** 总开关;false 时插件不加载任何逻辑。 */
  enabled: true,
  /** 启动后首次扫描的延迟(毫秒),等所有服务就绪。 */
  firstDelayMs: 20000,
  /** 服务未就绪时的重试间隔(毫秒)。 */
  retryDelayMs: 60000,
  /** 最大重试次数。 */
  maxRetries: 15,
}

export const name = 'auto-goal-resume'

export const inject = ['timer']

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...config }
  if (cfg.enabled === false) {
    ctx.logger.info('auto-goal-resume: disabled by config')
    return
  }

  // ── 实时层:会话启动/恢复时立即检查 ──────────────────────────────
  ctx.on('agent/session-start', (payload) => {
    const agent = payload === undefined || payload === null ? undefined : payload.agent
    const sessionId = agent === undefined || agent.session === undefined ? undefined : agent.session.id
    if (sessionId === undefined) return
    void (async () => {
      try {
        if (tryResumeGoal(ctx, agent, 'live')) {
          ctx.logger.info(`auto-goal-resume: session ${sessionId} resumed via session-start`)
        }
      } catch (err) {
        ctx.logger.warn(`auto-goal-resume: session ${sessionId} live resume failed: ${String(err && err.message || err)}`)
      }
    })()
  })

  // ── 兜底层:启动稳定后扫描全部持久化会话 ─────────────────────────
  let attempt = 0
  const scan = async () => {
    attempt += 1
    let outcome
    try {
      outcome = await scanOnce(ctx)
    } catch (err) {
      ctx.logger.warn(`auto-goal-resume: scan failed (attempt ${attempt}): ${String(err && err.message || err)}`)
      outcome = 'retry'
    }
    if (outcome === 'done') {
      ctx.logger.info('auto-goal-resume: scan complete')
      return
    }
    if (attempt < cfg.maxRetries) {
      ctx.timeout(scan, cfg.retryDelayMs)
    } else {
      ctx.logger.warn(`auto-goal-resume: giving up after ${attempt} attempts`)
    }
  }
  ctx.timeout(scan, cfg.firstDelayMs)
}

/**
 * 对一个 live agent 检查并 resume 其活跃目标。
 * @param ctx - 插件上下文。
 * @param agent - 已发布(registry live)的 agent。
 * @param trigger - 触发来源,用于日志(live / scan)。
 * @returns 是否执行了 resume。
 */
function tryResumeGoal(ctx, agent, trigger) {
  const goals = ctx.get('goals')
  if (goals === undefined) return false
  let view
  try {
    view = goals.get(agent)
  } catch (err) {
    ctx.logger.warn(`auto-goal-resume: ${trigger} session ${agent.session.id}: goal read failed: ${String(err && err.message || err)}`)
    return false
  }
  if (view === undefined || view.phase !== 'active' || view.activation === 'armed') return false
  if (view.roundsStarted >= view.maxGoalRounds) return false
  try {
    // 用 live view 自身的 id/revision,避免持久化快照过期导致 CAS 失败。
    goals.resume(agent, { id: view.id, revision: view.revision })
    ctx.logger.info(`auto-goal-resume: ${trigger} session ${agent.session.id}: goal armed (${String(view.objective).slice(0, 60)})`)
    return true
  } catch (err) {
    ctx.logger.warn(`auto-goal-resume: ${trigger} session ${agent.session.id}: resume failed: ${String(err && err.message || err)}`)
    return false
  }
}

async function scanOnce(ctx) {
  const sessionQuery = ctx.get('sessionQuery')
  const goals = ctx.get('goals')
  const agents = ctx.get('agents')
  const sessionPersistence = ctx.get('sessionPersistence')
  if (sessionQuery === undefined || goals === undefined || agents === undefined || sessionPersistence === undefined) {
    ctx.logger.info('auto-goal-resume: services not ready, will retry')
    return 'retry'
  }
  const records = await sessionQuery.listSessions()
  let recovered = 0
  let checked = 0
  for (const record of records) {
    const sessionId = record.header.id
    try {
      const snapshot = await sessionQuery.readSession(sessionId)
      const change = lastActiveGoalChange(snapshot.events)
      if (change === null) continue
      checked += 1
      let agent = agents.get(sessionId)
      if (agent === undefined) {
        agent = await coldResumeAgent(ctx, sessionId)
        if (agent === undefined) continue
      }
      if (tryResumeGoal(ctx, agent, 'scan')) recovered += 1
    } catch (err) {
      ctx.logger.warn(`auto-goal-resume: session ${sessionId} skipped: ${String(err && err.message || err)}`)
    }
  }
  ctx.logger.info(`auto-goal-resume: ${checked} active-goal session(s) checked, ${recovered} resumed`)
  return 'done'
}

/** 从事件日志找出最后一个"仍 active 且未超轮次上限"的目标变更,否则 null。 */
function lastActiveGoalChange(events) {
  let last = null
  for (const event of events) {
    if (event !== null && event.type === 'goal/change') last = event
  }
  if (last === null) return null
  const data = last.data
  if (data.operation === 'clear') return null
  if (data.goal.phase !== 'active') return null
  if (data.roundsStarted >= data.goal.maxGoalRounds) return null
  return data
}

async function coldResumeAgent(ctx, sessionId) {
  const sessionPersistence = ctx.get('sessionPersistence')
  const agents = ctx.get('agents')
  if (sessionPersistence === undefined || agents === undefined) return undefined
  const inspected = await sessionPersistence.inspect(sessionId)
  const presetId = resolveSessionPreset(inspected)
  const setup = await makeSetup(ctx, presetId)
  const defaults = ctx.get('agentDefaultModel')
  const selection = defaults === undefined ? undefined : defaults.currentSelection()
  const handle = await agents.resume({
    resumeSessionId: sessionId,
    ...(selection === undefined || selection.provider === undefined
      ? {}
      : { agentOptions: { provider: selection.provider, model: selection.model } }),
    ...(setup === undefined ? {} : { setup }),
  })
  return handle.agent
}

/** 会话记录的 preset:倒序找 agent-preset/selected 事件,否则取 header。 */
function resolveSessionPreset(inspected) {
  const events = inspected.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== null && event.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return inspected.meta.agentPreset
}

/** 把会话记录的 preset 组合成 agent 恢复时的 setup(挂载该 preset 的插件子树)。 */
async function makeSetup(ctx, presetId) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined || presetId === undefined) return undefined
  const resolved = await presets.resolve(presetId)
  return async (agentCtx) => {
    await presets.mount(agentCtx, resolved.id)
  }
}
