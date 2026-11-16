import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

/** Install the plugin against a stub Agnes API and return its tools plus the recorded calls. */
async function harness({ pollScript = ['completed'], createStatus = 200 } = {}) {
  const calls = []
  let polls = 0
  const created = {
    id: 'task_TEST',
    task_id: 'task_TEST',
    video_id: 'task_TEST',
    object: 'video',
    model: 'agnes-video-2.5-flash',
    status: 'queued',
    progress: 0,
    seconds: '4',
    size: '720P',
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push({ href, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (href.endsWith('/v1/videos')) {
      if (createStatus !== 200) return json(createStatus, { error: { message: 'video queue is full, please retry later' } })
      return json(200, created)
    }
    if (href.includes('/agnesapi')) {
      const status = pollScript[Math.min(polls, pollScript.length - 1)]
      polls += 1
      if (status === 429) return json(429, { error: { message: 'too many video status queries' } })
      if (status === 'completed') {
        return json(200, { ...created, status: 'completed', progress: 100, url: 'https://cdn.example.com/out.mp4' })
      }
      return json(200, { ...created, status, progress: 0 })
    }
    if (href === 'https://cdn.example.com/out.mp4') {
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200 })
    }
    return new Response('unexpected url ' + href, { status: 500 })
  }
  try {
    const registry = new Map()
    const ctx = {
      tools: {
        register(definition) {
          registry.set(definition.name, definition)
          return () => registry.delete(definition.name)
        },
      },
      get: () => undefined,
    }
    apply(ctx, {
      apiKey: 'sk-test',
      baseUrl: 'https://apihub.agnes-ai.com',
      model: 'agnes-video-2.5-flash',
      pollIntervalMs: 1,
      maxWaitMs: 2000,
      retryDelayMs: 1,
      downloadDir: 'videos',
    })
    const workdir = await mkdtemp(join(tmpdir(), 'agnes-video-'))
    return {
      calls,
      workdir,
      tools: registry,
      restore() {
        globalThis.fetch = originalFetch
      },
    }
  } catch (error) {
    globalThis.fetch = originalFetch
    throw error
  }
}

const signal = () => ({ signal: new AbortController().signal })

test('registers both tools with a required prompt and video_id', async () => {
  const h = await harness()
  try {
    assert.deepEqual([...h.tools.keys()].sort(), ['agnes_video_generate', 'agnes_video_status'])
    assert.deepEqual(h.tools.get('agnes_video_generate').parameters.required, ['prompt'])
    assert.deepEqual(h.tools.get('agnes_video_status').parameters.required, ['video_id'])
    for (const tool of h.tools.values()) {
      assert.equal(tool.parameters.additionalProperties, false)
      assert.ok(tool.description.length > 40)
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
    }
  } finally {
    h.restore()
  }
})

test('creates a text task, waits through a throttled poll, saves the MP4', async () => {
  const h = await harness({ pollScript: [429, 'pending', 'completed'] })
  const cwd = process.cwd()
  try {
    process.chdir(h.workdir)
    const result = await h.tools.get('agnes_video_generate').execute(
      { prompt: 'a paper lantern over a lake', seconds: '4' },
      signal(),
    )
    assert.equal(result.status, 'completed')
    assert.equal(result.url, 'https://cdn.example.com/out.mp4')
    assert.ok(result.savedPath.endsWith('task_TEST.mp4'))
    assert.deepEqual(await readdir(join(h.workdir, 'videos')), ['task_TEST.mp4'])
    assert.ok((await readFile(result.savedPath)).length > 0)

    const create = h.calls.find((call) => call.method === 'POST')
    assert.deepEqual(create.body, {
      model: 'agnes-video-2.5-flash',
      prompt: 'a paper lantern over a lake',
      seconds: '4',
      mode: 'text',
      size: '720P',
      aspect_ratio: '16:9',
    })
    const poll = h.calls.find((call) => call.href.includes('/agnesapi'))
    assert.match(poll.href, /video_id=task_TEST/)
    assert.match(poll.href, /model_name=agnes-video-2\.5-flash/)
    assert.match(h.tools.get('agnes_video_generate').output.render({}, result)[0].text, /Video completed/)
  } finally {
    process.chdir(cwd)
    h.restore()
  }
})

test('infers keyframe and reference modes from media fields', async () => {
  const h = await harness()
  try {
    const generate = h.tools.get('agnes_video_generate')
    await generate.execute(
      { prompt: 'turn slowly', first_frame: 'https://x.test/a.png', wait: false },
      signal(),
    )
    await generate.execute(
      { prompt: 'use <Picture 1>', images: ['https://x.test/b.png'], wait: false },
      signal(),
    )
    const [keyframe, reference] = h.calls.filter((call) => call.method === 'POST').map((call) => call.body)
    assert.equal(keyframe.mode, 'keyframe')
    assert.equal(keyframe.first_frame, 'https://x.test/a.png')
    assert.equal(reference.mode, 'reference')
    assert.deepEqual(reference.images, ['https://x.test/b.png'])
  } finally {
    h.restore()
  }
})

test('rejects arguments Agnes would refuse', async () => {
  const h = await harness()
  try {
    const generate = h.tools.get('agnes_video_generate')
    const cases = [
      [{ prompt: 'x', seconds: '3' }, /seconds/],
      [{ prompt: 'x', seconds: '13' }, /seconds/],
      [{ prompt: 'x', size: '2K' }, /only supports size "720P"/],
      [{ prompt: '' }, /prompt/],
      [{ prompt: 'x', model: 'agnes-video-9' }, /model must be one of/],
      [{ prompt: 'x', aspect_ratio: 'auto' }, /aspect_ratio/],
      [
        { prompt: 'x', first_frame: 'https://x.test/a.png', images: ['https://x.test/b.png'] },
        /cannot be combined/,
      ],
    ]
    for (const [args, pattern] of cases) {
      await assert.rejects(generate.execute(args, signal()), pattern)
    }
    assert.equal(h.calls.length, 0, 'invalid arguments must not reach the API')
  } finally {
    h.restore()
  }
})

test('surfaces a full queue with Agnes\' own message', async () => {
  const h = await harness({ createStatus: 503 })
  try {
    await assert.rejects(
      h.tools.get('agnes_video_generate').execute({ prompt: 'x', wait: false }, signal()),
      /HTTP 503: video queue is full/,
    )
  } finally {
    h.restore()
  }
})

test('status tool reports a finished task without re-saving when save is false', async () => {
  const h = await harness({ pollScript: ['completed'] })
  try {
    const status = h.tools.get('agnes_video_status')
    const result = await status.execute({ video_id: 'task_TEST', save: false }, signal())
    assert.equal(result.status, 'completed')
    assert.equal(result.savedPath, null)
    assert.match(status.output.render({}, result)[0].text, /not saved locally/)
  } finally {
    h.restore()
  }
})
