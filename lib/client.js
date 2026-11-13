/**
 * dsh-deepseek-balance — 浏览器半边。
 *
 * 往「对话区底部的 composer dock」里注册一张余额卡片：左边是圆角卡片
 * （当前余额 + 最后更新时间），右边是一个圆形刷新按钮。位置贴对话区左下角。
 *
 * 为什么不自己读余额：余额要么来自宿主进程里的账号凭证，要么来自凭据服务里的
 * API Key，两者都只在宿主半边可达。所以这里只做一件事——fetch 宿主那条只读路由
 * `GET /dsh-deepseek-balance/read`（见 `lib/index.js`），把 JSON 画出来。
 *
 * 为什么是半透明的：桌面端已经用 `dsh-chat-background` 铺了一张壁纸，并要求
 * 这张卡片透出它。卡片因此走「低不透明度 + 自身磨砂」的一条规则——
 *
 *   壁纸层   opacity: 38%   filter: blur(Npx)   磨砂作用在它自己身上
 *   这张卡片 opacity ~42%  backdrop-filter: blur(16px)   磨砂作用在它背后的东西上
 *
 * 数值刻意与壁纸不同：壁纸越磨越糊，卡片再糊就彻底读不出字了。所以卡片用「比壁纸
 * 更低的模糊 + 略高的不透明度 + 压暗底色 + 发丝描边」，文字对比度始终够。
 * 模糊半径、表面不透明度、贴边距离都在 `cordis.patch.yml` 的 `config` 里。
 *
 * 文字不自己造字号：跟随 DSH 「外观 → 字号」的 `--dsh-content-font-size`，以及
 * 与它配套、由主题派生的 `--dsh-content-font-delta`。
 *
 * 这个 bundle 是惰性的 CJS 工厂：执行它只登记工厂，模块体在 shell 真正物化插件时
 * 才运行。`react` 是平台自带的 seed，不需要 `dsh.client.external`。
 */

