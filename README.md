# blender-band

A Claude Code mod for working with headless Blender: a **Blender side panel** beside the chat, and a **`blender_status` tool** Claude can call instead of polling with `ps`, `tail` and `sleep`.

The panel shows:

- **Jobs:** a card for every running Blender, with its script and `.blend`, how long it has run, and who started it (this session, another Claude session, agy, Codex, Gemini, ...). Its log gives frame and sample (Cycles and EEVEE). When the command line names the frames (`-s 1 -e 250 -a`), the card shows overall progress and time left. Each card has **Pause** / **Resume**, **Stop** (asks once more), and **Log**. A Python traceback shows in red with **Ask Claude**, which puts a question about the error in your prompt box without sending it.
- **Preview:** the newest render, with its size and resolution. A frame sequence plays as a looping flipbook, with ◀ ▶ to step through single frames. A video plays as a short looping preview with its length, and **Play** opens it in your player.
- **System:** GPU temperature with a chart of the last minutes and the warning level dashed, then meters for GPU load, VRAM, CPU, RAM and disk. A meter turns yellow, then red, as a limit nears, and says so in words too.
- **Finished:** the last jobs that ended, done or failed, with how long they took, kept across sessions.

It also toasts when a job finishes or fails, and when the GPU gets hot.

## Install

At the prompt of a terminal session:

```
/plugin install blender-band --marketplace Coinqueror/blender-band
```

From a shell:

```
claude plugin install blender-band --marketplace Coinqueror/blender-band
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `Coinqueror/blender-band`, then Add plugin.

## Use

- `/blender` opens or closes the panel. It also opens by itself when a Blender job starts.
- Ask Claude to check on a render. It calls `blender_status`, which can also wait (up to 9 minutes) for a running job to finish.

**Progress needs a log file.** Frame and sample progress come from Blender's own output, so they show when that output goes to a file:

```
blender -b scene.blend -a > render.log 2>&1
```

A job whose output goes to a terminal or a pipe still shows as running, without progress. Claude Code's background Bash commands write to a file, so they show progress.

**Finding outputs.** The panel looks for the newest picture or video in the session's folder (never in your whole home folder). It also looks in every folder a running Blender saves into, from its `Saved:` lines and the files it holds open, and remembers those folders for later sessions. Set *Outputs folders* to search specific folders instead.

## Options

In `/plugin` (or the desktop app's plugin settings):

| Option | Default | What it does |
| --- | --- | --- |
| Outputs folders | empty | Folders searched for renders, `;`-separated, `~` allowed. Empty: the session's folder plus the remembered save folders. |
| GPU warning temperature (C) | 85 | Yellow 6 °C below, red and a toast at it. |
| Low RAM warning (% of total) | 10 | Available RAM below this share turns yellow. |
| Low disk warning (GB) | 10 | Free disk below this turns red. |
| Refresh interval (seconds) | 5 | How often it reads processes, logs and sensors. |
| Open the panel when a job starts | on | |
| Open the panel when a session starts | off | |
| Your Blender wrapper scripts | empty | If you run Blender through scripts of your own (resource limits, thermal guards, queues), name them here, `;`-separated, e.g. `render.sh;blender_job.sh`. Claude is then refused when it runs the blender binary headless itself, and pointed at them. |

## Requirements

- **Linux.** It reads `/proc` and `/sys`. macOS and Windows are not supported.
- **python3**, which most Linux systems have.
- **For previews**, any one of: `vipsthumbnail` (libvips), ImageMagick, `ffmpeg`, or Python's Pillow. `ffmpeg` (with `ffprobe`) is needed for video previews. Without any of them, the panel shows the file name with an **Open** button.
- **GPU sensors:** AMD through `amdgpu` in `/sys`, NVIDIA through `nvidia-smi`, Intel Arc through `i915`/`xe` (temperature only).

In the desktop app the preview is drawn as shapes: the app does not show embedded pictures in a mod's drawings, so each frame is shrunk (to 256 px wide for a still, about 160 px for a loop), reduced to a small palette and drawn as colored runs. It is a preview, not full quality; **Open** and **Play** show the real file. In a terminal that shows pictures (kitty, Ghostty), a PNG render is shown directly.

Everything runs on your machine. The mod makes no network requests, and the thumbnails run at the lowest CPU priority without touching the GPU.

## License

MIT, see [LICENSE](LICENSE).
