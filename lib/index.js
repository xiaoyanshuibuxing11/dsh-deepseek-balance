/**
 * dsh-deepseek-balance — 宿主半边。
 *
 * 只做一件事：把「当前 DeepSeek 余额」读出来，交给浏览器半边显示。读法有两条，
 * 由 `config.source` 选：
 *
 *   account  用 DSH 自己已登录的账号（`ctx.deepseekAccount.getBalance`）。
 *            这条路径不接触任何密钥：请求凭证只在宿主进程里，浏览器永远拿不到。
 *   api-key  用凭据服务里的 API Key（默认引用名 `DEEPSEEK_API_KEY`，即
 *            「设置 → 模型」里那个）请求开放平台的 `/user/balance`。
 *   auto     先试 account，拿不到再试 api-key；两条都不行就报出两条各自的原因。
 *
 * 结果通过一条只读 HTTP 路由交给页面：
 *
 *   GET /dsh-deepseek-balance/read
 *
 * 凭据解析、金额字符串、错误分类——余额本身从不落到 `localStorage`，也从不被
 * 插进 index.html：这个插件的宿主半边不贡献任何 index 注入行，页面上的一切
 * 都来自这一次 JSON 响应。
 *
 * 路由按来源白名单校验，只有本应用自己的文档能读（回环 HTTP 源、
 * `dsh-app://app`、`file://` 的 `null`），所以本机其它网页既读不到余额，
 * 也借不到 API Key。
 *
 * @module dsh-deepseek-balance
 */

/** 加载器行名。 */
export const name = 'deepseek-balance'

/** 本插件拥有的路由。 */
const ROUTE_READ = '/dsh-deepseek-balance/read'

/** 默认的开放平台地址与凭据引用名。 */
const DEFAULT_API_BASE = 'https://api.deepseek.com'
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEFAULT_TIMEOUT_MS = 15_000

/** 钱包金额保留的小数位，与平台 Web 的两位显示规则一致。 */
const MONEY_SCALE = 2

/* ------------------------------------------------------------- 值处理 --- */

/** 读一个服务，缺失时不抛。 */
function serviceOf(ctx, key) {
	try {
		return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
	} catch {
		return undefined
	}
}

/** 表驱动取第一个存在的服务名，缺失时返回 `undefined`。 */
function firstService(ctx, keys) {
	for (const key of keys) {
		const found = serviceOf(ctx, key)
		if (found !== undefined && found !== null) return found
	}
	return undefined
}

/** 数字配置，带默认值与范围钳制。 */
function num(value, fallback, min, max) {
	const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
	if (!Number.isFinite(parsed)) return fallback
	return Math.min(max, Math.max(min, parsed))
}

/** 字符串配置；空串与带 `;{}<>` 的取值一律退回默认（不能拿配置拼 CSS/HTML）。 */
function text(value, fallback) {
	const raw = String(value ?? '').trim()
	if (raw === '' || /[;{}<>]/.test(raw)) return fallback
	return raw
}

/** 服务名或来源名的候选：`a|b` 形式都接受。 */
function oneOf(value, allowed, fallback) {
	const raw = String(value ?? '').trim().toLowerCase()
	return allowed.includes(raw) ? raw : fallback
}

/**
 * 把平台/开放平台给的金额字符串按两位小数显示。
 *
 * 一律走整数运算，不引 `big.js`：余额是十进制字符串，两位显示只需要
 * 「四舍五入到分」，用不着大数库。解析不出来时原样返回，绝不制造一个假的 0。
 *
 * @param amount - 十进制金额字符串或数字。
 * @returns 两位小数的字符串。
 */
function money(amount) {
	const raw = String(amount ?? '').trim()
	if (raw === '') return ''
	if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return raw
	const value = Number(raw)
	if (!Number.isFinite(value)) return raw
	// 用定点字符串做四舍五入，避免二进制浮点在 .005 这类边界上抖。
	const negative = value < 0
	const fixed = Math.abs(value).toFixed(MONEY_SCALE + 2)
	const [whole, fraction = ''] = fixed.split('.')
	const digits = `${whole}${fraction}`
	const keep = digits.slice(0, digits.length - 2)
	const roundUp = Number(digits[digits.length - 2] ?? '0') >= 5
	const cents = BigInt(keep === '' ? '0' : keep) + (roundUp ? 1n : 0n)
	const text = cents.toString().padStart(MONEY_SCALE + 1, '0')
	const body = `${text.slice(0, text.length - MONEY_SCALE)}.${text.slice(-MONEY_SCALE)}`
	return negative && cents !== 0n ? `-${body}` : body
}

