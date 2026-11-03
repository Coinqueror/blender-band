#!/usr/bin/env python3
"""blender-band's reader: prints one JSON object on stdout.

  gather.py status <outputs dir>...          jobs, sensors, the newest output
  gather.py still <path> <width>             a picture drawn as SVG shapes
  gather.py flip <dir> <width> <name>...     a looping flipbook of frames, as shapes
  gather.py video <path> <width>             a looping preview of a video, as shapes
  gather.py wait <seconds> <pid>...          returns once one of the pids exits

Linux only: it reads /proc and /sys. Thumbnails run at the lowest CPU priority
and never touch the GPU, so a preview cannot trip a thermal guard.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

IMAGE = re.compile(r"\.(png|jpe?g|webp)$", re.I)
VIDEO = re.compile(r"\.(mp4|mkv|webm|mov|avi)$", re.I)
FRAME = re.compile(r"^(.*?)(\d{2,})(\.[A-Za-z0-9]+)$")
AGENT = re.compile(r"^(claude|agy|antigravity|codex|gemini|aider|opencode|cursor-agent|goose)$", re.I)
# Python warnings and the like say nothing about what Blender is doing.
NOISE = re.compile(r"(Deprecation|User|Future|Runtime)Warning|^\s*warnings\.warn|^Read prefs|^Blender \d|^Blender quit")
# Blender 4.2+ prefixes log lines with a clock and a channel: "00:06.285  render  | ".
LOG_PREFIX = re.compile(r"^\d+:\d+\.\d+\s+[\w.]+\s+\|\s*")
# A video's name holds its frame range: spin_0001-0072.mp4.
RANGE_IN_NAME = re.compile(r"(\d{3,})-(\d{3,})\.\w+$")
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


def frame_range(argv):
    """[first, last] frame from -s/-e (with -a) or a single -f, when the command line says."""
    start = end = single = None
    for i, a in enumerate(argv[:-1]):
        value = argv[i + 1]
        if a in ("-s", "--frame-start") and value.isdigit():
            start = int(value)
        elif a in ("-e", "--frame-end") and value.isdigit():
            end = int(value)
        elif a in ("-f", "--render-frame") and value.isdigit():
            single = int(value)
    if single is not None:
        return [single, single]
    if start is not None and end is not None and end >= start and ("-a" in argv or "--render-anim" in argv):
        return [start, end]
    return None


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
        m = re.search(r"append frame (\d+)", line, re.I)
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
    last = next((l.strip() for l in reversed(lines) if l.strip() and not l.startswith(" ") and not NOISE.search(l)), "")
    out["last"] = LOG_PREFIX.sub("", last)[:300]
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
            "frames": frame_range(argv),
            "thermal": thermal_of(log, kind),
        }
        job["writing"] = open_outputs(pid)
        if job["frames"] is None:
            for path in job["writing"]:
                m = RANGE_IN_NAME.search(path)
                if m and int(m.group(2)) >= int(m.group(1)):
                    job["frames"] = [int(m.group(1)), int(m.group(2))]
                    break
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
        usage = shutil.disk_usage(target)
        out["diskGB"], out["diskTotalGB"] = usage.free // 1024 ** 3, usage.total // 1024 ** 3
    except OSError:
        out["diskGB"] = out["diskTotalGB"] = None
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
    dims = picture_size(path)
    if dims:
        item["width"], item["height"] = dims
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
#
# The desktop app's Svg drops <image> (it allows shapes, animation and filters
# only), so a picture is drawn as shapes: shrunk, reduced to a small palette,
# and each row written as colored line runs. A loop draws its first frame
# whole and, on top, only what each later frame changes.


def lower_priority():
    try:
        os.nice(19)
    except OSError:
        pass


def picture_size(path):
    """(width, height) of a PNG or JPEG from its header, without decoding it."""
    try:
        with open(path, "rb") as f:
            head = f.read(65536)
    except OSError:
        return None
    if head[:8] == b"\x89PNG\r\n\x1a\n" and len(head) >= 24:
        return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")
    if head[:2] == b"\xff\xd8":
        return jpeg_size(head)
    return None


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


def parse_ppm(data):
    """(w, h, rgb bytes) of a binary PPM (P6, 8 bits)."""
    fields, i = [], 2
    while len(fields) < 3:
        while data[i : i + 1].isspace():
            i += 1
        if data[i : i + 1] == b"#":
            i = data.index(b"\n", i) + 1
            continue
        j = i
        while not data[j : j + 1].isspace():
            j += 1
        fields.append(int(data[i:j]))
        i = j
    w, h, _ = fields
    start = i + 1
    return w, h, data[start : start + w * h * 3]


def pixels(path, width, at=None):
    """(w, h, [(r, g, b), ...]) of a picture or a video frame at `at` seconds, `width` wide; None when unreadable."""
    found = None
    if shutil.which("ffmpeg"):
        cmd = ["ffmpeg", "-v", "error"] + (["-ss", f"{at:.3f}"] if at is not None else [])
        cmd += ["-i", path, "-frames:v", "1", "-vf", f"scale={width}:-2:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        try:
            data = subprocess.run(cmd, capture_output=True, timeout=60).stdout
            if data:
                h = len(data) // (width * 3)
                found = (width, h, data[: width * h * 3])
        except (OSError, subprocess.SubprocessError):
            pass
    if found is None and at is None and (shutil.which("magick") or shutil.which("convert")):
        tool = "magick" if shutil.which("magick") else "convert"
        try:
            data = subprocess.run([tool, path + "[0]", "-resize", f"{width}x", "-depth", "8", "ppm:-"], capture_output=True, timeout=60).stdout
            if data.startswith(b"P6"):
                found = parse_ppm(data)
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    if found is None and at is None:
        try:
            from PIL import Image  # noqa: PLC0415 - optional

            with Image.open(path) as im:
                im = im.convert("RGB")
                im = im.resize((width, max(1, round(im.height * width / im.width))))
                found = (im.width, im.height, im.tobytes())
        except Exception:  # noqa: BLE001 - Pillow missing or the file unreadable
            pass
    if found is None:
        return None
    w, h, data = found
    return w, h, [tuple(data[i : i + 3]) for i in range(0, len(data), 3)]


def near(p, colors):
    return min(range(len(colors)), key=lambda j: (p[0] - colors[j][0]) ** 2 + (p[1] - colors[j][1]) ** 2 + (p[2] - colors[j][2]) ** 2)


def palette_of(pixels_, k, rounds=8):
    """k colors for the pixels: k-means from colors spread by brightness."""
    sample = pixels_[:: max(1, len(pixels_) // 5000)]
    ordered = sorted(set(sample), key=lambda c: c[0] * 3 + c[1] * 6 + c[2])
    if len(ordered) <= k:
        return ordered
    centers = [ordered[int(i * (len(ordered) - 1) / (k - 1))] for i in range(k)]
    for _ in range(rounds):
        sums = [[0, 0, 0, 0] for _ in centers]
        for p in sample:
            s = sums[near(p, centers)]
            s[0] += p[0]
            s[1] += p[1]
            s[2] += p[2]
            s[3] += 1
        centers = [(s[0] // s[3], s[1] // s[3], s[2] // s[3]) if s[3] else c for s, c in zip(sums, centers)]
    return centers


def indexed(pixels_, colors):
    cache = {}
    out = []
    for p in pixels_:
        i = cache.get(p)
        if i is None:
            i = cache[p] = near(p, colors)
        out.append(i)
    return out


def runs(indexes, w, h, mask=None):
    """Per palette index, the path data of its horizontal runs (only where mask is set, if given)."""
    paths = {}
    for y in range(h):
        row = y * w
        x = 0
        while x < w:
            if mask is not None and not mask[row + x]:
                x += 1
                continue
            i = indexes[row + x]
            start = x
            while x < w and indexes[row + x] == i and (mask is None or mask[row + x]):
                x += 1
            paths.setdefault(i, []).append(f"M{start} {y}h{x - start}")
    return paths


def drawn(paths, colors):
    return "".join(
        f'<path stroke="#{colors[i][0]:02x}{colors[i][1]:02x}{colors[i][2]:02x}" d="{"".join(d)}"/>' for i, d in paths.items()
    )


def svg_of(frames, w, h, colors, seconds_per_frame):
    n = len(frames)
    base = frames[0]
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" shape-rendering="crispEdges">',
        f'<g fill="none" stroke-width="1" transform="translate(0 0.5)">{drawn(runs(base, w, h), colors)}',
    ]
    times = ";".join(f"{j / n:.4f}" for j in range(n))
    for k in range(1, n):
        mask = [a != b for a, b in zip(frames[k], base)]
        values = ";".join("visible" if j == k else "hidden" for j in range(n))
        parts.append(
            f'<g visibility="hidden"><animate attributeName="visibility" values="{values}" keyTimes="{times}" '
            f'calcMode="discrete" dur="{n * seconds_per_frame:.2f}s" repeatCount="indefinite"/>'
            f"{drawn(runs(frames[k], w, h, mask), colors)}</g>"
        )
    parts.append("</g></svg>")
    return "".join(parts)


def shrink(grab, width):
    """A grabbed picture scaled down to width, each new pixel the average of the ones it covers."""
    w, h, px = grab
    if width >= w:
        return grab
    height = max(1, round(h * width / w))
    out = []
    for y in range(height):
        y0, y1 = y * h // height, max(y * h // height + 1, (y + 1) * h // height)
        for x in range(width):
            x0, x1 = x * w // width, max(x * w // width + 1, (x + 1) * w // width)
            r = g = b = n = 0
            for yy in range(y0, y1):
                row = yy * w
                for xx in range(x0, x1):
                    q = px[row + xx]
                    r += q[0]
                    g += q[1]
                    b += q[2]
                    n += 1
            out.append((r // n, g // n, b // n))
    return width, height, out


def shapes(grab, tries, seconds_per_frame):
    """The first of (width, frame count, colors) tries whose drawing fits the budget.

    Pictures are read once, at the first try's size and count; later tries shrink and thin those."""
    first = [g for g in grab(tries[0][0], tries[0][1]) if g is not None]
    if not first:
        return {"error": "the picture could not be read (install ffmpeg, ImageMagick or Pillow)"}
    first = [g for g in first if (g[0], g[1]) == (first[0][0], first[0][1])]
    for width, count, k in tries:
        grabs = [shrink(g, width) for g in spread(first, count)]
        w, h = grabs[0][0], grabs[0][1]
        colors = palette_of([p for g in grabs for p in g[2]], k)
        text = svg_of([indexed(g[2], colors) for g in grabs], w, h, colors, seconds_per_frame)
        if len(text) <= SVG_BUDGET:
            return {"svg": text, "width": w, "height": h, "frames": len(grabs)}
    return {"error": "the picture is too detailed to draw here"}


