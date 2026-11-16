/**
 * Agnes AI video generation (Host half).
 *
 * Registers two agent tools:
 *   agnes_video_generate  create a video task, optionally wait for it and save the MP4
 *   agnes_video_status    read (and optionally finish) an existing task
 *
 * Transport is the OpenAI-Videos-compatible Agnes API:
 *   POST {base}/v1/videos                                  create task
 *   GET  {base}/agnesapi?video_id=..&model_name=..          poll task
 *
 * @module @local/agnes-video
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export const name = 'agnes-video'
export const inject = ['tools']

const FREE_MODEL = 'agnes-video-2.5-flash'
const PAID_MODEL = 'agnes-video-2.5'
const MODELS = [FREE_MODEL, PAID_MODEL]
const ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
const SIZES = ['720P', '1080P', '1K', '2K']
const TERMINAL = new Set(['completed', 'failed'])
/** Transient Agnes failures worth retrying: throttling, capacity, and gateway hiccups. */
const RETRYABLE = new Set([429, 502, 503, 504])

const DEFAULTS = {
  baseUrl: 'https://apihub.agnes-ai.com',
  model: FREE_MODEL,
  pollIntervalMs: 5000,
  maxWaitMs: 300_000,
  requestTimeoutMs: 60_000,
  retryDelayMs: 5000,
  downloadDir: 'agnes-videos',
  saveByDefault: true,
}

/**
 * Merge the row config over the defaults and resolve the API key.
 * @param {Record<string, unknown> | undefined} config - the patch row's config.
 * @returns {typeof DEFAULTS & { apiKey: string }} resolved settings.
 */
function resolveSettings(config) {
  const raw = config ?? {}
  const settings = { ...DEFAULTS }
  if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) settings.baseUrl = raw.baseUrl.trim()
  if (typeof raw.model === 'string' && raw.model.trim()) settings.model = raw.model.trim()
  for (const key of ['pollIntervalMs', 'maxWaitMs', 'requestTimeoutMs', 'retryDelayMs']) {
    const value = Number(raw[key])
    if (Number.isFinite(value) && value > 0) settings[key] = value
  }
  if (typeof raw.downloadDir === 'string' && raw.downloadDir.trim()) settings.downloadDir = raw.downloadDir.trim()
  if (typeof raw.saveByDefault === 'boolean') settings.saveByDefault = raw.saveByDefault
  const configured = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  const apiKey = configured || process.env.AGNES_API_KEY?.trim() || process.env.AGNES_AI_API_KEY?.trim() || ''
  return { ...settings, apiKey }
}

/**
 * Drop a trailing slash and an optional `/v1` suffix so paths can be appended.
 * @param {string} base - configured base URL.
 * @returns {string} origin-style base URL.
 */
function normalizeBase(base) {
  return base.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/**
 * Fail early with an actionable message when no key is configured.
 * @param {{ apiKey: string }} settings - resolved settings.
 * @returns {string} the API key.
 */
function requireKey(settings) {
  if (!settings.apiKey) {
    throw new Error(
      'Agnes API key is not configured. Set `apiKey` in this plugin\'s config in cordis.patch.yml, '
      + 'or export AGNES_API_KEY, then retry.',
    )
  }
  return settings.apiKey
}

/**
 * Request headers for one Agnes call.
 * @param {{ apiKey: string }} settings - resolved settings.
 * @returns {Record<string, string>} headers.
 */
function authHeaders(settings) {
  return { Authorization: `Bearer ${settings.apiKey}` }
}

/**
 * Compose the abort signal for one HTTP request: caller cancellation plus a per-request timeout.
 * @param {{ signal: AbortSignal }} exec - tool run context.
 * @param {number} timeoutMs - per-request timeout.
 * @returns {AbortSignal} signal for fetch.
 */
function requestSignal(exec, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return exec?.signal ? AbortSignal.any([exec.signal, timeout]) : timeout
}

/**
 * Perform one JSON request and turn transport and HTTP failures into readable errors.
 * @param {string | URL} url - request URL.
 * @param {RequestInit} init - fetch options.
 * @param {string} label - human label for messages.
 * @returns {Promise<any>} parsed JSON body.
 */
async function callJson(url, init, label) {
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init?.signal?.aborted) throw new Error(`Agnes ${label} was cancelled or timed out`)
    throw new Error(`Agnes ${label} request failed: ${error?.message ?? String(error)}`)
  }
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const detail = body?.error?.message ?? body?.message ?? text.trim().slice(0, 300)
    const error = new Error(`Agnes ${label} failed with HTTP ${response.status}: ${detail}`)
    error.status = response.status
    throw error
  }
  if (body === undefined) throw new Error(`Agnes ${label} returned a non-JSON body: ${text.trim().slice(0, 300)}`)
  return body
}

