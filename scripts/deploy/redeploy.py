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
DONE_MARK = "__REDEPLOY_DONE__"
IDLE_TIMEOUT = 30 * 60     # 30 分钟无新输出视为卡死

C_RED, C_GRN, C_CYN, C_YEL, C_BLD, C_RST = (
    "\033[31m", "\033[32m", "\033[36m", "\033[33m", "\033[1m", "\033[0m")


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


def connect(conf: dict[str, str]) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(conf["SSH_HOST"], port=int(conf.get("SSH_PORT", 22)),
                   username=conf["SSH_USER"], password=conf["SSH_PASS"],
                   timeout=20, allow_agent=False, look_for_keys=False)
    return client


def sh(client: paramiko.SSHClient, cmd: str) -> tuple[str, int]:
    _in, out, _err = client.exec_command(cmd, timeout=60)
    text = out.read().decode("utf-8", "replace")
    return text, out.channel.recv_exit_status()


def start_remote(client: paramiko.SSHClient, app_dir: str, branch: str,
                 extra: list[str]) -> None:
    """用 setsid 后台起任务，SSH 立刻返回；进度靠日志轮询。"""
    say("启动服务器部署任务（后台运行，断线不影响）")
    script_args = " ".join(extra)
    cmd = (
        f"mkdir -p /root/servers && "
        f"test -f /tmp/redeploy-current.log && cp /tmp/redeploy-current.log "
        f"/tmp/redeploy-$(date +%Y%m%d-%H%M%S).log || true; "
        f": > {REMOTE_LOG}; "
        f"cd /root/servers && "
        f"APP_DIR={app_dir} BRANCH={branch} LOG={REMOTE_LOG} "
        f"setsid nohup bash {REMOTE_SCRIPT} {script_args} >> {REMOTE_LOG} 2>&1 < /dev/null & "
        f"disown $! 2>/dev/null; sleep 1; echo started"
    )
    out, rc = sh(client, cmd)
    if rc != 0 or "started" not in out:
        sys.exit(f"任务启动失败（rc={rc}）：{out}")
    ok("已启动，开始跟进日志")


def follow(client: paramiko.SSHClient) -> int:
    """SFTP 增量读日志，直到出现 DONE 标记。"""
    sftp = client.open_sftp()
    offset = 0
    last_size, last_change = 0, time.time()
    rc = 1
    try:
        while True:
            try:
                st = sftp.stat(REMOTE_LOG)
                size = st.st_size
            except IOError:
                size = 0
            if size != last_size:
                last_size, last_change = size, time.time()
            if size > offset:
                with sftp.open(REMOTE_LOG, "r") as fh:
                    fh.seek(offset)
                    chunk = fh.read(size - offset)
                offset = size
                text = chunk.decode("utf-8", "replace") if isinstance(chunk, bytes) else chunk
                for line in text.splitlines():
                    if line.startswith(DONE_MARK):
                        try:
                            rc = int(line.split("rc=")[1].strip())
                        except (IndexError, ValueError):
                            rc = 1
                        print()
                        return rc
                    print(line, flush=True)
            elif time.time() - last_change > IDLE_TIMEOUT:
                warn("30 分钟没有新输出，可能卡住了。服务器上看：tail -f " + REMOTE_LOG)
                return 1
            time.sleep(2)
    finally:
        sftp.close()


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
                client.exec_command("mkdir -p /root/servers")[1].read()
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
