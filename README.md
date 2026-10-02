> [!IMPORTANT]
> This repository has moved to [`jvm/pi-mono`](https://github.com/jvm/pi-mono/tree/main/packages/pi-codex-image-gen). It is archived and no longer maintained here.
> Please file issues and pull requests in [`jvm/pi-mono`](https://github.com/jvm/pi-mono).

# pi-codex-compatible-image-gen

Image generation for Pi through a self-hosted LiteLLM gateway's Responses API and native image-generation tool.

## Install

```sh
pi install npm:pi-codex-compatible-image-gen
```

To uninstall:

```sh
pi remove npm:pi-codex-compatible-image-gen
```

## Quick usage

In a Pi session:

```
> Generate a pixel-art sword icon, 32×32, with a blue blade and gold hilt
```

The agent invokes `codex_generate_image` with your prompt and saves the returned image. The `model` parameter selects the gateway route; pass `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst` to call either route. When omitted, the active Pi model ID is used.

## Authentication

Uses your existing **openai-codex** login — no `OPENAI_API_KEY` required. If you haven't logged in yet:

```
> /login
```

Select **ChatGPT Plus/Pro (Codex)** and complete the OAuth flow.

## Configuration

Create a JSON config file at one (or both) of these locations:

| Scope   | Path                                                    |
| ------- | ------------------------------------------------------- |
| Global  | `~/.pi/agent/extensions/codex-image-gen.json`           |
| Project | `<project-root>/.pi/extensions/codex-image-gen.json`    |

Project config overrides global config. Example:

```json
{
  "save": "global",
  "saveDir": "~/Pictures/generated"
}
```

### Config keys

| Key       | Type   | Default    | Description                              |
| --------- | ------ | ---------- | ---------------------------------------- |
| `save`    | string | `"global"` | Default save mode (see below).           |
| `saveDir` | string | —          | Directory used when `save=custom`.       |

### Environment variables

| Variable                     | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| `PI_CODEX_IMAGE_SAVE_MODE`   | Overrides the `save` config key.                 |
| `PI_CODEX_IMAGE_SAVE_DIR`    | Overrides the `saveDir` config key (custom mode).|
| `PI_OFFLINE=1`               | Disables install/update telemetry.              |
| `PI_TELEMETRY=0`             | Disables install/update telemetry.              |

## Save modes

| Mode      | Behavior                                                         |
| --------- | ---------------------------------------------------------------- |
| `none`    | Image is returned inline but not written to disk.                |
| `project` | Saves to `<project>/.pi/generated-images/<session-id>/`.         |
| `global`  | Saves to `~/.pi/agent/generated-images/<session-id>/`.           |
| `custom`  | Saves to a user-specified directory (requires `saveDir` or env). |

## Tool parameters

| Parameter      | Type   | Required | Description                                                        |
| -------------- | ------ | -------- | ------------------------------------------------------------------ |
| `prompt`       | string | ✅        | The image generation prompt.                                       |
| `model`        | string | —        | Gateway model route. Use `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst`; defaults to the active Pi model ID. |
| `outputFormat` | string | —        | `png` (default), `jpeg`, or `webp`.                                |
| `save`         | string | —        | Override save mode for this call.                                  |
| `saveDir`      | string | —        | Directory when `save=custom`. Relative paths resolve under CWD.    |

## How it works

1. Resolves the active Pi provider's gateway URL and API key.
2. Sends a streamed Responses API request with the selected model route and `image_generation` tool enabled.
3. The gateway routes the request to the selected backend model.
4. Parses the SSE stream for `response.output_item.done` events containing the base64 image.
5. Saves the image to disk according to the active save mode.
6. Returns the image data inline plus metadata (model, format, path, revised prompt, usage).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Missing openai-codex credentials" | Not logged in | Run `/login` and select **ChatGPT Plus/Pro (Codex)** |
| 401 / 403 response | Token expired | Re-run `/login` for openai-codex |
| 429 response | Rate limited | Wait and retry; the extension retries automatically with backoff |
| "Codex did not return an image" | Backend refused the prompt | Rephrase the prompt and try again |
| "save=custom requires saveDir" | Missing config | Set `saveDir` in config or `PI_CODEX_IMAGE_SAVE_DIR` env var |

## License

Apache-2.0