/**
 * Create a video task, retrying with a pause while Agnes throttles or reports a full queue.
 * @param {Record<string, unknown>} body - `POST /v1/videos` body.
 * @param {typeof DEFAULTS & { apiKey: string }} settings - resolved settings.
 * @param {{ signal?: AbortSignal }} exec - tool run context.
 * @returns {Promise<any>} create response.
 */
async function createVideoTask(body, settings, exec) {
  const url = `${normalizeBase(settings.baseUrl)}/v1/videos`
  const init = {
    method: 'POST',
    headers: { ...authHeaders(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await callJson(url, { ...init, signal: requestSignal(exec, settings.requestTimeoutMs) }, 'video creation')
    } catch (error) {
      if (!RETRYABLE.has(error?.status) || attempt > 3) throw error
      await sleep(settings.retryDelayMs * attempt, exec?.signal)
    }
  }
}

/**
 * Normalize an optional URL list argument.
 * @param {unknown} value - model-supplied value.
 * @param {string} field - field name for error messages.
 * @returns {string[]} trimmed URLs.
 */
function urlList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of public URLs`)
  const urls = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  if (urls.length !== value.length) throw new Error(`${field} must contain only non-empty URL strings`)
  return urls
}

/**
 * Normalize an optional single URL argument.
 * @param {unknown} value - model-supplied value.
 * @param {string} field - field name for error messages.
 * @returns {string | undefined} trimmed URL.
 */
function optionalUrl(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a public URL string`)
  return value.trim()
}

/**
 * Build and validate the `POST /v1/videos` body, inferring the generation mode from the media fields.
 * @param {Record<string, unknown>} args - model-supplied arguments.
 * @param {typeof DEFAULTS} settings - resolved settings.
 * @returns {Record<string, unknown>} request body.
 */
function createBody(args, settings) {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) throw new Error('prompt must be a non-empty description of the video')
  const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : settings.model
  if (!MODELS.includes(model)) throw new Error(`model must be one of ${MODELS.join(', ')}`)

  const seconds = args.seconds === undefined ? '5' : String(args.seconds).trim()
  const duration = Number(seconds)
  if (!Number.isInteger(duration) || duration < 4 || duration > 12) {
    throw new Error('seconds must be a whole number between 4 and 12')
  }

  const size = typeof args.size === 'string' && args.size.trim() ? args.size.trim() : '720P'
  if (!SIZES.includes(size)) throw new Error(`size must be one of ${SIZES.join(', ')}`)
  if (model === FREE_MODEL && size !== '720P') {
    throw new Error(`model ${FREE_MODEL} only supports size "720P"; use ${PAID_MODEL} for other sizes`)
  }

  const aspectRatio = typeof args.aspect_ratio === 'string' && args.aspect_ratio.trim()
    ? args.aspect_ratio.trim()
    : '16:9'
  if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error(`aspect_ratio must be one of ${ASPECT_RATIOS.join(', ')}`)

  const firstFrame = optionalUrl(args.first_frame, 'first_frame')
  const lastFrame = optionalUrl(args.last_frame, 'last_frame')
  const images = urlList(args.images, 'images')
  const audios = urlList(args.audios, 'audios')

  let mode = 'text'
  if (firstFrame || lastFrame) {
    if (images.length || audios.length) {
      throw new Error('keyframe inputs (first_frame/last_frame) and reference media (images/audios) cannot be combined in one request')
    }
    mode = 'keyframe'
  } else if (images.length || audios.length) {
    mode = 'reference'
    if (model === FREE_MODEL) {
      if (images.length > 5) throw new Error(`${FREE_MODEL} accepts at most 5 reference images`)
      if (audios.length > 3) throw new Error(`${FREE_MODEL} accepts at most 3 reference audio files`)
    }
  }

  /** @type {Record<string, unknown>} */
  const body = { model, prompt, seconds, mode, size, aspect_ratio: aspectRatio }
  if (mode === 'keyframe') {
    if (firstFrame) body.first_frame = firstFrame
    if (lastFrame) body.last_frame = lastFrame
  }
  if (mode === 'reference') {
    if (images.length) body.images = images
    if (audios.length) body.audios = audios
  }
  if (args.seed !== undefined && args.seed !== null) {
    const seed = Number(args.seed)
    if (!Number.isInteger(seed) || seed < 0) throw new Error('seed must be a non-negative integer')
    body.seed = seed
  }
  return body
}

