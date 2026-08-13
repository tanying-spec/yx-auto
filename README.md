# 服务器优选工具

一个简化版的Cloudflare Workers优选工具，用来生成订阅链接。

GitHub: https://github.com/tanying-spec/yx-auto

## 主要功能

- 优选域名：内置了一些常用的优选域名
- 优选IP：持续采集 WeTest 历史 IPv4/IPv6，支持移动、联通、电信筛选
- GitHub优选：可以从GitHub仓库拉取IP列表
- 多协议支持：VLESS、Trojan、VMess
- 多客户端格式：Clash、Surge、Quantumult X等
- 运营商筛选：可以按移动/联通/电信筛选

### 默认优选 IP 源

- WeTest：实时三网 IPv4/IPv6 地址、线路和数据中心信息

Worker 每 15 分钟获取一次 WeTest，并将新结果按 IP 和端口去重合并到 KV 历史池。历史池最多保存 500 个 IP；超过上限时优先淘汰最久未出现的普通 IP，并优先保护 HKG、NRT 的 IPv6，保护组自身超过上限时才淘汰其中最老的记录。IPv6 优先占主要名额，IPv4 约保留 10%；仅选择移动时 HKG 优先，仅选择电信时 NRT 优先。最终订阅最多 50 个节点；单协议且仅启用优选 IP 时，为 1 个原生地址加最多 49 个历史优选 IP。

最终输出会全局检查 VLESS、Trojan 和 VMess 的节点名称；重名节点自动追加 `-02`、`-03` 等序号。

优选 IP 会按订阅当时的剩余节点名额动态取样。例如单协议、仅 TLS、同时启用优选域名与 IPv4/IPv6 时，通常生成 1 个原生地址、11 个优选域名、约 34 个 IPv6 和 4 个 IPv4，共 50 个节点。

部署时需创建 Cloudflare KV 命名空间，并将 Worker 的 KV 变量名绑定为 `WETEST_HISTORY`；再添加 Cron 触发器 `*/15 * * * *`，即可每 15 分钟主动采集。没有 KV 绑定时仍能生成订阅，但只能使用当次 WeTest 数据，无法累计历史。

## 部署

1. 去Cloudflare Dashboard，找到Workers & Pages
2. 创建个新Worker
3. 把`_worker.js`的代码复制进去
4. 保存部署就完事了

## 使用

打开你的Worker地址，会看到一个界面：

1. 填域名和UUID
2. 选协议（VLESS/Trojan/VMess）
3. 选客户端类型
4. 点按钮生成订阅链接

就这么简单。

## 订阅链接格式

生成的链接大概长这样：
```
https://your-worker.workers.dev/{UUID}/sub?domain=your-domain.com&epd=yes&epi=yes&egi=yes
```

可以通过`&target=`参数指定输出格式：
- `base64` - 默认格式
- `clash` - Clash配置
- `surge` - Surge配置  
- `quantumult` - Quantumult配置

## URL参数

所有配置都通过URL参数控制，不需要环境变量。

主要参数：
- `domain` - 你的域名（必填）
- `epd` - 启用优选域名（默认yes）
- `epi` - 启用优选IP（默认yes）
- `egi` - 启用GitHub优选（默认yes）
- `piu` - 自定义IP来源URL（可选）
- `ev` - 启用VLESS（默认yes）
- `et` - 启用Trojan（默认no）
- `mess` - 启用VMess（默认no，注意不是vm，会被屏蔽）
- `ipv4/ipv6` - IP版本选择（默认都开启）
- `ispMobile/ispUnicom/ispTelecom` - 运营商筛选（默认都开启）
- `target` - 输出格式（base64/clash/surge/quantumult）

## 注意事项

- 这只是一个订阅生成工具，不提供代理服务
- 生成的节点需要配合你自己的服务器使用
- UUID必须是标准格式（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）
- VMess参数用的是`mess`不是`vm`，因为`vm`会被某些地方屏蔽