/* --------------------------------------------------------------- 来源 --- */

/**
 * 已登录账号里的钱包。
 *
 * `getBalance` 的返回是个独立结果信封：`null` 表示没登录或凭证在查询期间变了，
 * `{ status: 'failed' }` 表示平台侧失败，`{ status: 'ready' }` 才有金额。
 *
 * @param ctx - 插件上下文。
 * @param client - 账号请求身份（版本/语言/时区）。
 * @returns `{ ok: true, wallets, bonusWallets, currency }` 或 `{ ok: false, reason }`。
 */
async function readAccount(ctx, client) {
	const account = firstService(ctx, ['deepseekAccount', 'account'])
	if (account === undefined || typeof account.getBalance !== 'function') {
		return { ok: false, reason: 'unavailable', detail: '宿主没有 deepseekAccount 服务' }
	}
	let envelope
	try {
		envelope = await account.getBalance(client)
	} catch (error) {
		return { ok: false, reason: 'failed', detail: messageOf(error) }
	}
	if (envelope === null || envelope === undefined) {
		return { ok: false, reason: 'signed-out', detail: 'DSH 当前没有已登录的账号' }
	}
	if (envelope.status === 'failed') {
		return { ok: false, reason: 'failed', detail: '平台没有给出余额' }
	}
	if (envelope.status !== 'ready') {
		return { ok: false, reason: 'failed', detail: `未知的余额结果：${String(envelope.status)}` }
	}
	const wallets = Array.isArray(envelope.value) ? envelope.value : []
	const bonusWallets = Array.isArray(envelope.bonusWallets) ? envelope.bonusWallets : []
	if (wallets.length === 0 && bonusWallets.length === 0) {
		return { ok: false, reason: 'failed', detail: '平台返回了空钱包列表' }
	}
	return { ok: true, wallets, bonusWallets, currency: wallets[0]?.currency ?? bonusWallets[0]?.currency ?? 'CNY' }
}

/**
 * 用 API Key 读开放平台余额。
 *
 * @param ctx - 插件上下文。
 * @param settings - 已解析的插件配置。
 * @returns `{ ok: true, ... }` 或 `{ ok: false, reason, detail }`。
 */
async function readApiKey(ctx, settings) {
	const credentials = serviceOf(ctx, 'credentials')
	if (credentials === undefined || typeof credentials.resolve !== 'function') {
		return { ok: false, reason: 'unavailable', detail: '宿主没有 credentials 服务' }
	}
	const ref = text(settings.apiKeyEnv, DEFAULT_API_KEY_ENV)
	let resolved
	try {
		resolved = await credentials.resolve(ref)
	} catch (error) {
		return { ok: false, reason: 'failed', detail: messageOf(error) }
	}
	const key = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
	if (key === '') {
		return { ok: false, reason: 'no-key', detail: `没有配置 ${ref}` }
	}

	const base = text(settings.apiBase, DEFAULT_API_BASE).replace(/\/+$/u, '')
	const timeout = num(settings.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000)
	let response
	try {
		response = await fetch(`${base}/user/balance`, {
			method: 'GET',
			headers: { accept: 'application/json', authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(timeout),
		})
	} catch (error) {
		return { ok: false, reason: 'network', detail: messageOf(error) }
	}
	let payload
	try {
		payload = await response.json()
	} catch {
		payload = undefined
	}
	if (!response.ok) {
		const upstream = typeof payload?.error?.message === 'string' ? payload.error.message : ''
		return {
			ok: false,
			reason: response.status === 401 || response.status === 403 ? 'rejected' : 'failed',
			detail: upstream === '' ? `HTTP ${response.status}` : `HTTP ${response.status}：${upstream}`,
		}
	}
	if (payload === null || typeof payload !== 'object') {
		return { ok: false, reason: 'failed', detail: '开放平台返回了无法解析的响应' }
	}
	const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : []
	if (infos.length === 0) {
		return { ok: false, reason: 'failed', detail: '开放平台没有给出余额条目' }
	}
	return {
		ok: true,
		available: payload.is_available !== false,
		source: 'api-key',
		wallets: infos.map((info) => ({
			currency: info?.currency ?? 'CNY',
			balance: money(info?.total_balance),
		})),
		bonusWallets: infos
			.map((info) => ({ currency: info?.currency ?? 'CNY', balance: money(info?.granted_balance) }))
			.filter((wallet) => Number(wallet.balance) > 0),
		currency: infos[0]?.currency ?? 'CNY',
		keySource: typeof resolved?.source === 'string' ? resolved.source : undefined,
	}
}

/** 错误文本，永不抛。 */
function messageOf(error) {
	if (error instanceof Error) return error.message
	return String(error ?? 'unknown')
}

/* -------------------------------------------------------------- 请求 --- */

/**
 * 组装本次请求的账号身份。
 *
 * 平台用这三个字段写请求头（版本、语言、时区），所以它们必须存在；页面会给
 * 真实值，缺失时退回宿主自己的默认值，而不是让请求带着 `undefined` 出去。
 *
 * @param body - 请求体（可能是 `null`）。
 * @returns 账号请求身份。
 */
function clientMetadata(body) {
	const source = body !== null && typeof body === 'object' ? body : {}
	const version = typeof source.version === 'string' && source.version.trim() !== '' ? source.version.trim() : '0.0.0'
	const locale = typeof source.locale === 'string' && source.locale.trim() !== '' ? source.locale.trim() : 'zh-CN'
	const offset = Number(source.timezoneOffsetSeconds)
	return {
		version,
		locale,
		timezoneOffsetSeconds: Number.isFinite(offset) ? Math.trunc(offset) : -new Date().getTimezoneOffset() * 60,
	}
}

/** 读一个请求体，超过上限就截断（这里只需要几个字段）。 */
function readBody(req, limit = 8_192) {
	return new Promise((resolve) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > limit) {
				resolve('')
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', () => resolve(''))
	})
}

