/**
 * auto-goal-resume — 重启后自动续跑有活跃目标(goal)的会话。
 *
 * DSH 的 goal 系统把"目标"(目标文本、阶段、轮次)持久化到会话日志,但"继续执行
 * 的授权"(activation)永不持久化:每次进程重启或会话恢复都会 disarm,需要一次显式
 * resume 之后,goal-round-driver 才会在 agent 空闲时自动驱动剩余轮次。
 *
 * 本插件在 DSH 启动稳定后扫描全部持久化会话,对每个"目标仍 active 且未超轮次上限"
 * 的会话:
 *   1. agent 不在内存时,从持久化冷恢复(复用会话记录的 preset 组合);
 *   2. 调用 ctx.goals.resume() 重新武装目标;
 *   3. goal-round-driver 随后在 agent 空闲时自动驱动剩余轮次,直到完成/阻塞/轮次上限。
 *
 * 幂等:已 armed 或 phase 已变化的会话直接跳过;单个会话失败不影响其他会话。
 * 零依赖:不 import 任何包,逻辑自包含,避免包解析链路。
 */

const FIRST_DELAY_MS = 20000
const RETRY_DELAY_MS = 60000
const MAX_RETRIES = 15

export const name = 'auto-goal-resume'

export const inject = ['timer']

export function apply(ctx) {
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
    if (attempt < MAX_RETRIES) {
      ctx.timeout(scan, RETRY_DELAY_MS)
    } else {
      ctx.logger.warn(`auto-goal-resume: giving up after ${attempt} attempts`)
    }
  }
  ctx.timeout(scan, FIRST_DELAY_MS)
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
      if (await recoverSession(ctx, sessionId, change, { goals, agents, sessionPersistence })) recovered += 1
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

async function recoverSession(ctx, sessionId, change, deps) {
  const goal = change.goal
  let agent = deps.agents.get(sessionId)
  if (agent === undefined) {
    agent = await coldResumeAgent(ctx, sessionId, deps)
    if (agent === undefined) {
      ctx.logger.warn(`auto-goal-resume: session ${sessionId}: agent could not be resumed`)
      return false
    }
  }
  let view
  try {
    view = deps.goals.get(agent)
  } catch (err) {
    ctx.logger.warn(`auto-goal-resume: session ${sessionId}: goal read failed: ${String(err && err.message || err)}`)
    return false
  }
  if (view === undefined || view.id !== goal.id) {
    ctx.logger.info(`auto-goal-resume: session ${sessionId}: goal changed or missing, skip`)
    return false
  }
  if (view.activation === 'armed') {
    ctx.logger.info(`auto-goal-resume: session ${sessionId}: goal already armed, skip`)
    return true
  }
  if (view.phase !== 'active') {
    ctx.logger.info(`auto-goal-resume: session ${sessionId}: goal phase=${view.phase}, skip`)
    return false
  }
  deps.goals.resume(agent, { id: goal.id, revision: goal.revision })
  ctx.logger.info(`auto-goal-resume: session ${sessionId}: goal armed (${String(goal.objective).slice(0, 60)})`)
  return true
}

async function coldResumeAgent(ctx, sessionId, deps) {
  const inspected = await deps.sessionPersistence.inspect(sessionId)
  const presetId = resolveSessionPreset(inspected)
  const setup = await makeSetup(ctx, presetId)
  const defaults = ctx.get('agentDefaultModel')
  const selection = defaults === undefined ? undefined : defaults.currentSelection()
  const handle = await deps.agents.resume({
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
