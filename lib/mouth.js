// dsh-senses · 嘴
//
// 每回复完一条就念出来。盯会话日志，发现有新的 assistant 文本就交给 say_worker.py。

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 插件根 = join(这里, '..')
const 帧魔数 = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function 读目录(p) {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

function 最近的日志(根) {
  if (!existsSync(根)) return null
  let best = null
  for (const ws of 读目录(根)) {
    if (!ws.includes('lanfei') && !ws.includes('deepseek')) continue
    for (const s of 读目录(join(根, ws))) {
      const p = join(根, ws, s, 'session.v4.jsonl.zstd')
      if (!existsSync(p)) continue
      const t = statSync(p).mtimeMs
      if (!best || t > best.t) best = { path: p, t }
    }
  }
  return best
}

/** 多帧 zstd：按魔数切开逐帧解 */
function 解帧(buf) {
  const 偏移 = []
  let pos = 0
  while (true) {
    const i = buf.indexOf(帧魔数, pos)
    if (i < 0) break
    偏移.push(i)
    pos = i + 1
  }
  偏移.push(buf.length)
  const 出 = []
  for (let k = 0; k < 偏移.length - 1; k++) {
    try {
      出.push(zlib.zstdDecompressSync(buf.subarray(偏移[k], 偏移[k + 1])).toString('utf8'))
    } catch {}
  }
  return 出.join('\n')
}

/** 只取 type==="text"，reasoning 不念 */
function 抽文本(事件) {
  const 数据 = 事件 && 事件.data
  if (!数据) return ''
  const 内容 = (数据.message || {}).content
  if (Array.isArray(内容)) {
    return 内容
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join(' ')
      .trim()
  }
  if (typeof 内容 === 'string') return 内容
  return ''
}

function 该念(文本, 设定) {
  if (!文本 || 文本.length < 设定.minChars) return false
  if (!/[\u4e00-\u9fff]/.test(文本)) return false
  const 头 = 文本.trimStart()
  if (头.startsWith('{') || 头.startsWith('[') || 头.startsWith('```') || 头.startsWith('<')) return false
  return true
}

export function 装嘴(ctx, 设定, defineTool) {
  const 场 = {
    定时器: null,
    上次大小: 0,
    上次时间: 0,
    当前日志: null,
  }

  let 正在念 = false

  function 念(文本) {
    // 同一时间只允许一个在念。以前不拦，同一条消息被扫到两次就会叠两个进程，
    // 听成"念了两遍"（2026-10-30 实测抓到 4 个 say_worker 同时在跑）。
    if (正在念) return
    正在念 = true
    const 短 = 文本.length > 设定.maxChars ? 文本.slice(0, 设定.maxChars) + '……后面还有，你看屏幕吧。' : 文本
    const 脚本 = join(插件根, 'scripts', 'say_worker.py')
    if (!existsSync(脚本)) return
    execFile(
      设定.python,
      [脚本, '--text', 短, '--voice', 设定.voice, '--rate', 设定.rate],
      { timeout: 120000, windowsHide: true },
      (err, _o, errOut) => {
        正在念 = false
        if (err) ctx.logger?.warn?.('[dsh-senses] 嘴：念失败 ' + String(errOut || err.message).slice(0, 160))
      },
    )
  }

  function 巡检() {
    try {
      const 目标 = 最近的日志(设定.sessionsRoot)
      if (!目标) return
      if (场.当前日志 !== 目标.path) {
        场.当前日志 = 目标.path
        // 换会话 / 刚启动：记下位置和"最新一条的时间"，**不念历史**
        场.上次大小 = statSync(场.当前日志).size
        try {
          const buf = readFileSync(场.当前日志)
          const 起点 = Math.max(0, buf.length - 1024 * 1024)
          let 最新 = 0
          for (const 行 of 解帧(buf.subarray(起点)).split('\n')) {
            if (!行.trim()) continue
            try {
              const e = JSON.parse(行)
              if (e.type === 'assistant/message') {
                const ts = e.time || (e.data && e.data.time) || 0
                if (ts > 最新) 最新 = ts
              }
            } catch {}
          }
          场.上次时间 = 最新
        } catch {
          场.上次时间 = Date.now()
        }
        return
      }
      const 现在 = statSync(场.当前日志).size
      if (现在 < 场.上次大小) {
        // 日志被重写变短了（会话压缩/轮转）。
        // ⚠ 以前这里把位置归零 ⇒ 下一轮从文件开头读 ⇒ 把整段历史全念一遍。
        // 正确的做法是重新对齐到新末尾，并且把时间线推到当下，别念旧账。
        场.上次大小 = 现在
        场.上次时间 = Date.now()
        return
      }
      if (现在 === 场.上次大小) return
      // 往回退 1MB 保证落在帧边界（只读增量会截到半帧）
      const 起点 = Math.max(0, 场.上次大小 - 1024 * 1024)
      const buf = readFileSync(场.当前日志)
      场.上次大小 = 现在
      for (const 行 of 解帧(buf.subarray(起点)).split('\n')) {
        if (!行.trim()) continue
        let 事件
        try {
          事件 = JSON.parse(行)
        } catch {
          continue
        }
        if (事件.type !== 'assistant/message') continue
        const ts = 事件.time || (事件.data && 事件.data.time) || 0
        if (ts && ts <= 场.上次时间) continue
        if (ts) 场.上次时间 = ts
        const 正文 = 抽文本(事件)
        if (该念(正文, 设定)) 念(正文)
      }
    } catch (e) {
      ctx.logger?.debug?.('[dsh-senses] 嘴：' + String(e.message).slice(0, 120))
    }
  }

  if (typeof defineTool === 'function') {
    const 工具 = defineTool({
      name: 'say',
      description: '让 AI 用声念一句话（本机 edge-tts，不外传）。适合重要结论、或主人不在屏幕前时。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要念的文字（会自动洗成口语）' },
          voice: { type: 'string', description: '音色，默认 zh-CN-XiaoxiaoNeural' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        },
        render(_a, v) {
          if (!v || v.ok === false) return [{ type: 'text', text: '✗ ' + String((v && v.message) || '没念') }]
          return [{ type: 'text', text: '✓ ' + String(v.message || '念了') }]
        },
      },
      async execute(args) {
        const t = String((args && args.text) || '').trim()
        if (!t) return { ok: false, message: '没内容' }
        念(t)
        return { ok: true, message: '开始念了' }
      },
    })
    if (ctx.tools && typeof ctx.tools.register === 'function') ctx.tools.register(工具)
  }

  场.定时器 = setInterval(巡检, 设定.intervalMs)
  ctx.logger?.info?.('[dsh-senses] 嘴已张开（每 ' + 设定.intervalMs + 'ms 看一次日志）')

  ctx.effect(() => () => {
    if (场.定时器) clearInterval(场.定时器)
  })
}
