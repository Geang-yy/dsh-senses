// dsh-senses · 入口
//
// 三样感官合成一个插件：
//   · 眼睛（look）  —— 按需看一眼屏幕
//   · 嘴（say）     —— 回复完自动念出来
//   · 耳朵（听）    —— 喊唤醒词就把那句话送进会话
//
// 每样都能单独关。为什么要合成一个：三份装起来麻烦，而且它们互相有依赖
// （嘴要用"正在说话"的牌子让耳朵闭嘴），拆开装箱最容易出的就是这块对不上。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { loadHostDeps } from './hostdeps.mjs'
import { 装眼睛 } from './eye.js'
import { 装嘴 } from './mouth.js'
import { 装耳朵 } from './ear.js'

export const name = 'dsh-senses'
export const inject = ['agents', 'sessions', 'tools']

const hostDeps = await loadHostDeps()
const defineTool = hostDeps && hostDeps.defineTool

// 面板可改的配置放这里（重启后不会被 profile 覆盖）
const 家 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 面板配置 = join(家, 'dsh-senses', 'config.json')

function 读面板配置() {
  try {
    return JSON.parse(readFileSync(面板配置, 'utf8'))
  } catch {
    return null
  }
}

function 写面板配置(内容) {
  mkdirSync(dirname(面板配置), { recursive: true })
  writeFileSync(面板配置, JSON.stringify(内容, null, 2) + '\n', 'utf8')
}

/** profile 配置 与 面板配置 合并：面板里显式写了的优先 */
function 合并配置(基础, 面板) {
  const 出 = JSON.parse(JSON.stringify(基础 || {}))
  if (!面板 || typeof 面板 !== 'object') return 出
  if (面板.enabled && typeof 面板.enabled === 'object') {
    出.enabled = { ...(出.enabled || {}), ...面板.enabled }
  }
  for (const k of ['eye', 'mouth', 'ear']) {
    if (面板[k] && typeof 面板[k] === 'object') {
      出[k] = { ...(出[k] || {}), ...面板[k] }
    }
  }
  if (typeof 面板.python === 'string' && 面板.python.trim()) 出.python = 面板.python.trim()
  return 出
}

// 单例锁：DSH 有时会把插件加载两次（实测耳朵被拉起了两份，说也说两遍）。
// 用进程级标记兜住，第二份直接不干活。
const 已经装过 = Symbol.for('dsh-senses.installed')

