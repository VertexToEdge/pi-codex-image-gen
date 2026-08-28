/**
 * Project-local image generation extension for Pi.
 *
 * Registers `codex_generate_image`, a tool that calls a self-hosted LiteLLM
 * gateway (which sits in front of codex-proxy, which holds the shared
 * ChatGPT/Codex login) with the native `image_generation` tool. The backend
 * maps that tool to gpt-image-2.
 *
 * This is a fork of jvm/pi-codex-image-gen (Apache-2.0), retargeted to call
 * a self-hosted gateway with a plain bearer key instead of talking to
 * chatgpt.com directly through Pi's own "openai-codex" provider login. That
 * means usage is attributed to this server's own gateway key and can be
 * throttled/monitored centrally, instead of requiring every server running
 * Pi to hold its own ChatGPT session. Install-telemetry reporting from the
 * upstream package has been removed (it phoned home to the original
 * author's own endpoint; not appropriate to carry over into a fork that
 * talks to a different backend).
 *
 * Gateway URL and API key are NOT configured separately here -- they're
 * read from Pi's currently active chat model (`ctx.model.baseUrl` /
 * `ctx.modelRegistry.getProviderAuth(ctx.model.provider)`), i.e. whatever
 * provider/model you already have Pi's chat pointed at. Point Pi's model at
 * the gateway (e.g. a custom provider with baseUrl
 * https://litellm.verte.kr/v1 and one of the server1..server6 keys) and
 * this tool automatically follows it -- one place to configure, not two.
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const CONFIG_FILENAME = "litellm-codex-image-gen.json";
const DEFAULT_SAVE_MODE = "global";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

const SAVE_MODES = ["none", "project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

// --- Retry helpers with exponential backoff + jitter ---

function isRetryableStatus(status: number, errorText: string): boolean {
	if ([429, 500, 502, 503, 504].includes(status)) return true;
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function backoffMs(attempt: number): number {
	const jitter = 0.9 + Math.random() * 0.2;
	return BASE_DELAY_MS * 2 ** (attempt - 1) * jitter;
}

// --- Tool parameter schema ---

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({ description: "The image prompt. Be specific about subject, composition, style, text, and constraints." }),
	model: Type.Optional(
		Type.String({ description: "Gateway model name that should invoke image generation. Defaults to Pi's currently active model." }),
	),
	outputFormat: Type.Optional(StringEnum(OUTPUT_FORMATS)),
	save: Type.Optional(StringEnum(SAVE_MODES)),
	saveDir: Type.Optional(
		Type.String({
			description: "Directory to save the image when save=custom. Relative paths resolve under the current workspace.",
		}),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

// --- Config types ---

interface ExtensionConfig {
	save?: SaveMode;
	saveDir?: string;
}

interface SaveConfig {
	mode: SaveMode;
	outputDir?: string;
}

interface GeneratedImage {
	id: string;
	status: string;
	result: string;
	revisedPrompt?: string;
}

interface ParsedResponse {
	image?: GeneratedImage;
	text: string[];
	responseId?: string;
	usage?: unknown;
}

type SseEvent =
	| { type: "error"; message?: string; code?: string }
	| { type: "response.failed"; response?: { error?: { message?: string } } }
	| { type: "response.created"; response?: { id?: string } }
	| { type: "response.output_text.delta"; delta?: string }
	| {
			type: "response.output_item.done";
			item?: {
				type?: string;
				id?: string | number;
				status?: string;
				result?: string;
				revised_prompt?: string;
			};
	  }
	| { type: "response.completed"; response?: { id?: string; usage?: unknown } };

// --- Config loading ---

function readConfigFile(path: string): ExtensionConfig {
	try {
		return JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch {
		return {};
	}
}

function loadConfig(cwd: string): ExtensionConfig {
	const globalConfig = readConfigFile(join(getAgentDir(), "extensions", CONFIG_FILENAME));
	const projectConfig = readConfigFile(join(cwd, ".pi", "extensions", CONFIG_FILENAME));
	return { ...globalConfig, ...projectConfig };
}

// ctx.model.baseUrl is the provider's base (e.g. "https://litellm.verte.kr/v1",
// however Pi's active model/provider is configured -- no trailing slash
// assumed). Append /responses, tolerating either form.
function resolveResponsesUrl(baseUrl: string): string {
	if (!baseUrl) {
		throw new Error("Pi's active model has no baseUrl. Point Pi's chat model at the gateway before using codex_generate_image.");
	}
	return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

// --- Path helpers ---

function resolveUnderCwd(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function sanitizePathPart(value: string, fallback: string): string {
	const sanitized = value
		.split("")
		.map((ch) => (/[a-zA-Z0-9_-]/.test(ch) ? ch : "_"))
		.join("")
		.replace(/_+$/g, "");
	return sanitized || fallback;
}

function resolveSaveConfig(params: ToolParams, cwd: string, sessionId: string, config: ExtensionConfig): SaveConfig {
	const envMode = process.env.PI_LITELLM_IMAGE_SAVE_MODE?.toLowerCase();
	const mode = (params.save || envMode || config.save || DEFAULT_SAVE_MODE) as SaveMode;
	const safeSessionId = sanitizePathPart(sessionId, "session");
	if (!SAVE_MODES.includes(mode)) {
		throw new Error(`Invalid save mode: ${mode}. Expected one of ${SAVE_MODES.join(", ")}.`);
	}
	if (mode === "project") {
		return { mode, outputDir: join(cwd, ".pi", "generated-images", safeSessionId) };
	}
	if (mode === "global") {
		return { mode, outputDir: join(getAgentDir(), "generated-images", safeSessionId) };
	}
	if (mode === "custom") {
		const configuredDir = params.saveDir || process.env.PI_LITELLM_IMAGE_SAVE_DIR || config.saveDir;
		if (!configuredDir || !configuredDir.trim()) {
			throw new Error("save=custom requires saveDir or PI_LITELLM_IMAGE_SAVE_DIR.");
		}
		return { mode, outputDir: join(resolveUnderCwd(cwd, configuredDir), safeSessionId) };
	}
	return { mode };
}

// --- Image save helpers ---

function extensionForFormat(outputFormat: OutputFormat): string {
	return outputFormat === "jpeg" ? "jpg" : outputFormat;
}

function mimeForFormat(outputFormat: OutputFormat): string {
	return outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat}`;
}

async function saveImage(base64Data: string, outputFormat: OutputFormat, outputDir: string, imageCallId: string): Promise<string> {
	const filename = `${sanitizePathPart(imageCallId, "image_generation")}.${extensionForFormat(outputFormat)}`;
	const filePath = join(outputDir, filename);
	await withFileMutationQueue(filePath, async () => {
		await mkdir(outputDir, { recursive: true });
		await writeFile(filePath, Buffer.from(base64Data, "base64"));
	});
	return filePath;
}

// --- Request building ---

function buildRequestBody(params: ToolParams, model: string, outputFormat: OutputFormat, sessionId: string) {
	return {
		model,
		store: false,
		stream: true, // required: the gateway's /v1/responses only relays cleanly in streaming mode
		prompt_cache_key: sessionId,
		instructions:
			"You are generating bitmap image assets. For this request, call the image_generation tool exactly once. Do not answer with only text unless image generation is unavailable.",
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: params.prompt }],
			},
		],
		tools: [{ type: "image_generation", output_format: outputFormat }],
		tool_choice: "auto",
		parallel_tool_calls: false,
		text: { verbosity: "low" },
	};
}

// --- SSE parsing ---

function parseSseDataLines(chunk: string): string | undefined {
	const data = chunk
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	return data && data !== "[DONE]" ? data : undefined;
}

async function parseResponseSse(response: Response, signal?: AbortSignal): Promise<ParsedResponse> {
	if (!response.body) throw new Error("Gateway response did not include a stream body.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const parsed: ParsedResponse = { text: [] };

	try {
		while (true) {
			if (signal?.aborted) throw new Error("Image generation was aborted.");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let separator = buffer.indexOf("\n\n");
			while (separator !== -1) {
				const chunk = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				const data = parseSseDataLines(chunk);
				if (data) handleSseEvent(JSON.parse(data) as SseEvent, parsed);
				separator = buffer.indexOf("\n\n");
			}
		}
		const remaining = parseSseDataLines(buffer);
		if (remaining) handleSseEvent(JSON.parse(remaining) as SseEvent, parsed);
	} finally {
		try {
			await reader.cancel();
		} catch {
			// ignored: stream may already be closed
		}
		reader.releaseLock();
	}

	return parsed;
}

function handleSseEvent(event: SseEvent, parsed: ParsedResponse): void {
	if (!event || typeof event !== "object") return;

	switch (event.type) {
		case "error": {
			const e = event as Extract<SseEvent, { type: "error" }>;
			throw new Error(`Gateway error: ${e.message || e.code || JSON.stringify(event)}`);
		}
		case "response.failed": {
			const e = event as Extract<SseEvent, { type: "response.failed" }>;
			throw new Error(e.response?.error?.message || "Response failed.");
		}
		case "response.created": {
			const e = event as Extract<SseEvent, { type: "response.created" }>;
			if (typeof e.response?.id === "string") parsed.responseId = e.response.id;
			break;
		}
		case "response.output_text.delta": {
			const e = event as Extract<SseEvent, { type: "response.output_text.delta" }>;
			if (typeof e.delta === "string") parsed.text.push(e.delta);
			break;
		}
		case "response.output_item.done": {
			const e = event as Extract<SseEvent, { type: "response.output_item.done" }>;
			const item = e.item;
			if (item?.type === "image_generation_call") {
				if (typeof item.result !== "string" || item.result.length === 0) {
					throw new Error("image_generation_call did not contain image data.");
				}
				parsed.image = {
					id: String(item.id || "image_generation"),
					status: String(item.status || "completed"),
					result: item.result,
					revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
				};
			}
			break;
		}
		case "response.completed": {
			const e = event as Extract<SseEvent, { type: "response.completed" }>;
			if (typeof e.response?.id === "string") parsed.responseId = e.response.id;
			if (e.response?.usage) parsed.usage = e.response.usage;
			break;
		}
	}
}

// --- Gateway call with retry + backoff + jitter ---

async function requestImage(
	params: ToolParams,
	gatewayUrl: string,
	apiKey: string,
	model: string,
	outputFormat: OutputFormat,
	sessionId: string,
	signal?: AbortSignal,
): Promise<ParsedResponse> {
	const body = JSON.stringify(buildRequestBody(params, model, outputFormat, sessionId));
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		accept: "text/event-stream",
		"content-type": "application/json",
	};

	for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
		if (signal?.aborted) throw new Error("Image generation was aborted.");

		const response = await fetch(gatewayUrl, { method: "POST", headers, body, signal });

		if (!response.ok) {
			const errorText = await response.text();
			if (attempt <= MAX_RETRIES && isRetryableStatus(response.status, errorText)) {
				const delay = backoffMs(attempt);
				await new Promise<void>((resolve) => setTimeout(resolve, delay));
				continue;
			}
			throw new Error(`Gateway image generation request failed (${response.status}): ${errorText}`);
		}

		return parseResponseSse(response, signal);
	}

	throw new Error("Gateway image generation request failed after all retries.");
}

// --- Extension entry point ---

export default function litellmCodexImageGen(pi: ExtensionAPI) {
	pi.registerTool({
		name: "codex_generate_image",
		label: "Gateway Image",
		description:
			"Generate an image via the self-hosted LiteLLM gateway's codex image_generation tool (backed by gpt-image-2). " +
			"Uses this server's own gateway API key; does not require OPENAI_API_KEY or a local ChatGPT login.",
		promptSnippet: "Generate bitmap images via the gateway's gpt-image-2 image_generation tool.",
		promptGuidelines: [
			"Use codex_generate_image when the user asks to generate a raster image, illustration, photo, sprite, icon draft, banner, or other bitmap asset.",
			"Do not use codex_generate_image without a clear image-generation request, because it consumes shared image quota tracked centrally on the gateway.",
		],
		parameters: TOOL_PARAMS,
		executionMode: "parallel",
		async execute(toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const outputFormat = params.outputFormat || "png";
			const config = loadConfig(ctx.cwd);

			// Reuse whatever provider/model Pi's chat is currently pointed at,
			// instead of a separately configured gateway URL/key. ctx.model is
			// the active model; its baseUrl is the provider's API base, and
			// getProviderAuth resolves the credential currently in effect for
			// that provider (API key, stored credential, OAuth, etc).
			if (!ctx.model) {
				throw new Error("No active model on this session -- select a model in Pi before using codex_generate_image.");
			}
			const gatewayUrl = resolveResponsesUrl(ctx.model.baseUrl);
			const providerAuth = await ctx.modelRegistry.getProviderAuth(ctx.model.provider);
			const apiKey = providerAuth?.auth.apiKey;
			if (!apiKey) {
				throw new Error(`No API key resolved for provider "${ctx.model.provider}". Check Pi's model/provider auth setup.`);
			}
			const model = params.model || ctx.model.id;
			const sessionId = ctx.sessionManager.getSessionId();

			onUpdate?.({
				content: [{ type: "text", text: `Requesting gpt-image-2 generation through gateway/${model}...` }],
				details: { gatewayUrl, model, outputFormat },
			});

			const parsed = await requestImage(params, gatewayUrl, apiKey, model, outputFormat, sessionId, signal);
			if (!parsed.image) {
				const text = parsed.text.join("").trim();
				throw new Error(text ? `Gateway did not return an image. Response text: ${text}` : "Gateway did not return an image.");
			}

			const saveConfig = resolveSaveConfig(params, ctx.cwd, sessionId, config);
			let savedPath: string | undefined;
			if (saveConfig.mode !== "none" && saveConfig.outputDir) {
				savedPath = await saveImage(parsed.image.result, outputFormat, saveConfig.outputDir, parsed.image.id || toolCallId);
				onUpdate?.({
					content: [{ type: "text", text: `Image saved to ${savedPath}.` }],
					details: { model, savedPath, byteCount: Buffer.byteLength(parsed.image.result, "base64") },
				});
			}

			const summary = [
				`Generated image via gateway/${model} using backend gpt-image-2.`,
				`Status: ${parsed.image.status}.`,
				parsed.image.revisedPrompt ? `Revised prompt: ${parsed.image.revisedPrompt}` : undefined,
				savedPath ? `Saved image to: ${savedPath}` : "Image was not saved to disk.",
			]
				.filter(Boolean)
				.join(" ");

			return {
				content: [
					{ type: "text", text: summary },
					{ type: "image", data: parsed.image.result, mimeType: mimeForFormat(outputFormat) },
				],
				details: {
					model,
					backendImageModel: "gpt-image-2",
					outputFormat,
					saveMode: saveConfig.mode,
					savedPath,
					responseId: parsed.responseId,
					imageGenerationId: parsed.image.id,
					revisedPrompt: parsed.image.revisedPrompt,
					usage: parsed.usage,
				},
			};
		},
	});
}