/** 允许读余额的文档来源：本应用自己的页面。 */
function originAllowed(ctx, origin) {
	if (origin === 'null') return true
	if (origin === 'dsh-app://app') return true
	const port = serviceOf(ctx, 'webServer')?.port
	if (typeof port === 'number' && (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`)) return true
	// 桌面端在回环端口之外的载体上也可能是本机页面：只放行本机地址。
	try {
		const url = new URL(origin)
		return (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') && url.protocol === 'http:'
	} catch {
		return false
	}
}

/**
 * 只读余额路由。
 *
 * `GET` 或 `POST`：POST 会带上页面自己的版本/语言/时区，让平台侧记录更准确；
 * GET 也能用（退回宿主默认身份），方便在地址栏里手动确认一次。
 *
 * @param ctx - 插件上下文。
 * @param settings - 已解析的插件配置。
 * @returns 路由处理函数。
 */
function readHandler(ctx, settings) {
	return async (req, res) => {
		const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : undefined
		if (origin !== undefined && !originAllowed(ctx, origin)) {
			json(res, 403, { ok: false, reason: 'forbidden', error: `拒绝来自该来源的请求：${origin}` })
			return
		}
		const cors =
			origin === undefined
				? {}
				: {
						'access-control-allow-origin': origin,
						'access-control-allow-methods': 'GET, POST, OPTIONS',
						'access-control-allow-headers': 'content-type',
						'access-control-max-age': '600',
						vary: 'origin',
					}
		if (req.method === 'OPTIONS') {
			res.writeHead(204, cors)
			res.end()
			return
		}
		if (req.method !== 'GET' && req.method !== 'POST') {
			res.writeHead(405, { allow: 'GET, POST, OPTIONS', ...cors })
			res.end()
			return
		}

		let body = null
		if (req.method === 'POST') {
			const raw = await readBody(req)
			try {
				const parsed = JSON.parse(raw)
				body = parsed !== null && typeof parsed === 'object' ? parsed : null
			} catch {
				body = null
			}
		}
		const client = clientMetadata(body)
		const source = oneOf(settings.source, ['auto', 'account', 'api-key'], 'auto')

		const attempts = []
		let result
		if (source === 'account' || source === 'auto') {
			result = await readAccount(ctx, client)
			attempts.push({ source: 'account', ...failureOf(result) })
		}
		if ((result === undefined || result.ok !== true) && (source === 'api-key' || source === 'auto')) {
			const fallback = await readApiKey(ctx, settings)
			attempts.push({ source: 'api-key', ...failureOf(fallback) })
			if (fallback.ok === true) {
				result = fallback
			} else if (result === undefined || result.ok === true) {
				result = fallback
			} else if (result.reason === 'unavailable') {
				// 两条都失败时，报更像「真正原因」的那条。宿主缺服务是环境问题，
				// 而「没配 Key / 凭证被拒 / 网络不通」才是用户能处理的事。
				result = fallback
			}
		}
		if (result === undefined) {
			json(res, 500, { ok: false, reason: 'failed', error: '没有任何可用的余额来源' })
			return
		}
		if (result.ok !== true) {
			ctx.logger?.warn?.(`deepseek-balance: 读取失败（${source}）— ${attempts.map((a) => `${a.source}:${a.reason}`).join(', ')}`)
			json(res, 200, {
				ok: false,
				source: result.source ?? source,
				reason: result.reason ?? 'failed',
				error: describeFailure(result, attempts),
				attempts,
				readAt: Date.now(),
			})
			return
		}

		json(res, 200, {
			ok: true,
			source: result.source ?? (source === 'api-key' ? 'api-key' : 'account'),
			currency: result.currency ?? 'CNY',
			available: result.available !== false,
			wallets: (result.wallets ?? []).map((wallet) => ({
				currency: wallet?.currency ?? result.currency ?? 'CNY',
				balance: money(wallet?.balance),
			})),
			bonusWallets: (result.bonusWallets ?? []).map((wallet) => ({
				currency: wallet?.currency ?? result.currency ?? 'CNY',
				balance: money(wallet?.balance),
			})),
			readAt: Date.now(),
			attempts,
		})
	}
}

/** 失败项里能对外说的部分。 */
function failureOf(result) {
	if (result?.ok === true) return { ok: true }
	return { ok: false, reason: result?.reason ?? 'failed', detail: result?.detail ?? '' }
}

/** 把多条失败原因拼成一句给人看的话。 */
function describeFailure(result, attempts) {
	const failed = attempts.filter((attempt) => attempt.ok !== true)
	if (failed.length === 0) return result?.detail ?? '读取失败'
	if (failed.length === 1) {
		const [only] = failed
		return only.detail === '' ? labelOf(only.reason) : `${labelOf(only.reason)}：${only.detail}`
	}
	return failed.map((attempt) => `${attempt.source} — ${labelOf(attempt.reason)}`).join('；')
}

/** 失败分类的中文说法。 */
function labelOf(reason) {
	switch (reason) {
		case 'signed-out':
			return 'DSH 账号未登录'
		case 'no-key':
			return '没有配置 API Key'
		case 'rejected':
			return '凭证被拒绝'
		case 'network':
			return '网络不可达'
		case 'unavailable':
			return '宿主缺少账号/凭据服务'
		default:
			return '读取失败'
	}
}

/** 写一个 JSON 响应，永不抛。 */
function json(res, status, payload) {
	let text
	try {
		text = JSON.stringify(payload)
	} catch {
		text = '{"ok":false,"reason":"failed","error":"响应无法序列化"}'
	}
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': String(Buffer.byteLength(text)),
	})
	res.end(text)
}

/* --------------------------------------------------------------- 挂载 --- */

/**
 * 挂载余额路由。
 *
 * `ctx.inject(['webServer'], …)` 而不是直接取服务：回调在 HTTP 载体就绪时运行
 * （被替换也会重跑），所以本插件无论早于还是晚于载体激活都正确，在没有 HTTP
 * 载体的组合里则安静地什么都不做。
 *
 * @param ctx - 插件上下文。
 * @param config - `cordis.patch.yml` 里这一行的 `config`。
 */
export function apply(ctx, config) {
	const settings = config ?? {}
	ctx.inject(['webServer'], (child) => {
		let dispose
		try {
			dispose = child.webServer.register({
				kind: 'exact',
				path: ROUTE_READ,
				handler: readHandler(ctx, settings),
			})
		} catch (error) {
			ctx.logger?.warn?.(`deepseek-balance: 无法注册 ${ROUTE_READ} — ${messageOf(error)}`)
			return
		}
		child.effect(() => () => dispose())
		ctx.logger?.info?.(`deepseek-balance: 余额路由就绪 ${ROUTE_READ}（source=${oneOf(settings.source, ['auto', 'account', 'api-key'], 'auto')}）`)
	})
}