/**
 * Read one task from the Agnes query endpoint.
 * @param {string} videoId - video id from creation.
 * @param {string} modelName - model id, required for keyframe and reference tasks.
 * @param {typeof DEFAULTS} settings - resolved settings.
 * @param {AbortSignal} signal - request signal.
 * @returns {Promise<any>} task payload.
 */
function queryTask(videoId, modelName, settings, signal) {
  const url = new URL(`${normalizeBase(settings.baseUrl)}/agnesapi`)
  url.searchParams.set('video_id', videoId)
  if (modelName) url.searchParams.set('model_name', modelName)
  return callJson(url, { headers: authHeaders(settings), signal }, 'task query')
}

/**
 * Sleep, rejecting early when the caller cancels.
 * @param {number} ms - delay.
 * @param {AbortSignal} signal - caller signal.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms, signal) {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      rejectSleep(new Error('Agnes video task was cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveSleep()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      rejectSleep(new Error('Agnes video task was cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Poll until the task reaches a terminal state or the wait budget runs out. Agnes rate limits
 * status queries (HTTP 429), so a throttled poll backs off instead of failing the task.
 * @param {string} videoId - video id.
 * @param {string} modelName - model id.
 * @param {typeof DEFAULTS} settings - resolved settings.
 * @param {AbortSignal} signal - caller signal.
 * @returns {Promise<{ task: any; timedOut: boolean }>} last observed task.
 */
async function waitForTask(videoId, modelName, settings, signal) {
  const deadline = Date.now() + settings.maxWaitMs
  let task
  let throttled = 0
  for (;;) {
    try {
      const next = await queryTask(videoId, modelName, settings, requestSignal({ signal }, settings.requestTimeoutMs))
      task = next
      throttled = 0
      if (TERMINAL.has(task?.status)) return { task, timedOut: false }
    } catch (error) {
      if (!RETRYABLE.has(error?.status)) throw error
      throttled = Math.min(throttled + 1, 5)
    }
    if (Date.now() >= deadline) {
      if (task === undefined) {
        throw new Error(
          'Agnes kept throttling or failing status queries before the first successful poll; '
          + 'raise pollIntervalMs or retry with agnes_video_status later.',
        )
      }
      return { task, timedOut: true }
    }
    const backoff = settings.pollIntervalMs * 2 ** throttled
    const pause = Math.max(500, Math.min(backoff, deadline - Date.now()))
    await sleep(pause, signal)
  }
}

/**
 * Resolve the directory that relative downloads use: the session workspace when available.
 * @param {any} ctx - plugin context.
 * @param {{ agent?: any }} exec - tool run context.
 * @param {{ downloadDir: string }} settings - resolved settings.
 * @returns {string} absolute output directory.
 */
function outputDirectory(ctx, exec, settings) {
  if (isAbsolute(settings.downloadDir)) return settings.downloadDir
  let base = ''
  try {
    const workingDirectory = ctx.get('workingDirectory')
    const session = exec?.agent?.session
    if (workingDirectory && session) {
      const directory = workingDirectory.get(session)
      if (typeof directory === 'string' && directory) base = directory
    }
  } catch {
    base = ''
  }
  return resolve(base || process.cwd(), settings.downloadDir)
}

/**
 * Fetch a finished video into the output directory.
 * @param {string} url - completed video URL.
 * @param {string} videoId - id used as the file name.
 * @param {string} directory - absolute output directory.
 * @param {AbortSignal} signal - request signal.
 * @returns {Promise<{ path: string; bytes: number }>} saved file.
 */
