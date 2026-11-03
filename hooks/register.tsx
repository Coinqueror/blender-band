import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BlenderJob, Finished, JobProgress, Output, Sensors, Snapshot, Thumb } from '../types'

const PANE = 'blender'
const TOOL = 'blender_status'

// Change a tag when its value's fields change: a reload then starts from null
// instead of reading what an older version stored.
const snapshot = atom({ plugin: 'blender-band', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })
const thumb = atom({ plugin: 'blender-band', key: 'thumb' } as const, null, { shape: 'thumb-2' })
const step = atom({ plugin: 'blender-band', key: 'step' } as const, null)
const stepThumb = atom({ plugin: 'blender-band', key: 'stepThumb' } as const, null, { shape: 'thumb-2' })
const history = atom({ plugin: 'blender-band', key: 'history' } as const, [], { shape: 'history-1' })
const confirmStop = atom({ plugin: 'blender-band', key: 'confirmStop' } as const, null)

type Options = {
  outputs: string[]
  hotWarnC: number
  lowRamPercent: number
  minDiskGB: number
  pollSeconds: number
  openOnJob: boolean
  openOnStart: boolean
  wrappers: string[]
}

type Status = { jobs: BlenderJob[]; sensors: Sensors; comfy: boolean; output: Output | null }
type Made = { svg: string; width: number; height: number; frames: number } | { error: string }