def spread(items, count):
    if len(items) <= count:
        return list(items)
    return [items[round((len(items) - 1) * i / (count - 1))] for i in range(count)]


def still(path):
    return shapes(lambda w, _: [pixels(path, w)], [(256, 1, 48), (224, 1, 40), (192, 1, 40), (160, 1, 32), (128, 1, 32)], 1)


def flip(paths):
    tries = [(160, 12, 32), (128, 12, 32), (128, 8, 28), (112, 6, 24), (96, 4, 24)]
    return shapes(lambda w, n: [pixels(p, w) for p in spread(paths, n)], tries, 0.2)


def probe(path):
    """(seconds, width, height) of a video, or None when it cannot be read yet."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
             "-of", "json", path],
            capture_output=True, text=True, timeout=20,
        ).stdout
        data = json.loads(out)
        duration = float(data["format"]["duration"])
        stream = (data.get("streams") or [{}])[0]
        return duration, stream.get("width"), stream.get("height")
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return None


def video(path):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        return {"error": "install ffmpeg for video previews"}
    probed = probe(path)
    if probed is None or probed[0] <= 0:
        return {"error": "Still being written: the preview plays once Blender finishes the video."}
    duration, w, h = probed
    tries = [(160, 12, 32), (128, 12, 32), (128, 8, 28), (112, 6, 24), (96, 4, 24)]
    made = shapes(lambda width, n: [pixels(path, width, duration * (i + 0.5) / n) for i in range(n)], tries, 0.25)
    minutes, seconds = divmod(int(round(duration)), 60)
    made["info"] = f"{minutes}:{seconds:02d}" + (f" · {w}×{h}" if w and h else "")
    return made


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
        result = still(argv[2])
    elif command == "flip":
        lower_priority()
        result = flip([os.path.join(argv[2], n) for n in argv[4:]])
    elif command == "video":
        lower_priority()
        result = video(argv[2])
    elif command == "log":
        result = progress_of(tail(argv[2]))
    elif command == "wait":
        result = wait(float(argv[2]), [int(p) for p in argv[3:]])
    else:
        result = {"error": f"unknown command {command}"}
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main(sys.argv)
