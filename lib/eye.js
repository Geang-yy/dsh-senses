// dsh-senses · 眼睛
//
// 按需看一眼屏幕。不做常驻录屏——那个方案试过，又占资源又不懂事。

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 插件根 = join(这里, '..')

function 清理(目录, keep) {
  try {
    const 文件们 = readdirSync(目录)
      .filter((n) => n.startsWith('look-') && n.endsWith('.png'))
      .map((n) => join(目录, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    for (const f of 文件们.slice(keep)) rmSync(f, { force: true })
  } catch {}
}

export function 截图(模式, 宽度, 输出目录, 区域) {
  return new Promise((resolve, reject) => {
    const 脚本 = join(插件根, 'scripts', 'shot.ps1')
    if (!existsSync(脚本)) {
      reject(new Error('找不到截图脚本：' + 脚本))
      return
    }
    mkdirSync(输出目录, { recursive: true })
    const 参数 = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 脚本, '-Width', String(宽度), '-OutDir', 输出目录]
    if (模式 === 'active') 参数.push('-Active')
    if (区域) 参数.push('-Region', String(区域))
    execFile('powershell.exe', 参数, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(String(stderr || err.message).slice(0, 300)))
        return
      }
      const 行 = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)
      const 图 = 行.reverse().find((l) => l.toLowerCase().endsWith('.png'))
      if (!图) {
        reject(new Error('脚本没返回图片路径：' + String(stdout).slice(0, 200)))
        return
      }
      resolve(图)
    })
  })
}

/** 调 Windows 自带 OCR 把图里的字提出来（不要网络、不要 key） */
function 提文字(图片) {
  return new Promise((resolve, reject) => {
    const 脚本 = join(插件根, 'scripts', 'ocr.ps1')
    if (!existsSync(脚本)) {
      reject(new Error('找不到 ocr.ps1'))
      return
    }
    // ⚠ encoding 必须是 'buffer' 再手动按 utf8 解。
    //   交给默认值会按系统代码页解，中文全变成"看着像错别字"的乱码
    //   （"任务看板" → "任务音板"，2026-10-31 栽过）。
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 脚本, '-Path', 图片], { windowsHide: true, timeout: 30000, encoding: 'buffer' }, (err, stdout) => {
      if (err) {
        reject(new Error(String(err.message).slice(0, 200)))
        return
      }
      // Windows OCR 会在中文字之间塞空格，这里洗掉（换行留着，那是原文结构）
      let 文本 = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '')
      let 上次 = null
      while (上次 !== 文本) {
        上次 = 文本
        文本 = 文本.replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])[ \t]+([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, (m) => m[0] + m[m.length - 1])
      }
      resolve(文本.trim())
    })
  })
}

export function 装眼睛(ctx, 设定, defineTool) {
  const 输出目录 = 设定.outDir || join(homedir(), '.dsh', 'look', 'shots')

  if (typeof defineTool !== 'function') {
    ctx.logger?.warn?.('[dsh-senses] 眼睛：拿不到 defineTool')
    return
  }

  const 工具 = defineTool({
    name: 'look',
    description:
      '看一眼主人的屏幕（截一张图，按需调用，绝不常驻）。' +
      '用在你需要知道他"在干什么 / 卡在哪 / 窗口里写了什么"的时候。' +
      'mode=active 只截当前窗口（默认，看得清），mode=screen 截整个桌面（看布局）。' +
      '返回图片的绝对路径，之后要用 read_image 读它——图片本身不会自动进上下文。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['active', 'screen'], description: 'active=只截当前窗口（默认）；screen=整个桌面' },
        width: { type: 'number', description: '缩到多宽（默认 1280；要看清小字可以给 1920）' },
        region: { type: 'string', enum: ['left', 'right', 'top', 'bottom'], description: '只截半个屏。带鱼屏（比如 5120 宽）缩到 1280 会有 360 高、字全糊，用这个就清楚了' },
        text: { type: 'boolean', description: '只要文字（用本机 OCR 提取，省很多 token）。截到报错、日志、文档时用这个' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, path: { type: 'string' }, text: { type: 'string' }, message: { type: 'string' } },
      },
      render(_a, v) {
        if (!v || v.ok === false) return [{ type: 'text', text: '✗ ' + String((v && v.message) || '没截到') }]
        if (v.text) {
          const 行 = String(v.text).split('\n').slice(0, 6).join('\n')
          const 多 = String(v.text).split('\n').length > 6 ? '\n…' : ''
          return [{ type: 'text', text: '✓ ' + String(v.message || '') + '\n' + 行 + 多 }]
        }
        return [{ type: 'text', text: '✓ 截好了：' + String(v.path || '') }]
      },
    },
    async execute(args) {
      const 模式 = args && args.mode === 'screen' ? 'screen' : 'active'
      const 宽 = args && Number(args.width) > 200 ? Number(args.width) : 设定.width || 1280
      const 只要文字 = args && args.text === true
      const 区域 = args && ['left', 'right', 'top', 'bottom'].includes(args.region) ? args.region : ''
      try {
        const 图 = await 截图(模式, 宽, 输出目录, 区域)
        清理(输出目录, 设定.keep || 10)
        if (只要文字) {
          try {
            const 文本 = await 提文字(图)
            return {
              ok: true,
              path: 图,
              text: 文本,
              message: 文本 ? ('OCR 识别到 ' + 文本.length + ' 个字') : '画面里没找到文字',
            }
          } catch (e) {
            // OCR 挂了不算失败：图还在，照样能看
            return { ok: true, path: 图, text: '', message: 'OCR 没成功（' + String(e.message).slice(0, 80) + '），可以直接读图' }
          }
        }
        return { ok: true, path: 图, text: '', message: '接下来用 read_image 读它' }
      } catch (e) {
        return { ok: false, path: '', text: '', message: String(e && e.message ? e.message : e).slice(0, 300) }
      }
    },
  })

  if (ctx.tools && typeof ctx.tools.register === 'function') ctx.tools.register(工具)
  ctx.logger?.info?.('[dsh-senses] 眼睛已睁开')
}
