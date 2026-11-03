/** What a job's log says about it (hooks/gather.py `progress_of`). */
export type JobProgress = {
  frame?: number
  sample?: number
  samples?: number
  remaining?: string
  saved?: string
  error?: string
  last?: string
}

/** One running Blender process. */
export type BlenderJob = {
  pid: number
  /** `run` is headless, `server` a persistent blender_server.py, `window` the GUI. */
  kind: 'run' | 'server' | 'window'
  script: string | null
  blend: string | null
  seconds: number
  isPaused: boolean
  log: string | null
  server: string | null
  /** The agent that started it: `this session`, `Claude`, `agy`, ...; null when none is found. */
  driver: string | null
  /** A server running a script for a caller now. */
  isBusy?: boolean
  progress: JobProgress
  /** The last line of a thermal guard's log beside the job's log, when one keeps such a log. */
  thermal: string | null
  /** Pictures and videos the process holds open: what it is writing now. */
  writing?: string[]
  /** [first, last] frame when the command line names them (-s/-e with -a, or -f). */
  frames?: [number, number] | null
  /** What this session's Bash call said it was doing, when this session started it. */
  intent?: string
}

export type Sensors = {
  gpu: { tempC: number | null; label: string; busy: number | null; vramUsedMB: number | null; vramTotalMB: number | null } | null
  cpu: { tempC: number | null } | null
  cpuTicks: [number, number]
  ramMB: number | null
  ramTotalMB: number | null
  diskGB: number | null
  diskTotalGB?: number | null
}

/** The newest picture, frame sequence or video under the outputs folders. */
export type Output = {
  kind: 'still' | 'sequence' | 'video'
  path: string
  dir: string
  name: string
  mtimeMs: number
  size: number
  /** A sequence's frame file names, oldest first (the last 2000). */
  frames?: string[]
  count?: number
  stem?: string
  /** Pixels, from a PNG's or JPEG's header. */
  width?: number
  height?: number
}

/** A job that ended, newest first in the history. */
export type Finished = {
  pid: number
  name: string
  blend: string | null
  isFailed: boolean
  error?: string
  seconds: number
  endedAt: number
  log: string | null
  driver: string | null
}

export type Snapshot = {
  jobs: BlenderJob[]
  sensors: Sensors
  cpuBusy: number | null
  comfy: boolean
  output: Output | null
  /** GPU temperatures of the last readings, oldest first. */
  gpuHistory: number[]
  at: number
}

/** A preview drawn as an SVG, for the output or frame it was made from. */
export type Thumb = { key: string; svg: string; width: number; height: number; frames: number; info?: string } | { key: string; error: string }

declare module 'claude-code' {
  interface PluginState {
    'blender-band': {
      snapshot: Shaped<Snapshot | null>
      thumb: Shaped<Thumb | null>
      /** The frame (file path) of a sequence the person stepped to; null follows the newest. */
      step: string | null
      stepThumb: Shaped<Thumb | null>
      history: Shaped<Finished[]>
      /** The pid whose Stop button asks to be pressed again. */
      confirmStop: number | null
    }
  }
}
