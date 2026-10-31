/**
 * dsh-senses —— 浏览器半端（设置里的「鱼的感官」一页）
 *
 * client bundle 不是 ESM，是自注册脚本：window.__ModuleLoader__.load({ id, factory })
 * id 必须等于 package.json 的 name。
 *
 * 这一页只做一件事：三个开关（眼睛 / 嘴 / 耳朵），点了立刻写配置。
 * 改完需要重载才真正生效——因为插件是加载时装上或没装的，运行时摘不掉。
 */
window.__ModuleLoader__.load({
  id: 'dsh-senses',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    // 先试不需要鉴权的那条（webServer 路由），/api/* 那条要带 token，面板里拿不到。
    const CANDIDATES = ['/dsh-senses/api', '/api/dsh-senses']
    let BASE = null

    async function 探测() {
      if (BASE) return BASE
      for (const b of CANDIDATES) {
        try {
          const r = await fetch(b + '/status', { credentials: 'same-origin', signal: AbortSignal.timeout(2500) })
          if (r.ok) {
            BASE = b
            return b
          }
        } catch {}
      }
      BASE = CANDIDATES[0]
      return BASE
    }

    async function 取状态() {
      const b = await 探测()
      const r = await fetch(b + '/status', { credentials: 'same-origin', signal: AbortSignal.timeout(4000) })
      if (!r.ok) throw new Error('读不到状态：HTTP ' + r.status)
      return r.json()
    }

    async function 切换(key, value) {
      const b = await 探测()
      const r = await fetch(b + '/toggle', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
        signal: AbortSignal.timeout(4000),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.ok === false) throw new Error(j.error || 'HTTP ' + r.status)
      return j
    }

    const 三样 = [
      { key: 'eye', 名: '眼睛', 说: '按需看一眼屏幕。不常驻，只在需要的时候截一张。' },
      { key: 'mouth', 名: '嘴', 说: '每回复完一条，念出来。太长只念开头，太短不念。' },
      { key: 'ear', 名: '耳朵', 说: '常驻听，喊唤醒词就把那句话送进会话。要麦克风。' },
    ]

    function 开关({ on, onChange, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          onClick: onChange,
          disabled,
          'aria-pressed': on,
          style: {
            width: 46,
            height: 26,
            borderRadius: 13,
            border: 'none',
            cursor: disabled ? 'default' : 'pointer',
            position: 'relative',
            flex: '0 0 auto',
            background: on ? '#3b82f6' : 'rgba(127,127,127,.35)',
            transition: 'background .15s',
            opacity: disabled ? 0.6 : 1,
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 3,
            left: on ? 23 : 3,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left .15s',
            boxShadow: '0 1px 3px rgba(0,0,0,.3)',
          },
        }),
      )
    }

    function Panel() {
      const [状态, set状态] = React.useState(null)
      const [错, set错] = React.useState(null)
      const [忙, set忙] = React.useState(null)
      const [提示, set提示] = React.useState(null)
      const 活着 = React.useRef(true)

      React.useEffect(() => () => {
        活着.current = false
      }, [])

      const 读 = React.useCallback(async () => {
        try {
          const j = await 取状态()
          if (活着.current) {
            set状态(j)
            set错(null)
          }
        } catch (e) {
          if (活着.current) set错(String((e && e.message) || e))
        }
      }, [])

      React.useEffect(() => {
        读()
      }, [读])

      async function 点(key, 新值) {
        set忙(key)
        set提示(null)
        try {
          const j = await 切换(key, 新值)
          if (活着.current) {
            set状态((旧) => (旧 ? { ...旧, enabled: { ...旧.enabled, ...(j.enabled || {}) } } : 旧))
            set提示('改好了，正在重载插件…')
          }
          // 配置是在插件加载时读的，改完必须重载一次才生效。
          // 有重载器就自己调，没有就退回到"手动点重载"。
          try {
            const r = await fetch('/dsh-reloader/api/reload', {
              method: 'POST',
              credentials: 'same-origin',
              signal: AbortSignal.timeout(5000),
            })
            if (!r.ok) throw new Error('reload ' + r.status)
            if (活着.current) set提示('重载中，页面马上会刷新——刷新完就生效了。')
          } catch {
            if (活着.current) set提示('改好了。到「重载与重启」里点一下「重载刷新」就生效。')
          }
        } catch (e) {
          if (活着.current) set错(String((e && e.message) || e))
        } finally {
          if (活着.current) set忙(null)
        }
      }

      const 卡 = {
        maxWidth: 620,
        padding: '18px 20px',
        border: '1px solid rgba(127,127,127,.22)',
        borderRadius: 10,
        background: 'rgba(127,127,127,.05)',
      }

      if (错 && !状态) {
        return h('div', { style: 卡 }, h('div', { style: { color: '#ef4444' } }, '读不到状态：' + 错), h('div', { style: { marginTop: 8, fontSize: 12, opacity: 0.7 } }, '插件可能没加载，或者要重载一次。'))
      }
      if (!状态) return h('div', { style: 卡 }, '读着…')

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(
          'div',
          null,
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '鱼的感官'),
          h(
            'div',
            { style: { marginTop: 6, fontSize: 12.5, opacity: 0.75, lineHeight: 1.6 } },
            '三样各管一件事，可以单独关。改完会自动重载，不用重启整个程序。',
          ),
        ),

        ...三样.map((项) => {
          const on = 状态.enabled ? 状态.enabled[项.key] !== false : true
          return h(
            'div',
            {
              key: 项.key,
              style: {
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
                padding: '12px 14px',
                border: '1px solid rgba(127,127,127,.16)',
                borderRadius: 9,
                background: on ? 'rgba(59,130,246,.06)' : 'transparent',
              },
            },
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontWeight: 600, fontSize: 13.5 } }, 项.名),
              h('div', { style: { marginTop: 4, fontSize: 12, opacity: 0.72, lineHeight: 1.55 } }, 项.说),
            ),
            开关({
              on,
              disabled: 忙 === 项.key,
              onChange: () => 点(项.key, !on),
            }),
          )
        }),

        提示 ? h('div', { style: { fontSize: 12, color: '#10b981' } }, 提示) : null,
        错 && 状态 ? h('div', { style: { fontSize: 12, color: '#ef4444' } }, 错) : null,

        h(
          'div',
          { style: { fontSize: 11.5, opacity: 0.55, lineHeight: 1.6, borderTop: '1px solid rgba(127,127,127,.15)', paddingTop: 10 } },
          '配置存在：' + String(状态.配置在 || ''),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots || !slots.inject || !slots.register) return
        ctx.effect(
          () =>
            slots.inject('settings.section', () =>
              slots.register(
                { name: 'settings.section', id: 'dsh-senses', order: 55, label: '鱼的感官' },
                () => h(Panel),
              ),
            ),
          'dsh-senses: 设置页',
        )
      },
    }
  },
})
