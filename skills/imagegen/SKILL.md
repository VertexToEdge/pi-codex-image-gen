---
name: "imagegen"
description: "Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or UI assets. Use input images for image-to-image edits and reference-guided generation. Do not use when the task is better handled by editing existing SVG/vector/code-native assets or building the visual directly in HTML/CSS/canvas."
---

# Image Generation Skill

Generates and edits images for the current project (website assets, game assets, UI mockups, product mockups, wireframes, icon drafts, banners) via the `codex_generate_image` tool, which calls this deployment's self-hosted LiteLLM gateway (gpt-image-2 backend). No `OPENAI_API_KEY` or local ChatGPT login is required — the gateway holds the shared credential.

## Rules

- Use `codex_generate_image` for any raster/bitmap image request. Call it once per requested asset or variant.
- Be specific in the prompt: subject, composition, style, any text that must appear, and constraints (aspect ratio, background, mood).
- For image-to-image edits, pass local paths in `inputImages`; relative paths resolve under the current workspace. The tool accepts PNG, JPEG, WebP, and GIF inputs.
- Describe each input image's role explicitly in the prompt (`Image 1 is the base image`, `Image 2 is the style reference`). Multiple references are supported.
- Supplying `inputImages` defaults `action` to `edit`; omit inputs for generation. Use `action=auto` only when the gateway model should decide between generation and editing.
- This tool does not support `background=transparent`; if the user needs a true transparent background, generate on a flat, easily removable background color and say a local background-removal step would be needed — do not attempt CLI/API fallbacks that aren't configured in this deployment.
- Generated images are saved under Pi's agent directory by default: `<pi-agent-dir>/generated-images/<pi-session-id>/<image-call-id>.*` (`save=global`, the default). Pass `save=project` to save under `.pi/generated-images/` in the current workspace instead, or `save=custom` with `saveDir` for an explicit path.
- Image generation consumes shared quota tracked centrally on the gateway (per-server key). Don't call it speculatively without a clear image request.
