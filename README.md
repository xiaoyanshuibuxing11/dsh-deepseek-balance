# DeepSeek Harness-deepseek-balance

在 DeepSeek Harness 对话区显示当前 DeepSeek 余额：一张半透明卡片加一个圆形刷新按钮，按住 Ctrl + 左键可以拖到屏幕任意位置。

## 功能

- 余额来源二选一：DeepSeek Harness 已登录账号（默认）或 API Key；`auto` 先问账号，失败再回退 Key。
- 卡片透明度、磨砂、位置由插件行 `config` 控制，默认 0.42 表面不透明度、16px 磨砂，与聊天背景风格一致。
- Ctrl + 左键拖动，位置存本窗口 `localStorage`；Ctrl + 双击回到配置的初始位置。
- 显示最后更新时间与余额来源；读取失败时给出分类原因，不用 `0.00` 冒充余额。
- 文字跟随 DeepSeek Harness 的「外观 → 字号」，不另造字号。

## 安装

1. 把本仓库放到本机任意目录。
2. 方式一：侧栏 → 插件 → 添加插件 → 粘贴本目录的绝对路径 → 安装 → 启用。
   方式二：在 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: deepseek-balance
         name: DeepSeek Harness-deepseek-balance
         config:
           source: auto
   ```

3. 重启 DeepSeek Harness，让宿主路由就绪。

## 配置

`config` 全部可省略：

| 键 | 默认 | 说明 |
|---|---|---|
| `source` | `auto` | `auto` / `account` / `api-key` |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据服务里的 API Key 引用名 |
| `apiBase` | `https://api.deepseek.com` | API Key 回退时的开放平台地址 |
| `timeoutMs` | `15000` | 单次余额请求超时 |
| `position` | `bottom-left` | 初始位置：`bottom-left` / `bottom-right` |
| `offsetX` / `offsetY` | `10` / `18` | 初始位置距对话区的像素偏移 |
| `maxWidth` | `236` | 卡片最大宽度 |
| `blurPx` | `16` | 卡片自身磨砂半径 |
| `surfaceOpacity` | `0.42` | 卡片表面不透明度 |
| `tint` | `rgba(0,0,0,.38)` | 卡片表面混合色 |
| `showBonus` / `showSource` | `false` / `true` | 是否显示赠送余额 / 余额来源 |
| `fetchOnMount` | `true` | 打开界面自动读一次 |
| `clockSeconds` | `false` | 最后更新时间是否显示秒 |

## 数据与隐私

- 余额请求由宿主进程发起；页面只接收金额字符串，API Key 不会进入页面。
- API Key 走 DeepSeek Harness 凭据服务，不写进配置文件；仓库不含任何密钥。
- `localStorage` 只存拖动位置（键 `DeepSeek Harness-deepseek-balance:position`）。

## 目录

```
.
├── lib/index.js       宿主半侧：余额路由（账号 / API Key）
├── lib/client.js      浏览器半侧：余额卡片、拖动、刷新
├── package.json       bundle 与 DeepSeek Harness.client 声明
└── cordis.patch.yml   装载器补丁
```