window.__ModuleLoader__.load({
	id: 'dsh-deepseek-balance',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		/**
		 * 可选的 portal：卡片要挂到 `document.body` 才能按视口坐标自由拖动——
		 * composer 那一层会给 fixed 元素生成包含块，留在里面只能在小范围里动。
		 * 取不到 `react-dom` 时退回原来的「容器内绝对定位」，行为与改动前一致。
		 */
		let createPortal
		try {
			const reactDom = require('react-dom')
			createPortal = typeof reactDom?.createPortal === 'function' ? reactDom.createPortal : undefined
		} catch {
			createPortal = undefined
		}

		/** 宿主那一半的路由。 */
		const READ_PATH = '/dsh-deepseek-balance/read'
		/** 一次读取的最长等待：宿主自己也有超时，这里只兜底。 */
		const FETCH_TIMEOUT_MS = 20_000
		/** 一次会话内记住上一次结果，切会话/重挂载时先显示它。 */
		const CACHE_KEY = 'dsh-deepseek-balance:last'
		/**
		 * Ctrl + 左键拖动后记住的位置，形如 `{ left, top, space }`。
		 *
		 * 这是**本机这个浏览器窗口**的状态，和聊天背景的不透明度/磨砂度一样走
		 * `localStorage`：配置文件里 bake 进去的数值要重启才生效，而拖一下就想立刻
		 * 看到结果。所以配置里的 offsetX/offsetY 只作为「没拖过时的初始位置」。
		 * `space` 标记坐标系：portal 模式是 `viewport`，退路模式是 `parent`。
		 */
		const POSITION_KEY = 'dsh-deepseek-balance:position'
		/** 一次拖动至少要走这么多像素才算拖动，避免把单击误判成拖动。 */
		const DRAG_THRESHOLD_PX = 2
		/** 位置坐标所在的坐标系：portal 模式下是视口，退路模式下是容器。 */
		const POSITION_SPACE = createPortal === undefined ? 'parent' : 'viewport'
		/** 与提示词工坊一致：拖动时与视口边缘至少留 8px。 */
		const VIEWPORT_MARGIN_PX = 8
		const STYLE_ID = 'dsh-deepseek-balance-style'

		const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' }
		const CURRENCY_SUFFIX = { CNY: '元', USD: '' }

		/* ------------------------------------------------------------ 工具 --- */

		/**
		 * 两位小数显示。
		 *
		 * 宿主已经按分四舍五入过一次，这里只负责最终渲染；解析不出来时原样返回，
		 * 永远不制造一个假的 `0.00`。
		 */
		function money(value) {
			const raw = String(value ?? '').trim()
			if (raw === '') return ''
			const parsed = Number(raw)
			return Number.isFinite(parsed) ? parsed.toFixed(2) : raw
		}

		/** 一个金额的可读写法：`¥12.34 元` / `$1.00`。 */
		function amount(wallet) {
			const currency = String(wallet?.currency ?? 'CNY').toUpperCase()
			const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `
			const suffix = CURRENCY_SUFFIX[currency] ?? ''
			return `${symbol}${money(wallet?.balance)}${suffix}`
		}

		/** 多个钱包拼一行。 */
		function amountLine(wallets) {
			const list = Array.isArray(wallets) ? wallets.filter((wallet) => wallet !== null && typeof wallet === 'object') : []
			if (list.length === 0) return ''
			return list.map(amount).join(' / ')
		}

		/** `HH:MM` 或 `HH:MM:SS`。 */
		function clockOf(timestamp, withSeconds) {
			const date = new Date(Number(timestamp))
			if (!Number.isFinite(date.getTime())) return ''
			const pad = (value) => String(value).padStart(2, '0')
			const base = `${pad(date.getHours())}:${pad(date.getMinutes())}`
			return withSeconds ? `${base}:${pad(date.getSeconds())}` : base
		}

		/** 失败原因的中文说法。 */
		function reasonText(reason) {
			switch (reason) {
				case 'signed-out':
					return '未登录'
				case 'no-key':
					return '没有 API Key'
				case 'rejected':
					return '凭证被拒绝'
				case 'network':
					return '网络不可达'
				case 'unavailable':
					return '宿主缺服务'
				case 'forbidden':
					return '来源被拒绝'
				default:
					return '读取失败'
			}
		}

		/** 来源标签。 */
		function sourceText(source) {
			return source === 'api-key' ? 'API Key' : '已登录账号'
		}

		/** 读缓存，失败返回 `undefined`。 */
		function readCache() {
			try {
				const raw = window.localStorage.getItem(CACHE_KEY)
				if (raw === null) return undefined
				const parsed = JSON.parse(raw)
				return parsed !== null && typeof parsed === 'object' ? parsed : undefined
			} catch {
				return undefined
			}
		}

		/** 写缓存；锁死的文档只保留内存里的那一份。 */
		function writeCache(value) {
			try {
				window.localStorage.setItem(CACHE_KEY, JSON.stringify(value))
			} catch {
				/* 忽略 */
			}
		}

		/** 拖动过就存下来的位置，形如 `{ left, top, space }`；坐标系不匹配就当没存过。 */
		function readStoredPosition() {
			try {
				const raw = window.localStorage.getItem(POSITION_KEY)
				if (raw === null) return undefined
				const parsed = JSON.parse(raw)
				if (parsed?.space !== POSITION_SPACE) return undefined
				const left = Number(parsed?.left)
				const top = Number(parsed?.top)
				if (!Number.isFinite(left) || !Number.isFinite(top)) return undefined
				return { left, top }
			} catch {
				return undefined
			}
		}

		/** 记住一次拖动结果；锁死的文档只保留内存里的那一份。 */
		function writeStoredPosition(position) {
			try {
				window.localStorage.setItem(
					POSITION_KEY,
					JSON.stringify({ left: Math.round(position.left), top: Math.round(position.top), space: POSITION_SPACE }),
				)
			} catch {
				/* 忽略 */
			}
		}

		/** 忘掉拖动结果，回到配置里的初始位置。 */
		function clearStoredPosition() {
			try {
				window.localStorage.removeItem(POSITION_KEY)
			} catch {
				/* 忽略 */
			}
		}

		/** 用页面自己的 fetch（载体可能换成了 IPC 桥），绑好作用域。 */
		function doFetch(input, init) {
			const scope = typeof window === 'undefined' ? globalThis : window
			const fn = typeof scope.fetch === 'function' ? scope.fetch : undefined
			if (fn === undefined) return Promise.reject(new Error('这个页面没有 fetch'))
			return fn.call(scope, input, init)
		}

		/**
		 * 候选 URL。
		 *
		 * 相对路径对两种载体都对：`http(s)` 文档解析到回环服务，桌面端的
		 * `dsh-app://app` 文档则由外壳自己的协议处理器转发。壁纸插件发布的回环
		 * 基准地址作为兜底，给不代理未知路径的载体用。
		 */
		function readUrls() {
			const urls = [READ_PATH]
			const base = window.__dshChatBackground?.base
			if (typeof base === 'string' && base !== '') urls.push(`${base}${READ_PATH}`)
			return urls
		}

		/**
		 * 读一次余额。
		 *
		 * @param identity - 页面自己的版本/语言/时区，交给平台侧记录。
		 * @returns 宿主返回的 JSON 对象（形如 `{ ok: true, wallets, readAt }`）。
		 */
		async function readBalance(identity) {
			let lastError
			for (const url of readUrls()) {
				const controller = typeof AbortController === 'function' ? new AbortController() : undefined
				const timer = setTimeout(() => controller?.abort(), FETCH_TIMEOUT_MS)
				try {
					const response = await doFetch(url, {
						method: 'POST',
						// 简单请求：CORS 安全列表内的 content-type，桌面端不需要预检。
						headers: { 'content-type': 'text/plain;charset=UTF-8' },
						body: JSON.stringify(identity ?? {}),
						signal: controller?.signal,
					})
					const payload = await response.json()
					if (payload !== null && typeof payload === 'object') return payload
					lastError = `宿主返回了无法解析的响应（HTTP ${response.status}）`
				} catch (error) {
					lastError = error instanceof Error ? error.message : String(error)
				} finally {
					clearTimeout(timer)
				}
			}
			return { ok: false, reason: 'network', error: `无法访问宿主的余额接口：${lastError ?? '未知原因'}` }
		}

		/* ------------------------------------------------------------ 样式 --- */

		/**
		 * 一次性样式。数值全部来自宿主渲染时注入的 CSS 变量（见 `apply()`），
		 * 所以调位置/磨砂/不透明度只改 `cordis.patch.yml`，不用动这里。
		 */
		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return
			const style = document.createElement('style')
			style.id = STYLE_ID
			style.textContent = [
				'.dsbal-wrap{position:fixed;z-index:40;display:flex;align-items:stretch;gap:8px;pointer-events:auto;-webkit-app-region:no-drag;cursor:grab}',
				// 退路模式：取不到 react-dom 时仍是 composer 里的绝对定位，行为不变。
				'.dsbal-wrap[data-space=parent]{position:absolute;bottom:var(--dsbal-offset-y,18px);z-index:6}',
				'.dsbal-wrap[data-space=parent][data-side=left]{left:calc(50% - var(--dsh-composer-card-max-width,952px) / 2 + var(--dsbal-offset-x,10px))}',
				'.dsbal-wrap[data-space=parent][data-side=right]{right:calc(50% - var(--dsh-composer-card-max-width,952px) / 2 + var(--dsbal-offset-x,10px))}',
				// 零尺寸锚点：留在 composer 下面那条 dock 里，用来量 composer 的视口位置。
				'.dsbal-anchor{position:absolute;width:0;height:0;pointer-events:none}',
				// Ctrl + 左键拖动：按住 Ctrl 时给抓手光标当提示，拖动中换成抓紧的抓手，
				// 并把两层表面一起换成蓝色描边作为「正在移动」的反馈。
				'.dsbal-wrap[data-armed=true]{cursor:grab}',
				'.dsbal-wrap[data-dragging=true]{cursor:grabbing}',
				'.dsbal-wrap[data-dragging=true] .dsbal-card,.dsbal-wrap[data-dragging=true] .dsbal-btn{box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#4176e6),0 6px 18px rgba(0,0,0,.22)}',
				'.dsbal-card{box-sizing:border-box;max-width:var(--dsbal-max-width,236px);min-width:150px;padding:8px 12px;border-radius:12px;position:relative;isolation:isolate;text-align:center;background:var(--dsbal-fill,rgba(0,0,0,.38));backdrop-filter:blur(var(--dsbal-blur,16px)) saturate(115%);-webkit-backdrop-filter:blur(var(--dsbal-blur,16px)) saturate(115%);box-shadow:0 0 0 .5px var(--dsw-alias-border-l2,rgba(255,255,255,.16)),0 4px 14px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary,#f5f6f7);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}',
				'.dsbal-card[data-state=loading]{color:var(--dsw-alias-label-secondary,#c9ccd1)}',
				'.dsbal-card[data-state=error]{color:var(--dsw-alias-state-error-primary,#e06c6c)}',
				'.dsbal-main{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
				// 次级行字号：优先用主题派生变量；没有它（主题没定义）时按
				// 「字号 ≤14 时低一档、>14 时低两档」自行算，与 DSH 的阶梯规则一致。
				'.dsbal-sub,.dsbal-note{margin-top:2px;color:var(--dsw-alias-label-tertiary,#a3a7ad);font-size:var(--dsh-content-font-size-secondary,calc(var(--dsh-content-font-size,14px) - 1px));line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
				'.dsbal-btn{box-sizing:border-box;width:40px;height:40px;flex:none;display:grid;place-items:center;padding:0;border-radius:50%;cursor:default;color:var(--dsw-alias-label-secondary,#c9ccd1);background:var(--dsbal-fill,rgba(0,0,0,.38));backdrop-filter:blur(var(--dsbal-blur,16px)) saturate(115%);-webkit-backdrop-filter:blur(var(--dsbal-blur,16px)) saturate(115%);border:0;box-shadow:0 0 0 .5px var(--dsw-alias-border-l2,rgba(255,255,255,.16)),0 4px 14px rgba(0,0,0,.16);transition:color .12s,box-shadow .12s}',
				'.dsbal-btn:hover:not([disabled]){color:var(--dsw-alias-label-primary,#f5f6f7);box-shadow:0 0 0 .5px var(--dsw-alias-state-business-primary,#4176e6),0 4px 14px rgba(0,0,0,.16)}',
				'.dsbal-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}',
				'.dsbal-btn[disabled]{cursor:default;opacity:.72}',
				'.dsbal-icon{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
				'.dsbal-btn[data-busy=true] .dsbal-icon{animation:dsbal-spin 1s linear infinite}',
				'@keyframes dsbal-spin{to{transform:rotate(360deg)}}',
				'@media (prefers-reduced-motion:reduce){.dsbal-btn[data-busy=true] .dsbal-icon{animation:none}}',
			].join('\n')
			document.head.appendChild(style)
		}

		/* --------------------------------------------------------- 刷新图标 --- */

		/**
		 * 刷新按键：两个圆弧 + 两个箭头，描边跟随文字色。
		 * 纯 SVG，不依赖任何图标包；`currentColor` 让它在悬停变亮时一起变。
		 */
		function RefreshIcon() {
			return React.createElement(
				'svg',
				{ className: 'dsbal-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
				React.createElement('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
				React.createElement('polyline', { points: '21 3 21 9 15 9' }),
			)
		}

		/* ------------------------------------------------------------- 卡片 --- */

		/**
		 * 余额卡片。
		 *
		 * 状态机很简单：`loading` / `ready` / `error`，三种状态都有内容可读——
		 * 加载时说「正在读取」，失败时说清是没登录、没 Key 还是网络不通，绝不
		 * 用一个 `0.00` 冒充余额。
		 *
		 * @param props - 宿主注入的配置（来自 `apply()` 的闭包，不是插槽 props）。
		 */
		function BalanceCard(props) {
			const { side, offsetX, offsetY, maxWidth, blurPx, surfaceOpacity, tint, showBonus, showSource, fetchOnMount, clockSeconds } = props
			const [state, setState] = React.useState(() => {
				const cached = readCache()
				return cached !== undefined && cached.ok === true ? cached : undefined
			})
			const [status, setStatus] = React.useState('idle')
			const [failure, setFailure] = React.useState(undefined)
			const [busy, setBusy] = React.useState(false)
			// 拖过就以「拖出来的位置」为准；没拖过则为 undefined，此时由 composer 角上的
			// 锚点算出默认位置（portal 之后 CSS 的 left/right 公式够不到 composer）。
			const [placed, setPlaced] = React.useState(() => readStoredPosition())
			const [armed, setArmed] = React.useState(false)
			const [dragging, setDragging] = React.useState(false)
			const alive = React.useRef(true)
			const wrapRef = React.useRef(null)
			const anchorRef = React.useRef(null)
			const drag = React.useRef(null)
			const draggedRef = React.useRef(placed !== undefined)

			React.useEffect(() => {
				ensureStyle()
				alive.current = true
				return () => {
					alive.current = false
				}
			}, [])

			/**
			 * 没拖过时的默认位置：贴着 composer 的左/右角。
			 *
			 * portal 之后卡片在 body 里，CSS 的 `calc(50% - …)` 够不到 composer，
			 * 所以在 composer 下面那条 dock 里留一个零尺寸锚点，用它的视口矩形换算。
			 */
			const defaultPosition = React.useCallback(() => {
				const anchor = anchorRef.current
				if (anchor === null || anchor === undefined) return undefined
				if (typeof anchor.getBoundingClientRect !== 'function') return undefined
				const rect = anchor.getBoundingClientRect()
				const element = wrapRef.current
				const width = element?.offsetWidth || maxWidth
				const height = element?.offsetHeight || 64
				const left = side === 'right' ? rect.right - width - offsetX : rect.left + offsetX
				const top = rect.bottom - height - offsetY
				return clampToViewport({ left, top }, width, height)
			}, [maxWidth, offsetX, offsetY, side])

			/** 没拖过时跟着 composer 走；拖过之后位置完全由拖动结果决定，缩放时只做视口夹取。 */
			React.useEffect(() => {
				const sync = () => {
					if (draggedRef.current) {
						const element = wrapRef.current
						setPlaced((current) => {
							if (current === undefined) return current
							const next = clampToViewport(current, element?.offsetWidth || maxWidth, element?.offsetHeight || 64)
							if (next.left === current.left && next.top === current.top) return current
							writeStoredPosition(next)
							return next
						})
						return
					}
					const next = defaultPosition()
					if (next !== undefined) setPlaced(next)
				}
				sync()
				window.addEventListener('resize', sync)
				return () => window.removeEventListener('resize', sync)
			}, [defaultPosition, maxWidth])

			/** 首帧用估算宽高，卡片挂载后按真实尺寸再校正一次。 */
			React.useEffect(() => {
				if (draggedRef.current || placed === undefined) return
				const next = defaultPosition()
				if (next === undefined) return
				if (Math.abs(next.left - placed.left) > 0.5 || Math.abs(next.top - placed.top) > 0.5) setPlaced(next)
			}, [defaultPosition, placed])

			/** 按住 / 松开 Ctrl 时给出「可拖动」的光标提示。 */
			React.useEffect(() => {
				const tracking = (event) => event.key === 'Control' || event.ctrlKey
				const onKeyDown = (event) => {
					if (tracking(event)) setArmed(true)
				}
				const onKeyUp = (event) => {
					if (!event.ctrlKey) setArmed(false)
				}
				const onBlur = () => setArmed(false)
				window.addEventListener('keydown', onKeyDown)
				window.addEventListener('keyup', onKeyUp)
				window.addEventListener('blur', onBlur)
				return () => {
					window.removeEventListener('keydown', onKeyDown)
					window.removeEventListener('keyup', onKeyUp)
					window.removeEventListener('blur', onBlur)
				}
			}, [])

			/** 页面自己的请求身份：版本/语言/时区，交给平台侧记录。 */
			const identity = React.useCallback(
				() => ({
					version: typeof window.__DSH_CLIENT_VERSION__ === 'string' ? window.__DSH_CLIENT_VERSION__ : '',
					locale: typeof navigator?.language === 'string' && navigator.language !== '' ? navigator.language : 'zh-CN',
					timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
				}),
				[],
			)

			const refresh = React.useCallback(async () => {
				setBusy(true)
				setStatus('loading')
				setFailure(undefined)
				const payload = await readBalance(identity())
				if (!alive.current) return
				setBusy(false)
				if (payload.ok === true) {
					setState(payload)
					setStatus('ready')
					writeCache(payload)
					return
				}
				setStatus('error')
				setFailure({
					reason: typeof payload.reason === 'string' ? payload.reason : 'failed',
					error: typeof payload.error === 'string' ? payload.error : '',
				})
			}, [identity])

			React.useEffect(() => {
				if (fetchOnMount !== true) return undefined
				void refresh()
				return undefined
			}, [fetchOnMount, refresh])

			/**
			 * Ctrl + 左键按住卡片开始拖动。
			 *
			 * 只有按着 Ctrl 才接管，否则左键该干嘛干嘛（点圆形按键刷新、以后若要选中
			 * 卡片上的文字也照旧）。所有监听都挂在 `window` 上：指针一旦滑出卡片，
			 * 事件就不会再回到这个元素，挂在自己身上会「拖着拖着就不动了」。
			 *
			 * portal 模式下位置是视口坐标，夹在 `[8px, 视口 - 尺寸 - 8px]` 之间，
			 * 与提示词工坊同一套边界；取不到 react-dom 时退回原来的容器坐标与旧边界。
			 */
			const onPointerDown = React.useCallback(
				(event) => {
					if (event.button !== 0 || event.ctrlKey !== true) return
					const element = wrapRef.current
					if (element === null || element === undefined) return
					const parent = element.offsetParent
					if (createPortal === undefined && (parent === null || parent === undefined)) return
					event.preventDefault()
					event.stopPropagation()
					// 只有 portal 模式才用视口坐标；退路模式仍用容器坐标，行为与改动前一致。
					const viewport = createPortal !== undefined && typeof element.getBoundingClientRect === 'function'
					const box = viewport ? element.getBoundingClientRect() : undefined
					const base = viewport ? { left: box.left, top: box.top } : { left: element.offsetLeft, top: element.offsetTop }
					// 位置一旦由拖动接管，就把 side 规则带来的 right/bottom 让开。
					element.style.right = 'auto'
					element.style.bottom = 'auto'
					element.style.left = `${Math.round(base.left)}px`
					element.style.top = `${Math.round(base.top)}px`
					drag.current = {
						pointerId: event.pointerId,
						origin: { x: event.clientX, y: event.clientY },
						base,
						bounds: viewport
							? { width: window.innerWidth, height: window.innerHeight }
							: { width: parent.clientWidth, height: parent.clientHeight },
						size: { width: element.offsetWidth, height: element.offsetHeight },
						moved: false,
					}
					setDragging(true)
					const onMove = (moveEvent) => {
						const info = drag.current
						if (info === null || moveEvent.pointerId !== info.pointerId) return
						const dx = moveEvent.clientX - info.origin.x
						const dy = moveEvent.clientY - info.origin.y
						if (!info.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
						info.moved = true
						let left
						let top
						if (viewport) {
							const next = clampToViewport({ left: info.base.left + dx, top: info.base.top + dy }, info.size.width, info.size.height)
							left = next.left
							top = next.top
						} else {
							left = clamp(info.base.left + dx, -info.size.width / 3, info.bounds.width - info.size.width / 3)
							top = clamp(info.base.top + dy, -info.size.height / 3, info.bounds.height - info.size.height)
						}
						element.style.left = `${Math.round(left)}px`
						element.style.top = `${Math.round(top)}px`
					}
					const onUp = () => {
						const info = drag.current
						drag.current = null
						window.removeEventListener('pointermove', onMove)
						window.removeEventListener('pointerup', onUp)
						window.removeEventListener('pointercancel', onUp)
						setDragging(false)
						if (info === null || info.moved !== true) return
						const next = viewport
							? { left: element.getBoundingClientRect().left, top: element.getBoundingClientRect().top }
							: { left: element.offsetLeft, top: element.offsetTop }
						draggedRef.current = true
						writeStoredPosition(next)
						setPlaced(next)
					}
					window.addEventListener('pointermove', onMove)
					window.addEventListener('pointerup', onUp)
					window.addEventListener('pointercancel', onUp)
				},
				[],
			)

			/** 双击卡片忘掉拖出来的位置，回到 config 里的初始位置。 */
			const onDoubleClick = React.useCallback(
				(event) => {
					if (event.ctrlKey !== true) return
					event.preventDefault()
					event.stopPropagation()
					clearStoredPosition()
					draggedRef.current = false
					setPlaced(defaultPosition())
				},
				[defaultPosition],
			)

			const ready = state !== undefined && state.ok === true
			const main = (() => {
				// 读失败时先说失败：一次失败的刷新不该继续用旧数字当「当前余额」，
				// 也不该用 0.00 冒充。旧结果只留在缓存里，供下一次成功前参考。
				if (status === 'error') return reasonText(failure?.reason)
				if (status === 'loading' && !ready) return '正在读取…'
				if (!ready) return '当前余额：点击刷新'
				return `当前余额：${amountLine(state.wallets)}`
			})()
			const when = ready ? clockOf(state.readAt, clockSeconds === true) : ''
			const sub = (() => {
				if (status === 'error') return failure?.error === '' ? '再点一次刷新试试' : failure.error
				if (!ready) return '点击右侧圆形按键读取'
				return when === '' ? '' : `（最后更新时间为 ${when}）`
			})()
			const note = (() => {
				if (!ready) return ''
				const parts = []
				if (showBonus === true) {
					const bonus = amountLine(state.bonusWallets)
					if (bonus !== '') parts.push(`赠送 ${bonus}`)
				}
				if (showSource === true) parts.push(sourceText(state.source))
				return parts.join(' · ')
			})()

			const cardState = status === 'error' ? 'error' : status === 'loading' && !ready ? 'loading' : 'ready'
			const label = cardState === 'error' ? '读取失败' : '刷新余额'
			const hint = dragging ? '松手放到这里' : '按住 Ctrl 拖动可移动；Ctrl 双击回到默认位置'
			const anchor = React.createElement('span', { ref: anchorRef, className: 'dsbal-anchor', 'aria-hidden': 'true' })
			// 位置一律用内联 left/top：portal 后它相对视口，退路模式下相对容器。
			// 还没测出位置时：portal 模式先藏起来（避免停在 body 左上角），退路模式交给 side 规则。
			const placedStyle = placed === undefined ? undefined : { left: `${placed.left}px`, top: `${placed.top}px`, right: 'auto', bottom: 'auto' }
			const hiddenStyle = placed === undefined && createPortal !== undefined ? { visibility: 'hidden' } : undefined

			const panel = React.createElement(
				'div',
				{
					ref: wrapRef,
					className: 'dsbal-wrap',
					'data-side': side,
					'data-space': POSITION_SPACE,
					'data-armed': armed ? 'true' : 'false',
					'data-dragging': dragging ? 'true' : 'false',
					title: hint,
					onPointerDown: onPointerDown,
					onDoubleClick: onDoubleClick,
					style: {
						...placedStyle,
						...hiddenStyle,
						'--dsbal-offset-x': `${offsetX}px`,
						'--dsbal-offset-y': `${offsetY}px`,
						'--dsbal-max-width': `${maxWidth}px`,
						'--dsbal-blur': `${blurPx}px`,
						'--dsbal-fill': `color-mix(in srgb, ${tint} ${Math.round(surfaceOpacity * 100)}%, transparent)`,
					},
				},
				React.createElement(
					'div',
					{ className: 'dsbal-card', 'data-state': cardState, role: 'status', 'aria-live': 'polite' },
					React.createElement('div', { className: 'dsbal-main', title: main }, main),
					sub === '' ? null : React.createElement('div', { className: 'dsbal-sub', title: sub }, sub),
					note === '' ? null : React.createElement('div', { className: 'dsbal-note' }, note),
				),
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'dsbal-btn',
						disabled: busy,
						'data-busy': busy ? 'true' : 'false',
						title: label,
						'aria-label': label,
						onClick: () => void refresh(),
					},
					React.createElement(RefreshIcon),
				),
			)

			// 锚点永远留在 composer 的 dock 里；卡片在 portal 模式下挂到 body，
			// 这样 fixed 的包含块是视口而不是 composer，才能全屏拖动。
			return React.createElement(
				React.Fragment,
				null,
				anchor,
				createPortal === undefined ? panel : createPortal(panel, document.body),
			)
		}

		/* -------------------------------------------------------------- 注册 --- */

		/** 需要的客户端服务：插槽注册表。 */
		const inject = ['slots']

		/** 把配置里的字符串转成数字，畸形值退回默认。 */
		const clampNum = (value, fallback, min, max) => {
			const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
			if (!Number.isFinite(parsed)) return fallback
			return Math.min(max, Math.max(min, parsed))
		}

		/** 通用钳制。 */
		const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

		/**
		 * 视口边界：与提示词工坊一致的 `[8px, 视口 - 元素尺寸 - 8px]`。
		 *
		 * @param position - 视口坐标。
		 * @param width - 卡片宽度。
		 * @param height - 卡片高度。
		 * @returns 夹进可视区域后的整数坐标。
		 */
		function clampToViewport(position, width, height) {
			const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
			const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight
			return {
				left: Math.round(clamp(position.left, VIEWPORT_MARGIN_PX, Math.max(VIEWPORT_MARGIN_PX, viewportWidth - width - VIEWPORT_MARGIN_PX))),
				top: Math.round(clamp(position.top, VIEWPORT_MARGIN_PX, Math.max(VIEWPORT_MARGIN_PX, viewportHeight - height - VIEWPORT_MARGIN_PX))),
			}
		}

		/** 只认这两侧；其余一律左下角。 */
		const sideOf = (value) => (String(value ?? '').trim().toLowerCase() === 'bottom-right' ? 'right' : 'left')

		/**
		 * 注册卡片。
		 *
		 * `conversation.composer.dock` 是 composer 下面那条横向 list 槽（内置的
		 * 「输出速度 / 缓存命中」小药丸也在里面）。它只在实际会话里渲染，所以新会话
		 * 空状态页不会多出一块东西。
		 *
		 * @param ctx - 客户端根上下文。
		 * @param config - 插件行配置（对象形状与 `cordis.patch.yml` 一致）。
		 */
		function apply(ctx, config) {
			const settings = config ?? {}
			ensureStyle()
			const options = {
				side: sideOf(settings.position),
				offsetX: clampNum(settings.offsetX, 10, 0, 400),
				offsetY: clampNum(settings.offsetY, 18, 0, 400),
				maxWidth: clampNum(settings.maxWidth, 236, 120, 520),
				blurPx: clampNum(settings.blurPx, 16, 0, 60),
				surfaceOpacity: clampNum(settings.surfaceOpacity, 0.42, 0.05, 1),
				tint: (() => {
					const raw = String(settings.tint ?? '').trim()
					return raw === '' || /[;{}<>]/u.test(raw) ? 'rgba(0,0,0,.38)' : raw
				})(),
				// 默认不显示「赠送余额」——这份额度很少真有余额，多一行只是噪声。
				// 想要就把 config 里的 showBonus 设成 true。
				showBonus: settings.showBonus === true,
				showSource: settings.showSource !== false,
				fetchOnMount: settings.fetchOnMount !== false,
				clockSeconds: settings.clockSeconds === true,
			}
			const Card = (props) => React.createElement(BalanceCard, { ...options, ...props })
			ctx.slots.inject('conversation.composer.dock', () =>
				ctx.slots.register({ name: 'conversation.composer.dock', id: 'deepseek-balance', order: 20 }, Card),
			)
		}

		exports.name = 'deepseek-balance'
		exports.inject = inject
		exports.apply = apply
		return module.exports
	},
})