export function apply(ctx, config) {
  if (globalThis[已经装过]) {
    ctx.logger?.info?.('[dsh-senses] 已经装过了，这一份跳过（防止重复拉起）')
    return
  }
  globalThis[已经装过] = true
  const c = 合并配置(config && typeof config === 'object' ? config : {}, 读面板配置())
  const 开关 = c.enabled && typeof c.enabled === 'object' ? c.enabled : {}
  // 默认全开；eye/mouth 轻，ear 重（要模型、要麦克风），但都按 true 起步，
  // 想关谁在配置里写 false 就行。
  const 开 = {
    eye: 开关.eye !== false && c.eye !== false,
    mouth: 开关.mouth !== false && c.mouth !== false,
    ear: 开关.ear !== false && c.ear !== false,
  }

  const python = c.python || 'python'

  if (开.eye) {
    const e = c.eye && typeof c.eye === 'object' ? c.eye : {}
    装眼睛(ctx, {
      width: Number(e.width) > 200 ? Number(e.width) : 1280,
      keep: Number(e.keep) > 0 ? Number(e.keep) : 10,
      outDir: e.outDir || join(家, 'look', 'shots'),
    }, defineTool)
  }

  if (开.mouth) {
    const m = c.mouth && typeof c.mouth === 'object' ? c.mouth : {}
    装嘴(ctx, {
      python,
      voice: m.voice || 'zh-CN-XiaoxiaoNeural',
      rate: m.rate || '+4%',
      maxChars: Number(m.maxChars) > 20 ? Number(m.maxChars) : 180,
      minChars: Number(m.minChars) > 0 ? Number(m.minChars) : 8,
      intervalMs: Number(m.intervalMs) > 200 ? Number(m.intervalMs) : 1000,
      sessionsRoot: m.sessionsRoot || join(家, 'sessions'),
    }, defineTool)
  }

  if (开.ear) {
    const r = c.ear && typeof c.ear === 'object' ? c.ear : {}
    装耳朵(ctx, {
      python,
      wake: r.wake || '小鱼',
      device: Number.isFinite(Number(r.device)) ? Number(r.device) : 0,
      session: String(r.session || '').trim(),
      inbox: r.inbox || join(家, 'dsh-listen', 'inbox.jsonl'),
      autoStart: r.autoStart !== false,
      intervalMs: Number(r.intervalMs) > 200 ? Number(r.intervalMs) : 1000,
    })
  }

  ctx.logger?.info?.(
    '[dsh-senses] 已装：' +
      ['眼睛', '嘴', '耳朵'].filter((_, i) => [开.eye, 开.mouth, 开.ear][i]).join(' · '),
  )

  // ── 面板用的接口：读/写配置 ─────────────────────────────────────────
  const 当前状态 = () => ({
    ok: true,
    enabled: 开,
    python,
    eye: c.eye || {},
    mouth: c.mouth || {},
    ear: c.ear || {},
    配置在: 面板配置,
  })

  const 路由 = {
    '/status': {
      methods: ['GET'],
      handler: async () => ({ status: 200, body: 当前状态() }),
    },
    '/toggle': {
      methods: ['POST'],
      handler: async (_req, body) => {
        const 键 = String((body && body.key) || '').trim()
        if (!['eye', 'mouth', 'ear'].includes(键)) {
          return { status: 400, body: { ok: false, error: 'key 只能是 eye / mouth / ear' } }
        }
        const 现在 = 读面板配置() || {}
        const 新值 = body.value !== false
        现在.enabled = { ...(现在.enabled || {}), [键]: 新值 }
        写面板配置(现在)
        // 改完不会热生效（模块已经装/没装），要重载；这里如实告诉面板
        return { status: 200, body: { ok: true, enabled: 现在.enabled, needReload: true } }
      },
    },
  }

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

  try {
    ctx.inject(['connection'], (cx) => {
      const 宿主 = cx.connection && cx.connection.fetch
      if (!宿主 || typeof 宿主.register !== 'function') return
      const 释放 = []
      for (const [路径, 条目] of Object.entries(路由)) {
        try {
          释放.push(
            宿主.register({
              path: '/api/dsh-senses' + 路径,
              methods: 条目.methods,
              requestBody: 条目.methods.some((m) => m !== 'GET' && m !== 'HEAD') ? 'buffered' : 'none',
              fetch: async (req) => {
                let 体 = {}
                try {
                  体 = await req.json()
                } catch {}
                const r = await 条目.handler(req, 体)
                return json(r.body, r.status)
              },
            }),
          )
        } catch (e) {
          ctx.logger?.warn?.('[dsh-senses] 注册路由失败 ' + 路径 + '：' + String(e && e.message))
        }
      }
      ctx.effect(() => () => {
        for (const d of 释放) {
          try {
            d && d()
          } catch {}
        }
      })
    })
  } catch (e) {
    ctx.logger?.warn?.('[dsh-senses] connection 路由跳过：' + String(e && e.message))
  }

  try {
    ctx.inject(['webServer'], (cx) => {
      if (!cx.webServer || typeof cx.webServer.register !== 'function') return
      const 关 = cx.webServer.register({
        kind: 'prefix',
        path: '/dsh-senses/api',
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://localhost')
          const 路径 = url.pathname.replace(/^\/dsh-senses\/api/, '') || '/'
          const 条目 = 路由[路径]
          if (!条目) {
            res.statusCode = 404
            res.end(JSON.stringify({ ok: false, error: '没有这个接口：' + 路径 }))
            return
          }
          let 体 = {}
          if (req.method !== 'GET') {
            体 = await new Promise((resolve) => {
              const 块 = []
              req.on('data', (c) => 块.push(c))
              req.on('end', () => {
                try {
                  resolve(JSON.parse(Buffer.concat(块).toString('utf8') || '{}'))
                } catch {
                  resolve({})
                }
              })
            })
          }
          const r = await 条目.handler(req, 体)
          res.statusCode = r.status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(r.body))
        },
      })
      ctx.effect(() => () => {
        try {
          关 && 关()
        } catch {}
      })
    })
  } catch (e) {
    ctx.logger?.warn?.('[dsh-senses] webServer 路由跳过：' + String(e && e.message))
  }
}

