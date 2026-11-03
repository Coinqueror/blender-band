#!/usr/bin/env python3
"""blender-band's reader: prints one JSON object on stdout.

  gather.py status <outputs dir>...          jobs, sensors, the newest output
  gather.py still <path> <width>             a picture's thumbnail as an SVG
  gather.py flip <dir> <width> <name>...     a looping flipbook of frames
  gather.py video <path> <width>             a looping preview of a video
  gather.py wait <seconds> <pid>...          returns once one of the pids exits

Linux only: it reads /proc and /sys. Thumbnails run at the lowest CPU priority
and never touch the GPU, so a preview cannot trip a thermal guard.
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

IMAGE = re.compile(r"\.(png|jpe?g|webp)$", re.I)
VIDEO = re.compile(r"\.(mp4|mkv|webm|mov|avi)$", re.I)
FRAME = re.compile(r"^(.*?)(\d{2,})(\.[A-Za-z0-9]+)$")
AGENT = re.compile(r"^(claude|agy|antigravity|codex|gemini|aider|opencode|cursor-agent|goose)$", re.I)
SKIP_DIRS = {"_to_delete", "__pycache__", "node_modules", ".git"}
SVG_BUDGET = 120_000  # the desktop's Svg takes 131072 characters
SCAN_BUDGET = 60_000  # directory entries one search of the outputs folders reads at most
# CPU temperature sensors, best first: AMD, Intel, ARM boards, then the ACPI zone.
CPU_CHIPS = ["k10temp", "zenpower", "coretemp", "cpu_thermal", "soc_thermal", "acpitz"]
TAIL_BYTES = 96 * 1024


def read(path, default=None):
    try:
        with open(path, "r", errors="replace") as f:
            return f.read()
    except OSError:
        return default


def number(path):
    text = read(path)
    try:
        return int(text.strip()) if text is not None else None
    except ValueError:
        return None


def tail(path, size=TAIL_BYTES):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - size))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


# ---------------------------------------------------------------- processes


def proc_stat(pid):
    """(comm, state, ppid, start ticks) of a pid, or None."""
    text = read(f"/proc/{pid}/stat")
    if text is None:
        return None
    close = text.rfind(")")
    comm = text[text.find("(") + 1 : close]
    rest = text[close + 2 :].split()
    return comm, rest[0], int(rest[1]), int(rest[19])


def cmdline(pid):
    text = read(f"/proc/{pid}/cmdline", "")
    return [a for a in text.split("\0") if a != ""]


def all_pids():
    return [int(n) for n in os.listdir("/proc") if n.isdigit()]


def agent_of(pid, session_pid):
    """Who started a process: the first agent among its ancestors."""
    for _ in range(40):
        if pid <= 1:
            return None
        if pid == session_pid:
            return "this session"
        st = proc_stat(pid)
        if st is None:
            return None
        names = [st[0]] + [os.path.basename(a) for a in cmdline(pid)[:2]]
        for name in names:
            if AGENT.match(name):
                return "Claude" if name.lower() == "claude" else name
        pid = st[2]
    return None


def describe(argv):
    """Script, .blend and kind of a Blender command line."""
    script = blend = sock = None
    background = False
    for i, a in enumerate(argv):
        if a in ("-b", "--background"):
            background = True
        elif a in ("-P", "--python") and i + 1 < len(argv):
            script = argv[i + 1]
        elif a.endswith(".blend") and blend is None:
            blend = a
        m = re.search(r"blender_srv_([\w.-]+)\.sock", a)
        if m:
            sock = m.group(1)
    kind = "run" if background else "window"
    # A script that keeps Blender loaded between jobs (a "server") is idle unless a caller runs one.
    if script and re.search(r"server", os.path.basename(script), re.I):
        kind = "server"
    elif "--python-expr" in argv:
        script = script or "python expression"
    return kind, script, blend, sock


def progress_of(text):
    """Frame, samples, time left, saved files, an error and the last line of a log."""
    out = {}
    lines = text.splitlines()
    for line in reversed(lines):
        m = re.search(r"\bFra:(\d+)\b", line)
        if m:
            out["frame"] = int(m.group(1))
            s = re.search(r"\bSample (\d+)/(\d+)", line) or re.search(r"Rendering (\d+) / (\d+) samples", line)
            if s:
                out["sample"], out["samples"] = int(s.group(1)), int(s.group(2))
            r = re.search(r"Remaining:([\d:.]+)", line)
            if r:
                out["remaining"] = r.group(1).split(".")[0]
            break
        m = re.search(r"Append frame (\d+)", line)
        if m:
            out["frame"] = int(m.group(1))
            break
    saved = re.findall(r"Saved: '([^']+)'", text)
    if saved:
        out["saved"] = saved[-1]
    # An error counts only near the end: a server's log keeps old runs.
    recent = lines[-60:]
    if any(l.startswith("Traceback (most recent call last)") for l in recent):
        message = next((l for l in reversed(recent) if re.match(r"^[\w.]+(Error|Exception)\b", l)), "Python error")
        out["error"] = message[:300]
    last = next((l.strip() for l in reversed(lines) if l.strip() and not l.startswith(" ")), "")
    out["last"] = last[:300]
    return out


def server_file(text, pid):
    """The .blend a persistent server holds now, from its log."""
    start = text.rfind(f"ready pid={pid}")
    part = text[start:] if start >= 0 else text
    found = re.findall(r"file='([^']*)'|\[?opened (.+?\.blend)\]?$", part, re.M)
    for a, b in reversed(found):
        if a or b:
            return a or b
    return None


def thermal_of(log, kind):
    """The thermal guard's last word for this job's log, if any."""
    if log is None:
        return None
    path = log + ".thermal" if kind == "run" else os.path.join(os.path.dirname(log), "srv_thermal.log")
    text = tail(path, 4096).strip()
    return text.splitlines()[-1].strip() if text else None


def jobs(session_pid):
    pids = all_pids()
    clk = os.sysconf("SC_CLK_TCK")
    uptime = float(read("/proc/uptime", "0 0").split()[0])
    clients = []  # blender_srv.sh run / blender_run.sh callers, by argv
    for pid in pids:
        argv = cmdline(pid)
        if any(a.endswith("blender_srv.sh") for a in argv[:3]) and "run" in argv:
            clients.append((pid, argv))
    found = []
    for pid in pids:
        st = proc_stat(pid)
        if st is None or st[0] != "blender" or st[1] == "Z":
            continue
        argv = cmdline(pid)
        kind, script, blend, sock = describe(argv)
        try:
            log = os.readlink(f"/proc/{pid}/fd/1")
            log = log if log.startswith("/") and os.path.isfile(log) else None
        except OSError:
            log = None
        text = tail(log) if log else ""
        job = {
            "pid": pid,
            "kind": kind,
            "script": os.path.basename(script) if script else None,
            "blend": os.path.basename(blend) if blend else None,
            "seconds": max(0, int(uptime - st[3] / clk)),
            "isPaused": st[1] == "T",
            "log": log,
            "server": sock,
            "driver": None,
            "progress": progress_of(text) if text else {},
            "thermal": thermal_of(log, kind),
        }
        job["writing"] = open_outputs(pid)
        if kind == "server":
            held = server_file(text, pid)
            job["blend"] = os.path.basename(held) if held else job["blend"]
            for cpid, cargv in clients:
                i = cargv.index("run")
                if len(cargv) > i + 3 and cargv[i + 1] == sock:
                    job["script"] = os.path.basename(cargv[i + 3])
                    job["blend"] = os.path.basename(cargv[i + 2]) if cargv[i + 2] != "none" else job["blend"]
                    job["driver"] = agent_of(cpid, session_pid)
                    job["isBusy"] = True
            job.setdefault("isBusy", False)
        if job["driver"] is None:
            job["driver"] = starter(pid, st[2], session_pid)
        found.append(job)
    return found


def starter(pid, parent, session_pid):
    """The agent behind a Blender: its ancestors, or, when a service manager
    adopted it (systemd-run and the like), the live process its unit is named after."""
    parent_comm = (proc_stat(parent) or ("",))[0]
    if parent > 1 and parent_comm not in ("systemd", "init", "launchd"):
        return agent_of(parent, session_pid)
    cgroup = read(f"/proc/{pid}/cgroup", "")
    for m in re.finditer(r"-(\d+)\.(service|scope)\b", cgroup):
        owner = int(m.group(1))
        if proc_stat(owner) is not None:
            found = agent_of(owner, session_pid)
            if found:
                return found
    return None


def open_outputs(pid):
    """Pictures and videos a Blender holds open: what it is writing now."""
    out = []
    try:
        names = os.listdir(f"/proc/{pid}/fd")
    except OSError:
        return out
    for fd in names:
        try:
            target = os.readlink(f"/proc/{pid}/fd/{fd}")
        except OSError:
            continue
        if target.startswith("/") and (IMAGE.search(target) or VIDEO.search(target)):
            out.append(target)
    return out[:4]


def comfy_running():
    for pid in all_pids():
        main = next((a for a in cmdline(pid)[:3] if a.endswith("main.py")), None)
        if main is None:
            continue
        try:
            cwd = os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            cwd = ""
        if "comfy" in (main + cwd).lower():
            return True
    return False


# ---------------------------------------------------------------- sensors


def sensors(outputs):
    out = {"gpu": None, "cpu": None}
    hw = "/sys/class/hwmon"
    for name in sorted(os.listdir(hw)) if os.path.isdir(hw) else []:
        base = os.path.join(hw, name)
        chip = (read(os.path.join(base, "name"), "") or "").strip()
        if chip == "amdgpu" and out["gpu"] is None:
            hot = number(os.path.join(base, "temp2_input"))
            edge = number(os.path.join(base, "temp1_input"))
            dev = os.path.join(base, "device")
            out["gpu"] = {
                "tempC": round((hot if hot is not None else edge or 0) / 1000) if (hot or edge) else None,
                "label": "hotspot" if hot is not None else "edge",
                "busy": number(os.path.join(dev, "gpu_busy_percent")),
                "vramUsedMB": (number(os.path.join(dev, "mem_info_vram_used")) or 0) // 1048576 or None,
                "vramTotalMB": (number(os.path.join(dev, "mem_info_vram_total")) or 0) // 1048576 or None,
            }
        elif chip in ("i915", "xe") and out["gpu"] is None:
            t = number(os.path.join(base, "temp1_input"))
            if t is not None:
                out["gpu"] = {"tempC": round(t / 1000), "label": "GPU", "busy": None, "vramUsedMB": None, "vramTotalMB": None}
        elif chip in CPU_CHIPS:
            t = number(os.path.join(base, "temp1_input"))
            rank = CPU_CHIPS.index(chip)
            if t is not None and (out["cpu"] is None or rank < out["cpu"]["rank"]):
                out["cpu"] = {"tempC": round(t / 1000), "rank": rank}
    if out["cpu"] is not None:
        out["cpu"].pop("rank")
    if out["gpu"] is None and shutil.which("nvidia-smi"):
        try:
            line = subprocess.run(
                ["nvidia-smi", "--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5,
            ).stdout.splitlines()[0]
            t, u, used, total = [int(float(x)) for x in line.split(",")]
            out["gpu"] = {"tempC": t, "label": "GPU", "busy": u, "vramUsedMB": used, "vramTotalMB": total}
        except (OSError, IndexError, ValueError, subprocess.SubprocessError):
            pass
    cpu = (read("/proc/stat", "") or "").splitlines()[0].split()[1:]
    ticks = [int(x) for x in cpu]
    out["cpuTicks"] = [ticks[3] + (ticks[4] if len(ticks) > 4 else 0), sum(ticks)]
    mem = dict(re.findall(r"^(\w+):\s+(\d+)", read("/proc/meminfo", ""), re.M))
    out["ramMB"] = int(mem.get("MemAvailable", 0)) // 1024 or None
    out["ramTotalMB"] = int(mem.get("MemTotal", 0)) // 1024 or None
    target = next((d for d in outputs if os.path.isdir(d)), os.path.expanduser("~"))
    try:
        out["diskGB"] = shutil.disk_usage(target).free // 1024 ** 3
    except OSError:
        out["diskGB"] = None
    return out


# ---------------------------------------------------------------- outputs


def newest_output(outputs, extra):
    best = None  # (mtime, path)
    budget = SCAN_BUDGET
    home = os.path.realpath(os.path.expanduser("~"))
    for root in outputs:
        # A home folder or the file system's root is too wide to search every few seconds.
        if not os.path.isdir(root) or os.path.realpath(root) in (home, "/"):
            continue
        base_depth = root.rstrip("/").count("/")
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS]
            if dirpath.count("/") - base_depth >= 6:
                dirnames[:] = []
            budget -= len(filenames) + len(dirnames)
            if budget < 0:
                break
            for f in filenames:
                if IMAGE.search(f) or VIDEO.search(f):
                    p = os.path.join(dirpath, f)
                    try:
                        m = os.stat(p).st_mtime
                    except OSError:
                        continue
                    if best is None or m > best[0]:
                        best = (m, p)
    for p in extra:
        try:
            m = os.stat(p).st_mtime
        except OSError:
            continue
        if (IMAGE.search(p) or VIDEO.search(p)) and (best is None or m > best[0]):
            best = (m, p)
    if best is None:
        return None
    mtime, path = best
    d, name = os.path.split(path)
    item = {"path": path, "dir": d, "name": name, "mtimeMs": int(mtime * 1000), "size": os.path.getsize(path)}
    if VIDEO.search(name):
        item["kind"] = "video"
        return item
    m = FRAME.match(name)
    if m:
        prefix, digits, ext = m.groups()
        same = re.compile(re.escape(prefix) + r"\d{%d}" % len(digits) + re.escape(ext) + "$")
        names = sorted(n for n in os.listdir(d) if same.match(n))
        if len(names) >= 3:
            item.update(kind="sequence", frames=names[-2000:], count=len(names), stem=prefix.rstrip("_-. ") or prefix)
            return item
    item["kind"] = "still"
    return item


def status(outputs, session_pid):
    found = jobs(session_pid)
    extra = [j["progress"]["saved"] for j in found if j["progress"].get("saved")]
    extra += [p for j in found for p in j.get("writing", [])]
    return {
        "jobs": found,
        "sensors": sensors(outputs),
        "comfy": comfy_running(),
        "output": newest_output(outputs, extra),
    }


# ---------------------------------------------------------------- thumbnails


def lower_priority():
    try:
        os.nice(19)
    except OSError:
        pass


def jpeg_size(data):
    """(width, height) from a JPEG's frame header."""
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        length = int.from_bytes(data[i + 2 : i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7 : i + 9], "big"), int.from_bytes(data[i + 5 : i + 7], "big")
        i += 2 + length
    return None