async function saveVideo(url, videoId, directory, signal) {
  let response
  try {
    response = await fetch(url, { signal })
  } catch (error) {
    throw new Error(`Downloading the generated video failed: ${error?.message ?? String(error)}`)
  }
  if (!response.ok) throw new Error(`Downloading the generated video failed with HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('The generated video download was empty')
  await mkdir(directory, { recursive: true })
  const file = join(directory, `${String(videoId).replace(/[^A-Za-z0-9_-]/g, '-')}.mp4`)
  await writeFile(file, bytes)
  return { path: file, bytes: bytes.length }
}

/**
 * Flatten a task payload into the tool result shape.
 * @param {any} task - Agnes task or create response.
 * @param {Record<string, unknown>} body - the create request body.
 * @returns {Record<string, unknown>} result fields.
 */
function toResult(task, body) {
  const error = task?.error
  return {
    videoId: task?.video_id ?? task?.id ?? null,
    model: task?.model ?? body.model,
    status: task?.status ?? 'unknown',
    progress: typeof task?.progress === 'number' ? task.progress : 0,
    seconds: task?.seconds ?? body.seconds,
    size: task?.size ?? body.size,
    aspectRatio: typeof body.aspect_ratio === 'string' ? body.aspect_ratio : null,
    url: typeof task?.url === 'string' ? task.url : null,
    savedPath: null,
    errorMessage: error ? (typeof error === 'string' ? error : error?.message ?? JSON.stringify(error)) : null,
  }
}

/**
 * Describe one finished or pending result as model-facing text.
 * @param {Record<string, any>} result - tool result.
 * @param {boolean} timedOut - whether the wait budget ran out.
 * @returns {string} rendered text.
 */
function describe(result, timedOut) {
  const dimension = [result.seconds ? `${result.seconds}s` : '', result.size, result.aspectRatio]
    .filter(Boolean)
    .join(' ')
  const label = ` (${dimension ? `${dimension}, ` : ''}model ${result.model})`
  if (result.status === 'completed') {
    const where = result.savedPath ? `saved to ${result.savedPath}` : 'not saved locally'
    const link = result.url ? ` Source URL: ${result.url}` : ' No video URL was returned.'
    return `Video completed${label}, ${where}.${link} video_id=${result.videoId}`
  }
  if (result.status === 'failed') {
    return `Video generation failed${label}: ${result.errorMessage ?? 'unknown error'} video_id=${result.videoId}`
  }
  const percent = typeof result.progress === 'number' ? `${result.progress}%` : 'unknown'
  const tail = timedOut
    ? 'The wait budget ran out; call agnes_video_status with this video_id to keep following it.'
    : 'Call agnes_video_status with this video_id to keep following it.'
  return `Video still processing${label} status=${result.status} progress=${percent}. ${tail} video_id=${result.videoId}`
}

/** A string that may be null. */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** Shared result schema of both tools. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    videoId: { ...NULLABLE_STRING, description: 'Video id for later status checks.' },
    model: { type: 'string', description: 'Model that produced the task.' },
    status: { type: 'string', description: 'queued | pending | in_progress | completed | failed.' },
    progress: { type: 'integer', description: 'Task progress from 0 to 100.' },
    seconds: { type: 'string', description: 'Requested duration in seconds.' },
    size: { type: 'string', description: 'Output resolution tier.' },
    aspectRatio: { ...NULLABLE_STRING, description: 'Output aspect ratio.' },
    url: { ...NULLABLE_STRING, description: 'Source video URL once completed.' },
    savedPath: { ...NULLABLE_STRING, description: 'Local MP4 path when the video was saved.' },
    errorMessage: { ...NULLABLE_STRING, description: 'Failure detail when status is failed.' },
    timedOut: { type: 'boolean', description: 'Whether the wait budget ran out before the task finished.' },
  },
}

const GENERATE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      description: 'What the video shows. Order it as subject and setting, action, camera language, visual style, sound, then consistency requirements.',
    },
    seconds: {
      type: 'string',
      description: 'Duration "4" to "12" seconds. Default "5".',
    },
    aspect_ratio: {
      type: 'string',
      enum: ASPECT_RATIOS,
      description: 'Frame shape. Default 16:9.',
    },
    size: {
      type: 'string',
      enum: SIZES,
      description: 'Resolution tier. agnes-video-2.5-flash accepts only 720P; the paid agnes-video-2.5 accepts all. Default 720P.',
    },
    model: {
      type: 'string',
      enum: MODELS,
      description: 'agnes-video-2.5-flash is free (720P); agnes-video-2.5 is paid and supports higher resolutions. Default agnes-video-2.5-flash.',
    },
    first_frame: {
      type: 'string',
      description: 'Public image URL pinned as the first frame. Providing it or last_frame selects keyframe mode.',
    },
    last_frame: {
      type: 'string',
      description: 'Public image URL pinned as the last frame.',
    },
    images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Public image URLs used as content or style references (reference mode). Flash accepts at most 5.',
    },
    audios: {
      type: 'array',
      items: { type: 'string' },
      description: 'Public audio URLs used as rhythm or sound references (reference mode). Flash accepts at most 3.',
    },
    seed: {
      type: 'integer',
      description: 'Random seed. Reuse one to make similar results reproducible.',
    },
    wait: {
      type: 'boolean',
      description: 'Wait for the task and save the MP4. Default true; false returns the queued task immediately.',
    },
    save: {
      type: 'boolean',
      description: 'Save the finished MP4 into the workspace. Default from the plugin config.',
    },
  },
}

const STATUS_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['video_id'],
  properties: {
    video_id: {
      type: 'string',
      description: 'video_id returned by agnes_video_generate.',
    },
    model: {
      type: 'string',
      enum: MODELS,
      description: 'Model that created the task. Pass it for keyframe and reference tasks. Defaults to the plugin config model.',
    },
    wait: {
      type: 'boolean',
      description: 'Keep polling until the task finishes. Default false.',
    },
    save: {
      type: 'boolean',
      description: 'Save the finished MP4 into the workspace. Default true.',
    },
  },
}

/**
 * Register the Agnes video tools.
 * @param {any} ctx - plugin context carrying the tool registry.
 * @param {Record<string, unknown> | undefined} config - the patch row's config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)

  ctx.tools.register({
    name: 'agnes_video_generate',
    description:
      'Generate a 4-12 second video with the free Agnes AI model agnes-video-2.5-flash (720P) '
      + 'or the paid agnes-video-2.5. A plain prompt is text-to-video; first_frame/last_frame '
      + 'pin the opening or closing frame; images/audios become content, style, or rhythm references. '
      + 'By default this waits for the task and saves the MP4 in the workspace, and returns its path and URL. '
      + 'Media URLs must be publicly reachable by Agnes.',
    parameters: GENERATE_PARAMETERS,
    output: {
      schema: RESULT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: describe(value, value.timedOut === true) }],
    },
    presentCall: args => ({ card: 'generic', title: 'Generate Agnes video', kind: 'other', rawInput: args }),
    timeoutMs: settings.maxWaitMs + settings.requestTimeoutMs + 60_000,
    async execute(args, exec) {
      requireKey(settings)
      const body = createBody(args, settings)
      const created = await createVideoTask(body, settings, exec)
      const videoId = created?.video_id ?? created?.id
      if (!videoId) throw new Error('Agnes video creation returned no video_id')

      let task = created
      let timedOut = false
      if (args.wait !== false) {
        const settled = await waitForTask(videoId, created.model ?? body.model, settings, exec.signal)
        task = settled.task
        timedOut = settled.timedOut
      }

      const result = toResult(task, body)
      result.videoId = videoId
      if (result.status === 'failed') throw new Error(describe(result, false))

      const save = args.save ?? settings.saveByDefault
      if (result.status === 'completed' && result.url && save) {
        const directory = outputDirectory(ctx, exec, settings)
        const saved = await saveVideo(
          result.url,
          videoId,
          directory,
          requestSignal(exec, Math.max(settings.requestTimeoutMs, 120_000)),
        )
        result.savedPath = saved.path
      }
      result.timedOut = timedOut
      return result
    },
  })

  ctx.tools.register({
    name: 'agnes_video_status',
    description:
      'Read an Agnes AI video task created by agnes_video_generate. Returns status, progress, and the video URL, '
      + 'and by default saves a finished MP4 into the workspace. With wait true it keeps polling until the task '
      + 'finishes or the configured wait budget runs out.',
    parameters: STATUS_PARAMETERS,
    output: {
      schema: RESULT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: describe(value, value.timedOut === true) }],
    },
    presentCall: args => ({ card: 'generic', title: 'Check Agnes video', kind: 'fetch', rawInput: args }),
    timeoutMs: settings.maxWaitMs + settings.requestTimeoutMs + 60_000,
    async execute(args, exec) {
      requireKey(settings)
      const videoId = typeof args.video_id === 'string' ? args.video_id.trim() : ''
      if (!videoId) throw new Error('video_id must be a non-empty video id from agnes_video_generate')
      const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : settings.model
      if (!MODELS.includes(model)) throw new Error(`model must be one of ${MODELS.join(', ')}`)

      let task
      let timedOut = false
      if (args.wait === true) {
        const settled = await waitForTask(videoId, model, settings, exec.signal)
        task = settled.task
        timedOut = settled.timedOut
      } else {
        task = await queryTask(videoId, model, settings, requestSignal(exec, settings.requestTimeoutMs))
      }

      const result = toResult(task, { model })
      result.videoId = videoId
      result.timedOut = timedOut
      if (result.status === 'failed') throw new Error(describe(result, false))

      const save = args.save !== false
      if (result.status === 'completed' && result.url && save) {
        const directory = outputDirectory(ctx, exec, settings)
        const saved = await saveVideo(
          result.url,
          videoId,
          directory,
          requestSignal(exec, Math.max(settings.requestTimeoutMs, 120_000)),
        )
        result.savedPath = saved.path
      }
      return result
    },
  })
}
