# dsh-plugin-agnes-video

> Generate short videos with [Agnes AI](https://agnes-ai.com/)'s **free** video model, straight from
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): two agent tools that create the
> task, wait for it, and save the MP4 in your workspace.

```
you:  帮我生成一个视频：夜雨里漂过水洼的纸船，路灯倒影，缓慢推近
agent: → agnes_video_generate { prompt, seconds: "4" }
       ← saved to agnes-videos/task_….mp4  (4s, 720P, 16:9)
```

- **Free by default** — `agnes-video-2.5-flash`, 720P, 4–12 seconds per clip.
- **Three modes** — text-to-video, first/last **keyframe** control, and image/audio **reference** mode.
- **No dependencies, no build step** — plain ESM that talks to the OpenAI-Videos-compatible Agnes API.
- **Retry-aware** — backs off on Agnes' status-query throttle and retries a full free queue instead of
  failing immediately.

[中文说明](#中文说明)

## Tools

| Tool | What it does |
|---|---|
| `agnes_video_generate` | Creates a video task. By default waits for completion and saves the MP4 under `agnes-videos/` in the session workspace, returning its path and URL. Pass `wait: false` to get the queued task immediately. |
| `agnes_video_status` | Reads an existing task by `video_id`; `wait: true` keeps polling, and a finished video is saved by default. |

Key parameters of `agnes_video_generate`:

| Parameter | Default | Notes |
|---|---|---|
| `prompt` | — | Required. Subject and setting → action → camera → style → sound → consistency. |
| `seconds` | `"5"` | String, `"4"`–`"12"`. |
| `aspect_ratio` | `"16:9"` | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`. |
| `size` | `"720P"` | Flash accepts only `720P`; the paid model adds `1080P`, `1K`, `2K`. |
| `model` | `agnes-video-2.5-flash` | Free flash, or the paid `agnes-video-2.5`. |
| `first_frame` / `last_frame` | — | Public image URLs; selects **keyframe** mode. |
| `images` / `audios` | — | Public reference URLs; selects **reference** mode (flash: ≤5 images, ≤3 audio). |
| `seed` | — | Integer, for reproducible results. |
| `wait` / `save` | `true` | Wait for the task / save the MP4. |

`mode` is inferred from the media fields — you never pass it.

## Requirements

- A DeepSeek Harness profile (tested on the Desktop 0.2.2 release line).
- Node.js 20+ for the runtime features it uses (`fetch`, `AbortSignal.any`).
- A free [Agnes AI](https://agnes-ai.com/) API key (`sk-…`) from the platform console.

## Install

1. Clone this repository anywhere, e.g. `git clone https://github.com/yuyu867/dsh-plugin-agnes-video`.
2. Open **Plugins** in DeepSeek Harness → **Add plugin** → select the cloned directory.
3. The bundle registers the `agnes-video` row and enables it immediately; the two tools appear in
   every new session.

> DSH links a locally added directory, so the clone *is* the live plugin source. Re-add it (or restart
> DSH) after you change its files or configuration.

## Configure the API key

The repository ships **no** key. Pick one of:

**A. Profile patch layer (recommended, keeps the repo clean).** Add to
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: agnes-video
  config:
    apiKey: sk-your-key
    baseUrl: https://apihub.agnes-ai.com
    model: agnes-video-2.5-flash
    pollIntervalMs: 5000
    maxWaitMs: 300000
    retryDelayMs: 5000
    downloadDir: agnes-videos
    saveByDefault: true
```

A profile layer replaces the row's whole `config`, so restate every field you want to keep. Without
the key the tools stay available but every call fails with a message telling you what to set.

**B. Environment variable.** Export `AGNES_API_KEY` (or `AGNES_AI_API_KEY`) before starting DSH; the
plugin uses it whenever `apiKey` is empty.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `''` | Agnes API key; falls back to `AGNES_API_KEY` / `AGNES_AI_API_KEY`. |
| `baseUrl` | `https://apihub.agnes-ai.com` | API origin. A trailing `/v1` is stripped. |
| `model` | `agnes-video-2.5-flash` | Default model. |
| `pollIntervalMs` | `5000` | Poll interval while waiting; throttled polls back off exponentially. |
| `maxWaitMs` | `300000` | How long one tool call waits before returning a pending task. |
| `requestTimeoutMs` | `60000` | Per-HTTP-request timeout. |
| `retryDelayMs` | `5000` | Base pause between creation retries (5s, 10s, 15s). |
| `downloadDir` | `agnes-videos` | Output directory, relative to the session workspace unless absolute. |
| `saveByDefault` | `true` | Save the MP4 when no explicit `save` argument is given. |

## Models

| Model | Price | Limits |
|---|---|---|
| `agnes-video-2.5-flash` | Free (list price $0.025/s waived) | 720P only, faster. |
| `agnes-video-2.5` | $0.025/s (720P) … $0.055/s (2K) | All resolutions, video references. |

## How it talks to Agnes

- Create: `POST {base}/v1/videos` with `Authorization: Bearer <key>` and a JSON body of `model`,
  `prompt`, `seconds`, `mode`, `size`, `aspect_ratio`, plus mode-specific media fields.
- Poll: `GET {base}/agnesapi?video_id=<id>&model_name=<model>`. `model_name` is required for
  keyframe and reference tasks; a bare `video_id` query works only for `text` tasks.
- Ready when `status` is `completed`; `url` holds the video.

See the official [Agnes Video 2.5 docs](https://wiki.agnes-ai.com/zh-Hans/docs/agnes-video-25) and
[Flash docs](https://wiki.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash).

## Known limitations

- The free tier is rate limited (about 20 requests/minute), renders 720P only, and its queue is often
  full: creation retries three times, then fails with Agnes' own `video queue is full` message —
  just retry later. Free tasks can also sit queued for ~10 minutes.
- Status queries have their own throttle; the plugin backs off instead of failing the task.
- Media must be **publicly reachable by Agnes**; local files are not uploaded. Reference
  videos (`videos[]`) are not supported by the free flash model, so they are not exposed.
- Clips are 4–12 s; joining them into one file is left to your editor (the plugin does not call out
  to ffmpeg).
- The tools write the MP4 and nothing else; no session events, no UI surface.

## Development

```bash
npm test          # offline tests against a stubbed Agnes API, no network or key needed
node --check index.js
```

The test suite drives `apply()` with a stub `ctx.tools` registry and a stubbed `fetch`, covering mode
inference, argument validation, throttled polling, download, and the full-queue error path.

## 中文说明

DeepSeek Harness 插件：接入 [Agnes AI](https://agnes-ai.com/) 的**免费**视频模型，新增两个 Agent 工具：

- `agnes_video_generate`：创建 4–12 秒视频任务；默认等它完成并把 MP4 存到会话工作区的
  `agnes-videos/` 目录，返回本地路径和源地址。纯文本即文生视频，`first_frame`/`last_frame`
  走首尾帧，`images`/`audios` 走参考模式。
- `agnes_video_status`：用 `video_id` 查进度；`wait: true` 持续等待，完成时默认下载。

**安装**：克隆本仓库 → DSH 里打开「插件 / Plugins」→「添加插件」→ 选择该目录。DSH 以链接方式
引用该目录，改文件后重新添加或重启 DSH 即可生效。

**配置 API Key**：仓库里不含密钥。两种方式——写进 profile 的 `cordis.patch.yml`（上面 A 段示例，
用 `- id: agnes-video` 覆盖整段 `config`），或者启动 DSH 前设置环境变量 `AGNES_API_KEY`。

**限制**：免费模型仅 720P、约每分钟 20 次请求，免费队列经常排队甚至返回
`video queue is full`（插件会自动重试 3 次）；参考素材必须是 Agnes 能公网访问的 URL，
免费 flash 不支持视频参考；片段最长 12 秒，拼接成整片请用剪辑软件。

MIT licensed.
