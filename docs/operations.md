# 运行维护

本文对应[服务器部署](server-deployment.md)中的 systemd + Nginx + Docker / gVisor 结构。示例域名 `tensorv.example.com` 应替换为实际入口。

## 服务管理

```sh
sudo systemctl status tensorv --no-pager
sudo systemctl restart tensorv
sudo systemctl stop tensorv
sudo systemctl start tensorv
```

启用 `systemctl enable tensorv` 后，网关随服务器启动，不依赖 SSH 会话或管理员本地计算机保持在线。服务重启会丢弃所有执行快照；浏览器本地保存的脚本不受影响，用户需重新运行代码。

网关依赖 Docker 和 gVisor。服务停止后的 `ExecStopPost` 会清理经标签和名称确认属于 TensorV 的执行容器；另有清理计时器回收异常退出后的残留。两个机制依赖 Docker 可响应，主机或 Docker 故障后仍应检查实际回收结果。

检查定期清理状态：

```sh
sudo systemctl status tensorv-cleanup.timer --no-pager
sudo systemctl list-timers tensorv-cleanup.timer --all
sudo journalctl -u tensorv-cleanup.service --since '1 hour ago' --no-pager
```

计时器在启动约 90 秒后首次运行，随后约每 60 秒执行一次，回收创建超过 90 秒的 TensorV 容器。正常执行有独立的 20 秒默认超时；计时器用于故障后的补充清理。

## 健康与执行检查

公网入口检查：

```sh
curl -fsS https://tensorv.example.com/api/health
```

宿主机直接检查回环网关时，需要发送配置允许的 Host：

```sh
curl -fsS -H 'Host: tensorv.example.com' http://127.0.0.1:8765/api/health
```

`status: ok`、`mode: isolated` 表示公共网关响应。健康接口不执行用户代码、不创建会话，也不持续验证 Docker 状态。部署、主机更新或故障恢复后，还需在浏览器运行一个小型 Tensor 示例，并检查切片查询。

按实际资源监控 CPU、主机可用内存、磁盘空间、沙箱数量、429 / 5xx 响应以及证书有效期。公共服务不提供内建监控告警平台，需由部署环境接入。

## 日志

```sh
sudo journalctl -u tensorv --since '1 hour ago' --no-pager
sudo journalctl -u nginx --since '1 hour ago' --no-pager
sudo docker ps -a --filter label=app=tensorv-sandbox
```

公共网关默认不记录请求体、代码、Cookie 或快照。沙箱使用 `log-driver=none`，避免容器日志积累。Nginx 访问日志和系统日志仍应设置访问权限、轮转和保留周期；需要临时增加调试日志时，避免采集完整代码与会话令牌。

不要通过公开网页提供日志目录或 Docker 管理接口。错误详情应在受控运维渠道处理。

## 请求错误

| 状态码 | 常见原因 | 处理 |
| --- | --- | --- |
| 400 | 请求结构无效、切片参数错误或快照过期 | 重新运行脚本；检查客户端是否保留有效会话 |
| 403 | Host / Origin 与配置不符，或跨来源请求 | 核对公网协议、域名、端口及代理设置 |
| 409 | 同一会话仍有请求执行 | 等待上一请求完成；避免多标签页同时运行 |
| 413 | 请求体超过限制 | 缩减请求大小；代码最长为 20,000 字符 |
| 415 | 请求不是 JSON | 使用 `application/json` |
| 429 | 执行频率、会话数量、并发或入口限制 | 稍后重试；持续发生时评估负载和配额 |
| 503 | Docker / 隔离执行不可用，或连接资源不足 | 检查服务日志、Docker、runsc、镜像及主机资源 |
| 504 | 执行超时 | 简化代码；确认超时容器已回收 |

Nginx 也可能返回网关错误，应结合入口和应用日志定位。沙箱被内存或输出限制终止时，当前运行会失败，旧快照不会被恢复。

## 更新与回退

1. 记录当前发布目录、提交号、执行镜像 ID 和运行配置，并保留上一个可用发布。
2. 在新的目录构建前端和带独立版本标签的沙箱镜像。
3. 执行构建与测试，完成实际 gVisor 启动和资源边界验证。
4. 在维护窗口停止网关，切换 `/opt/tensorv/current` 和环境配置中的镜像标签。
5. 启动服务，检查日志、健康接口、浏览器执行和多会话隔离。
6. 验收失败时，恢复旧目录链接及旧镜像配置，重启服务并复验。

不要在运行中的发布目录直接覆盖文件，也不要使用同一可变镜像标签替换所有可回退版本。源码、前端构建产物和执行镜像应来自相同提交，避免网关和沙箱协议不一致。

证书续期应独立于应用发布管理。定期验证续期任务和 Nginx reload；过期证书会阻断正常浏览器访问。

## 异常容器与容量

正常执行完成、超时或输出超限后，执行容器会被强制删除。停止钩子和 `tensorv-cleanup.timer` 提供补充回收。若主机断电、Docker 故障或网关被强制终止，应检查残留容器与清理任务状态：

```sh
sudo docker ps -a --filter label=app=tensorv-sandbox
```

先停止网关并确认容器属于 TensorV 且没有有效任务，再按核实过的容器 ID 单独执行 `docker rm -f <container-id>`。不要批量删除宿主机上的其他容器或镜像。

会话快照缓存在网关内存中。默认每 IP 最多 2 个会话，容量不足时会提前回收空闲会话；900 秒空闲超时不是最低保留时间。会话数量、历史数据大小和 Python 对象开销共同决定网关内存占用。systemd 模板将网关限制为 256 MiB，执行容器则单独限制为 512 MiB；两者都不包括 Nginx、Docker 和操作系统的内存。持续出现资源不足时，应降低负载或增加资源，而不是取消隔离限制。

## 备份和恢复

应备份发布记录、运行配置、代理配置、证书管理配置，以及恢复部署所需的受控凭据。备份文件不应存放在 `dist/` 或提交到 Git 仓库。

用户脚本保存在其浏览器中，服务器没有账号级脚本库可供恢复。执行快照是临时状态，无需作为业务数据备份。更换域名或协议前，应通知用户从旧站点下载脚本；浏览器不会自动把旧来源的 localStorage 迁移到新来源。

## 安全事件

发现异常代码执行、隔离疑似失效或凭据泄露时，先停止公共执行入口并保留必要日志，再核对宿主机和控制面的影响范围。按受影响范围轮换凭据，修复后重建镜像并重新验证，不直接恢复未核实的执行环境。

已公开的访问地址应视为可被扫描的服务入口。保护措施应落在隔离、权限、更新、入口限制和资源管理上；删除 README 中的链接不能撤销已公开地址或代替事件处置。

返回 [README](../README.md) · [安全说明](../SECURITY.md)