// Running the blender binary headless itself. `blender --version` and the like pass.
const RAW_BLENDER = /(^|[;&|(`]|\bthen|\bdo|\bexec|\bnohup|\bnice|\btimeout\s+\S+)\s*("?[^\s;&|"]*\/)?blender"?\s+[^;&|]*(-b\b|--background\b|--python\b|-P\s|\.blend\b)/
const STORE_DIRS = 'outputDirs'
const STORE_HISTORY = 'history'
const REMEMBERED_DIRS = 8
const HISTORY = 8

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Whether a command runs one of the person's wrapper scripts. */
const usesWrapper = (command: string) => options.wrappers.some(name => new RegExp(`(^|[\\s/;&|'"])${escape(name)}(\\s|$|['"])`).test(command))

const PREVIEW_PX = 320
const FLIP_FRAMES = 12

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path
const dirname = (path: string) => path.replace(/\/[^/]*$/, '') || '/'

const since = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

const gb = (mb: number) => (mb / 1024).toFixed(1)

const SPARK = '▁▂▃▄▅▆▇█'
function sparkline(values: number[], low: number, high: number): string {
  return values
    .map(v => SPARK[Math.max(0, Math.min(SPARK.length - 1, Math.round(((v - low) / (high - low)) * (SPARK.length - 1))))])
    .join('')
}

function bar(fraction: number, cells: number): string {
  const full = Math.max(0, Math.min(cells, Math.round(fraction * cells)))
  return '█'.repeat(full) + '░'.repeat(cells - full)
}

// Chart marks: the drawings carry no text (a picture cannot follow the app's
// light or dark theme), so these mid-tone fills read on either surface and
// every word beside them is a theme-colored Text.
type Severity = 'ok' | 'warning' | 'critical'
const FILL: Record<Severity, string> = { ok: '#3987e5', warning: '#fab219', critical: '#d03b3b' }
const COLOR: Record<Severity, 'warning' | 'error' | undefined> = { ok: undefined, warning: 'warning', critical: 'error' }
const clamp = (value: number) => Math.max(0, Math.min(1, value))

/** A thin meter: the fill carries severity, the track is the same hue, faint. */
function meterSvg(fraction: number, severity: Severity, width: number): string {
  const h = 6
  const w = clamp(fraction) * width
  const fill = FILL[severity]
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" width="${width}" height="${h}">` +
    `<rect width="${width}" height="${h}" rx="3" fill="${fill}" fill-opacity="0.22"/>` +
    (w > 0 ? `<rect width="${Math.max(h, w).toFixed(1)}" height="${h}" rx="3" fill="${fill}"/>` : '') +
    '</svg>'
  )
}

/** The GPU temperature over the last readings: a line with a faint area, the warning level dashed. */
function tempSvg(values: readonly number[], warnC: number, width: number, height: number, stepSeconds: number): string {
  // The scale hugs the readings (so a rise shows) while keeping the warning level in view.
  const lo = Math.min(Math.min(...values) - 8, warnC - 25)
  const hi = Math.max(warnC + 4, ...values)
  const right = width - 5 // room for the newest reading's dot
  const x = (i: number) => (values.length === 1 ? right : (i / (values.length - 1)) * right)
  const y = (v: number) => height - 2 - ((v - lo) / (hi - lo)) * (height - 4)
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  const last = values[values.length - 1] ?? lo
  const severity: Severity = last >= warnC ? 'critical' : last >= warnC - 6 ? 'warning' : 'ok'
  const slot = width / Math.max(1, values.length)
  const hits = values
    .map((v, i) => {
      const age = Math.round((values.length - 1 - i) * stepSeconds)
      return `<rect x="${(x(i) - slot / 2).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${height}" fill="transparent"><title>${v}°C, ${age === 0 ? 'now' : `${since(age)} ago`}</title></rect>`
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<line x1="0" x2="${width}" y1="${y(warnC).toFixed(1)}" y2="${y(warnC).toFixed(1)}" stroke="${FILL.critical}" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"/>` +
    (points.length > 1
      ? `<path d="M0,${height} L${points.join(' L')} L${width},${height} Z" fill="${FILL.ok}" fill-opacity="0.14"/>` +
        `<polyline points="${points.join(' ')}" fill="none" stroke="${FILL.ok}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
      : '') +
    `<circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4" fill="${FILL[severity]}"/>` +
    hits +
    '</svg>'
  )
}

/** How far a job is through its frames (with the current frame's samples), when its range is known. */
function overall(job: BlenderJob): number | null {
  const range = job.frames
  const frame = job.progress.frame
  if (!range || frame === undefined) return null
  const within = job.progress.sample !== undefined && job.progress.samples ? job.progress.sample / job.progress.samples : 0
  return clamp((frame - range[0] + within) / (range[1] - range[0] + 1))
}

/** Up to `count` names spread evenly over a list, its last always among them. */
function spread(names: readonly string[], count: number): string[] {
  if (names.length <= count) return [...names]
  const picked: string[] = []
  for (let i = 0; i < count; i++) {
    const name = names[Math.round(((names.length - 1) * i) / (count - 1))]
    if (name !== undefined) picked.push(name)
  }
  return picked
}

function title(job: BlenderJob): string {
  if (job.kind === 'server') {
    const file = job.blend ?? 'no file'
    return job.isBusy && job.script ? `${job.script} · ${file} (server)` : `server · ${file}`
  }
  if (job.kind === 'window') return `Blender window${job.blend ? ` · ${job.blend}` : ''}`
  return `${job.script ?? 'Blender'}${job.blend ? ` · ${job.blend}` : ''}`
}

function stateOf(job: BlenderJob): { word: string; color?: 'success' | 'warning' | 'error' } {
  if (job.progress.error) return { word: 'error', color: 'error' }
  if (job.isPaused) return { word: 'paused', color: 'warning' }
  if (job.kind === 'server' && !job.isBusy) return { word: 'idle' }
  return { word: 'running', color: 'success' }
}

function progressText(p: JobProgress): string {
  const parts: string[] = []
  if (p.frame !== undefined) parts.push(`frame ${p.frame}`)
  if (p.sample !== undefined && p.samples !== undefined) parts.push(`sample ${p.sample}/${p.samples}`)
  if (p.remaining !== undefined) parts.push(`${p.remaining} left`)
  return parts.join(' · ')
}

const driverText = (driver: string | null) =>
  driver === null ? null : driver === 'this session' ? 'started by this session' : `started by ${driver}`

/** The same picture's key: a new key makes a new preview. */
function outputKey(output: Output): string {
  return output.kind === 'sequence' ? `${output.dir}/${output.stem}:${output.count}` : `${output.path}:${output.mtimeMs}:${output.size}`
}

// Module state, reset by a reload.
let options: Options = {
  outputs: [],
  hotWarnC: 85,
  lowRamPercent: 10,
  minDiskGB: 10,
  pollSeconds: 5,
  openOnJob: true,
  openOnStart: false,
  wrappers: [],
}
// The folders searched for outputs: the configured ones, else the session's
// folder; plus the folders Blender was seen saving into, kept in $.store.
let searchDirs: string[] = []
let rememberedDirs: string[] = []
let previous: Map<number, BlenderJob> | null = null
let lastTicks: [number, number] | null = null
let isHotToasted = false
let inFlight: Promise<void> | null = null
let isThumbing = false
let lastFlipAt = 0
// What this session's Bash calls said they were starting, matched to the job
// that appears next.
let pendingIntent: { text: string; at: number } | null = null
const intents = new Map<number, string>()

async function gather<T>($: EngineInterface, args: string[], timeoutMs: number): Promise<T> {
  const ran = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/gather.py`, ...args], { timeoutMs })
  return JSON.parse(ran.stdout) as T
}

/** Opens the panel unasked, unless it is open already; a surface that cannot place it is left be. */
async function openPane($: EngineInterface): Promise<void> {
  try {
    const panes = await $.ui.panes()
    if (!panes.some(pane => pane.id === PANE)) await $.ui.open({ id: PANE, title: 'Blender' })
  } catch {
    // No surface, or none that places panes: /blender still opens it.
  }
}

async function finished($: EngineInterface, job: BlenderJob, at: number): Promise<void> {
  if (job.kind !== 'run') return
  // The log's last lines come after the final reading: read them once more.
  const last = job.log === null ? job.progress : await gather<JobProgress>($, ['log', job.log], 10000).catch(() => job.progress)
  const name = job.script ?? 'Blender job'
  $.ui.toast(
    last.error
      ? `Blender failed: ${name} after ${since(job.seconds)}: ${last.error}`
      : `Blender finished: ${name} after ${since(job.seconds)}`,
  )
  const entry: Finished = {
    pid: job.pid,
    name,
    blend: job.blend,
    isFailed: last.error !== undefined,
    ...(last.error === undefined ? {} : { error: last.error }),
    seconds: job.seconds,
    endedAt: at,
    log: job.log,
    driver: job.driver,
  }
  const list = await update($, history, old => [entry, ...old.filter(one => one.pid !== job.pid)].slice(0, HISTORY))
  await $.store.set(STORE_HISTORY, list).catch(() => undefined)
}

async function signal($: EngineInterface, pid: number, name: 'STOP' | 'CONT' | 'TERM'): Promise<void> {
  await $.process.run(['kill', `-${name}`, String(pid)])
  await poll($)
}

/** Puts a question about a failed job in the prompt box, unsent. */
async function askClaude($: EngineInterface, name: string, error: string, log: string | null): Promise<void> {
  await $.prompt.fill({
    text: `The Blender job ${name} failed with: ${error}${log ? `\nIts log is ${log}` : ''}\nWhat went wrong, and how do I fix it?`,
  })
}

/** One reading at a time: a call while one runs waits for that one. */
function poll($: EngineInterface): Promise<void> {
  inFlight ??= readOnce($).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function readOnce($: EngineInterface): Promise<void> {
  try {
    const raw = await gather<Status>($, ['status', ...searchDirs, ...rememberedDirs], 20000)
    const at = await $.clock.now()
    void remember($, raw.jobs)

    const [idle, total] = raw.sensors.cpuTicks
    const cpuBusy =
      lastTicks !== null && total > lastTicks[1] ? Math.round(100 * (1 - (idle - lastTicks[0]) / (total - lastTicks[1]))) : null
    lastTicks = [idle, total]

    const jobs = raw.jobs.map(job => {
      if (job.driver === 'this session' && !intents.has(job.pid) && pendingIntent !== null && at - pendingIntent.at < 120000) {
        intents.set(job.pid, pendingIntent.text)
        pendingIntent = null
      }
      const intent = intents.get(job.pid)
      return intent === undefined ? job : { ...job, intent }
    })

    const now = new Map(jobs.map(job => [job.pid, job]))
    if (previous !== null) {
      for (const [pid, job] of previous) {
        if (!now.has(pid)) {
          intents.delete(pid)
          void finished($, job, at)
        }
      }
    }
    const isNewJob = jobs.some(job => job.kind !== 'window' && (previous === null || !previous.has(job.pid)))
    previous = now
    if (isNewJob && options.openOnJob) void openPane($)

    const gpuC = raw.sensors.gpu?.tempC ?? null
    if (gpuC !== null && gpuC >= options.hotWarnC && !isHotToasted) {
      isHotToasted = true
      $.ui.toast(`GPU ${raw.sensors.gpu?.label ?? ''} at ${gpuC}°C (warning at ${options.hotWarnC}°C)`)
    } else if (gpuC !== null && gpuC < options.hotWarnC - 10) {
      isHotToasted = false
    }

    const before = await read($, snapshot)
    const gpuHistory = [...(before?.gpuHistory ?? []), ...(gpuC === null ? [] : [gpuC])].slice(-30)
    await update($, snapshot, () => ({ jobs, sensors: raw.sensors, cpuBusy, comfy: raw.comfy, output: raw.output, gpuHistory, at }))

    // A frame the person stepped to that belongs to another sequence: back to the newest.
    const stepped = await read($, step)
    if (stepped !== null && (raw.output?.kind !== 'sequence' || dirname(stepped) !== raw.output.dir)) {
      await update($, step, () => null)
    }
    if (raw.output !== null) void preview($, raw.output, at)
  } catch {
    // A failed read leaves the last snapshot standing; the next tick tries again.
  }
}

/** Keeps the folders running jobs save into, so their outputs are found after the jobs end. */
async function remember($: EngineInterface, jobs: readonly BlenderJob[]): Promise<void> {
  const seen = jobs.flatMap(job => [job.progress.saved, ...(job.writing ?? [])]).filter((p): p is string => p !== undefined)
  const dirs = [...new Set(seen.map(dirname))].filter(dir => !rememberedDirs.includes(dir) && !searchDirs.includes(dir))
  if (dirs.length === 0) return
  rememberedDirs = [...dirs, ...rememberedDirs].slice(0, REMEMBERED_DIRS)
  await $.store.set(STORE_DIRS, rememberedDirs).catch(() => undefined)
}

const isLowRam = (s: Sensors) => s.ramMB !== null && s.ramTotalMB !== null && s.ramMB < (s.ramTotalMB * options.lowRamPercent) / 100

async function preview($: EngineInterface, output: Output, at: number): Promise<void> {
  const key = outputKey(output)
  const current = await read($, thumb)
  if (isThumbing || current?.key === key) return
  // A sequence still rendering gets a new flipbook at most once a minute: drawing one takes seconds of CPU.
  const isSameSequence = output.kind === 'sequence' && current?.key.startsWith(`${output.dir}/${output.stem}:`) === true
  if (isSameSequence && at - lastFlipAt < 60000) return
  isThumbing = true
  try {
    const args =
      output.kind === 'still' ? ['still', output.path, String(PREVIEW_PX)]
      : output.kind === 'video' ? ['video', output.path, String(PREVIEW_PX)]
      : ['flip', output.dir, String(PREVIEW_PX), ...spread(output.frames ?? [], FLIP_FRAMES)]
    if (output.kind === 'sequence') lastFlipAt = at
    const made = await gather<Made>($, args, 180000)
    await update($, thumb, () => ({ key, ...made }))
  } catch {
    await update($, thumb, () => ({ key, error: 'the preview could not be made' }))
  } finally {
    isThumbing = false
  }
}

async function stepTo($: EngineInterface, path: string | null): Promise<void> {
  await update($, step, () => path)
  if (path === null) return
  const made = await gather<Made>($, ['still', path, String(PREVIEW_PX)], 60000).catch(
    (): Made => ({ error: 'the frame could not be read' }),
  )
  if ((await read($, step)) === path) await update($, stepThumb, () => ({ key: path, ...made }))
}

function openPath($: EngineInterface, path: string) {
  return () =>
    $.process.run([
      'sh',
      '-c',
      '( if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"; else open "$1"; fi ) >/dev/null 2>&1 &',
      'sh',
      path,
    ])
}

/** The plain-text status the tool answers with. */
function statusText(snap: Snapshot): string {
  const lines: string[] = []
  if (snap.jobs.length === 0) lines.push('No Blender is running.')
  for (const job of snap.jobs) {
    const state = stateOf(job)
    const who = driverText(job.driver)
    lines.push(`- pid ${job.pid}: ${title(job)}: ${state.word}, ${since(job.seconds)}${who ? `, ${who}` : ''}`)
    const progress = progressText(job.progress)
    const done = overall(job)
    if (progress) lines.push(`  progress: ${progress}`)
    if (done !== null && job.frames) {
      const eta = done > 0.02 ? `, about ${since((job.seconds * (1 - done)) / done)} left` : ''
      lines.push(`  overall: ${Math.round(done * 100)}% of frames ${job.frames[0]}-${job.frames[1]}${eta}`)
    }
    if (job.progress.error) lines.push(`  error in log: ${job.progress.error}`)
    if (job.isPaused) lines.push(`  stopped (SIGSTOP)${job.thermal ? `; thermal guard log: ${job.thermal}` : ''}`)
    if (job.progress.last && !job.progress.error) lines.push(`  last log line: ${job.progress.last}`)
    if (job.log) lines.push(`  log: ${job.log}`)
  }
  const s = snap.sensors
  if (s.gpu) {
    lines.push(
      `GPU: ${s.gpu.tempC ?? '?'}°C ${s.gpu.label} (warning at ${options.hotWarnC}°C), load ${s.gpu.busy ?? '?'}%` +
        (s.gpu.vramUsedMB !== null && s.gpu.vramTotalMB !== null ? `, VRAM ${gb(s.gpu.vramUsedMB)}/${gb(s.gpu.vramTotalMB)} GB` : ''),
    )
  }
  if (s.cpu || snap.cpuBusy !== null) lines.push(`CPU: ${s.cpu?.tempC ?? '?'}°C, load ${snap.cpuBusy ?? '?'}%`)
  if (s.ramMB !== null) lines.push(`RAM: ${gb(s.ramMB)} GB available${s.ramTotalMB !== null ? ` of ${gb(s.ramTotalMB)}` : ''}${isLowRam(s) ? ' (low)' : ''}`)
  if (s.diskGB !== null) lines.push(`Disk: ${s.diskGB} GB free${s.diskGB < options.minDiskGB ? ' (low)' : ''}`)
  if (snap.comfy) lines.push('ComfyUI is also running: it shares the GPU and RAM.')
  const o = snap.output
  if (o) {
    const what = o.kind === 'sequence' ? `frame sequence ${o.stem} (${o.count} frames, newest ${o.name})` : `${o.kind} ${o.name}`
    lines.push(`Newest output: ${what}, ${ago(snap.at - o.mtimeMs)}: ${o.path}`)
  }
  return lines.join('\n')
}

export const register: Register = (on, raw) => {
  const list = (value: unknown) =>
    (typeof value === 'string' ? value : '')
      .split(';')
      .map(item => item.trim())
      .filter(item => item !== '')
  options = {
    outputs: list(raw.outputsDir),
    hotWarnC: typeof raw.hotWarnC === 'number' ? raw.hotWarnC : 85,
    lowRamPercent: typeof raw.lowRamPercent === 'number' ? raw.lowRamPercent : 10,
    minDiskGB: typeof raw.minDiskGB === 'number' ? raw.minDiskGB : 10,
    pollSeconds: typeof raw.pollSeconds === 'number' && raw.pollSeconds >= 1 ? raw.pollSeconds : 5,
    openOnJob: raw.openOnJob !== false,
    openOnStart: raw.openOnStart === true,
    wrappers: list(raw.wrapperScripts),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'blender', description: 'Open or close the Blender panel' })
    await $.tool.register({
      name: TOOL,
      description:
        'Blender on this machine right now: each running Blender (script, .blend, who started it, frame/sample progress and time left from its log when its output goes to a file, paused, a Python error in its log, the log path), GPU temperature/load/VRAM, CPU, free RAM and disk, whether ComfyUI is running, and the newest render, frame sequence or video. Use it instead of ps, tail or sleep loops to check on a Blender job; pass waitSeconds to wait for a running job to finish.',
      inputSchema: {
        type: 'object',
        properties: {
          waitSeconds: {
            type: 'number',
            description: 'Wait up to this many seconds (at most 540) for a running headless job to end before answering. 0 or absent: answer now.',
          },
        },
      },
      isDeferred: false,
    })
    const ran = await next(e)
    searchDirs = options.outputs.length > 0 ? options.outputs : [await $.session.cwd()]
    const stored = await $.store.get(STORE_DIRS).catch(() => undefined)
    rememberedDirs = Array.isArray(stored) ? stored.filter((dir): dir is string => typeof dir === 'string').slice(0, REMEMBERED_DIRS) : []
    const past = await $.store.get(STORE_HISTORY).catch(() => undefined)
    if (Array.isArray(past) && (await read($, history)).length === 0) {
      const kept = past.filter((one): one is Finished => typeof one === 'object' && one !== null && typeof (one as Finished).name === 'string' && typeof (one as Finished).endedAt === 'number')
      await update($, history, () => kept.slice(0, HISTORY))
    }
    void poll($)
    $.clock.every(options.pollSeconds * 1000, () => {
      void poll($)
    })
    if (options.openOnStart) void openPane($)
    return ran
  })

  on('command.run', { command: 'blender' }, async $ => {
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'Blender panel closed.' }
    }
    await $.ui.open({ id: PANE, title: 'Blender', focus: true })
    void poll($)
    return { text: 'Blender panel opened.' }
  })

  on('tool.call', { tool: `mcp__blender-band__${TOOL}` }, async ($, e) => {
    const asked = (e as { waitSeconds?: unknown }).waitSeconds
    const seconds = typeof asked === 'number' && asked > 0 ? Math.min(540, asked) : 0
    await poll($)
    const before = await read($, snapshot)
    const running = (before?.jobs ?? []).filter(job => job.kind === 'run').map(job => String(job.pid))
    if (seconds > 0 && running.length > 0) {
      // A process in flight spends none of the hook's own time.
      await gather($, ['wait', String(seconds), ...running], (seconds + 30) * 1000)
      await poll($)
    }
    const snap = await read($, snapshot)
    const note = seconds > 0 && running.length === 0 ? 'No headless job was running to wait for.\n' : ''
    return { result: snap === null ? 'No reading yet: the sensors could not be read.' : note + statusText(snap) }
  }).catch(() => ({ result: 'blender_status failed to read the machine; try again, or read the job log directly.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isRaw = RAW_BLENDER.test(e.command)
    const isWrapped = usesWrapper(e.command)
    if (options.wrappers.length > 0 && isRaw && !isWrapped) {
      return {
        deny: `blender-band: run headless Blender through ${options.wrappers.join(' or ')}, not the blender binary itself; the person set those as their Blender wrapper scripts (the plugin option "Your Blender wrapper scripts").`,
      }
    }
    if (isRaw || isWrapped) {
      const text = typeof e.description === 'string' && e.description.trim() !== '' ? e.description.trim() : e.command.trim().slice(0, 120)
      pendingIntent = { text, at: await $.clock.now() }
    }
    return next(e)
    // A guard that fails lets the call through rather than blocking every Bash call.
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const snap = await read($, snapshot)
    if (snap === null) return <Text dimColor>Reading Blender jobs and sensors…</Text>
    const columns = Math.max(20, e.props.bodyColumns)
    // Pixels across the body where the surface draws pictures; cells are its code font's advance.
    const px = Math.min(520, Math.floor(columns * 7.5))
    const pending = await read($, confirmStop)

    const heading = (text: string, aside?: string) => (
      <Box flexDirection="row" columnGap={1}>
        <Text size="caption" weight="semibold" dimColor>
          {text.toUpperCase()}
        </Text>
        {aside ? (
          <Text size="caption" dimColor wrap="truncate-end">
            {aside}
          </Text>
        ) : null}
      </Box>
    )
    const meter = (key: string, fraction: number, severity: Severity) =>
      Svg ? (
        <Svg key={key} source={meterSvg(fraction, severity, px)} alt={`${Math.round(fraction * 100)}%`} width={px} height={6} />
      ) : (
        <Text color={COLOR[severity]} dimColor={severity === 'ok'}>
          {bar(fraction, Math.min(32, columns))}
        </Text>
      )
    const row = (label: string, value: string, severity: Severity, note?: string) => (
      <Box flexDirection="row" columnGap={1}>
        <Box width={9} flexShrink={0}>
          <Text size="footnote" dimColor>
            {label}
          </Text>
        </Box>
        <Text size="footnote" weight="medium" tabular color={COLOR[severity]}>
          {value}
        </Text>
        {note ? (
          <Text size="footnote" dimColor wrap="truncate-end">
            {note}
          </Text>
        ) : null}
      </Box>
    )

    // Jobs: one card each.
    const jobCards = snap.jobs.map(job => {
      const state = stateOf(job)
      const p = job.progress
      const who = driverText(job.driver)
      const done = overall(job)
      const eta = done !== null && done > 0.02 ? since((job.seconds * (1 - done)) / done) : p.remaining
      const severity: Severity = state.color === 'error' ? 'critical' : state.color === 'warning' ? 'warning' : 'ok'
      const frameText =
        p.frame === undefined ? null
        : job.frames ? `Frame ${p.frame} of ${job.frames[1] - job.frames[0] + 1}`
        : `Frame ${p.frame}`
      const sampleText = p.sample !== undefined && p.samples !== undefined ? `sample ${p.sample}/${p.samples}` : null
      const fraction = done ?? (p.sample !== undefined && p.samples ? p.sample / p.samples : null)
      const isRun = job.kind !== 'window'
      const isConfirming = pending === job.pid
      return (
        <Box
          key={`job-${job.pid}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={state.color ?? 'subtle'}
          paddingX={1}
          rowGap={0}
        >
          <Box flexDirection="row" columnGap={1}>
            <Text color={state.color} dimColor={state.color === undefined}>
              {state.color === undefined ? '○' : '●'}
            </Text>
            <Text weight="semibold" wrap="truncate-end">
              {job.kind === 'server' && !(job.isBusy && job.script) ? `Server · ${job.blend ?? 'no file'}` : (job.script ?? title(job))}
            </Text>
          </Box>
          <Text size="footnote" dimColor wrap="truncate-end">
            {[job.kind === 'server' ? null : job.blend, state.word, who, since(job.seconds)].filter(Boolean).join(' · ')}
          </Text>
          {job.intent ? (
            <Text size="footnote" italic dimColor wrap="truncate-end">
              “{job.intent}”
            </Text>
          ) : null}
          {frameText || sampleText ? (
            <Box flexDirection="row" columnGap={1} marginTop={1}>
              <Text size="footnote" weight="medium" tabular wrap="truncate-end">
                {[frameText, sampleText].filter(Boolean).join(' · ')}
              </Text>
            </Box>
          ) : null}
          {fraction !== null ? (
            <Box flexDirection="column">
              {meter(`progress-${job.pid}`, fraction, severity)}
              <Box flexDirection="row" columnGap={1}>
                <Text size="footnote" weight="medium" tabular>
                  {Math.round(fraction * 100)}%
                </Text>
                <Text size="footnote" dimColor tabular wrap="truncate-end">
                  {eta ? `${done !== null ? 'about ' : ''}${eta} left${done !== null ? '' : ' in this frame'}` : ''}
                </Text>
              </Box>
            </Box>
          ) : null}
          {p.error ? (
            <Text size="footnote" color="error" wrap="truncate-end">
              ✗ {p.error}
            </Text>
          ) : null}
          {job.isPaused ? (
            <Text size="footnote" color="warning" wrap="truncate-end">
              ❚❚ {job.thermal ?? 'Stopped: press Resume to continue'}
            </Text>
          ) : null}
          {p.last && !p.error && state.word !== 'idle' ? (
            <Text size="caption" mono dimColor wrap="truncate-end">
              {p.last}
            </Text>
          ) : null}
          <Box flexDirection="row" columnGap={1} flexWrap="wrap" marginTop={1}>
            {isConfirming
              ? [
                  <Button key={`stop-yes-${job.pid}`} label="Yes, stop it" variant="primary" onPress={() => update($, confirmStop, () => null).then(() => signal($, job.pid, 'TERM'))} />,
                  <Button key={`stop-no-${job.pid}`} label="Keep running" onPress={() => update($, confirmStop, () => null)} />,
                ]
              : [
                  isRun ? (
                    <Button key={`pause-${job.pid}`} label={job.isPaused ? 'Resume' : 'Pause'} onPress={() => signal($, job.pid, job.isPaused ? 'CONT' : 'STOP')} />
                  ) : null,
                  isRun ? <Button key={`stop-${job.pid}`} label="Stop" onPress={() => update($, confirmStop, () => job.pid)} /> : null,
                  job.log ? <Button key={`log-${job.pid}`} label="Log" onPress={openPath($, job.log)} /> : null,
                  p.error ? (
                    <Button key={`ask-${job.pid}`} label="Ask Claude" variant="primary" onPress={() => askClaude($, job.script ?? 'Blender', p.error ?? '', job.log)} />
                  ) : null,
                ]}
          </Box>
        </Box>
      )
    })
    const running = snap.jobs.filter(job => stateOf(job).word === 'running').length
    const jobs = (
      <Box flexDirection="column" rowGap={1}>
        {heading('Jobs', snap.jobs.length === 0 ? undefined : `${running} running · ${snap.jobs.length} in all`)}
        {snap.jobs.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor>No Blender running.</Text>
            <Text size="footnote" dimColor>
              A render shows here as soon as it starts.
            </Text>
          </Box>
        ) : (
          jobCards
        )}
      </Box>
    )

    // System: the temperature line, then one meter per resource.
    const s = snap.sensors
    const gpuC = s.gpu?.tempC ?? null
    const tempSeverity: Severity = gpuC === null ? 'ok' : gpuC >= options.hotWarnC ? 'critical' : gpuC >= options.hotWarnC - 6 ? 'warning' : 'ok'
    const vram = s.gpu && s.gpu.vramUsedMB !== null && s.gpu.vramTotalMB ? s.gpu.vramUsedMB / s.gpu.vramTotalMB : null
    const ramUsed = s.ramMB !== null && s.ramTotalMB ? 1 - s.ramMB / s.ramTotalMB : null
    const ramSeverity: Severity =
      s.ramMB === null || !s.ramTotalMB ? 'ok'
      : s.ramMB < (s.ramTotalMB * options.lowRamPercent) / 200 ? 'critical'
      : isLowRam(s) ? 'warning'
      : 'ok'
    const diskSeverity: Severity = s.diskGB === null ? 'ok' : s.diskGB < options.minDiskGB ? 'critical' : s.diskGB < options.minDiskGB * 2 ? 'warning' : 'ok'
    const minutes = Math.max(1, Math.round((snap.gpuHistory.length * options.pollSeconds) / 60))
    const system = (
      <Box flexDirection="column" rowGap={1}>
        {heading('System')}
        {s.gpu ? (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1} alignItems="center">
              <Text size="heading" weight="semibold" tabular color={COLOR[tempSeverity]}>
                {gpuC === null ? '—' : `${gpuC}°C`}
              </Text>
              <Text size="footnote" dimColor wrap="truncate-end">
                GPU {s.gpu.label}
                {tempSeverity === 'critical' ? ' · ▲ hot' : tempSeverity === 'warning' ? ' · ▲ warm' : ''}
              </Text>
            </Box>
            {Svg && snap.gpuHistory.length > 1 ? (
              <Svg
                key="temp"
                source={tempSvg(snap.gpuHistory, options.hotWarnC, px, 40, options.pollSeconds)}
                alt={`GPU temperature over the last ${minutes} min, now ${gpuC ?? '?'}°C`}
                width={px}
                height={40}
                isInteractive
              />
            ) : (
              <Text color={COLOR[tempSeverity]} dimColor={tempSeverity === 'ok'} wrap="truncate-end">
                {sparkline(snap.gpuHistory.slice(-Math.max(4, columns)), 35, options.hotWarnC + 6)}
              </Text>
            )}
            <Text size="caption" dimColor wrap="truncate-end">
              last {minutes} min · dashed line: warning at {options.hotWarnC}°C
            </Text>
          </Box>
        ) : null}
        {s.gpu && s.gpu.busy !== null ? (
          <Box flexDirection="column">
            {row('GPU load', `${s.gpu.busy}%`, 'ok')}
            {meter('gpu-load', s.gpu.busy / 100, 'ok')}
          </Box>
        ) : null}
        {s.gpu && vram !== null && s.gpu.vramUsedMB !== null && s.gpu.vramTotalMB ? (
          <Box flexDirection="column">
            {row('VRAM', `${gb(s.gpu.vramUsedMB)} / ${gb(s.gpu.vramTotalMB)} GB`, vram >= 0.97 ? 'critical' : vram >= 0.9 ? 'warning' : 'ok')}
            {meter('vram', vram, vram >= 0.97 ? 'critical' : vram >= 0.9 ? 'warning' : 'ok')}
          </Box>
        ) : null}
        <Box flexDirection="column">
          {row('CPU', snap.cpuBusy === null ? '—' : `${snap.cpuBusy}%`, 'ok', s.cpu?.tempC == null ? undefined : `${s.cpu.tempC}°C`)}
          {snap.cpuBusy === null ? null : meter('cpu', snap.cpuBusy / 100, 'ok')}
        </Box>
        {ramUsed !== null && s.ramMB !== null && s.ramTotalMB ? (
          <Box flexDirection="column">
            {row('RAM', `${gb(s.ramMB)} GB free`, ramSeverity, `of ${gb(s.ramTotalMB)}${ramSeverity === 'ok' ? '' : ' · low'}`)}
            {meter('ram', ramUsed, ramSeverity)}
          </Box>
        ) : null}
        {s.diskGB !== null ? (
          <Box flexDirection="column">
            {row('Disk', `${s.diskGB} GB free`, diskSeverity, s.diskTotalGB ? `of ${s.diskTotalGB}${diskSeverity === 'ok' ? '' : ' · low'}` : undefined)}
            {s.diskTotalGB ? meter('disk', 1 - s.diskGB / s.diskTotalGB, diskSeverity) : null}
          </Box>
        ) : null}
        {snap.comfy ? (
          <Text size="footnote" color="warning" wrap="truncate-end">
            ▲ ComfyUI is also running: it shares the GPU and RAM.
          </Text>
        ) : null}
      </Box>
    )

    // Preview
    const output = snap.output
    let previewBox = null
    if (output !== null) {
      const stepped = output.kind === 'sequence' ? await read($, step) : null
      const frames = output.frames ?? []
      const index = stepped === null ? frames.length - 1 : frames.indexOf(basename(stepped))
      const shown: Thumb | null = stepped === null ? await read($, thumb) : await read($, stepThumb)
      const isCurrent = shown !== null && (stepped === null ? shown.key === outputKey(output) || output.kind === 'sequence' : shown.key === stepped)

      let picture
      if (Svg && shown !== null && isCurrent && 'svg' in shown) {
        picture = (
          <Svg
            key="preview"
            source={shown.svg}
            alt={output.name}
            width={px}
            height={Math.round((px * shown.height) / shown.width)}
            isInteractive={shown.frames > 1 ? true : undefined}
          />
        )
      } else if ('Image' in elements && output.kind === 'still' && /\.png$/i.test(output.path)) {
        const { Image } = elements
        const cols = Math.min(60, columns)
        picture = <Image key="preview" source={{ file: output.path, format: 'png' }} columns={cols} rows={Math.max(4, Math.round(cols / 4))} alt={output.name} />
      } else if (shown !== null && 'error' in shown && isCurrent) {
        picture = <Text dimColor>{shown.error}</Text>
      } else {
        picture = <Text dimColor>Making the preview…</Text>
      }

      const name = stepped === null ? output.name : basename(stepped)
      const kindText =
        output.kind === 'sequence'
          ? `frames · ${output.stem ?? ''} · ${stepped === null ? `${output.count} so far` : `${index + 1} of ${frames.length}`}`
          : output.kind === 'video'
            ? 'video'
            : 'newest render'
      const details = [
        output.kind === 'video' && shown !== null && 'info' in shown ? shown.info : output.width && output.height ? `${output.width}×${output.height}` : null,
        `${(output.size / 1048576).toFixed(1)} MB`,
        ago(snap.at - output.mtimeMs),
      ].filter(Boolean)
      const go = (to: number) => () => stepTo($, to >= frames.length - 1 ? null : `${output.dir}/${frames[Math.max(0, to)]}`)

      previewBox = (
        <Box flexDirection="column" rowGap={1}>
          {heading('Preview', kindText)}
          {picture}
          <Box flexDirection="column">
            <Text size="footnote" weight="medium" wrap="truncate-middle">
              {name}
            </Text>
            <Text size="caption" dimColor tabular wrap="truncate-end">
              {details.join(' · ')}
            </Text>
          </Box>
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            {output.kind === 'sequence'
              ? [
                  <Button key="prev" label="◀" onPress={go(index - 1)} />,
                  <Button key="next" label="▶" onPress={go(index + 1)} />,
                  stepped !== null ? <Button key="newest" label="Newest" onPress={() => stepTo($, null)} /> : null,
                  <Button key="open" label="Open frame" onPress={openPath($, stepped ?? output.path)} />,
                ]
              : <Button key="open" label={output.kind === 'video' ? 'Play' : 'Open'} variant="primary" onPress={openPath($, output.path)} />}
            <Button key="folder" label="Folder" onPress={openPath($, output.dir)} />
          </Box>
        </Box>
      )
    }

    // Finished jobs, newest first.
    const past = (await read($, history)).slice(0, 5)
    const finishedBox =
      past.length === 0 ? null : (
        <Box flexDirection="column" rowGap={0}>
          {heading('Finished')}
          {past.map(one => (
            <Box key={`done-${one.pid}-${one.endedAt}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text color={one.isFailed ? 'error' : 'success'}>{one.isFailed ? '✗' : '✓'}</Text>
                <Text size="footnote" weight="medium" wrap="truncate-end">
                  {one.name}
                </Text>
                <Box flexShrink={0}>
                  <Text size="caption" dimColor tabular>
                    {since(one.seconds)} · {ago(snap.at - one.endedAt)}
                  </Text>
                </Box>
              </Box>
              {one.isFailed && one.error ? (
                <Text size="caption" color="error" wrap="truncate-end">
                  {one.error}
                </Text>
              ) : null}
              {one.log || one.isFailed ? (
                <Box flexDirection="row" columnGap={1}>
                  {one.log ? <Button key={`done-log-${one.pid}-${one.endedAt}`} label="Log" plain dimColor onPress={openPath($, one.log)} /> : null}
                  {one.isFailed ? (
                    <Button key={`done-ask-${one.pid}-${one.endedAt}`} label="Ask Claude" plain onPress={() => askClaude($, one.name, one.error ?? 'an error', one.log)} />
                  ) : null}
                </Box>
              ) : null}
            </Box>
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column" rowGap={2}>
        {jobs}
        {previewBox}
        {system}
        {finishedBox}
      </Box>
    )
  })
}
