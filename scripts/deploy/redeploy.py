#!/usr/bin/env python3
"""qq-farm-bot 一键部署：本机 git pull + 服务器拉代码/构建/重启/验证。

服务器端脚本以 setsid 后台运行，本机通过日志增量轮询跟进，
所以**本机断网、关窗口、SSH 掉线都不会中断部署**，重跑本脚本会续看进度。

用法：
    python scripts/deploy/redeploy.py                  # 全流程
    python scripts/deploy/redeploy.py --no-pull        # 本机不拉代码
    python scripts/deploy/redeploy.py --skip-build     # 服务器不重建镜像，只重启
    python scripts/deploy/redeploy.py --verify-only    # 只做健康验证
    python scripts/deploy/redeploy.py --attach         # 不启动新任务，只接着看当前日志

配置查找顺序：
    1. 本文件同目录的 .deploy.env（不入库，见 .deploy.env.example）
    2. .workbuddy/deploy/.deploy.env（Agent 工作区的私有副本）
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from pathlib import Path

try:
    import paramiko
except ImportError:                                       # pragma: no cover
    sys.exit("缺少 paramiko，先安装：pip install paramiko")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]                 # 仓库根
CONF_CANDIDATES = (HERE / ".deploy.env", ROOT / ".workbuddy" / "deploy" / ".deploy.env")
LOCAL_SCRIPT = HERE / "redeploy.sh"
REMOTE_SCRIPT = "/root/servers/redeploy.sh"
REMOTE_LOG = "/tmp/redeploy-current.log"
REMOTE_PID = "/tmp/redeploy.pid"
DONE_MARK = "__REDEPLOY_DONE__"
IDLE_TIMEOUT = 40 * 60     # 40 分钟无新输出视为卡死（首次构建最慢约 22 分钟）
BEAT_EVERY = 30            # 无新输出时每隔多少秒报一次心跳

# ---------------------------------------------------------------- 终端颜色
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _enable_ansi() -> bool:
    """Windows 10+ 的 cmd 需要显式打开 VT 处理，否则转义码会显示成乱码。"""
    if os.name != "nt":
        return sys.stdout.isatty()
    if not sys.stdout.isatty():
        return False
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if not k32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(k32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:                                     # noqa: BLE001
        return False


COLOR = _enable_ansi()
C_RED, C_GRN, C_CYN, C_YEL, C_BLD, C_RST = (
    ("\033[31m", "\033[32m", "\033[36m", "\033[33m", "\033[1m", "\033[0m")
    if COLOR else ("",) * 6)


def say(msg: str) -> None:
    print(f"\n{C_BLD}{C_CYN}==> {msg}{C_RST}", flush=True)


def ok(msg: str) -> None:
    print(f"{C_GRN}  OK  {msg}{C_RST}", flush=True)


def bad(msg: str) -> None:
    print(f"{C_RED} FAIL {msg}{C_RST}", flush=True)


def warn(msg: str) -> None:
    print(f"{C_YEL} WARN {msg}{C_RST}", flush=True)


def load_conf() -> dict[str, str]:
    conf_path = next((p for p in CONF_CANDIDATES if p.exists()), None)
    if conf_path is None:
        tried = "\n  ".join(str(p) for p in CONF_CANDIDATES)
        sys.exit("缺少部署配置，请复制模板后填写：\n"
                 f"  cp {HERE / '.deploy.env.example'} {HERE / '.deploy.env'}\n"
                 f"已查找路径：\n  {tried}")
    conf: dict[str, str] = {}
    for raw in conf_path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        k, v = raw.split("=", 1)
        conf[k.strip()] = v.strip()
    for need in ("SSH_HOST", "SSH_USER", "SSH_PASS"):
        if not conf.get(need):
            sys.exit(f"{conf_path} 缺少必填项：{need}")
    print(f"配置: {conf_path}")
    return conf


# ---------------------------------------------------------------- 本机 git
def git(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True,
                          encoding="utf-8", errors="replace", check=False)


def local_pull(branch: str) -> None:
    say("本机同步远程仓库")
    dirty = git(["status", "--porcelain"]).stdout.strip()
    stashed = False
    if dirty:
        print("  工作区有未提交改动，自动 stash：")
        for line in dirty.splitlines()[:10]:
            print("    " + line)
        if git(["stash", "push", "-u", "-m", "redeploy auto-stash"]).returncode != 0:
            sys.exit("git stash 失败，手动处理后重试")
        stashed = True

    if git(["fetch", "origin"]).returncode != 0:
        sys.exit("git fetch 失败（检查网络 / GitHub 凭据）")
    before = git(["rev-parse", "--short", "HEAD"]).stdout.strip()
    r = git(["merge", f"origin/{branch}", "--no-edit"])
    if r.returncode != 0:
        print(r.stdout, r.stderr)
        sys.exit("合并失败（可能有冲突），手动解决后重试")
    after = git(["rev-parse", "--short", "HEAD"]).stdout.strip()
    ok(f"本地 {before} -> {after}  {git(['log', '--oneline', '-1']).stdout.strip()}")

    if stashed:
        if git(["stash", "pop"]).returncode != 0:
            bad("stash pop 有冲突，本地改动还在 stash 里：git stash list / git stash pop")
        else:
            ok("本地改动已恢复")


# ---------------------------------------------------------------- SSH 交互
def connect(conf: dict[str, str]) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(conf["SSH_HOST"], port=int(conf.get("SSH_PORT", 22)),
                   username=conf["SSH_USER"], password=conf["SSH_PASS"],
                   timeout=20, allow_agent=False, look_for_keys=False)
    return client


def run_channel(client: paramiko.SSHClient, cmd: str,
                settle: float = 8.0) -> tuple[str, bool]:
    """执行命令并读走输出。

    **不能用 out.read()**：后台守护进程可能继承 SSH 通道的 fd，
    通道永远不 EOF，read() 会一直阻塞到超时。
    这里改成非阻塞收数据 + 静默 settle 秒后主动结束。
    """
    chan = client.get_transport().open_session()
    chan.settimeout(2.0)
    chan.exec_command(cmd)
    chunks: list[bytes] = []
    deadline = time.time() + settle
    while time.time() < deadline:
        if chan.recv_ready():
            chunks.append(chan.recv(65536))
            deadline = time.time() + settle
            continue
        if chan.exit_status_ready():
            while chan.recv_ready():
                chunks.append(chan.recv(65536))
            break
        time.sleep(0.15)
    finished = chan.exit_status_ready()
    chan.close()
    return b"".join(chunks).decode("utf-8", "replace"), finished


def sh(client: paramiko.SSHClient, cmd: str) -> tuple[str, int]:
    _in, out, _err = client.exec_command(cmd, timeout=60)
    text = out.read().decode("utf-8", "replace")
    return text, out.channel.recv_exit_status()


def deploy_alive(client: paramiko.SSHClient) -> bool:
    out, _ = run_channel(
        client, f"test -f {REMOTE_PID} && kill -0 $(cat {REMOTE_PID}) 2>/dev/null "
                f"&& echo alive || echo dead", settle=3)
    return "alive" in out


def start_remote(client: paramiko.SSHClient, app_dir: str, branch: str,
                 extra: list[str]) -> bool:
    """用 setsid 后台起任务，读走极少输出后立刻返回；进度靠日志轮询。

    返回 False 表示未启动新任务（已有任务在跑，直接接管进度）。
    """
    say("启动服务器部署任务")
    if deploy_alive(client):
        warn("服务器上已有部署任务在跑，不重复启动（1.6G 机器并行构建会互相拖死）")
        ok("直接接管它的进度")
        return False

    script_args = " ".join(extra)
    # 双重 fork：外包子 shell 立刻退出，孙进程的 stdout/stderr 指向日志，
    # 不占用 SSH 通道 → 本机不会卡在“已连接但没输出”。
    inner = (f"cd /root/servers && exec env APP_DIR={app_dir} BRANCH={branch} "
             f"LOG={REMOTE_LOG} setsid bash {REMOTE_SCRIPT} {script_args}")
    cmd = (
        f"mkdir -p /root/servers; "
        f"cp -f {REMOTE_LOG} /tmp/redeploy-$(date +%Y%m%d-%H%M%S).log 2>/dev/null; "
        f": > {REMOTE_LOG}; "
        f"( {inner} >> {REMOTE_LOG} 2>&1 < /dev/null & ) ; "
        f"echo launched"
    )
    out, _ = run_channel(client, cmd, settle=3)
    if "launched" not in out:
        sys.exit(f"任务启动失败，服务器返回：{out.strip() or '(空)'}")

    # 确认真的跑起来了：pid 文件出现 / 日志有首行
    for _ in range(15):
        time.sleep(1)
        if deploy_alive(client):
            ok("已启动，开始跟进日志")
            return True
        out, _ = run_channel(client, f"wc -c < {REMOTE_LOG} 2>/dev/null || echo 0", settle=2)
        if out.strip().isdigit() and int(out.strip()) > 0:
            ok("已启动，开始跟进日志")
            return True
    warn("已在服务器启动，但 15 秒内没检测到输出，继续跟进")
    return True


def follow(client: paramiko.SSHClient) -> int:
    """SFTP 增量读日志（二进制 + 行缓冲），直到出现 DONE 标记。"""
    sftp = client.open_sftp()
    offset = 0
    buf = b""
    rc: int | None = None
    last_data = time.time()
    next_beat = time.time() + BEAT_EVERY
    try:
        while rc is None:
            try:
                size = sftp.stat(REMOTE_LOG).st_size
            except IOError:
                size = 0

            if size > offset:
                with sftp.open(REMOTE_LOG, "rb") as fh:
                    fh.seek(offset)
                    buf += fh.read(size - offset)
                offset = size
                last_data = time.time()
                next_beat = time.time() + BEAT_EVERY

                *lines, buf = buf.split(b"\n")
                for raw in lines:
                    line = ANSI_RE.sub("", raw.decode("utf-8", "replace").rstrip("\r"))
                    if line.startswith(DONE_MARK):
                        try:
                            rc = int(line.split("rc=")[1].strip())
                        except (IndexError, ValueError):
                            rc = 1
                        print()
                        return rc
                    print(line, flush=True)
            else:
                now = time.time()
                if now - last_data > IDLE_TIMEOUT:
                    bad(f"{IDLE_TIMEOUT // 60} 分钟没有新输出，可能卡住了")
                    print(f"    服务器上看：tail -f {REMOTE_LOG}")
                    return 1
                if now > next_beat:
                    print(f"{C_YEL}  ... 仍在执行，已静默 {int(now - last_data)} 秒"
                          f"（日志 {size} 字节）{C_RST}", flush=True)
                    next_beat = now + BEAT_EVERY
                    # 任务进程没了又没写 DONE，说明被 OOM / 信号杀掉
                    if not deploy_alive(client):
                        print(f"    进程已退出且没有结束标记，最后 15 行：")
                        print(ansi_free_tail(client))
                        return 1
            time.sleep(1.5)
    finally:
        sftp.close()
    return rc if rc is not None else 1


def ansi_free_tail(client: paramiko.SSHClient) -> str:
    out, _ = sh(client, f"tail -15 {REMOTE_LOG} 2>/dev/null")
    return "\n".join("    " + ANSI_RE.sub("", ln) for ln in out.splitlines())


def main() -> int:
    conf = load_conf()
    branch = conf.get("BRANCH", "master")
    app_dir = conf.get("APP_DIR", "/root/docker/qq-farm-bot")
    args = set(sys.argv[1:])
    attach = "--attach" in args

    if not LOCAL_SCRIPT.exists():
        sys.exit(f"缺少服务器脚本：{LOCAL_SCRIPT}")

    if not attach and "--no-pull" not in args:
        local_pull(branch)
    elif attach:
        say("只跟进现有任务（--attach）")

    say("连接服务器")
    try:
        client = connect(conf)
    except Exception as exc:                              # noqa: BLE001
        sys.exit(f"SSH 连接失败：{exc}")
    ok(f"已连接 {conf['SSH_USER']}@{conf['SSH_HOST']}")

    try:
        if not attach:
            say("上传部署脚本")
            try:
                client.open_sftp().stat("/root/servers")
            except IOError:
                sh(client, "mkdir -p /root/servers")
            sftp = client.open_sftp()
            sftp.put(str(LOCAL_SCRIPT), REMOTE_SCRIPT)
            sftp.chmod(REMOTE_SCRIPT, 0o755)
            sftp.close()
            ok(f"{LOCAL_SCRIPT.name} -> {REMOTE_SCRIPT}")

            extra = [a for a in ("--skip-build", "--verify-only") if a in args]
            start_remote(client, app_dir, branch, extra)

        rc = follow(client)
    finally:
        client.close()

    print()
    if rc == 0:
        print(f"{C_BLD}{C_GRN}部署成功{C_RST}")
        print("提示：容器重启后账号需到面板手动点「启动」。")
    else:
        print(f"{C_BLD}{C_RED}部署未通过（rc={rc}），服务器日志 {REMOTE_LOG}{C_RST}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
