// dsh-senses · 耳朵
//
// 常驻听，听到唤醒词就把那句话送进会话。
// 分工：scripts/listen_worker.py 负责听和转写，写出收件箱；这里读收件箱、注入会话。

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 插件根 = join(这里, '..')
const 源标记 = 'dsh-senses'

function 新id() {
  return 'listen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function 找agent(ctx, id) {
  const 原 = String(id == null ? '' : id).trim()
  if (!原) return undefined
  const 候选 = [原]
  if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
  else 候选.push('session-' + 原)
  for (const 一个 of 候选) {
    try {
      const a = ctx.agents.get(一个)
      if (a !== undefined) return a
    } catch {}
  }
  return undefined
}

function 当前会话(ctx, 设定) {
  if (设定.session) return 设定.session
  try {
    const 列表 = ctx.agents.list ? ctx.agents.list() : []
    const 一个 = 列表 && 列表.length ? 列表[0] : null
    if (!一个) return ''
    return 一个.id || 一个.session || ''
  } catch {
    return ''
  }
}

export function 装耳朵(ctx, 设定) {
  const 收件箱 = 设定.inbox
  mkdirSync(dirname(收件箱), { recursive: true })
  const 记账文件 = join(dirname(收件箱), 'listen.log')
  let 子进程 = null
  let 定时器 = null

  function 记账(msg) {
    try {
      appendFileSync(记账文件, new Date().toISOString() + ' ' + msg + '\n')
    } catch {}
  }

  async function 注入(文本) {
    const id = 当前会话(ctx, 设定)
    if (!id) {
      记账('没找到活着的会话：' + 文本.slice(0, 40))
      return false
    }
    const agent = 找agent(ctx, id)
    if (!agent) {
      记账('agent 不在：' + id)
      return false
    }
    const 消息 = {
      id: 新id(),
      role: 'user',
      content: [{ type: 'text', text: String(文本) }],
      source: { kind: 源标记 },
    }
    try {
      // 必须 await：followup 一旦 reject 没接住，整个宿主进程会被带走
      await agent.followup(消息)
      try {
        if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session)
      } catch {}
      记账('已送进会话：' + 文本.slice(0, 40))
      return true
    } catch (e) {
      记账('注入失败：' + String(e && e.message ? e.message : e).slice(0, 200))
      return false
    }
  }

  function 读收件箱() {
    if (!existsSync(收件箱)) return
    let 内容 = ''
    try {
      内容 = readFileSync(收件箱, 'utf8')
    } catch {
      return
    }
    if (!内容.trim()) return
    try {
      unlinkSync(收件箱)
    } catch {}
    for (const 行 of 内容.split('\n')) {
      if (!行.trim()) continue
      let 条
      try {
        条 = JSON.parse(行)
      } catch {
        continue
      }
      const 文本 = String((条 && 条.text) || '').trim()
      if (文本) 注入(文本)
    }
  }

  const 锁文件 = join(dirname(收件箱), 'worker.pid')

  /** 已有的监听还活着吗？活着就别再拉第二份（跨进程的锁，globalThis 在这里不管用） */
  function 已经在听了() {
    try {
      if (!existsSync(锁文件)) return false
      const pid = Number(readFileSync(锁文件, 'utf8').trim())
      if (!Number.isFinite(pid) || pid <= 0) return false
      process.kill(pid, 0) // 不发信号，只探活
      return true
    } catch {
      return false
    }
  }

  /** 把还在跑的旧监听全清掉（按命令行找，只清 python，别误伤自己的 shell） */
  function 清旧的() {
    return new Promise((resolve) => {
      const 脚本 = [
        '$me = $PID',
        'Get-CimInstance Win32_Process -Filter "Name like \'%python%\'" |',
        '  Where-Object { $_.CommandLine -match \'listen_worker\' } |',
        '  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }',
      ].join(' ')
      execFile('powershell.exe', ['-NoProfile', '-Command', 脚本], { windowsHide: true, timeout: 20000 }, () => resolve())
    })
  }

  async function 拉起监听() {
    // 没登记声音就先提醒（不然用户以为插件坏了）
    try {
      if (!existsSync(join(插件根, 'models', 'owner.npy'))) {
        记账('还没登记声音：耳朵会拒绝所有人。先跑 python scripts/enroll.py')
      }
    } catch {}
    // 先把旧的清干净，再起一份 —— 这样永远只有一份在听。
    // （试过 globalThis、pid 锁、O_EXCL，都被"包装进程 + 子进程"的结构绕过去了）
    await 清旧的()
    if (已经在听了()) {
      记账('已经有一份在听了，这次不重复拉')
      return
    }
    // 抢锁：用排他创建（flag:'wx'）——两个实例同时进来时只有一个能建成。
    // 只检查不创建会有竞态窗口，两边都以为"没人占"，各拉一份（2026-10-30 实测就是这样出的两份）。
    try {
      writeFileSync(锁文件, 'pending', { flag: 'wx' })
    } catch {
      记账('锁被别人抢到了，这次不拉')
      return
    }
    const 脚本 = join(插件根, 'scripts', 'listen_worker.py')
    if (!existsSync(脚本)) {
      记账('找不到监听脚本：' + 脚本)
      try { unlinkSync(锁文件) } catch {}
      return
    }
    const 参数 = [
      脚本,
      '--wake', 设定.wake,
      '--device', String(设定.device),
      '--inbox', 收件箱,
      '--models', join(插件根, 'models'),
      '--keywords', join(插件根, 'models', 'keywords.txt'),
    ]
    try {
      子进程 = spawn(设定.python, 参数, { windowsHide: true, stdio: 'ignore' })
      子进程.on('error', (e) => {
        记账('拉起失败：' + String(e.message).slice(0, 160))
        try {
          unlinkSync(锁文件)
        } catch {}
        子进程 = null
      })
      try {
        writeFileSync(锁文件, String(子进程.pid), 'utf8')
      } catch {}
      子进程.on('exit', (code) => {
        记账('监听进程退出，code=' + code)
        子进程 = null
        try {
          const pid = Number(readFileSync(锁文件, 'utf8').trim())
          if (pid === 子进程?.pid) unlinkSync(锁文件)
        } catch {}
        try {
          unlinkSync(锁文件)
        } catch {}
      })
      记账('耳朵已开：唤醒词「' + 设定.wake + '」，设备 ' + 设定.device)
    } catch (e) {
      记账('spawn 异常：' + String(e && e.message ? e.message : e).slice(0, 160))
    }
  }

  定时器 = setInterval(读收件箱, 设定.intervalMs)
  if (设定.autoStart) 拉起监听().catch(() => {})
  ctx.logger?.info?.('[dsh-senses] 耳朵已开')

  ctx.effect(() => () => {
    if (定时器) clearInterval(定时器)
    if (子进程) {
      try {
        子进程.kill()
      } catch {}
    }
  })
}
