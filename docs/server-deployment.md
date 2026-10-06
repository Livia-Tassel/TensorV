# 服务器部署

本文部署允许匿名访问的公共执行服务。该模式与本地服务使用不同入口：反向代理提供 HTTPS，公共网关管理会话和请求，每次 Python 执行在独立 gVisor 容器中完成。

## 部署条件

| 项目 | 要求 |
| --- | --- |
| 主机 | Linux，支持 Docker 和 gVisor `runsc`，使用 systemd 管理服务 |
| 资源 | 建议至少 4 GiB 内存；2 GiB 主机应限制为单并发并按实际负载验证 |
| 构建工具 | Git、Node.js 20.19+ 或 22.12+、Docker |
| 网关运行环境 | Python 3.10+；宿主机网关不需要安装 PyTorch |
| 网络入口 | Nginx、可解析的域名、有效 TLS 证书 |
| 运维权限 | 可安装服务、管理 Docker、配置防火墙和证书续期 |

内存建议不是容量承诺。代码执行、容器启动、网关缓存和主机上的其他服务都会消耗资源；同机存在其他工作负载时，应额外预留空间。建议使用独立主机或虚拟机。

按对应发行版的 [Docker Engine 安装文档](https://docs.docker.com/engine/install/)准备容器环境，再按 [gVisor 安装文档](https://gvisor.dev/docs/user_guide/install/)安装并注册 `runsc`。当前 gVisor 发行包可能包含配套 `gvisor-bin/` 文件，部署时应保留完整布局。不要用普通 Docker 运行时代替 `runsc`。

## 部署结构

```text
/opt/tensorv/
  releases/<release>/     发布目录，包含 tensorv/、dist/、deploy/
  current -> releases/<release>
/etc/tensorv/public.env   环境配置
/etc/systemd/system/tensorv.service
/etc/nginx/sites-available/tensorv.conf
/etc/nginx/sites-enabled/tensorv.conf -> ../sites-available/tensorv.conf
```

运行账户为 `tensorv`。源码、前端资源、配置和服务定义应由管理员持有，运行账户只需读取。该账户通过 Docker 管理接口创建沙箱，因此其容器管理权限属于高权限控制面，不能视为普通无特权账户；不要向访客开放该接口。

仓库提供以下配置：

| 文件 | 用途 |
| --- | --- |
| `deploy/Dockerfile.sandbox` | 构建含 CPU PyTorch 的执行镜像 |
| `deploy/tensorv.service` | 公共网关的 systemd 服务 |
| `deploy/public.env.example` | 公网来源和执行镜像配置示例 |
| `deploy/nginx.conf` | HTTPS 入口、请求限制和回环代理模板 |
| `deploy/cleanup-sandboxes.py` | 按标签及名称核实并回收遗留执行容器 |
| `deploy/tensorv-cleanup.service`、`deploy/tensorv-cleanup.timer` | 定期清理任务 |

Nginx 路径采用 Debian / Ubuntu 的站点布局。其他发行版可将站点文件放入 `http` 上下文包含的目录，但不能同时在多个位置加载该模板，否则限流区域和站点定义会重复。上述服务与清理模板按同一 Docker 实例中运行一个 TensorV 服务设计。

## 构建和发布

在受控构建环境中获取源码、选择需要发布的提交，然后执行：

```sh
npm ci
npm run build
docker build -f deploy/Dockerfile.sandbox -t tensorv-sandbox:0.4.0 .
```

示例构建标签与 `deploy/public.env.example` 中的 `TENSORV_IMAGE` 一致。后续发布建议使用提交号作为镜像标签，并同步修改环境配置，以便更新和回退。Docker 镜像内安装 PyTorch；网关所在的宿主 Python 环境无需执行 `pip install -r requirements.txt`。

将 `tensorv/`、`dist/` 和 `deploy/` 放入一个新的发布目录，更新 `/opt/tensorv/current` 指向该目录。首次安装可在源码根目录执行：

```sh
release=$(git rev-parse --short=12 HEAD)
sudo install -d -m 0755 "/opt/tensorv/releases/$release"
sudo cp -R tensorv dist deploy "/opt/tensorv/releases/$release/"
sudo chown -R root:root "/opt/tensorv/releases/$release"
sudo ln -sfn "/opt/tensorv/releases/$release" /opt/tensorv/current
```

不要将 `.venv`、`node_modules`、临时日志、凭据或部署工作文件复制到公开静态目录 `dist/`。已有实例更新时，应先遵循[更新与回退](operations.md#更新与回退)流程，保留旧版本后再切换链接。

首次部署时创建专用账户，并赋予运行沙箱所需的 Docker 访问权限：

```sh
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin tensorv
sudo usermod -aG docker tensorv
sudo install -d -m 0755 /etc/tensorv
sudo install -o root -g root -m 0640 deploy/public.env.example /etc/tensorv/public.env
sudo install -m 0644 deploy/tensorv.service /etc/systemd/system/tensorv.service
sudo install -m 0644 deploy/tensorv-cleanup.service /etc/systemd/system/tensorv-cleanup.service
sudo install -m 0644 deploy/tensorv-cleanup.timer /etc/systemd/system/tensorv-cleanup.timer
```

若账户已存在，跳过 `useradd`。检查服务文件中的路径，并编辑 `/etc/tensorv/public.env`：

```ini
TENSORV_ORIGIN=https://tensorv.example.com
TENSORV_IMAGE=tensorv-sandbox:0.4.0
```

公网来源必须为完整协议、主机及可选端口，不能包含路径或末尾斜线；镜像名称必须与构建产物一致。环境文件由 systemd 管理器读取，可保持 `root:root`、`0640` 权限，不需要向运行账户开放写入或为其复制一份配置。

## 执行环境验证

在发布目录中，以服务账户验证 Docker 访问和实际 gVisor 启动：

```sh
cd /opt/tensorv/current
sudo -u tensorv python3 -c "from tensorv.sandbox import check_sandbox; print(check_sandbox(image='tensorv-sandbox:0.4.0'))"
```

使用其他版本标签时，同时修改上述检查命令中的镜像名称。检查会实际创建 `runsc` 容器、导入 PyTorch 并确认非 root 用户；不是只检查可执行文件是否存在。

公共网关启动时也会执行该检查。`runsc` 缺失、镜像不存在或启动验证失败时，网关拒绝启动，不回退到普通容器或宿主机执行。

## 公网入口

将 `deploy/nginx.conf` 安装到 `/etc/nginx/sites-available/tensorv.conf`，替换 `tensorv.example.com`、证书路径和按部署实际情况需要调整的监听配置。保留 Host 与 Origin 校验所需的来源一致性，并由代理**覆盖** `X-Forwarded-For` 为客户端地址；不要把访问者传入的该字段直接转发或追加。

先完成域名解析和证书签发，再启用 HTTPS 配置。模板的 ACME 验证目录为 `/var/lib/tensorv-acme`，证书名称为 `tensorv-public`。首次签发前先只启用模板中的 80 端口站点，保留 `/.well-known/acme-challenge/` 路径。已安装 Certbot 时，可执行：

```sh
sudo install -d -m 0755 /var/lib/tensorv-acme
sudo certbot certonly --webroot -w /var/lib/tensorv-acme \
  --cert-name tensorv-public -d tensorv.example.com
```

证书签发成功后再启用完整 HTTPS 站点配置，并创建站点链接：

```sh
sudo ln -s /etc/nginx/sites-available/tensorv.conf /etc/nginx/sites-enabled/tensorv.conf
```

若为初次证书验证已创建该链接，则保留现有链接。证书续期后应重新加载 Nginx。仅有 IP 的部署可以先准备可解析域名和证书，再公布访问地址。

启用代理前检查配置：

```sh
sudo nginx -t
sudo systemctl reload nginx
```

公网只需要开放 Web 入口；8765 为回环后端端口，不应在云防火墙或主机防火墙中公开。SSH 应按实际管理来源单独控制。不要为了调试而公开 Docker socket、Docker TCP API 或本地执行服务。

## 启动与验收

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tensorv-cleanup.timer
sudo systemctl enable --now tensorv
sudo systemctl status tensorv --no-pager
sudo systemctl status tensorv-cleanup.timer --no-pager
curl -fsS https://tensorv.example.com/api/health
```

健康接口返回公共模式状态，例如：

```json
{"status":"ok","ready":true,"mode":"isolated"}
```

健康检查不创建用户会话。首次执行才分配匿名会话；浏览器 Cookie 用于后续快照访问。会话不是用户账号，也不提供登录鉴权。

发布前还应完成以下验收：

1. 在浏览器运行默认示例，核对数值、步骤和高维切片。
2. 使用两个独立浏览器会话运行不同代码，确认不能读取对方快照。
3. 验证跨来源执行请求被拒绝，频率和并发限制有效。
4. 验证执行超时、超量输出和资源耗尽后，沙箱被销毁且后续正常代码可运行。
5. 验证执行环境不能访问宿主文件或外部网络，内部端口未公开。
6. 重启服务，确认进程受 systemd 管理、清理计时器启用，并检查证书续期与日志策略。

健康接口正常只表示 HTTP 网关可响应，不能替代实际执行及隔离验证。

## 默认资源策略

每次执行固定使用 gVisor、无外部网络、只读根文件系统和非 root 用户；不挂载宿主目录或 Docker socket。容器删除后，不保留用户文件或 Python 进程。

| 资源 | 默认限制 |
| --- | --- |
| CPU | 1 核配额 |
| 内存 | 512 MiB，不额外提供交换空间 |
| 进程数量 | 64 |
| 临时目录 | 64 MiB tmpfs，`noexec,nosuid,nodev` |
| 共享内存 | 8 MiB |
| 打开文件 | 128 |
| 执行等待 | 20 秒，包含 PyTorch 冷启动；Docker 创建和清理另有有界等待 |
| 沙箱 stdout + stderr | 合计 16 MiB |
| 历史数值 | 2 MiB，合计最多 100,000 个元素 |
| 执行轨迹 | 64 步、每步最多 16 个 Tensor |
| 已验证缓存序列化大小 | 每个会话最多 4 MiB；宿主对象实际内存还包含运行时开销 |

公共网关命令行默认最多 32 个会话、2 个执行并发、32 个连接，每 IP 最多 2 个会话。仓库部署配置使用更保守的 **8 个会话、1 个执行并发、24 个连接**，并以 systemd 将网关内存限制为 256 MiB。单次执行容器的内存由 Docker 另行限制，不包含在网关限额内。

会话空闲超时默认为 900 秒；达到单 IP 或全局会话数上限时，还会提前回收最久未使用且当前没有请求执行的会话。因此 900 秒不是快照保留承诺，用户可能需要重新运行代码。增加额度前先评估主机内存和单次沙箱成本。

执行 API 使用令牌桶限制：每会话和每 IP 容量各为 10 次，按每分钟 10 次补充；全局容量为 60 次，按每分钟 60 次补充。Nginx 模板额外将执行请求限制为每 IP 每分钟 10 次、突发额度 3，其他 API 请求为每 IP 每秒 5 次、突发额度 10。限制拒绝的请求不会排队，应根据返回提示稍后重试。

服务停止时通过 `ExecStopPost` 回收属于 TensorV 的执行容器；清理计时器约每 60 秒扫描一次，删除创建时间超过 90 秒的遗留容器。两个机制共同处理正常停止和网关异常退出后的资源回收，应随服务一同安装。

## 运行命令参考

需要前台诊断时，先停止占用相同端口的 systemd 服务，再以具备 Docker 权限的受控账户运行：

```sh
python3 -m tensorv.public_server \
  --origin https://tensorv.example.com \
  --host 127.0.0.1 --port 8765 \
  --image tensorv-sandbox:0.4.0 --runtime runsc \
  --trust-proxy-loopback \
  --max-sessions 8 --max-sessions-per-ip 2 --session-ttl 900 \
  --concurrency 1 --max-connections 24 --timeout 20
```

只有回环地址代理才能启用 `--trust-proxy-loopback`，且代理必须发送一个经过覆盖的合法客户端 IP。`--origin` 可重复指定多个明确允许的来源；不同来源的会话不能互用。

上线后的检查、更新和恢复见[运行维护](operations.md)。关于地址公开、代码保密和隔离风险，见[安全说明](../SECURITY.md)。
