import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'blender-band',
  component: 'Pane',
  requestId: 'blender',
  props: {
    title: 'Blender',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SENSORS = {
  gpu: { tempC: 81, label: 'hotspot', busy: 97, vramUsedMB: 6200, vramTotalMB: 8176 },
  cpu: { tempC: 64 },
  cpuTicks: [100, 1000],
  ramMB: 9800,
  ramTotalMB: 15907,
  diskGB: 212,
}

const JOB = {
  pid: 4242,
  kind: 'run',
  script: 'a_very_long_render_script_name_that_used_to_push_everything_off.py',
  blend: 'final_stage.blend',
  seconds: 252,
  isPaused: false,
  log: '/logs/blender/x.log',
  server: null,
  driver: 'agy',
  progress: { frame: 112, sample: 64, samples: 128, remaining: '05:12', last: 'Fra:112 | Sample 64/128' },
  thermal: null,
}

const OUTPUT = {
  kind: 'sequence',
  path: '/work/renders/f_0112.png',
  dir: '/work/renders',
  name: 'f_0112.png',
  mtimeMs: 1000,
  size: 2000,
  frames: ['f_0110.png', 'f_0111.png', 'f_0112.png'],
  count: 3,
  stem: 'f',
}

const SNAPSHOT = { jobs: [JOB], sensors: SENSORS, cpuBusy: 38, comfy: false, output: OUTPUT, gpuHistory: [70, 75, 81], at: 61000 }

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>

function seed(on: Parameters<Body>[1]) {
  on('state.get', (_, e, next) =>
    e.key === 'snapshot' ? { value: { value: { shape: 'snapshot-2', value: SNAPSHOT }, version: 1 } }
    : e.key === 'thumb' ? { value: { value: { shape: 'thumb-1', value: { key: '/work/renders/f:3', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1" width="2" height="1"></svg>', width: 2, height: 1, frames: 3 } }, version: 1 } }
    : next(e),
  )
}

test('the pane draws a job, the sensors and the frame sequence on every surface', async ($, on) => {
  seed(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /a_very_long_render_script/ }))?.text).toContain('final_stage.blend')
    expect((await ui.find({ type: 'Text', text: /started by agy/ }))?.text).toBe('running · started by agy · 4m12s')
    expect((await ui.find({ type: 'Text', text: /^frame 112/ }))?.text).toBe('frame 112 · sample 64/128 · 05:12 left')
    expect((await ui.find({ type: 'Text', text: /°C$/ }))?.text).toBe('81°C')
    expect((await ui.find({ type: 'Text', text: /^Frames/ }))?.text).toBe('Frames · f · 3 so far')
    expect(await ui.find({ key: 'prev' })).toBeDefined()
    expect(await ui.find({ key: 'folder' })).toBeDefined()
    await ui.unmount()
  }
})

test('before the first reading the pane says it is reading', async ($, on) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Reading Blender jobs and sensors…')
  await ui.unmount()
})

test('with wrapper scripts set, a headless blender call is refused; the wrappers and --version pass', { options: { wrapperScripts: 'render.sh; blender_job.sh' } }, async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  const raw = await $.tool.call({ tool: 'Bash', command: '/opt/blender/blender -b a.blend --python r.py' })
  expect(raw.deny).toContain('render.sh or blender_job.sh')
  const wrapped = await $.tool.call({ tool: 'Bash', command: './tools/blender_job.sh a.blend r.py' })
  expect(wrapped.deny).toBeUndefined()
  const version = await $.tool.call({ tool: 'Bash', command: 'blender --version' })
  expect(version.deny).toBeUndefined()
})

test('with no wrapper scripts set, nothing is refused', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  const raw = await $.tool.call({ tool: 'Bash', command: 'blender -b a.blend -a' })
  expect(raw.deny).toBeUndefined()
})

test('blender_status answers with the jobs and sensors', async ($, on) => {
  on('clock.now', () => ({ value: 61000 }))
  on('process.run', (_, e) =>
    e.argv.includes('status')
      ? { value: { exitCode: 0, stdout: JSON.stringify({ jobs: [JOB], sensors: SENSORS, comfy: true, output: OUTPUT }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 0, stdout: '{"error":"none"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  const ran = await $.tool.call({ tool: 'mcp__blender-band__blender_status' })
  const text = String(ran.result)
  expect(text).toContain('pid 4242')
  expect(text).toContain('started by agy')
  expect(text).toContain('frame 112 · sample 64/128')
  expect(text).toContain('GPU: 81°C hotspot')
  expect(text).toContain('ComfyUI is also running')
  expect(text).toContain('frame sequence f (3 frames')
})