def thumb(path, width, quality, tmp):
    """One small JPEG of a picture, or None."""
    out = os.path.join(tmp, f"t{abs(hash((path, width, quality)))}.jpg")
    # Whichever is installed, fastest first; Pillow last, in this process.
    tools = [
        ("vipsthumbnail", ["vipsthumbnail", path, "--size", f"{width}x", "-o", f"{out}[Q={quality},strip]"]),
        ("magick", ["magick", path, "-thumbnail", f"{width}x", "-strip", "-quality", str(quality), out]),
        ("convert", ["convert", path, "-thumbnail", f"{width}x", "-strip", "-quality", str(quality), out]),
        ("ffmpeg", ["ffmpeg", "-v", "error", "-y", "-i", path, "-vf", f"scale={width}:-2", "-q:v", str(max(2, min(31, (100 - quality) // 3))), out]),
    ]
    for name, cmd in tools:
        if not shutil.which(name):
            continue
        try:
            done = subprocess.run(cmd, capture_output=True, timeout=60).returncode == 0
        except (OSError, subprocess.SubprocessError):
            done = False
        if done and os.path.exists(out):
            with open(out, "rb") as f:
                return f.read()
    try:
        from PIL import Image  # noqa: PLC0415 - optional
        import io  # noqa: PLC0415

        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((width, width * 4))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=quality)
            return buf.getvalue()
    except Exception:  # noqa: BLE001 - Pillow missing or the file unreadable
        return None


def svg(frames, seconds_per_frame):
    """An SVG of JPEG frames: one picture, or a loop that shows the last when it cannot play."""
    size = jpeg_size(frames[-1]) or (320, 180)
    w, h = size
    n = len(frames)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">']
    for i, data in enumerate(frames):
        href = "data:image/jpeg;base64," + base64.b64encode(data).decode()
        if n == 1:
            parts.append(f'<image href="{href}" width="{w}" height="{h}"/>')
            continue
        values = ";".join("1" if k == i else "0" for k in range(n))
        times = ";".join(f"{k / n:.4f}" for k in range(n))
        parts.append(
            f'<image href="{href}" width="{w}" height="{h}" opacity="{1 if i == n - 1 else 0}">'
            f'<animate attributeName="opacity" values="{values}" keyTimes="{times}" calcMode="discrete" '
            f'dur="{n * seconds_per_frame:.2f}s" repeatCount="indefinite"/></image>'
        )
    parts.append("</svg>")
    return "".join(parts), w, h


def fit(make, paths, width, seconds_per_frame):
    """Thumbnails of paths as one SVG under the budget: smaller, then fewer, until it fits."""
    with tempfile.TemporaryDirectory(prefix="blender-band-") as tmp:
        for w, q in ((width, 62), (int(width * 0.8), 55), (int(width * 0.65), 50)):
            frames = [d for d in (make(p, w, q, tmp) for p in paths) if d]
            while frames:
                text, fw, fh = svg(frames, seconds_per_frame)
                if len(text) <= SVG_BUDGET:
                    return {"svg": text, "width": fw, "height": fh, "frames": len(frames)}
                if len(frames) <= 4:
                    break
                frames = frames[1::2] if len(frames) > 8 else frames[1:]
        return {"error": "the picture would not fit"}


def video_frames(path, n):
    """n evenly spaced timestamps of a video, or [] when it cannot be read yet."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=20,
        ).stdout.strip()
        duration = float(out)
    except (OSError, ValueError, subprocess.SubprocessError):
        return []
    if duration <= 0:
        return []
    return [duration * (i + 0.5) / n for i in range(n)]


def video_thumb(path, at):
    def make(_, w, q, tmp):
        out = os.path.join(tmp, f"v{w}_{at:.3f}.jpg")
        cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{at:.3f}", "-i", path, "-frames:v", "1",
               "-vf", f"scale={w}:-2", "-q:v", str(max(2, min(31, (100 - q) // 3))), out]
        if subprocess.run(cmd, capture_output=True, timeout=60).returncode != 0 or not os.path.exists(out):
            return None
        with open(out, "rb") as f:
            return f.read()
    return make


def video(path, width):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        return {"error": "install ffmpeg for video previews"}
    stamps = video_frames(path, 12)
    if not stamps:
        return {"error": "the video cannot be read yet"}
    makers = {f"{t:.3f}": video_thumb(path, t) for t in stamps}
    return fit(lambda key, w, q, tmp: makers[key](key, w, q, tmp), list(makers), width, 0.25)


def wait(seconds, pids):
    end = time.time() + seconds
    while time.time() < end:
        for pid in pids:
            st = proc_stat(pid)
            if st is None or st[1] == "Z":
                return {"ended": pid}
        time.sleep(2)
    return {"ended": None}


def main(argv):
    command = argv[1] if len(argv) > 1 else "status"
    if command == "status":
        outputs = [os.path.expanduser(d) for d in argv[2:] if d.strip()]
        result = status(outputs, os.getppid())
    elif command == "still":
        lower_priority()
        result = fit(lambda p, w, q, tmp: thumb(p, w, q, tmp), [argv[2]], int(argv[3]), 1)
    elif command == "flip":
        lower_priority()
        d, width, names = argv[2], int(argv[3]), argv[4:]
        result = fit(lambda p, w, q, tmp: thumb(p, w, q, tmp), [os.path.join(d, n) for n in names], width, 0.2)
    elif command == "video":
        lower_priority()
        result = video(argv[2], int(argv[3]))
    elif command == "log":
        result = progress_of(tail(argv[2]))
    elif command == "wait":
        result = wait(float(argv[2]), [int(p) for p in argv[3:]])
    else:
        result = {"error": f"unknown command {command}"}
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main(sys.argv)
