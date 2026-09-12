import Schema from "schemastery";
import { homedir } from "node:os";
import path, { join, posix } from "node:path";
import { ZodError, z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/config.ts
const Config = Schema.object({
	channels: Schema.array(Schema.object({
		id: Schema.string().required().description("渠道标识，用于轮换与诊断"),
		label: Schema.string().description("显示名"),
		baseUrl: Schema.string().required().description("OpenAI 兼容 base URL；缺 /v1 会自动尝试"),
		apiKey: Schema.string().role("secret").description("密钥明文（不推荐，优先用 apiKeyEnv）"),
		apiKeyEnv: Schema.string().description("存放密钥的环境变量名"),
		models: Schema.array(Schema.string()).description("图像模型 id；留空则用 GET /models 发现并按名称分类"),
		textModel: Schema.string().description("本渠道的分析/规划文本模型"),
		imageModel: Schema.string().description("本渠道的图像生成模型"),
		disabled: Schema.boolean().default(false)
	})).default([]).description("渠道列表，按顺序轮换"),
	workspaceDir: Schema.string().description("项目根目录，默认 $DSH_HOME/mxpage"),
	defaultLanguage: Schema.union([
		"zh-CN",
		"en",
		"ja",
		"ko"
	]).default("zh-CN"),
	defaultHeroCount: Schema.number().default(3),
	defaultDetailCount: Schema.number().default(6),
	defaultDetailAspectRatio: Schema.union([
		"1:1",
		"3:4",
		"9:16"
	]).default("3:4"),
	defaultPlatform: Schema.string().default("general_ecommerce"),
	defaultStyle: Schema.string().default("generic_clean"),
	analyzeTimeoutMs: Schema.number().default(18e4),
	promptTimeoutMs: Schema.number().default(6e4),
	imageTimeoutMs: Schema.number().default(12e4),
	maxReferenceImages: Schema.number().default(4),
	maxAnalysisImages: Schema.number().default(10),
	maxParallelSections: Schema.number().default(2),
	maxParallelProjects: Schema.number().default(1),
	rotateChannelOnQuotaExhausted: Schema.boolean().default(true).description("上游对 429/额度 不轮换模型；多渠道下开启此项会换到下一个渠道"),
	allowSvgFallback: Schema.boolean().default(false)
});
//#endregion
//#region src/core/ports/logger.ts
/** Derives a usage category from a request URL and an optional parsed/raw body. */
function inferCategory(url, body) {
	const serialized = typeof body === "string" ? body : body ? JSON.stringify(body) : "";
	if (/\/images\/edits/i.test(url)) return "image_edit";
	if (/\/images\/generations/i.test(url)) return "image_generation";
	if (/\/chat\/completions/i.test(url)) return /"response_format"/.test(serialized) ? "structured" : "text";
	if (/generateContent/i.test(url)) return "image_generation";
	if (/\/models/i.test(url)) return "models";
	return "unknown";
}
const noopLogger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	usage() {}
};
//#endregion
//#region src/core/ai/adapters/openai-compatible.ts
function normalizeBaseUrl(baseUrl) {
	return baseUrl.replace(/\/+$/, "");
}
function hasOpenAiVersionSuffix(baseUrl) {
	return /\/v\d+(?:beta)?$/i.test(normalizeBaseUrl(baseUrl));
}
function buildOpenAiCompatibleUrls(baseUrl, path) {
	const normalized = normalizeBaseUrl(baseUrl);
	const urls = [];
	if (!hasOpenAiVersionSuffix(normalized)) urls.push(`${normalized}/v1${path}`);
	urls.push(`${normalized}${path}`);
	return [...new Set(urls)];
}
function baseUrlFromRequestUrl(url, path) {
	return url.endsWith(path) ? normalizeBaseUrl(url.slice(0, -path.length)) : null;
}
function shouldRetryWithVersionedBase(status, body) {
	return status === 404 || status === 405 || /not found|no route|cannot\s+(get|post)|unsupported endpoint/i.test(body);
}
function isGeminiImageModel$1(model) {
	return /gemini.*image|nano-banana|banana/i.test(model);
}
function isOpenAiGptImageModel$1(model) {
	return /(?:^|[-_\s])gpt[-_\s]?image(?:[-_\s]?(?:\d+(?:\.\d+)?|mini))?|chatgpt-image/i.test(model);
}
function deriveGoogleBaseUrl(baseUrl) {
	const normalized = normalizeBaseUrl(baseUrl);
	if (/\/google(?:\/.*)?$/i.test(normalized)) return normalized.replace(/\/(v1|v1beta)$/i, "");
	if (/\/v1(?:beta)?$/i.test(normalized)) return normalized.replace(/\/v1(?:beta)?$/i, "/google");
	return `${normalized}/google`;
}
function sizeToAspectRatio(size) {
	switch (size) {
		case "3:4": return "3:4";
		case "9:16": return "9:16";
		case "1024x1536": return "2:3";
		case "1536x1024": return "3:2";
		case "1024x1024": return "1:1";
		default: return "9:16";
	}
}
function resolveAspectRatio(input) {
	if (input.aspectRatio) return input.aspectRatio;
	return sizeToAspectRatio(input.size);
}
function resolveOpenAiSize(input) {
	if (input.size) return input.size;
	if (input.aspectRatio === "1:1") return "1024x1024";
	if (input.aspectRatio === "3:4" || input.aspectRatio === "9:16") return "1024x1536";
	return "1024x1536";
}
function dataUrlToInlineData(dataUrl) {
	const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
	if (!match) throw new Error("Invalid base64 image data URL.");
	return {
		mimeType: match[1],
		data: match[2]
	};
}
function dataUrlToBlob(dataUrl) {
	const inlineData = dataUrlToInlineData(dataUrl);
	return new Blob([Buffer.from(inlineData.data, "base64")], { type: inlineData.mimeType });
}
function extractTextContent(payload) {
	const message = payload?.choices?.[0]?.message?.content;
	if (typeof message === "string") return message;
	if (Array.isArray(message)) return message.map((entry) => typeof entry === "object" && entry && "text" in entry ? String(entry.text ?? "") : "").join("\n").trim();
	return "";
}
function parseJsonBlock(raw) {
	const direct = raw.trim();
	if (direct.startsWith("{") || direct.startsWith("[")) return direct;
	const fencedMatch = direct.match(/```json([\s\S]*?)```/i) || direct.match(/```([\s\S]*?)```/i);
	if (fencedMatch?.[1]) return fencedMatch[1].trim();
	const firstBrace = direct.indexOf("{");
	const lastBrace = direct.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) return direct.slice(firstBrace, lastBrace + 1);
	return direct;
}
function tryParseJsonBody(body) {
	if (typeof body !== "string") return null;
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}
function tryReadBodyModel(body) {
	const jsonPayload = tryParseJsonBody(body);
	if (typeof jsonPayload?.model === "string") return jsonPayload.model;
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		const model = body.get("model");
		return typeof model === "string" ? model : null;
	}
	return null;
}
function inferModelFromEndpoint(url, bodyPayload) {
	if (typeof bodyPayload?.model === "string") return bodyPayload.model;
	return url.match(/\/models\/([^:\/]+):generateContent/i)?.[1] ?? null;
}
function readMonitorContext(input) {
	return {
		projectId: input?.projectId ?? null,
		sectionId: input?.sectionId ?? null,
		operation: input?.operation ?? null
	};
}
function tryParseStructuredPayload(raw, schema) {
	const parsedJson = JSON.parse(parseJsonBlock(raw));
	return schema.parse(parsedJson);
}
function isUnsupportedTemperatureError(error) {
	if (!(error instanceof Error)) return false;
	return /temperature/i.test(error.message) && /unsupported|does not support|only the default|unsupported_value/i.test(error.message);
}
function omitTemperature(body) {
	const { temperature: _temperature, ...rest } = body;
	return rest;
}
function shouldOmitTemperatureForModel(model) {
	return /^gpt-5/i.test(model);
}
function withOptionalTemperature(model, body, temperature) {
	return shouldOmitTemperatureForModel(model) ? body : {
		...body,
		temperature
	};
}
function buildMessages(input) {
	const content = input.images?.length ? [{
		type: "text",
		text: input.userPrompt
	}, ...input.images.map((url) => ({
		type: "image_url",
		image_url: { url }
	}))] : input.userPrompt;
	const messages = [];
	if (input.systemPrompt) messages.push({
		role: "system",
		content: input.systemPrompt
	});
	messages.push({
		role: "user",
		content
	});
	return messages;
}
function extractImageResult(payload) {
	const result = payload.data?.[0];
	if (!result) throw new Error("Image generation returned no data.");
	return {
		url: result.url ?? null,
		b64Json: result.b64_json ?? null,
		revisedPrompt: result.revised_prompt ?? null
	};
}
function extractGoogleImageResult(payload) {
	const parts = payload?.candidates?.[0]?.content?.parts ?? [];
	for (const part of parts) {
		const inlineData = part?.inlineData ?? part?.inline_data ?? null;
		if (inlineData?.data) return {
			url: null,
			b64Json: String(inlineData.data),
			revisedPrompt: typeof part?.text === "string" ? part.text : null
		};
	}
	throw new Error("Google image generation returned no inline image data.");
}
function toImageRefs(images) {
	return images.map((imageUrl) => ({ image_url: imageUrl }));
}
function toMaskRef(mask) {
	return { image_url: mask };
}
function classifyProbeResult(status, body) {
	if (/model.+does not exist|does not exist|invalid_value.+model|param.+model|unsupported model/i.test(body)) return "unavailable";
	if (/no available endpoint|not found|404/i.test(body) || status === 404) return "unavailable";
	if (status === 429 || /限流|rate limit/i.test(body)) return "rate_limited";
	if (/invalid value.+size|supported values|images\[0\]|unknown parameter|invalid type|aspectratio/i.test(body)) return "available";
	if (status === 401 || status === 403) return "unknown";
	if (status === 400 || status === 200) return "available";
	return "unknown";
}
var OpenAICompatibleAdapter = class {
	preferredBaseUrl = null;
	baseUrl;
	apiKey;
	logger;
	constructor(baseUrl, apiKey, logger = noopLogger) {
		this.baseUrl = baseUrl;
		this.apiKey = apiKey;
		this.logger = logger;
	}
	/**
	* Maps upstream's `logApiUsage` call shape onto the Logger port.
	*
	* Upstream imported this from `@/lib/monitor/api-usage` — an 18 KB in-app
	* HTTP ledger backed by a JSON file. That single import was the only thing
	* keeping this 1344-line adapter out of a framework-free bundle.
	*/
	async logUsage(params) {
		const event = {
			endpoint: params.finalEndpoint ?? params.endpoint,
			finalEndpoint: params.finalEndpoint ?? params.endpoint,
			method: params.method,
			model: params.model ?? void 0,
			status: params.statusCode,
			ok: params.success,
			durationMs: params.durationMs,
			requestBytes: params.requestBytes,
			responseBytes: params.responseBytes,
			attemptCount: params.attemptCount,
			retrySummary: params.retrySummary ?? void 0,
			collapsedAttempts: params.collapsedAttempts?.map((attempt) => ({
				url: attempt.endpoint,
				status: attempt.statusCode
			})),
			category: params.category,
			errorMessage: params.errorMessage ?? void 0,
			projectId: params.projectId ?? void 0,
			sectionId: params.sectionId ?? void 0,
			operation: params.operation ?? void 0
		};
		try {
			this.logger.usage(event);
		} catch {}
	}
	buildRequestUrls(path) {
		const urls = buildOpenAiCompatibleUrls(this.baseUrl, path);
		if (!this.preferredBaseUrl) return urls;
		const preferredUrl = `${this.preferredBaseUrl}${path}`;
		return [preferredUrl, ...urls.filter((url) => url !== preferredUrl)];
	}
	rememberCompatibleBaseUrl(url, path, response) {
		if (!response.ok && shouldRetryWithVersionedBase(response.status, response.body)) return;
		this.preferredBaseUrl = baseUrlFromRequestUrl(url, path) ?? this.preferredBaseUrl;
	}
	async fetchRaw(url, init, extraHeaders, timeoutMs = 15e3, monitor, options) {
		const controller = new AbortController();
		const externalSignal = init?.signal;
		const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
		if (externalSignal?.aborted) abortFromExternalSignal();
		else externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		const startedAt = Date.now();
		const method = init?.method ?? "GET";
		const bodyPayload = tryParseJsonBody(init?.body);
		const model = tryReadBodyModel(init?.body) ?? inferModelFromEndpoint(url, bodyPayload);
		const category = inferCategory(url, bodyPayload);
		const requestBytes = typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0;
		try {
			const response = await fetch(url, {
				...init,
				headers: {
					...typeof FormData !== "undefined" && init?.body instanceof FormData ? {} : { "Content-Type": "application/json" },
					Authorization: `Bearer ${this.apiKey}`,
					...extraHeaders ?? {},
					...init?.headers ?? {}
				},
				cache: "no-store",
				signal: controller.signal
			});
			const body = await response.text();
			if (!options?.suppressUsageLog) await this.logUsage({
				providerBaseUrl: normalizeBaseUrl(this.baseUrl),
				endpoint: url,
				method,
				model,
				...readMonitorContext(monitor),
				category,
				statusCode: response.status,
				durationMs: Date.now() - startedAt,
				success: response.ok,
				requestBytes,
				responseBytes: Buffer.byteLength(body),
				responseBody: body,
				errorMessage: response.ok ? null : body.slice(0, 1e3)
			});
			return {
				ok: response.ok,
				status: response.status,
				body,
				durationMs: Date.now() - startedAt
			};
		} catch (error) {
			if (!options?.suppressUsageLog) await this.logUsage({
				providerBaseUrl: normalizeBaseUrl(this.baseUrl),
				endpoint: url,
				method,
				model,
				...readMonitorContext(monitor),
				category,
				statusCode: 0,
				durationMs: Date.now() - startedAt,
				success: false,
				requestBytes,
				responseBytes: 0,
				responseBody: "",
				errorMessage: error instanceof Error ? error.message : "Unknown request failure"
			});
			if (error?.name === "AbortError") {
				if (externalSignal?.aborted) throw new Error("Task canceled.");
				throw new Error(`Provider request timed out after ${timeoutMs}ms: ${url}`);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			externalSignal?.removeEventListener("abort", abortFromExternalSignal);
		}
	}
	async requestRaw(path, init, timeoutMs, monitor, options) {
		const urls = this.buildRequestUrls(path);
		if (urls.length === 1) {
			const response = await this.fetchRaw(urls[0], init, void 0, timeoutMs, monitor, options);
			this.rememberCompatibleBaseUrl(urls[0], path, response);
			return response;
		}
		const startedAt = Date.now();
		const method = init?.method ?? "GET";
		const bodyPayload = tryParseJsonBody(init?.body);
		const requestBytes = typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0;
		const collapsedAttempts = [];
		let lastResponse = null;
		let lastUrl = urls[0];
		let lastError = null;
		for (const url of urls) try {
			const response = await this.fetchRaw(url, init, void 0, timeoutMs, monitor, {
				...options,
				suppressUsageLog: true
			});
			lastResponse = response;
			lastUrl = url;
			collapsedAttempts.push({
				endpoint: url,
				statusCode: response.status,
				success: response.ok,
				errorMessage: response.ok ? null : response.body.slice(0, 1e3)
			});
			this.rememberCompatibleBaseUrl(url, path, response);
			if (response.ok || !shouldRetryWithVersionedBase(response.status, response.body)) break;
		} catch (error) {
			lastError = error;
			lastUrl = url;
			collapsedAttempts.push({
				endpoint: url,
				statusCode: 0,
				success: false,
				errorMessage: error instanceof Error ? error.message : "Unknown request failure"
			});
			break;
		}
		const finalResponse = lastError && (!lastResponse || shouldRetryWithVersionedBase(lastResponse.status, lastResponse.body)) ? {
			ok: false,
			status: 0,
			body: lastError instanceof Error ? lastError.message : "Unknown request failure",
			durationMs: Date.now() - startedAt
		} : lastResponse ?? {
			ok: false,
			status: 0,
			body: "",
			durationMs: Date.now() - startedAt
		};
		const retrySummary = collapsedAttempts.length > 1 ? collapsedAttempts.filter((item) => !item.success).map((item) => `${item.endpoint} -> ${item.statusCode}: ${item.errorMessage ?? "Unknown error"}`).join(" | ") : null;
		if (!options?.suppressUsageLog) await this.logUsage({
			providerBaseUrl: normalizeBaseUrl(this.baseUrl),
			endpoint: urls[0],
			finalEndpoint: lastUrl,
			method,
			model: tryReadBodyModel(init?.body) ?? inferModelFromEndpoint(lastUrl, bodyPayload),
			...readMonitorContext(monitor),
			category: inferCategory(lastUrl, bodyPayload),
			statusCode: finalResponse.status,
			durationMs: Date.now() - startedAt,
			success: finalResponse.ok,
			requestBytes,
			responseBytes: Buffer.byteLength(finalResponse.body),
			responseBody: finalResponse.body,
			attemptCount: collapsedAttempts.length,
			retrySummary,
			collapsedAttempts,
			errorMessage: finalResponse.ok ? null : finalResponse.body.slice(0, 1e3) || (lastError instanceof Error ? lastError.message : "Unknown request failure")
		});
		if (!lastResponse && lastError) {
			if (lastError?.name === "AbortError") throw new Error(`Provider request timed out after ${timeoutMs ?? 15e3}ms: ${lastUrl}`);
			throw lastError;
		}
		return finalResponse;
	}
	async requestJson(path, init, timeoutMs, monitor, options) {
		const response = await this.requestRaw(path, init, timeoutMs, monitor, options);
		if (!response.ok) throw new Error(`Provider request failed (${response.status}): ${response.body}`);
		return JSON.parse(response.body);
	}
	async requestChatCompletion(body, timeoutMs, monitor, options) {
		try {
			return await this.requestJson("/chat/completions", {
				method: "POST",
				body: JSON.stringify(body),
				signal: options?.signal
			}, timeoutMs, monitor, options);
		} catch (error) {
			if (!("temperature" in body) || !isUnsupportedTemperatureError(error)) throw error;
			return this.requestJson("/chat/completions", {
				method: "POST",
				body: JSON.stringify(omitTemperature(body)),
				signal: options?.signal
			}, timeoutMs, monitor, options);
		}
	}
	async requestMultipartJson(path, fields, images, options) {
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) if (value !== null && value !== void 0) form.append(key, String(value));
		const imageFieldName = options?.imageFieldName ?? (images.length > 1 ? "image[]" : "image");
		images.forEach((image, index) => {
			form.append(imageFieldName, dataUrlToBlob(image), `image-${index + 1}.png`);
		});
		const response = await this.requestRaw(path, {
			method: "POST",
			body: form,
			signal: options?.signal
		}, options?.timeoutMs, options?.monitor);
		if (!response.ok) throw new Error(`Provider request failed (${response.status}): ${response.body}`);
		return JSON.parse(response.body);
	}
	async requestGoogleJson(path, body, timeoutMs = 45e3, monitor, signal) {
		const base = deriveGoogleBaseUrl(this.baseUrl);
		const attempts = [`${base}/v1${path}`, `${base}/v1beta${path}`];
		const collapsedAttempts = [];
		let finalSuccess = null;
		for (const url of attempts) try {
			const response = await this.fetchRaw(url, {
				method: "POST",
				body: JSON.stringify(body),
				signal
			}, { "x-goog-api-key": this.apiKey }, timeoutMs, monitor, { suppressUsageLog: true });
			collapsedAttempts.push({
				endpoint: url,
				statusCode: response.status,
				success: response.ok,
				errorMessage: response.ok ? null : response.body.slice(0, 1e3)
			});
			if (response.ok) {
				finalSuccess = {
					body: response.body,
					url,
					status: response.status,
					durationMs: response.durationMs
				};
				break;
			}
		} catch (error) {
			collapsedAttempts.push({
				endpoint: url,
				statusCode: 0,
				success: false,
				errorMessage: error instanceof Error ? error.message : "Unknown Google protocol error"
			});
		}
		const requestBody = JSON.stringify(body);
		const model = typeof body?.model === "string" ? String(body.model) : inferModelFromEndpoint(path);
		const retrySummary = collapsedAttempts.length > 1 ? collapsedAttempts.filter((item) => !item.success).map((item) => `${item.statusCode} ${item.endpoint}`).join(" | ") : null;
		if (finalSuccess) {
			await this.logUsage({
				providerBaseUrl: normalizeBaseUrl(this.baseUrl),
				endpoint: finalSuccess.url,
				finalEndpoint: finalSuccess.url,
				method: "POST",
				model,
				...readMonitorContext(monitor),
				category: inferCategory(finalSuccess.url, typeof body === "object" ? body : null),
				statusCode: finalSuccess.status,
				durationMs: collapsedAttempts.reduce((sum, item, index) => sum + (index === collapsedAttempts.length - 1 ? finalSuccess.durationMs : 0), 0) || finalSuccess.durationMs,
				success: true,
				requestBytes: Buffer.byteLength(requestBody),
				responseBytes: Buffer.byteLength(finalSuccess.body),
				responseBody: finalSuccess.body,
				attemptCount: collapsedAttempts.length,
				retrySummary,
				collapsedAttempts,
				errorMessage: null
			});
			return JSON.parse(finalSuccess.body);
		}
		const errorSummary = collapsedAttempts.map((item) => `${item.endpoint} -> ${item.statusCode}: ${item.errorMessage ?? "Unknown error"}`).join(" | ");
		await this.logUsage({
			providerBaseUrl: normalizeBaseUrl(this.baseUrl),
			endpoint: attempts[attempts.length - 1] ?? `${base}/v1${path}`,
			finalEndpoint: attempts[attempts.length - 1] ?? `${base}/v1${path}`,
			method: "POST",
			model,
			...readMonitorContext(monitor),
			category: inferCategory(`${base}/v1${path}`, typeof body === "object" ? body : null),
			statusCode: collapsedAttempts[collapsedAttempts.length - 1]?.statusCode ?? 0,
			durationMs: 0,
			success: false,
			requestBytes: Buffer.byteLength(requestBody),
			responseBytes: 0,
			responseBody: errorSummary,
			attemptCount: collapsedAttempts.length,
			retrySummary,
			collapsedAttempts,
			errorMessage: errorSummary
		});
		throw new Error(`Google protocol request failed: ${errorSummary}`);
	}
	async repairStructuredOutput(input, raw, reason) {
		const repairedRaw = extractTextContent(await this.requestChatCompletion(withOptionalTemperature(input.model, {
			model: input.model,
			response_format: { type: "json_object" },
			messages: [{
				role: "system",
				content: "You repair malformed model output into strict valid JSON. Return JSON only."
			}, {
				role: "user",
				content: [
					`The previous response could not be parsed.`,
					`Reason: ${reason}`,
					"Convert the following content into strict valid JSON that matches the intended structure.",
					"Do not add markdown fences or commentary.",
					"",
					raw
				].join("\n")
			}]
		}, 0), Math.min(input.timeoutMs ?? 6e4, 45e3), input.monitor, {
			suppressUsageLog: input.suppressUsageLog,
			signal: input.signal
		}));
		return {
			parsed: tryParseStructuredPayload(repairedRaw, input.schema),
			raw: repairedRaw
		};
	}
	async probeGeminiImageSupport(model) {
		const tinyTransparentPixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pW4xQAAAABJRU5ErkJggg==";
		const generationBody = {
			contents: [{
				role: "user",
				parts: [{ text: "Generate a simple colored square." }]
			}],
			generationConfig: {
				responseModalities: ["TEXT", "IMAGE"],
				candidateCount: 1,
				imageConfig: { aspectRatio: "1:1" }
			}
		};
		const editBody = {
			contents: [{
				role: "user",
				parts: [{ text: "Edit this image slightly and keep the same subject." }, { inlineData: dataUrlToInlineData(tinyTransparentPixel) }]
			}],
			generationConfig: {
				responseModalities: ["TEXT", "IMAGE"],
				candidateCount: 1,
				imageConfig: { aspectRatio: "1:1" }
			}
		};
		const generationProbe = await this.fetchRaw(`${deriveGoogleBaseUrl(this.baseUrl)}/v1beta/models/${model}:generateContent`, {
			method: "POST",
			body: JSON.stringify(generationBody)
		}, { "x-goog-api-key": this.apiKey }, 5e3, void 0, { suppressUsageLog: true });
		const editProbe = await this.fetchRaw(`${deriveGoogleBaseUrl(this.baseUrl)}/v1beta/models/${model}:generateContent`, {
			method: "POST",
			body: JSON.stringify(editBody)
		}, { "x-goog-api-key": this.apiKey }, 5e3, void 0, { suppressUsageLog: true });
		return {
			imageGeneration: classifyProbeResult(generationProbe.status, generationProbe.body),
			imageEdit: classifyProbeResult(editProbe.status, editProbe.body),
			note: [generationProbe.body, editProbe.body].filter(Boolean).join(" | ").slice(0, 1e3)
		};
	}
	async probeOpenAiGptImageSupport(model) {
		const tinyTransparentPixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pW4xQAAAABJRU5ErkJggg==";
		const generationProbe = await this.requestRaw("/images/generations", {
			method: "POST",
			body: JSON.stringify({
				model,
				prompt: "probe",
				size: "1024x1024"
			})
		}, 5e3, void 0, { suppressUsageLog: true });
		let editProbe;
		try {
			const form = new FormData();
			form.append("model", model);
			form.append("prompt", "probe");
			form.append("size", "1024x1024");
			form.append("image", dataUrlToBlob(tinyTransparentPixel), "probe.png");
			editProbe = await this.requestRaw("/images/edits", {
				method: "POST",
				body: form
			}, 5e3, void 0, { suppressUsageLog: true });
		} catch (error) {
			editProbe = {
				status: 0,
				body: error instanceof Error ? error.message : "Unknown multipart image edit probe error"
			};
		}
		return {
			imageGeneration: classifyProbeResult(generationProbe.status, generationProbe.body),
			imageEdit: classifyProbeResult(editProbe.status, editProbe.body),
			note: [generationProbe.body, editProbe.body].filter(Boolean).join(" | ").slice(0, 1e3)
		};
	}
	async probeImageEndpointSupport(model) {
		return {
			imageGeneration: "unknown",
			imageEdit: "unknown",
			note: `已跳过 ${model} 的真实图像接口探测，避免在校验/发现阶段消耗图像额度。`
		};
	}
	async testConnection() {
		await this.requestJson("/models", { method: "GET" });
		return {
			ok: true,
			providerLabel: normalizeBaseUrl(this.baseUrl)
		};
	}
	async listModels() {
		return ((await this.requestJson("/models", { method: "GET" })).data ?? []).map((item) => ({
			id: item.id,
			label: item.label ?? item.name ?? item.id,
			type: typeof item.type === "string" ? item.type : typeof item.category === "string" ? item.category : null,
			category: typeof item.category === "string" ? item.category : typeof item.type === "string" ? item.type : null,
			modalities: Array.isArray(item.modalities) ? item.modalities.filter((entry) => typeof entry === "string") : Array.isArray(item.capabilities) ? item.capabilities.filter((entry) => typeof entry === "string") : void 0
		}));
	}
	async generateText(input) {
		return { text: extractTextContent(await this.requestChatCompletion(withOptionalTemperature(input.model, {
			model: input.model,
			messages: buildMessages(input)
		}, .4), input.timeoutMs ?? 6e4, input.monitor, {
			suppressUsageLog: input.suppressUsageLog,
			signal: input.signal
		})) };
	}
	async generateStructured(input) {
		const raw = extractTextContent(await this.requestChatCompletion(withOptionalTemperature(input.model, {
			model: input.model,
			messages: buildMessages(input),
			response_format: { type: "json_object" }
		}, .2), input.timeoutMs ?? 6e4, input.monitor, {
			suppressUsageLog: input.suppressUsageLog,
			signal: input.signal
		}));
		try {
			return {
				parsed: tryParseStructuredPayload(raw, input.schema),
				raw
			};
		} catch (error) {
			return this.repairStructuredOutput(input, raw, error instanceof Error ? error.message : "Unknown structured parse error");
		}
	}
	async generateGeminiImageWithGoogleProtocol(input) {
		const imageParts = [input.baseImage ?? null, ...input.referenceImages ?? []].filter(Boolean).map((item) => ({ inlineData: dataUrlToInlineData(item) }));
		return extractGoogleImageResult(await this.requestGoogleJson(`/models/${input.model}:generateContent`, {
			contents: [{
				role: "user",
				parts: [{ text: input.prompt }, ...imageParts]
			}],
			generationConfig: {
				responseModalities: ["TEXT", "IMAGE"],
				candidateCount: 1,
				imageConfig: { aspectRatio: resolveAspectRatio(input) }
			}
		}, 9e4, input.monitor, input.signal));
	}
	async generateOpenAiGptImageWithReferences(input) {
		const fields = {
			model: input.model,
			prompt: input.prompt,
			size: resolveOpenAiSize(input)
		};
		const errors = [];
		for (const imageFieldName of ["image[]", "image"]) try {
			return extractImageResult(await this.requestMultipartJson("/images/edits", fields, input.images, {
				imageFieldName,
				timeoutMs: input.timeoutMs ?? 12e4,
				monitor: input.monitor,
				signal: input.signal
			}));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : "Unknown GPT Image multipart error");
		}
		throw new Error(`GPT Image multipart request failed: ${errors.join(" | ")}`);
	}
	async generateImage(input) {
		const referenceImages = input.referenceImages ?? [];
		let googleProtocolError = null;
		if (isGeminiImageModel$1(input.model)) try {
			return await this.generateGeminiImageWithGoogleProtocol({
				model: input.model,
				prompt: input.prompt,
				referenceImages,
				size: input.size,
				aspectRatio: input.aspectRatio,
				monitor: input.monitor,
				signal: input.signal
			});
		} catch (error) {
			googleProtocolError = error;
			if (!referenceImages.length) throw error;
		}
		if (referenceImages.length > 0) {
			const referenceErrors = [];
			if (googleProtocolError instanceof Error) referenceErrors.push(`Google protocol failed: ${googleProtocolError.message}`);
			if (isOpenAiGptImageModel$1(input.model)) try {
				return await this.generateOpenAiGptImageWithReferences({
					model: input.model,
					prompt: input.prompt,
					images: referenceImages,
					size: input.size,
					aspectRatio: input.aspectRatio,
					timeoutMs: input.timeoutMs,
					monitor: input.monitor,
					signal: input.signal
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown GPT Image reference generation error";
				throw new Error(`GPT Image reference generation via /images/edits failed: ${message}`);
			}
			const imageRefs = toImageRefs(referenceImages);
			for (const attempt of [
				{
					path: "/images/edits",
					body: {
						model: input.model,
						prompt: input.prompt,
						size: resolveOpenAiSize(input),
						images: imageRefs
					}
				},
				{
					path: "/images/edits",
					body: {
						model: input.model,
						prompt: input.prompt,
						size: resolveOpenAiSize(input),
						images: imageRefs,
						input_fidelity: "high"
					}
				},
				{
					path: "/images/generations",
					body: {
						model: input.model,
						prompt: input.prompt,
						size: resolveOpenAiSize(input),
						reference_images: imageRefs
					}
				},
				{
					path: "/images/generations",
					body: {
						model: input.model,
						prompt: input.prompt,
						size: resolveOpenAiSize(input),
						input_images: imageRefs
					}
				}
			]) try {
				return extractImageResult(await this.requestJson(attempt.path, {
					method: "POST",
					body: JSON.stringify(attempt.body),
					signal: input.signal
				}, input.timeoutMs ?? 12e4, input.monitor));
			} catch (error) {
				referenceErrors.push(error instanceof Error ? error.message : "Unknown reference image generation error");
			}
			throw new Error(`Reference-guided image generation failed: ${referenceErrors.join(" | ")}`);
		}
		try {
			return extractImageResult(await this.requestJson("/images/generations", {
				method: "POST",
				body: JSON.stringify({
					model: input.model,
					prompt: input.prompt,
					size: resolveOpenAiSize(input)
				}),
				signal: input.signal
			}, input.timeoutMs ?? 12e4, input.monitor));
		} catch (error) {
			if (!isGeminiImageModel$1(input.model)) throw error;
			return this.generateGeminiImageWithGoogleProtocol({
				model: input.model,
				prompt: input.prompt,
				size: input.size,
				aspectRatio: input.aspectRatio,
				monitor: input.monitor,
				signal: input.signal
			});
		}
	}
	async editImage(input) {
		const imageRefs = toImageRefs([input.image, ...input.referenceImages ?? []]);
		let googleProtocolError = null;
		if (isGeminiImageModel$1(input.model)) try {
			return await this.generateGeminiImageWithGoogleProtocol({
				model: input.model,
				prompt: input.prompt,
				baseImage: input.image,
				referenceImages: input.referenceImages,
				size: input.size,
				aspectRatio: input.aspectRatio,
				monitor: input.monitor,
				signal: input.signal
			});
		} catch (error) {
			googleProtocolError = error;
		}
		if (isOpenAiGptImageModel$1(input.model)) try {
			return await this.generateOpenAiGptImageWithReferences({
				model: input.model,
				prompt: input.prompt,
				images: [input.image, ...input.referenceImages ?? []],
				size: input.size,
				aspectRatio: input.aspectRatio,
				timeoutMs: input.timeoutMs,
				monitor: input.monitor,
				signal: input.signal
			});
		} catch {}
		const attempts = [
			{
				path: "/images/edits",
				body: {
					model: input.model,
					prompt: input.prompt,
					size: resolveOpenAiSize(input),
					images: imageRefs,
					...input.mask ? { mask: toMaskRef(input.mask) } : {}
				}
			},
			{
				path: "/images/edits",
				body: {
					model: input.model,
					prompt: input.prompt,
					size: resolveOpenAiSize(input),
					images: imageRefs,
					input_fidelity: "high",
					...input.mask ? { mask: toMaskRef(input.mask) } : {}
				}
			},
			{
				path: "/images/generations",
				body: {
					model: input.model,
					prompt: input.prompt,
					size: resolveOpenAiSize(input),
					reference_images: imageRefs,
					...input.mask ? { mask: toMaskRef(input.mask) } : {}
				}
			}
		];
		const errors = [];
		for (const attempt of attempts) try {
			return extractImageResult(await this.requestJson(attempt.path, {
				method: "POST",
				body: JSON.stringify(attempt.body),
				signal: input.signal
			}, input.timeoutMs ?? 12e4, input.monitor));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : "Unknown image edit error");
		}
		if (isGeminiImageModel$1(input.model)) errors.unshift(googleProtocolError instanceof Error ? `Google protocol image edit failed: ${googleProtocolError.message}` : "Google protocol image edit attempt did not complete successfully");
		throw new Error(`Base64 image edit failed: ${errors.join(" | ")}`);
	}
};
//#endregion
//#region src/core/ai/prompts/analysis.ts
const requiredJsonShape = `{
  "productName": "string",
  "category": "string",
  "subcategory": "string",
  "material": "string",
  "color": "string",
  "styleTags": ["string"],
  "targetAudience": ["string"],
  "usageScenarios": ["string"],
  "coreSellingPoints": ["string"],
  "differentiationPoints": ["string"],
  "userConcerns": ["string"],
  "recommendedFocusPoints": ["string"],
  "additionalInformation": "string",
  "suggestedSectionPlan": [
    {
      "type": "hero | selling_points | scenario | detail_closeup | specs | material | comparison | gift_scene | brand_trust | summary",
      "title": "string",
      "goal": "string"
    }
  ]
}`;
const supportedSectionTypes = [
	"hero",
	"selling_points",
	"scenario",
	"detail_closeup",
	"specs",
	"material",
	"comparison",
	"gift_scene",
	"brand_trust",
	"summary"
].join(", ");
function buildProductAnalysisPrompt(assets) {
	return [
		"You are a senior e-commerce product strategist and detail-page planner.",
		"Analyze the provided product images and asset hints, then return one strict JSON object only. The main image is the factual source of truth for what the product actually is.",
		"Do not output markdown, code fences, explanations, comments, or extra keys.",
		"All copy values should be written in Simplified Chinese.",
		"If some attributes are uncertain, infer the most likely answer from the images and keep the field non-empty. Do not misclassify the product by overfitting to props, rulers, labels, packaging, or background objects.",
		"",
		"Available assets:",
		assets.sort((a, b) => a.sortOrder - b.sortOrder).map((asset, index) => `${index + 1}. type=${asset.type}; file=${asset.fileName}; isMain=${asset.isMain ? "yes" : "no"}`).join("\n") || "No uploaded assets.",
		"",
		"Required rules:",
		"1. Every required key must exist.",
		"2. Every array field must be an array of short Chinese strings.",
		"3. suggestedSectionPlan must contain at least 6 sections.",
		`4. suggestedSectionPlan.type must be one of: ${supportedSectionTypes}.`,
		"5. Focus on e-commerce conversion, visual hierarchy, and section planning, but every section must fit the real product category and mechanics shown in the main image.",
		"6. First identify the exact product object, its category, visual structure, count of repeated parts, operation/mechanism, and what it must never be mistaken for. Put this into additionalInformation.",
		"7. For puzzle cubes / speed cubes / Rubik-like cubes, explicitly capture: cube order such as 3x3x3 if visible, six colored faces, corner/edge/center pieces, twistable layers, seams, tile/sticker style, size if inferable, target users, and avoid treating it as a sticker craft, ruler, storage box, electronics product, or generic block.",
		"8. additionalInformation must summarize important extra facts for generation, especially product dimensions if visible or inferable. Include placeholders for unknown but required facts: size, weight/capacity/power, compatible specifications, package contents, usage constraints, and safety notes.",
		"",
		"Return exactly this JSON shape:",
		requiredJsonShape
	].join("\n");
}
function buildProductAnalysisRepairPrompt(raw) {
	return [
		"You repair malformed product-analysis output into one strict JSON object.",
		"Return JSON only. No markdown, no explanations, no extra keys.",
		"All string values should be in Simplified Chinese when possible.",
		"If a field is missing, infer a reasonable non-empty value from the source content.",
		"If suggestedSectionPlan is missing or too short, create at least 6 valid sections.",
		"If additionalInformation is missing, create a concise Chinese checklist covering size, weight/capacity/power, compatible specifications, package contents, usage constraints, and safety notes. Mark uncertain values as 待用户补充 instead of inventing exact numbers.",
		`Valid section types: ${supportedSectionTypes}.`,
		"",
		"Target JSON shape:",
		requiredJsonShape,
		"",
		"Source content to repair:",
		raw
	].join("\n");
}
//#endregion
//#region src/core/ai/schemas/product-analysis.ts
const productAnalysisOutputSchema = z.object({
	productName: z.string(),
	category: z.string(),
	subcategory: z.string(),
	material: z.string(),
	color: z.string(),
	styleTags: z.array(z.string()),
	targetAudience: z.array(z.string()),
	usageScenarios: z.array(z.string()),
	coreSellingPoints: z.array(z.string()),
	differentiationPoints: z.array(z.string()),
	userConcerns: z.array(z.string()),
	recommendedFocusPoints: z.array(z.string()),
	additionalInformation: z.string().default(""),
	generationRequirements: z.string().default(""),
	suggestedSectionPlan: z.array(z.object({
		type: z.string(),
		title: z.string(),
		goal: z.string()
	}))
});
//#endregion
//#region src/core/ports/storage.ts
/** POSIX-normalizes a storage-relative path and rejects escapes. */
function normalizeRelPath(relPath) {
	const posix = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
	const segments = [];
	for (const segment of posix.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) throw new Error(`path escapes storage root: ${relPath}`);
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	if (segments.length === 0) throw new Error(`invalid storage path: ${relPath}`);
	return segments.join("/");
}
//#endregion
//#region src/core/utils/files.ts
function sanitizeFileName(fileName) {
	return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function extFromMime(mimeType) {
	if (!mimeType) return "bin";
	const normalized = mimeType.toLowerCase();
	if (normalized.includes("png")) return "png";
	if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
	if (normalized.includes("webp")) return "webp";
	if (normalized.includes("gif")) return "gif";
	if (normalized.includes("svg")) return "svg";
	return "bin";
}
//#endregion
//#region src/core/services/asset-store.ts
/**
* Asset store — the storage + persistence seam for product images.
*
* Ported from upstream `lib/storage/asset-manager.ts` (ziguishian/MxPage, MIT).
*
* Changes made during the DSH port:
*  - `rootDir()` (`path.resolve(process.cwd(), env.STORAGE_ROOT)`) → injected
*    StorageDriver. `process.cwd()` is the host's cwd in a plugin, not the app's.
*  - `prisma.productAsset.*` → injected Repository.
*  - `nanoid` → `node:crypto` (drops a dependency).
*  - Stored `filePath` is now always POSIX. Upstream built it with `path.join`,
*    so on Windows the DB held backslashes while the URL builder converted them
*    back with `split(path.sep)` — an OS-dependent round trip.
*/
const STORAGE_DIRS = {
	uploads: "uploads",
	generated: "generated",
	exports: "exports",
	taskInputs: "task-inputs"
};
function suffix(bytes = 6) {
	return randomBytes(bytes).toString("hex").slice(0, bytes * 2);
}
function toPosix(...segments) {
	return normalizeRelPath(segments.filter(Boolean).join("/"));
}
function createAssetStore(host) {
	const { repository, storage } = host;
	async function ensureScaffold() {
		await Promise.all([
			storage.ensureDir(STORAGE_DIRS.uploads),
			storage.ensureDir(STORAGE_DIRS.generated),
			storage.ensureDir(STORAGE_DIRS.exports)
		]);
	}
	async function deleteAssetRecord(assetId) {
		const asset = await repository.asset.get(assetId);
		if (!asset) return null;
		await storage.remove(asset.filePath).catch(() => void 0);
		await repository.asset.delete(assetId);
		return asset;
	}
	return {
		ensureScaffold,
		deleteAssetRecord,
		async saveUploadAsset(params) {
			await ensureScaffold();
			const safeName = `${Date.now()}-${suffix()}-${sanitizeFileName(params.fileName)}`;
			const relativePath = toPosix(STORAGE_DIRS.uploads, params.projectId, safeName);
			await storage.write(relativePath, params.fileBuffer);
			return repository.asset.create({
				projectId: params.projectId,
				type: params.type,
				filePath: relativePath,
				fileName: params.fileName,
				mimeType: params.mimeType ?? null,
				sortOrder: params.sortOrder,
				isMain: params.isMain ?? false,
				metadata: { bytes: params.fileBuffer.byteLength }
			});
		},
		async saveGeneratedImage(params) {
			await ensureScaffold();
			const mimeType = params.source.svgText ? "image/svg+xml" : params.source.mimeType ?? "image/png";
			const ext = extFromMime(mimeType);
			const fileName = `${Date.now()}-${suffix()}.${ext}`;
			const relativePath = toPosix(STORAGE_DIRS.generated, params.projectId, params.sectionId, fileName);
			if (params.source.svgText) await storage.write(relativePath, Buffer.from(params.source.svgText, "utf8"));
			else if (params.source.b64Json) await storage.write(relativePath, Buffer.from(params.source.b64Json, "base64"));
			else if (params.source.url) {
				const response = await fetch(params.source.url);
				if (!response.ok) throw new Error(`Failed to download generated image: ${response.status}`);
				await storage.write(relativePath, Buffer.from(await response.arrayBuffer()));
			} else throw new Error("Image generation produced no usable image output.");
			return repository.asset.create({
				projectId: params.projectId,
				sectionId: params.sectionId,
				type: "GENERATED",
				filePath: relativePath,
				fileName,
				mimeType,
				sortOrder: 0,
				isMain: false,
				metadata: {
					prompt: params.prompt,
					...params.metadata ?? {}
				}
			});
		},
		async duplicateExportFile(params) {
			await ensureScaffold();
			const ext = extFromMime(params.mimeType);
			const safeName = sanitizeFileName(`${params.fileName}.${ext}`);
			const relativePath = toPosix(STORAGE_DIRS.exports, params.projectId, safeName);
			await storage.write(relativePath, params.sourceBuffer);
			return repository.asset.create({
				projectId: params.projectId,
				type: "EXPORTED",
				filePath: relativePath,
				fileName: safeName,
				mimeType: params.mimeType,
				sortOrder: 0,
				isMain: false
			});
		},
		assetPublicUrl(asset) {
			if (!asset) return null;
			return storage.publicUrl(asset.filePath);
		},
		readStorageFile(relativePath) {
			return storage.read(normalizeRelPath(relativePath));
		},
		statStorageFile(relativePath) {
			return storage.stat(normalizeRelPath(relativePath));
		},
		absolutePath(relativePath) {
			const normalized = normalizeRelPath(relativePath);
			return `${storage.rootDir().replace(/[\\/]+$/, "")}/${normalized}`;
		},
		async removeProjectDirs(projectId) {
			await Promise.all([
				STORAGE_DIRS.uploads,
				STORAGE_DIRS.generated,
				STORAGE_DIRS.exports
			].map((kind) => storage.removeDir(toPosix(kind, projectId)).catch(() => void 0)));
		},
		async stageTaskInput(taskId, index, fileName, data) {
			const relativePath = toPosix(STORAGE_DIRS.taskInputs, taskId, `${String(index).padStart(2, "0")}-${sanitizeFileName(fileName)}`);
			await storage.write(relativePath, data);
			return relativePath;
		},
		async listTaskInputs(taskId) {
			return storage.list(toPosix(STORAGE_DIRS.taskInputs, taskId));
		}
	};
}
//#endregion
//#region src/core/ports/tasks.ts
/** Cooperative-cancellation gate used between pipeline steps. */
var TaskCanceledError = class extends Error {
	code = "MXPAGE_CANCELLED";
	constructor(message = "Task canceled.") {
		super(message);
		this.name = "TaskCanceledError";
	}
};
function isTaskCanceledError(error) {
	if (error instanceof TaskCanceledError) return true;
	return error instanceof Error && /task canceled/i.test(error.message);
}
/** Throws when the signal is already aborted. */
function assertNotCanceled(signal) {
	if (signal?.aborted) throw new TaskCanceledError();
}
//#endregion
//#region src/core/services/task-service.ts
const TERMINAL_STATUSES = [
	"SUCCESS",
	"FAILED",
	"CANCELED"
];
function isTerminal$1(status) {
	return !!status && TERMINAL_STATUSES.includes(status);
}
function asRecord$1(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function createTaskService(host) {
	const { repository } = host;
	const abortControllers = /* @__PURE__ */ new Map();
	async function getTask(taskId) {
		return repository.task.get(taskId);
	}
	async function setSectionStatusFromImage(sectionId) {
		if (typeof sectionId !== "string") return;
		const section = await repository.section.get(sectionId);
		if (!section) return;
		await repository.section.update(sectionId, { status: section.currentImageAssetId ? "SUCCESS" : "IDLE" });
	}
	async function copyTerminalStateTo(taskId, status, message) {
		const child = await getTask(taskId);
		if (!child || isTerminal$1(child.status)) return null;
		return repository.task.update(taskId, {
			status,
			completedAt: /* @__PURE__ */ new Date(),
			errorMessage: message
		});
	}
	const service = {
		async createTask(input) {
			const status = input.status ?? "RUNNING";
			return repository.task.create({
				projectId: input.projectId,
				sectionId: input.sectionId ?? null,
				taskType: input.taskType,
				status,
				inputPayload: input.inputPayload,
				outputPayload: asRecord$1(input.outputPayload)
			});
		},
		findRecentRunningTask(input) {
			return repository.task.findRecentRunning({
				projectId: input.projectId,
				sectionId: input.sectionId ?? null,
				taskType: input.taskType,
				maxAgeMinutes: input.maxAgeMinutes ?? 10
			});
		},
		getTask,
		assertTaskNotCanceled: async (taskId) => {
			const task = await getTask(taskId);
			if (task?.status === "CANCELED") throw new TaskCanceledError();
			if (task?.status === "FAILED") throw new Error(task.errorMessage || "Task stopped.");
			return task;
		},
		async startTask(taskId, patch) {
			const current = await getTask(taskId);
			return repository.task.update(taskId, {
				status: "RUNNING",
				startedAt: current?.startedAt ?? /* @__PURE__ */ new Date(),
				outputPayload: {
					...asRecord$1(current?.outputPayload),
					...asRecord$1(patch)
				}
			});
		},
		/** Terminal-state sticky: silently no-ops once a task has settled. */
		async updateTaskProgress(taskId, patch) {
			const current = await getTask(taskId);
			if (!current || isTerminal$1(current.status)) return current;
			return repository.task.mergeProgress(taskId, {
				...patch,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		},
		async completeTask(taskId, outputPayload) {
			const current = await getTask(taskId);
			if (isTerminal$1(current?.status)) return current;
			return repository.task.update(taskId, {
				status: "SUCCESS",
				completedAt: /* @__PURE__ */ new Date(),
				outputPayload: {
					...asRecord$1(current?.outputPayload),
					...asRecord$1(outputPayload),
					completedAt: (/* @__PURE__ */ new Date()).toISOString()
				}
			});
		},
		async failTask(taskId, errorMessage, outputPayload) {
			const current = await getTask(taskId);
			if (isTerminal$1(current?.status)) return current;
			return repository.task.update(taskId, {
				status: "FAILED",
				completedAt: /* @__PURE__ */ new Date(),
				errorMessage,
				outputPayload: {
					...asRecord$1(current?.outputPayload),
					...asRecord$1(outputPayload),
					failedAt: (/* @__PURE__ */ new Date()).toISOString()
				}
			});
		},
		async cancelTask(taskId) {
			const task = await getTask(taskId);
			if (!task) throw new Error("Task not found.");
			if (isTerminal$1(task.status)) return task;
			const output = asRecord$1(task.outputPayload);
			const currentTaskId = typeof output.currentTaskId === "string" ? output.currentTaskId : null;
			const currentTask = currentTaskId ? await getTask(currentTaskId) : null;
			const canceled = await repository.task.update(taskId, {
				status: "CANCELED",
				completedAt: /* @__PURE__ */ new Date(),
				errorMessage: "Canceled by user."
			});
			if (currentTaskId) {
				await copyTerminalStateTo(currentTaskId, "CANCELED", "Canceled by user.");
				abortControllers.get(currentTaskId)?.abort(new TaskCanceledError());
			}
			abortControllers.get(taskId)?.abort(new TaskCanceledError());
			const sectionIds = new Set([task.sectionId, currentTask?.sectionId].filter((id) => typeof id === "string"));
			for (const sectionId of sectionIds) await setSectionStatusFromImage(sectionId);
			return canceled;
		},
		getTaskWithStaleRecovery: async (taskId) => service.recoverStaleBulkGenerationTask(await getTask(taskId)),
		/**
		* Upstream only ever *failed* orphaned bulk tasks after a restart — it never
		* re-dispatched them. Preserved as-is.
		*/
		async recoverStaleBulkGenerationTask(task) {
			if (!task || task.taskType !== "GENERATE" || task.sectionId !== null || task.status !== "PENDING" && task.status !== "RUNNING") return task;
			const output = asRecord$1(task.outputPayload);
			const heartbeatAt = typeof output.heartbeatAt === "string" ? Date.parse(output.heartbeatAt) : NaN;
			const lastActivityAt = Number.isFinite(heartbeatAt) ? heartbeatAt : task.updatedAt.getTime();
			const staleAfterMs = Number.isFinite(heartbeatAt) ? 9e4 : 3e5;
			if (Date.now() - lastActivityAt <= staleAfterMs) return task;
			const message = "批量生成后台执行已中断，系统已结束遗留任务，请重新生成未完成模块。";
			const currentTaskId = typeof output.currentTaskId === "string" ? output.currentTaskId : null;
			const currentTask = currentTaskId ? await getTask(currentTaskId) : null;
			await repository.task.update(task.id, {
				status: "FAILED",
				completedAt: /* @__PURE__ */ new Date(),
				errorMessage: message,
				outputPayload: {
					...output,
					currentStep: "stale_task_recovered",
					staleRecoveredAt: (/* @__PURE__ */ new Date()).toISOString()
				}
			});
			if (currentTaskId) {
				await copyTerminalStateTo(currentTaskId, "FAILED", message);
				abortControllers.get(currentTaskId)?.abort(new TaskCanceledError());
			}
			if (currentTask?.sectionId) await setSectionStatusFromImage(currentTask.sectionId);
			abortControllers.get(task.id)?.abort(new TaskCanceledError());
			return getTask(task.id);
		},
		registerTaskAbortController(taskId) {
			const controller = new AbortController();
			abortControllers.set(taskId, controller);
			return controller.signal;
		},
		releaseTaskAbortController(taskId) {
			abortControllers.delete(taskId);
		},
		abortTask(taskId, reason) {
			abortControllers.get(taskId)?.abort(new TaskCanceledError(reason));
		}
	};
	return service;
}
//#endregion
//#region src/core/services/analysis-service.ts
/**
* Product analysis service — uploaded product images → structured selling-point JSON.
*
* Ported from upstream `lib/services/analysis-service.ts`
* (ziguishian/MxPage, MIT, 灵矩绘境).
*
* Changes made during the DSH port (seams only):
*  - `prisma.project.findUnique({ include: { assets } })` → `Repository.project.getDetail`.
*  - `prisma.productAnalysis.upsert` → `Repository.analysis.upsert`;
*    `prisma.project.update` → `Repository.project.update`.
*  - `patchProjectModelSnapshot` → `Repository.project.mergeModelSnapshot`
*    (the upstream compare-and-swap loop over `updatedAt` collapses in a
*    single-writer host).
*  - `getProviderAdapter()` → `host.provider.resolve(...)` plus a locally
*    constructed `OpenAICompatibleAdapter`.
*  - `readStorageFile` → `AssetStore.readStorageFile`.
*  - `Prisma.JsonObject` / `Prisma.InputJsonValue` → plain
*    `Record<string, unknown>`.
*  - Module-level function exports → a `createAnalysisService(host, deps)`
*    factory.
*
* Deliberately unchanged: the prompt builders, the model-picking ladder, the
* error-classification strings (user-facing Chinese), `MAX_ANALYSIS_IMAGES`,
* and the structured → text → repair fallback chain. Upstream passes **no**
* `timeoutMs` on any of these calls, so the adapter default (60s for
* structured/text) still applies; the 180s ceiling lives in `planner-service`.
*/
const MAX_ANALYSIS_IMAGES = 10;
function normalizeModelId(value) {
	return value.toLowerCase();
}
function hasCapability(model, key) {
	const capabilities = model.capabilities ?? {};
	return Boolean(capabilities[key]);
}
function isPreviewLike(modelId) {
	return /(preview|experimental|beta|test)/i.test(modelId);
}
function isLiteLike(modelId) {
	return /(lite|flash-lite)/i.test(modelId);
}
function isImageSpecialized(modelId) {
	return /(image|imagen|recraft|flux|canvas)/i.test(modelId);
}
function isStableAnalysisCandidate(modelId) {
	return !isPreviewLike(modelId) && !isLiteLike(modelId) && !isImageSpecialized(modelId);
}
function extractJsonBlock$1(raw) {
	const direct = raw.trim();
	if (direct.startsWith("{") || direct.startsWith("[")) return direct;
	const fencedMatch = direct.match(/```json([\s\S]*?)```/i) || direct.match(/```([\s\S]*?)```/i);
	if (fencedMatch?.[1]) return fencedMatch[1].trim();
	const firstBrace = direct.indexOf("{");
	const lastBrace = direct.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) return direct.slice(firstBrace, lastBrace + 1);
	return direct;
}
function shouldAttemptRepair(error) {
	return error instanceof ZodError || error instanceof SyntaxError || error instanceof Error && /json|schema|parse/i.test(error.message);
}
function pickAnalysisModel(provider, preferredModelId) {
	if (preferredModelId) {
		const preferred = provider.models.find((item) => item.modelId === preferredModelId);
		if (preferred && hasCapability(preferred, "text")) return preferred.modelId;
	}
	const textVisionModels = provider.models.filter((item) => hasCapability(item, "text") && hasCapability(item, "vision"));
	const textModels = provider.models.filter((item) => hasCapability(item, "text"));
	const findMatch = (models, predicate) => models.find(predicate)?.modelId;
	return findMatch(textVisionModels, (item) => item.isDefaultAnalysis && isStableAnalysisCandidate(item.modelId)) ?? findMatch(textVisionModels, (item) => normalizeModelId(item.modelId).includes("gemini") && isStableAnalysisCandidate(item.modelId)) ?? findMatch(textVisionModels, (item) => normalizeModelId(item.modelId).includes("gpt-4o") && isStableAnalysisCandidate(item.modelId)) ?? findMatch(textVisionModels, (item) => isStableAnalysisCandidate(item.modelId)) ?? findMatch(textModels, (item) => item.isDefaultAnalysis) ?? findMatch(textModels, (item) => isStableAnalysisCandidate(item.modelId)) ?? textModels[0]?.modelId ?? null;
}
function normalizeAnalysisProviderError(error) {
	const detail = error instanceof Error ? error.message : "Unknown analysis error";
	if (/monthly spending limit|spending limit|billing|quota|insufficient_quota/i.test(detail)) throw new Error("当前 API Key 的分析额度已用尽。请前往代理商控制台提高或移除月度限额，或更换可用的 API Key。");
	if (/429|rate limit|限流/i.test(detail)) throw new Error("当前分析请求触发了限流。请稍后重试，或降低调用频率。");
	if (/invalid token|unauthorized|forbidden/i.test(detail)) throw new Error("当前 Provider 鉴权失败。请检查 baseURL、API Key 或代理商权限配置。");
	if (/timed out|aborterror|network error|fetch failed/i.test(detail)) throw new Error("当前 Provider 请求超时或网络异常，请稍后重试。");
	throw error instanceof Error ? error : new Error(detail);
}
function createAnalysisService(host, deps = {}) {
	const { repository } = host;
	const taskService = deps.taskService ?? createTaskService(host);
	const assetStore = deps.assetStore ?? createAssetStore(host);
	async function assetToDataUrl(asset) {
		const buffer = await assetStore.readStorageFile(asset.filePath);
		return `data:${asset.mimeType ?? "image/png"};base64,${buffer.toString("base64")}`;
	}
	async function repairAnalysisOutput(input) {
		const repaired = await input.adapter.generateText({
			model: input.model,
			systemPrompt: "Return one strict JSON object only.",
			userPrompt: buildProductAnalysisRepairPrompt(input.raw),
			monitor: { operation: "analysis_output_repair" }
		});
		return {
			parsed: productAnalysisOutputSchema.parse(JSON.parse(extractJsonBlock$1(repaired.text))),
			repairedRaw: repaired.text
		};
	}
	async function analyzeProject(projectId, preferredModelId) {
		const project = await repository.project.getDetail(projectId);
		if (!project) throw new Error("Project not found.");
		const resolved = await host.provider.resolve({
			projectId,
			operation: "project_analysis"
		});
		const adapter = new OpenAICompatibleAdapter(resolved.baseUrl, resolved.apiKey, host.logger);
		const model = pickAnalysisModel(resolved, preferredModelId);
		if (!model) throw new Error("No analysis model available.");
		if (await taskService.findRecentRunningTask({
			projectId,
			taskType: "ANALYZE",
			maxAgeMinutes: 10
		})) throw new Error("当前商品分析仍在进行中，请等待这一轮完成后再试。");
		const task = await taskService.createTask({
			projectId,
			taskType: "ANALYZE",
			inputPayload: { model }
		});
		try {
			const assets = [...project.assets].sort((a, b) => a.sortOrder - b.sortOrder);
			const imageUrls = await Promise.all(assets.slice(0, MAX_ANALYSIS_IMAGES).map((asset) => assetToDataUrl(asset)));
			const prompt = buildProductAnalysisPrompt(assets);
			let parsedResult;
			let rawResult;
			try {
				const structured = await adapter.generateStructured({
					model,
					systemPrompt: "Return one strict JSON object only. No markdown.",
					userPrompt: prompt,
					schema: productAnalysisOutputSchema,
					images: imageUrls,
					monitor: {
						projectId,
						operation: "project_analysis"
					}
				});
				parsedResult = structured.parsed;
				rawResult = {
					mode: "structured",
					model,
					raw: structured.raw
				};
			} catch (error) {
				if (!shouldAttemptRepair(error)) normalizeAnalysisProviderError(error);
				const fallbackText = await adapter.generateText({
					model,
					systemPrompt: "Return one strict JSON object only. No markdown.",
					userPrompt: prompt,
					images: imageUrls,
					monitor: {
						projectId,
						operation: "project_analysis_fallback"
					}
				});
				try {
					parsedResult = productAnalysisOutputSchema.parse(JSON.parse(extractJsonBlock$1(fallbackText.text)));
					rawResult = {
						mode: "text_fallback",
						model,
						initialError: error instanceof ZodError ? error.flatten() : error instanceof Error ? error.message : "Unknown analysis error",
						fallbackRaw: fallbackText.text
					};
				} catch {
					const repaired = await repairAnalysisOutput({
						adapter,
						model,
						raw: fallbackText.text
					}).catch((repairError) => {
						normalizeAnalysisProviderError(repairError);
					});
					parsedResult = repaired.parsed;
					rawResult = {
						mode: "text_repair",
						model,
						initialError: error instanceof ZodError ? error.flatten() : error instanceof Error ? error.message : "Unknown analysis error",
						fallbackRaw: fallbackText.text,
						repairedRaw: repaired.repairedRaw
					};
				}
			}
			const saved = await repository.analysis.upsert(projectId, {
				rawResult,
				normalizedResult: parsedResult
			});
			await repository.project.update(projectId, { status: "ANALYZED" });
			await repository.project.mergeModelSnapshot(projectId, {
				analysisModelId: model,
				...resolved.id ? { providerConfigId: resolved.id } : {}
			});
			await taskService.completeTask(task.id, saved.normalizedResult);
			return saved;
		} catch (error) {
			await taskService.failTask(task.id, error instanceof Error ? error.message : "Analysis failed");
			throw error;
		}
	}
	async function updateAnalysis(projectId, normalizedResult) {
		const existing = await repository.analysis.get(projectId);
		return repository.analysis.upsert(projectId, {
			rawResult: existing ? existing.rawResult : normalizedResult,
			normalizedResult
		});
	}
	return {
		analyzeProject,
		updateAnalysis
	};
}
//#endregion
//#region src/core/types/domain.ts
/**
* Upstream stores `platform` as free text but uses this sentinel to hide the
* lazily-created placeholder project that owns batch / XHS workflow tasks.
*/
const SYSTEM_TASK_PLATFORM = "__mxpage_system_task__";
const platformLabels = {
	general_ecommerce: "通用电商",
	taobao_tmall: "淘宝 / 天猫",
	pinduoduo: "拼多多",
	xiaohongshu: "小红书",
	douyin_ecommerce: "抖音电商"
};
const styleLabels = {
	generic_clean: "通用简洁",
	premium: "高级质感",
	soft_lifestyle: "柔和生活方式",
	conversion_focused: "转化导向",
	tech: "科技感"
};
const assetTypeLabels = {
	MAIN: "主商品图",
	ANGLE: "多角度图",
	DETAIL: "细节图",
	REFERENCE: "参考图",
	GENERATED: "生成图",
	EXPORTED: "导出文件"
};
const sectionTypeLabels = {
	hero: "头图主视觉",
	selling_points: "卖点模块",
	scenario: "场景展示",
	detail_closeup: "细节特写",
	specs: "规格参数",
	material: "材质工艺",
	comparison: "对比说明",
	gift_scene: "送礼场景",
	brand_trust: "品牌信任",
	summary: "总结收口",
	custom: "自定义模块"
};
//#endregion
//#region src/core/utils/content-language.ts
const contentLanguageOptions = [
	"zh-CN",
	"en-US",
	"ja-JP",
	"ko-KR",
	"es-ES",
	"fr-FR",
	"de-DE",
	"pt-PT",
	"ar-SA",
	"ru-RU"
];
const contentLanguageLabels = {
	"zh-CN": "简体中文",
	"en-US": "English",
	"ja-JP": "日本語",
	"ko-KR": "한국어",
	"es-ES": "Español",
	"fr-FR": "Français",
	"de-DE": "Deutsch",
	"pt-PT": "Português",
	"ar-SA": "العربية",
	"ru-RU": "Русский"
};
const contentLanguageNamesForPrompt = {
	"zh-CN": "Simplified Chinese",
	"en-US": "English",
	"ja-JP": "Japanese",
	"ko-KR": "Korean",
	"es-ES": "Spanish",
	"fr-FR": "French",
	"de-DE": "German",
	"pt-PT": "Portuguese",
	"ar-SA": "Arabic",
	"ru-RU": "Russian"
};
function normalizeContentLanguage(value) {
	if (typeof value === "string" && contentLanguageOptions.includes(value)) return value;
	return "zh-CN";
}
//#endregion
//#region src/core/utils/zip.ts
/**
* Minimal, dependency-free ZIP writer (STORE + DEFLATE).
*
* Added by the DSH port: upstream `lib/services/export-service.ts` streamed the
* archive with the CJS `archiver` package into
* `path.join(process.cwd(), 'tmp-export-<projectId>-<ts>.zip')`, read it back
* with `fsp.readFile`, then deleted it. That needed a dependency AND a temp file
* next to the host's cwd, which a plugin must never create. This module produces
* the same archive bytes in memory.
*
* Scope (deliberately small — this is not a general zip library):
*  - single-segment archives only: no ZIP64, no spanning, no encryption, no
*    data descriptors, no extra fields, no archive comment.
*  - no explicit directory entries. Folder entries appear implicitly through
*    `dir/name` paths, which is exactly what `archiver.append(buffer, { name })`
*    produced upstream, and every extractor (Windows Explorer, `Expand-Archive`,
*    Info-ZIP `unzip`, Python `zipfile`) creates the folders from them.
*  - sizes and CRC-32 are written into the local header (bit 3 stays clear)
*    because the whole entry is in memory before the header is emitted.
*
* Format: PKWARE APPNOTE 6.3.x — local file header (0x04034b50), central
* directory file header (0x02014b50), end of central directory (0x06054b50).
* General purpose bit 11 (0x0800) is set so names are read as UTF-8, which is
* what makes the Chinese folder names (`00-头图/`, `01-详情页/`) extract intact.
*/
const SIG_LOCAL_FILE_HEADER = 67324752;
const SIG_CENTRAL_FILE_HEADER = 33639248;
const SIG_END_OF_CENTRAL_DIR = 101010256;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** General purpose bit 11: the file name is UTF-8. */
const FLAG_UTF8 = 2048;
/** "Version needed to extract" 2.0 — the minimum that covers deflate. */
const VERSION_NEEDED = 20;
/** "Version made by": 0x00 = MS-DOS/FAT host, 2.0. */
const VERSION_MADE_BY = 20;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIR_SIZE = 22;
const UINT16_MAX = 65535;
const UINT32_MAX = 4294967295;
/** Reflected CRC-32 (IEEE 802.3) table — polynomial 0xEDB88320. */
const CRC_TABLE = (() => {
	const table = /* @__PURE__ */ new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 3988292384 ^ value >>> 1 : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();
/** CRC-32 of `data` as an unsigned 32-bit integer. */
function crc32(data) {
	let crc = -1;
	for (let index = 0; index < data.length; index += 1) crc = crc >>> 8 ^ CRC_TABLE[(crc ^ data[index]) & 255];
	return (crc ^ -1) >>> 0;
}
function toBuffer(data) {
	return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}
/** MS-DOS date/time pair (year-1980, 2-second resolution). */
function toDosDateTime(date) {
	const year = date.getFullYear();
	const dosYear = year < 1980 ? 0 : Math.min(year - 1980, 127);
	return {
		time: date.getHours() << 11 | date.getMinutes() << 5 | date.getSeconds() >> 1,
		date: dosYear << 9 | date.getMonth() + 1 << 5 | date.getDate()
	};
}
/** Deflates when that is actually smaller, otherwise stores. */
function compress(content, level) {
	if (level <= 0) return {
		method: METHOD_STORE,
		body: content
	};
	const deflated = deflateRawSync(content, { level });
	return deflated.length < content.length ? {
		method: METHOD_DEFLATE,
		body: deflated
	} : {
		method: METHOD_STORE,
		body: content
	};
}
function assertUint32(value, label) {
	if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) throw new Error(`zip: ${label} does not fit the 32-bit ZIP format (ZIP64 unsupported)`);
	return value;
}
/**
* Builds a complete ZIP archive in memory.
*
* @example
* const buffer = createZip([
*   { name: '00-头图/mx_1700000000000_01.jpg', data: jpegBuffer },
*   { name: 'export-manifest.json', data: JSON.stringify(manifest, null, 2) },
* ], { level: 9 })
*/
function createZip(entries, options = {}) {
	const level = options.level ?? 9;
	if (!Number.isInteger(level) || level < 0 || level > 9) throw new Error(`zip: deflate level must be an integer 0-9, received ${level}`);
	if (entries.length > UINT16_MAX) throw new Error(`zip: ${entries.length} entries exceed the 16-bit ZIP limit (ZIP64 unsupported)`);
	const { time: dosTime, date: dosDate } = toDosDateTime(options.modifiedAt ?? /* @__PURE__ */ new Date());
	const parts = [];
	const centralDirectory = [];
	let offset = 0;
	for (const entry of entries) {
		const name = normalizeRelPath(entry.name);
		const nameBytes = Buffer.from(name, "utf8");
		if (nameBytes.length > UINT16_MAX) throw new Error(`zip: entry name too long (${nameBytes.length} bytes): ${name}`);
		const content = toBuffer(entry.data);
		const { method, body } = compress(content, level);
		const crc = crc32(content);
		assertUint32(body.length, `compressed size of ${name}`);
		assertUint32(content.length, `uncompressed size of ${name}`);
		assertUint32(offset, `local header offset of ${name}`);
		const localHeader = Buffer.alloc(LOCAL_HEADER_SIZE);
		localHeader.writeUInt32LE(SIG_LOCAL_FILE_HEADER, 0);
		localHeader.writeUInt16LE(VERSION_NEEDED, 4);
		localHeader.writeUInt16LE(FLAG_UTF8, 6);
		localHeader.writeUInt16LE(method, 8);
		localHeader.writeUInt16LE(dosTime, 10);
		localHeader.writeUInt16LE(dosDate, 12);
		localHeader.writeUInt32LE(crc, 14);
		localHeader.writeUInt32LE(body.length, 18);
		localHeader.writeUInt32LE(content.length, 22);
		localHeader.writeUInt16LE(nameBytes.length, 26);
		localHeader.writeUInt16LE(0, 28);
		const centralHeader = Buffer.alloc(CENTRAL_HEADER_SIZE);
		centralHeader.writeUInt32LE(SIG_CENTRAL_FILE_HEADER, 0);
		centralHeader.writeUInt16LE(VERSION_MADE_BY, 4);
		centralHeader.writeUInt16LE(VERSION_NEEDED, 6);
		centralHeader.writeUInt16LE(FLAG_UTF8, 8);
		centralHeader.writeUInt16LE(method, 10);
		centralHeader.writeUInt16LE(dosTime, 12);
		centralHeader.writeUInt16LE(dosDate, 14);
		centralHeader.writeUInt32LE(crc, 16);
		centralHeader.writeUInt32LE(body.length, 20);
		centralHeader.writeUInt32LE(content.length, 24);
		centralHeader.writeUInt16LE(nameBytes.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(0, 38);
		centralHeader.writeUInt32LE(offset, 42);
		parts.push(localHeader, nameBytes, body);
		centralDirectory.push(centralHeader, nameBytes);
		offset += LOCAL_HEADER_SIZE + nameBytes.length + body.length;
	}
	const centralDirectoryBuffer = Buffer.concat(centralDirectory);
	assertUint32(offset, "start offset of the central directory");
	assertUint32(centralDirectoryBuffer.length, "size of the central directory");
	const endOfCentralDirectory = Buffer.alloc(END_OF_CENTRAL_DIR_SIZE);
	endOfCentralDirectory.writeUInt32LE(SIG_END_OF_CENTRAL_DIR, 0);
	endOfCentralDirectory.writeUInt16LE(0, 4);
	endOfCentralDirectory.writeUInt16LE(0, 6);
	endOfCentralDirectory.writeUInt16LE(entries.length, 8);
	endOfCentralDirectory.writeUInt16LE(entries.length, 10);
	endOfCentralDirectory.writeUInt32LE(centralDirectoryBuffer.length, 12);
	endOfCentralDirectory.writeUInt32LE(offset, 16);
	endOfCentralDirectory.writeUInt16LE(0, 20);
	return Buffer.concat([
		...parts,
		centralDirectoryBuffer,
		endOfCentralDirectory
	]);
}
//#endregion
//#region src/core/services/export-service.ts
/**
* Export service — project JSON export and the detail-page image archive.
*
* Ported from upstream `lib/services/export-service.ts` (ziguishian/MxPage, MIT).
*
* Changes made during the DSH port:
*  - `prisma.project.findUnique({ include: ... })` → `repository.project.getDetail(id)`.
*    Both upstream queries collapse into that one aggregate read: `assets`,
*    `analysis` and `sections.versions` come back on it, and each section's
*    `currentImageAsset` relation is re-resolved locally from `detail.assets`
*    (the repository exposes `currentImageAssetId` only). The upstream
*    `orderBy` clauses are re-applied in memory because the port does not
*    promise an ordering for the aggregate.
*  - `archiver` streaming into `path.join(process.cwd(), 'tmp-export-<id>.zip')`
*    → the in-memory `createZip` from `../utils/zip.ts`, written once through
*    `storage.write('exports/<projectId>/<name>.zip')`. No dependency, no temp
*    file, no absolute path, no `process.cwd()`.
*  - `readStorageFile` → `assetStore.readStorageFile`.
*  - `createTask` / `findRecentRunningTask` / `completeTask` / `failTask` →
*    the injected TaskService (upstream imported the same functions).
*  - `buildImageArchive` returns an archive descriptor (`zipPath`, `buffer`,
*    counts, manifest) instead of a bare `Buffer`: a headless host has no HTTP
*    response to stream into and needs the storage path. `.buffer` is exactly
*    the upstream return value.
*
* Preserved deliberately (product value — do not "fix"):
*  - the archive shape: `00-头图/`, `01-详情页/`, `export-manifest.json`,
*    `mx_<timestamp>_<NN>.<ext>`, and the selection logic of
*    `buildGalleryAssets` (HERO sections + MAIN/ANGLE assets, deduped on
*    `filePath`) and `buildDetailAssets` (non-HERO sections that have an image);
*  - every user-facing string, verbatim;
*  - `getPreviewConfig` lets a non-numeric count through as `NaN`
*    (`Number('abc')` → `Math.max(1, NaN)` → `NaN` → `slice(0, NaN)` → empty
*    gallery). Upstream behaves the same way;
*  - an unknown section type falls back to `section.sectionKey`. This is why
*    the label lookup below is a raw `toLowerCase()` instead of the port's
*    `toSectionTypeKey`, which coerces unknown types to `'custom'`.
*/
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function getPreviewConfig(project) {
	const config = asRecord(asRecord(project?.modelSnapshot).previewConfig);
	return {
		heroImageCount: Math.min(5, Math.max(1, Number(config.heroImageCount ?? 4))),
		detailSectionCount: Math.min(10, Math.max(1, Number(config.detailSectionCount ?? 6))),
		imageAspectRatio: config.imageAspectRatio === "3:4" ? "3:4" : "9:16",
		contentLanguage: normalizeContentLanguage(config.contentLanguage)
	};
}
function buildGalleryAssets(project) {
	const previewConfig = getPreviewConfig(project);
	const uploadedAssets = project.assets.filter((asset) => ["MAIN", "ANGLE"].includes(asset.type));
	const unique = [...project.sections.filter((section) => section.type === "HERO" && Boolean(section.currentImageAsset)).map((section, index) => ({
		asset: section.currentImageAsset,
		title: section.title || `头图 ${index + 1}`,
		sourceLabel: "头图规划"
	})), ...uploadedAssets.map((asset) => ({
		asset,
		title: asset.fileName,
		sourceLabel: assetTypeLabels[asset.type] ?? asset.type
	}))].filter((item, index, list) => item.asset?.filePath && list.findIndex((entry) => entry.asset?.filePath === item.asset?.filePath) === index);
	const plannedHeroCount = project.sections.filter((section) => section.type === "HERO").length;
	return unique.slice(0, Math.max(previewConfig.heroImageCount, plannedHeroCount));
}
/**
* Upstream looked the label up by `section.type.toLowerCase()` and fell back to
* `sectionKey`. `toSectionTypeKey` would return `'custom'` for an unknown type,
* which is a different (visible) manifest value, so the raw lookup is kept.
*/
function sectionTypeLabel(section) {
	const key = section.type.toLowerCase();
	return sectionTypeLabels[key] ?? section.sectionKey;
}
function buildDetailAssets(project) {
	return project.sections.filter((section) => section.type !== "HERO").filter((section) => Boolean(section.currentImageAsset)).map((section) => ({
		section,
		asset: section.currentImageAsset,
		sourceLabel: sectionTypeLabel(section)
	}));
}
const EXPORT_HERO_DIR = "00-头图";
const EXPORT_DETAIL_DIR = "01-详情页";
const EXPORT_MANIFEST_ENTRY = "export-manifest.json";
function buildExportImageFileName(exportTimestamp, index, ext) {
	const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;
	return `mx_${exportTimestamp}_${String(index + 1).padStart(2, "0")}${normalizedExt}`;
}
/** Upstream used OS-dependent `path.extname`; storage paths are POSIX here. */
function exportImageExt(asset) {
	return posix.extname(asset.fileName) || `.${extFromMime(asset.mimeType)}`;
}
function exportEntryPath(directory, exportTimestamp, index, asset) {
	return `${directory}/${buildExportImageFileName(exportTimestamp, index, exportImageExt(asset))}`;
}
/** Upstream `orderBy: [{ isMain: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }]`. */
function compareArchiveAssets(left, right) {
	if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
	if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
	return left.createdAt.getTime() - right.createdAt.getTime();
}
/** Upstream `orderBy: { order: 'asc' }` with `versions: { versionNumber: 'desc' }`. */
function sortSections(sections) {
	return [...sections].sort((left, right) => left.order - right.order).map((section) => ({
		...section,
		versions: [...section.versions ?? []].sort((left, right) => right.versionNumber - left.versionNumber)
	}));
}
/** Folds the upstream `include: { currentImageAsset: true, ... }` graph back in. */
function resolveArchiveProject(detail) {
	const assets = [...detail.assets].sort(compareArchiveAssets);
	const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
	return {
		...detail,
		assets,
		sections: sortSections(detail.sections).map((section) => ({
			...section,
			currentImageAsset: section.currentImageAssetId ? assetsById.get(section.currentImageAssetId) ?? null : null
		}))
	};
}
function createExportService(host, deps = {}) {
	const { repository, storage } = host;
	const assetStore = deps.assetStore ?? createAssetStore(host);
	const taskService = deps.taskService ?? createTaskService(host);
	async function loadArchiveProject(projectId) {
		const detail = await repository.project.getDetail(projectId);
		if (!detail) throw new Error("Project not found.");
		return resolveArchiveProject(detail);
	}
	return {
		async buildProjectJson(projectId) {
			const project = await repository.project.getDetail(projectId);
			if (!project) throw new Error("Project not found.");
			return {
				...project,
				sections: sortSections(project.sections)
			};
		},
		async buildImageArchive(projectId) {
			const project = await loadArchiveProject(projectId);
			if (await taskService.findRecentRunningTask({
				projectId,
				taskType: "EXPORT",
				maxAgeMinutes: 10
			})) throw new Error("当前导出任务仍在进行中，请等待这一轮完成后再试。");
			const task = await taskService.createTask({
				projectId,
				taskType: "EXPORT",
				inputPayload: { type: "detail-page-images" }
			});
			try {
				const exportTimestamp = Date.now();
				const galleryAssets = buildGalleryAssets(project);
				const detailAssets = buildDetailAssets(project);
				const [galleryEntries, detailEntries] = await Promise.all([Promise.all(galleryAssets.map(async (item, index) => ({
					name: exportEntryPath(EXPORT_HERO_DIR, exportTimestamp, index, item.asset),
					data: await assetStore.readStorageFile(item.asset.filePath)
				}))), Promise.all(detailAssets.map(async (item, index) => ({
					name: exportEntryPath(EXPORT_DETAIL_DIR, exportTimestamp, index, item.asset),
					data: await assetStore.readStorageFile(item.asset.filePath)
				})))]);
				const manifest = {
					projectId: project.id,
					projectName: project.name,
					exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
					exportTimestamp,
					heroImageCount: galleryAssets.length,
					detailImageCount: detailAssets.length,
					previewConfig: getPreviewConfig(project),
					outputLanguageLabel: contentLanguageLabels[getPreviewConfig(project).contentLanguage],
					gallery: galleryAssets.map((item, index) => ({
						order: index + 1,
						title: item.title,
						sourceLabel: item.sourceLabel,
						fileName: buildExportImageFileName(exportTimestamp, index, exportImageExt(item.asset)),
						originalFileName: item.asset.fileName,
						zipPath: exportEntryPath(EXPORT_HERO_DIR, exportTimestamp, index, item.asset),
						mimeType: item.asset.mimeType
					})),
					details: detailAssets.map((item, index) => ({
						order: index + 1,
						sectionKey: item.section.sectionKey,
						title: item.section.title,
						sectionType: item.section.type,
						sourceLabel: item.sourceLabel,
						fileName: buildExportImageFileName(exportTimestamp, index, exportImageExt(item.asset)),
						originalFileName: item.asset.fileName,
						zipPath: exportEntryPath(EXPORT_DETAIL_DIR, exportTimestamp, index, item.asset),
						mimeType: item.asset.mimeType
					}))
				};
				const zipBuffer = createZip([
					...galleryEntries,
					...detailEntries,
					{
						name: EXPORT_MANIFEST_ENTRY,
						data: JSON.stringify(manifest, null, 2)
					}
				], { level: 9 });
				const fileName = `mx_${exportTimestamp}_detail-page-images.zip`;
				const zipPath = normalizeRelPath(`${STORAGE_DIRS.exports}/${projectId}/${fileName}`);
				await assetStore.ensureScaffold();
				await storage.write(zipPath, zipBuffer);
				await taskService.completeTask(task.id, {
					exportedHeroImages: galleryAssets.length,
					exportedDetailImages: detailAssets.length
				});
				return {
					zipPath,
					fileName,
					mimeType: "application/zip",
					byteLength: zipBuffer.byteLength,
					buffer: zipBuffer,
					exportTimestamp,
					heroImageCount: galleryAssets.length,
					detailImageCount: detailAssets.length,
					manifest
				};
			} catch (error) {
				await taskService.failTask(task.id, error instanceof Error ? error.message : "Export failed");
				throw error;
			}
		}
	};
}
//#endregion
//#region src/core/ai/prompts/generation.ts
function buildReferenceText(referenceAssets) {
	if (!referenceAssets.length) return "No reference images were provided.";
	return `Reference images: ${referenceAssets.map((item) => item.fileName).join(" / ")}`;
}
function buildMainImageInstruction(referenceAssets) {
	if (!referenceAssets.length) return "If no product image reference is provided, infer the product carefully from the structured analysis and keep the same product identity across all generated sections.";
	return [
		"The uploaded main product image is the source of truth for product identity.",
		"Keep the same product category, shape, material, color family, proportions, grid/layer structure, moving parts, and key recognisable details across every generated hero image and detail image.",
		"Do not invent a different product.",
		"Use the provided image as the visual anchor, then change composition, scene, angle, crop, lighting, and selling-point emphasis according to the section goal. Never replace the product with a similar-looking object or a generic prop."
	].join(" ");
}
function buildAspectInstruction(aspectRatio) {
	if (aspectRatio === "1:1") return "The final image must be a square 1:1 e-commerce hero composition, optimized for tappable product gallery covers.";
	return aspectRatio === "3:4" ? "The final image must be a vertical 3:4 marketplace poster composition." : "The final image must be a vertical 9:16 long-form mobile commerce composition.";
}
function buildTargetLanguageInstruction(contentLanguage) {
	const targetLanguage = contentLanguageNamesForPrompt[normalizeContentLanguage(contentLanguage)];
	return [
		`All user-facing marketing copy that appears inside the image must be written in ${targetLanguage}.`,
		`The section title, key selling points, short supporting copy, disclaimers, and CTA should all be in ${targetLanguage} when they appear in the image.`,
		"Do not mix in Simplified Chinese unless the target language is Simplified Chinese.",
		"Keep the typography native, polished, and commercially readable for the target language."
	].join(" ");
}
function buildPhysicalRealityInstruction() {
	return [
		"Respect product physics and product-specific mechanical logic.",
		"Infer how the product actually works from the uploaded image and section goal: cable exit points, vents, nozzles, hinges, openings, drawers, buttons, handles, gravity, shadows, reflections, support surfaces, airflow, liquid flow, and user interaction direction.",
		"Do not create impossible physical effects: reversed airflow, cords disappearing into furniture, floating unsupported products, hands passing through solid parts, liquids flowing upward, disconnected shadows, impossible reflections, text crossing through product geometry, or parts bending in a way the material cannot.",
		"For hair dryers specifically, airflow must leave the front nozzle, the rear intake must not emit wind, and the power cord must connect naturally from the handle/base instead of merging into a desk or wall.",
		"For Rubik's cubes, speed cubes, puzzle cubes and other mechanical toys: preserve the correct cube order such as 3x3x3 when stated or visible, keep six square color faces, visible corner/edge/center piece logic, real twistable layer seams, rounded or straight tile style matching the reference, and do not turn it into a ruler, sticker sheet, generic storage box, electronics device, or unrelated block toy."
	].join(" ");
}
function buildGenerationRequirementsInstruction(generationRequirements) {
	const trimmed = generationRequirements?.trim();
	if (!trimmed) return "No extra project-level image generation requirements were provided.";
	return [
		"Project-level image generation requirements from the user. Treat these as high-priority creative constraints for this image while still following the current section goal:",
		trimmed,
		"Operationalize these requirements concretely through camera angle, scene, props, product interaction, composition variation, and in-image copy. Do not ignore them or mention them only as abstract text."
	].join("\n");
}
function buildSectionImagePrompt(section, referenceAssets = [], aspectRatio = "9:16", contentLanguage = "zh-CN", generationRequirements) {
	return [
		"You are a senior e-commerce key-visual designer creating marketplace-ready product artwork.",
		`Section type: ${section.type}`,
		`Section title: ${section.title}`,
		`Section goal: ${section.goal}`,
		`Section copy: ${section.copy}`,
		`Visual prompt guidance: ${section.visualPrompt}`,
		buildReferenceText(referenceAssets),
		buildMainImageInstruction(referenceAssets),
		buildAspectInstruction(aspectRatio),
		buildTargetLanguageInstruction(contentLanguage),
		buildGenerationRequirementsInstruction(generationRequirements),
		buildPhysicalRealityInstruction(),
		"Generate one high-conversion mobile e-commerce visual for this section.",
		"The image should emphasize product clarity, composition hierarchy, material texture, and marketplace aesthetics.",
		"The headline, selling points, supporting copy, and CTA should be visually designed inside the image rather than left for later DOM text insertion.",
		"Make the result feel like finished commercial artwork, not a blank template."
	].join("\n");
}
function buildRegenerationPrompt(section, referenceAssets = [], aspectRatio = "9:16", contentLanguage = "zh-CN", generationRequirements) {
	return [buildSectionImagePrompt(section, referenceAssets, aspectRatio, contentLanguage, generationRequirements), "This is a regeneration task. Keep the same product identity and selling-point direction, but improve composition accuracy, completion quality, and conversion appeal."].join("\n");
}
function buildImageEditPrompt(section, referenceAssets = [], mode = "repaint", aspectRatio = "9:16", contentLanguage = "zh-CN", generationRequirements) {
	const targetLanguage = contentLanguageNamesForPrompt[normalizeContentLanguage(contentLanguage)];
	const modeInstruction = mode === "translate" ? `This is an in-image translation task. Use the current image as the base and translate every visible user-facing word, headline, selling point, label, badge, CTA, note, and disclaimer into ${targetLanguage}. Preserve the original product, layout, composition, typography hierarchy, colors, lighting, and commercial style as much as possible. Do not add new claims or redesign the image except where text length requires natural typographic fitting. Remove the original-language text after replacing it with ${targetLanguage}.` : mode === "enhance" ? "This is an enhancement task. Use the current image as the base, preserve the overall framing, and improve realism, texture, lighting, clarity, edge quality, and commercial polish." : "This is a repaint task. Use the current image as the base, keep the same product identity, and redesign the composition, atmosphere, styling, and conversion emphasis according to the section goal.";
	return [
		buildSectionImagePrompt(section, referenceAssets, aspectRatio, contentLanguage, generationRequirements),
		modeInstruction,
		"The current section image must be treated as the editable base image.",
		"Keep the product identical to the uploaded main product image and do not replace it with a different item.",
		mode === "translate" ? "Only change the in-image language. Do not translate invisible metadata, do not add subtitles outside the artwork, and do not leave bilingual duplicates unless the original design intentionally uses bilingual branding." : "",
		"Output one marketplace-ready mobile e-commerce image only."
	].filter(Boolean).join("\n");
}
function buildSectionSvgLayoutPrompt(section, referenceAssets = [], aspectRatio = "9:16", contentLanguage = "zh-CN") {
	return [
		"You are designing a mobile e-commerce section poster that will be rendered as SVG.",
		"Return one strict JSON object only.",
		`All user-facing copy must be written in ${contentLanguageNamesForPrompt[normalizeContentLanguage(contentLanguage)]}.`,
		`Section type: ${section.type}`,
		`Section title: ${section.title}`,
		`Section goal: ${section.goal}`,
		`Section copy: ${section.copy}`,
		`Visual prompt guidance: ${section.visualPrompt}`,
		`Target aspect ratio: ${aspectRatio}`,
		buildReferenceText(referenceAssets),
		"Use the main uploaded product image as the product identity reference when composing the layout.",
		"Target JSON shape:",
		`{
  "headline": "string",
  "subheadline": "string",
  "badge": "string",
  "highlights": ["string", "string", "string"],
  "backgroundColor": "#F5E9D8",
  "accentColor": "#A85A2A",
  "panelColor": "#FFF8F0"
}`,
		"Keep the headline concise and commercial.",
		"highlights should contain 2 to 4 short selling points."
	].join("\n");
}
//#endregion
//#region src/core/utils/visual-style-guide.ts
const visualStyleGuideFieldLabels = {
	styleName: "风格名称",
	colorPalette: "主色 / 辅助色",
	backgroundSystem: "背景系统",
	lighting: "光线方向",
	cameraLanguage: "镜头语言",
	typography: "字体气质",
	layoutRules: "版式密度",
	propRules: "道具规则",
	productRenderingRules: "商品表现规则",
	negativeStyleConstraints: "负面约束"
};
const visualStyleGuideKeys = Object.keys(visualStyleGuideFieldLabels);
function stringifyUnknown(value) {
	if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).join("；");
	if (value && typeof value === "object") return JSON.stringify(value);
	return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}
function buildDefaultVisualStyleGuide(context) {
	const productName = context?.productName?.trim() || "当前商品";
	const styleLabel = context?.styleLabel?.trim() || "清爽高级电商风";
	const platformLabel = context?.platformLabel?.trim() || "移动端电商详情页";
	return {
		styleName: `${styleLabel}统一视觉系统`,
		colorPalette: "以商品真实颜色为主色，搭配低饱和浅色背景；全套头图和详情页保持同一组主色、辅助色和强调色。",
		backgroundSystem: `适合${platformLabel}的干净商业背景，头图和详情页共享相同材质、空间感和留白逻辑，避免每张图切换完全不同场景。`,
		lighting: "统一使用柔和商业棚拍光，主光方向保持一致，阴影柔和且连续，商品高光不过曝。",
		cameraLanguage: "头图可使用不同角度，但镜头焦段、透视强度和商品占比保持同一体系；详情页延续同样的产品比例和观察距离。",
		typography: "图内中文使用同一字体气质、字重层级和标题/卖点/CTA 规则；避免不同图片混用完全不同字体风格。",
		layoutRules: "统一标题区、卖点区、商品区和 CTA 的安全边距；信息密度中等，移动端优先，避免过度拥挤。",
		propRules: "只使用与商品真实使用场景相关的少量道具，道具色彩服从主色体系，不抢商品主体。",
		productRenderingRules: `${productName}必须保持同一外形、材质、颜色、比例、开口、线缆、按钮、结构方向和品牌识别点。`,
		negativeStyleConstraints: "禁止忽明忽暗、背景风格跳变、字体混乱、CTA 样式不一致、商品比例漂移、文字穿过商品、线缆插入桌面、悬浮、阴影断裂、反向风或其他不合理物理现象。"
	};
}
function normalizeVisualStyleGuide(value, fallback) {
	const base = fallback ?? buildDefaultVisualStyleGuide();
	const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	return visualStyleGuideKeys.reduce((guide, key) => {
		guide[key] = stringifyUnknown(raw[key]) || base[key];
		return guide;
	}, { ...base });
}
function hasVisualStyleGuide(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const raw = value;
	return visualStyleGuideKeys.some((key) => stringifyUnknown(raw[key]).length > 0);
}
function readVisualStyleGuide(snapshot, fallback) {
	const raw = snapshot?.visualStyleGuide;
	if (!hasVisualStyleGuide(raw)) return null;
	return normalizeVisualStyleGuide(raw, fallback);
}
function visualStyleGuideToPrompt(guide) {
	return visualStyleGuideKeys.map((key) => `${visualStyleGuideFieldLabels[key]}: ${guide[key]}`).join("\n");
}
//#endregion
//#region src/core/ai/schemas/visual-prompt.ts
const visualPromptAgentSchema = z.object({
	analysisSummary: z.string().default(""),
	finalPrompt: z.string().min(20),
	negativePrompt: z.string().default(""),
	qualityChecklist: z.array(z.string()).default([])
});
//#endregion
//#region src/core/services/visual-prompt-agent.ts
const VISUAL_PROMPT_AGENT_TIMEOUT_MS = 6e4;
function readCapabilities$2(model) {
	return model.capabilities ?? {};
}
function pickPromptModel(provider, needsVision) {
	const textModels = provider.models.filter((model) => readCapabilities$2(model).text);
	const visionTextModels = textModels.filter((model) => readCapabilities$2(model).vision);
	const candidates = needsVision && visionTextModels.length > 0 ? visionTextModels : textModels;
	return candidates.find((model) => model.isDefaultPlanning)?.modelId ?? candidates.find((model) => model.isDefaultAnalysis)?.modelId ?? candidates.find((model) => /gpt-4o|gpt-4\.1|gpt-5|gemini|qwen.*vl|kimi|moonshot/i.test(model.modelId))?.modelId ?? candidates[0]?.modelId ?? null;
}
function summarizeReferences(input) {
	const assetNames = input.referenceAssets?.map((asset) => {
		const role = asset.isMain ? "main product" : asset.type.toLowerCase();
		return `${asset.fileName} (${role})`;
	});
	const imageCount = input.referenceImages?.length ?? 0;
	if (!assetNames?.length && imageCount === 0) return "No reference images.";
	return [assetNames?.length ? `Reference assets: ${assetNames.join(" / ")}` : "", imageCount > 0 ? `Attached reference image count: ${imageCount}` : ""].filter(Boolean).join("\n");
}
function buildAgentPrompt(input) {
	return [
		"You are the system-level Visual Prompt Agent for an AI commerce design workflow.",
		"Your job is to analyze the task before image generation and write a detailed final prompt for the image model.",
		"Return strict JSON only. No markdown.",
		"",
		input.mode === "xiaohongshu_page" ? `Create a production-grade prompt for one Xiaohongshu ${input.aspectRatio} carousel image.` : input.mode === "image_edit" ? "Create a production-grade prompt for editing an existing image while preserving identity and composition continuity." : "Create a production-grade prompt for one e-commerce product detail page image.",
		"",
		"The finalPrompt must be detailed and directly usable by an image generation/editing model.",
		"It must include:",
		"- business objective and target audience",
		"- canvas aspect ratio and crop",
		"- product/subject identity rules from reference images, especially the main product image as the non-negotiable source of truth",
		"- foreground, middle ground, background, props, scene, camera angle, product placement",
		"- lighting, material texture, color palette, depth, shadows and reflections",
		"- in-image typography: title position, hierarchy, copy blocks, CTA/badges, safe margins",
		"- product-specific physical rules and impossible phenomena to avoid",
		"- final quality bar for a polished Xiaohongshu/e-commerce visual",
		"- if a project-level visual style guide is provided, repeat and obey it as the highest-priority visual consistency contract",
		"",
		"Important constraints:",
		"- Preserve the product/object identity from reference images. The main product image is the factual source of truth for category, geometry, count of parts, colors, labels, openings, mechanisms, proportions and material. Do not invent a different product.",
		"- All visible text must be clear, correctly spelled, and in the target content language.",
		"- Do not create category mistakes or impossible mechanics: no reversed airflow, cables entering furniture, floating unsupported objects, liquid flowing upward, broken shadows, impossible reflections, wrong hinges/openings, wrong cube layer count, wrong tile grid, wrong corner/edge/center structure, or hands passing through objects.",
		"- Avoid vague words alone. Make every visual choice concrete.",
		"- For e-commerce sections, hero images and detail images must look like one cohesive commercial page: consistent color palette, background system, lighting direction, shadow softness, typography, CTA style, icon/badge language, spacing, and product rendering.",
		"- If reference images are attached, analyze them as geometry/style references, but do not describe them as 'uploaded image' inside the final artwork.",
		"",
		"Task context:",
		JSON.stringify({
			mode: input.mode,
			title: input.title,
			goal: input.goal,
			copy: input.copy,
			basePrompt: input.basePrompt,
			aspectRatio: input.aspectRatio,
			contentLanguage: input.contentLanguage ?? "zh-CN",
			references: summarizeReferences(input),
			productContext: input.productContext ?? null,
			visualStyleGuide: input.visualStyleGuide ? visualStyleGuideToPrompt(input.visualStyleGuide) : null
		}, null, 2),
		"",
		"Return this JSON shape:",
		`{
  "analysisSummary": "short analysis of the image strategy",
  "finalPrompt": "long detailed prompt for the image model",
  "negativePrompt": "what must not appear",
  "qualityChecklist": ["check 1", "check 2", "check 3"]
}`
	].join("\n");
}
function buildFallbackPrompt(input) {
	const referenceInstruction = (input.referenceImages?.length ?? 0) > 0 || (input.referenceAssets?.length ?? 0) > 0 ? "Use the reference images as the source of truth for product identity, proportions, material, color, key openings, buttons, nozzles, handles, cables, logos and recognisable details." : "If no reference image is available, infer the subject carefully from the task context and keep it visually consistent.";
	return [
		input.mode === "xiaohongshu_page" ? `Design a native Xiaohongshu ${input.aspectRatio} carousel page with strong cover-like readability, useful content hierarchy, generous safe margins, and polished social-media typography.` : "Design a high-conversion e-commerce product visual that feels like finished marketplace artwork, not a blank poster or wireframe.",
		`Aspect ratio: ${input.aspectRatio}.`,
		`Image title/theme: ${input.title}.`,
		`Business goal: ${input.goal}.`,
		`Core copy to express inside the image: ${input.copy}.`,
		`User/base visual direction: ${input.basePrompt}.`,
		referenceInstruction,
		input.visualStyleGuide ? `Project-level visual style guide that must be preserved across the whole project:\n${visualStyleGuideToPrompt(input.visualStyleGuide)}` : "No project-level visual style guide is available; create a clean reusable visual system and keep this image compatible with it.",
		"Create a concrete composition: define foreground subject placement, middle-ground information blocks, background scene, camera angle, crop, props, lighting direction, shadows, reflections, material texture, color palette, and depth.",
		"Typography must be designed inside the image with clear hierarchy: large readable title, short supporting copy, 2-4 concise labels or selling points, and optional CTA/badge placed away from product edges.",
		"Respect real-world physics and product mechanics: correct airflow/light/liquid direction, visible cable exit points, realistic support surfaces, gravity, contact shadows, aligned hinges/openings/drawers/buttons/handles.",
		"Negative constraints: no garbled text, no over-crowded typography, no distorted product geometry, no floating unsupported product, no cables merging into tables or walls, no reversed airflow, no impossible reflections, no hands passing through solid parts.",
		"Final output should be a polished, commercially usable image with crisp details and no explanatory UI chrome."
	].join("\n");
}
function shouldFallback(error) {
	if (!(error instanceof Error)) return false;
	return /timed out|timeout|temperature|unsupported|invalid json|structured|parse|network error|fetch failed/i.test(error.message);
}
async function buildVisualPromptWithAgent(input) {
	const model = pickPromptModel(input.provider, (input.referenceImages?.length ?? 0) > 0);
	if (!model) return buildFallbackPrompt(input);
	try {
		const parsed = (await input.adapter.generateStructured({
			model,
			systemPrompt: "Return strict JSON only.",
			userPrompt: buildAgentPrompt(input),
			schema: visualPromptAgentSchema,
			images: input.referenceImages?.slice(0, 3),
			timeoutMs: VISUAL_PROMPT_AGENT_TIMEOUT_MS,
			suppressUsageLog: true,
			signal: input.signal
		})).parsed;
		return [
			parsed.finalPrompt,
			parsed.negativePrompt ? `Negative prompt / avoid: ${parsed.negativePrompt}` : "",
			parsed.qualityChecklist.length ? `Quality checklist: ${parsed.qualityChecklist.join("；")}` : ""
		].filter(Boolean).join("\n\n");
	} catch (error) {
		if (shouldFallback(error)) return buildFallbackPrompt(input);
		throw error;
	}
}
//#endregion
//#region src/core/services/generation-service.ts
/**
* Generation service — section image generation, regeneration, editing and
* section-version management.
*
* Ported from upstream `lib/services/generation-service.ts`
* (ziguishian/MxPage, MIT, 灵矩绘境). See ../../NOTICE.
*
* Changes made during the DSH port:
*  - The module-level exports became a factory: `createGenerationService(host, deps)`.
*    No module-level singletons.
*  - `import { prisma } from "@/lib/db/prisma"` → injected `host.repository`.
*  - `getProviderAdapter()` (Prisma reads + an API key carried through
*    `AsyncLocalStorage`) → `await host.provider.resolve(scope)` plus a
*    per-call `new OpenAICompatibleAdapter(resolved.baseUrl, resolved.apiKey, logger)`.
*  - `registerTaskAbortController` / `releaseTaskAbortController` /
*    `assertTaskNotCanceled` come from the ported `createTaskService(host)`;
*    `assertNotCanceled(taskSignal)` mirrors upstream's own cancellation
*    checkpoints on the signal it threaded into fetch.
*  - `assetToDataUrl` keeps reading bytes from disk, but through
*    `assetStore.readStorageFile`.
*  - `@prisma/client`'s `PageSection` / `ProductAsset` → domain types.
*
* Deliberately preserved verbatim (this file is mostly prompt + policy):
* image-model ranking, the "do not rotate on quota/429/403/401" fallback
* policy, the SVG fallback path, and every user-facing Chinese message.
*/
const svgLayoutSchema = z.object({
	headline: z.string().min(1),
	subheadline: z.string().min(1),
	badge: z.string().min(1),
	highlights: z.array(z.string().min(1)).min(2).max(4),
	backgroundColor: z.string().min(4),
	accentColor: z.string().min(4),
	panelColor: z.string().min(4)
});
const svgCopyByLanguage = {
	"zh-CN": {
		highlights: "核心亮点",
		waitingForAsset: "等待商品图片素材",
		footer: "商品详情模块 · MxPage AI 自动生成"
	},
	"en-US": {
		highlights: "Key Highlights",
		waitingForAsset: "Waiting for product image",
		footer: "Product Detail Section · Auto-generated by MxPage AI"
	},
	"ja-JP": {
		highlights: "主なポイント",
		waitingForAsset: "商品画像を待っています",
		footer: "商品詳細セクション · MxPage AI 自動生成"
	},
	"ko-KR": {
		highlights: "핵심 포인트",
		waitingForAsset: "상품 이미지를 기다리는 중",
		footer: "상품 상세 섹션 · MxPage AI 자동 생성"
	}
};
function getGenerationSettings(project) {
	const snapshot = project?.modelSnapshot ?? {};
	const settings = snapshot.generationSettings ?? {};
	const previewConfig = snapshot.previewConfig ?? {};
	return {
		allowSvgFallback: settings.allowSvgFallback === true,
		imageAspectRatio: previewConfig.imageAspectRatio === "3:4" ? "3:4" : "9:16",
		contentLanguage: normalizeContentLanguage(previewConfig.contentLanguage)
	};
}
function getProjectVisualStyleGuide(project) {
	const analysis = project.analysis?.normalizedResult ?? {};
	const fallback = buildDefaultVisualStyleGuide({
		productName: typeof analysis.productName === "string" ? analysis.productName : void 0,
		styleLabel: project.style ?? void 0,
		platformLabel: project.platform ?? void 0
	});
	return readVisualStyleGuide(project.modelSnapshot, fallback) ?? fallback;
}
function readGenerationRequirements(analysis) {
	const value = analysis?.generationRequirements;
	return typeof value === "string" ? value : "";
}
function getSectionAspectRatio(section, detailAspectRatio) {
	return section.type === "HERO" ? "1:1" : detailAspectRatio;
}
function getOutputSize(aspectRatio) {
	if (aspectRatio === "1:1") return "1024x1024";
	return "1024x1536";
}
function isStableImageModel(modelId) {
	return !/(preview|experimental|beta|test)/i.test(modelId);
}
function isPreferredImageModel(modelId) {
	return /(banana|nano-banana|nano banana|imagen|recraft|flux|gemini|gpt[-_\s]?image|chatgpt-image|dall[-_\s]?e|seedream|jimeng|midjourney|ideogram|hidream|kolors|wanx|cogview)/i.test(modelId);
}
function isGeminiImageModel(modelId) {
	return /gemini.*image|nano-banana|banana/i.test(modelId);
}
function isOpenAiGptImageModel(modelId) {
	return /(?:^|[-_\s])gpt[-_\s]?image(?:[-_\s]?(?:\d+(?:\.\d+)?|mini))?|chatgpt-image/i.test(modelId);
}
function readCapabilities$1(model) {
	return model.capabilities ?? {};
}
function hasImageCapability(model) {
	return Boolean(readCapabilities$1(model).image_gen);
}
function hasTextCapability(model) {
	return Boolean(readCapabilities$1(model).text);
}
function hasVisionCapability(model) {
	return Boolean(readCapabilities$1(model).vision);
}
function hasRealImageGeneration(model) {
	return readCapabilities$1(model).real_image_gen !== false;
}
function canGenerateRealImage(model) {
	const modelId = model.modelId ?? "";
	return hasImageCapability(model) && (hasRealImageGeneration(model) || isGeminiImageModel(modelId) || isOpenAiGptImageModel(modelId));
}
function canEditRealImage(model) {
	const capabilities = readCapabilities$1(model);
	const modelId = model.modelId ?? "";
	return Boolean(capabilities.image_edit) && capabilities.real_image_edit !== false || Boolean(capabilities.image_gen) && (capabilities.real_image_gen !== false || isGeminiImageModel(modelId) || isOpenAiGptImageModel(modelId));
}
function buildImageModelCandidates(provider, options) {
	const candidatePool = provider.models.filter((item) => options?.edit ? canEditRealImage(item) : canGenerateRealImage(item));
	const defaultKey = options?.edit ? "isDefaultImageEdit" : options?.regenerate ? "isDefaultDetailImage" : "isDefaultHeroImage";
	if (options?.preferredModelId) return [options.preferredModelId];
	const configuredDefault = candidatePool.find((item) => Boolean(item[defaultKey]))?.modelId ?? (!options?.edit ? candidatePool.find((item) => item.isDefaultDetailImage)?.modelId : null);
	if (configuredDefault) return [configuredDefault];
	const candidates = [
		...candidatePool.filter((item) => isStableImageModel(item.modelId) && isPreferredImageModel(item.modelId)).map((item) => item.modelId),
		...candidatePool.filter((item) => isStableImageModel(item.modelId)).map((item) => item.modelId),
		...candidatePool.filter((item) => isPreferredImageModel(item.modelId)).map((item) => item.modelId),
		...candidatePool.map((item) => item.modelId)
	].filter(Boolean);
	return [...new Set(candidates)];
}
function buildSvgModelCandidates(provider) {
	const visionText = provider.models.filter((item) => hasTextCapability(item) && hasVisionCapability(item));
	const textOnly = provider.models.filter((item) => hasTextCapability(item));
	const candidates = [
		provider.models.find((item) => item.isDefaultPlanning)?.modelId ?? null,
		provider.models.find((item) => item.isDefaultAnalysis)?.modelId ?? null,
		...visionText.filter((item) => /gemini|gpt-4o|gpt-5/i.test(item.modelId) && !/preview|experimental|beta|test/i.test(item.modelId)).map((item) => item.modelId),
		...visionText.filter((item) => !/preview|experimental|beta|test/i.test(item.modelId)).map((item) => item.modelId),
		...textOnly.filter((item) => /gemini|gpt-4o|gpt-5/i.test(item.modelId) && !/preview|experimental|beta|test/i.test(item.modelId)).map((item) => item.modelId),
		...textOnly.filter((item) => !/preview|experimental|beta|test/i.test(item.modelId)).map((item) => item.modelId),
		...textOnly.map((item) => item.modelId)
	].filter(Boolean);
	return [...new Set(candidates)];
}
function shouldFallbackToNextImageModel(error) {
	if (!(error instanceof Error)) return false;
	if (/monthly spending limit|spending limit|billing|quota|insufficient_quota|403|forbidden|unauthorized|invalid token|api key|429|rate limit|限流/i.test(error.message)) return false;
	return /404|405|no available endpoint|unsupported|not implemented|does not exist|invalid_value|unknown parameter|invalid type|supported values|invalid value.+size/i.test(error.message);
}
function isTransientImageNetworkFailure(detail) {
	return /fetch failed|timed out|timeout|network error|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(detail);
}
function buildTransientImageNetworkMessage(detail) {
	return "当前图片生成请求网络失败或代理临时中断，请稍后重试。当前模型端点已在本轮生成中成功返回过图片，这不是 Provider 不支持图片生成。原始错误：" + detail;
}
function summarizeProviderImageFailure(detail, mode) {
	const reasons = [];
	if (/model.+does not exist|invalid_value.+model/i.test(detail)) reasons.push("代理商返回的图片模型名称无效或并不存在");
	if (/no available endpoint|404/i.test(detail)) reasons.push("代理商没有为这些模型开放真实图片端点");
	if (/429|限流|rate limit/i.test(detail)) reasons.push("代理商图片接口当前触发了限流");
	if (/unknown parameter|invalid type|images\[0\]|supported values|invalid value.+size/i.test(detail)) reasons.push("代理商图片接口的兼容格式与当前网关实现不一致");
	if (!reasons.length) reasons.push(mode === "edit" ? "图像编辑接口暂时不可用" : "图像生成接口暂时不可用");
	return [...new Set(reasons)].join("；");
}
function extractJsonBlock(raw) {
	const direct = raw.trim();
	if (direct.startsWith("{") || direct.startsWith("[")) return direct;
	const fencedMatch = direct.match(/```json([\s\S]*?)```/i) || direct.match(/```([\s\S]*?)```/i);
	if (fencedMatch?.[1]) return fencedMatch[1].trim();
	const firstBrace = direct.indexOf("{");
	const lastBrace = direct.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) return direct.slice(firstBrace, lastBrace + 1);
	return direct;
}
function escapeXml(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
/**
* Upstream read the bytes off local disk; the port sources them through the
* injected asset store (the driver owns the storage root).
*/
async function assetToDataUrl(assets, asset) {
	const buffer = await assets.readStorageFile(asset.filePath);
	return `data:${asset.mimeType ?? "image/png"};base64,${buffer.toString("base64")}`;
}
function composeSectionSvg(params) {
	const uiCopy = svgCopyByLanguage[params.contentLanguage] ?? svgCopyByLanguage["en-US"];
	const sectionLabel = sectionTypeLabels[params.section.type.toLowerCase()] ?? params.section.type;
	const highlights = params.layout.highlights.map((item, index) => `
      <g transform="translate(${90 + index % 2 * 390}, ${1160 + Math.floor(index / 2) * 100})">
        <rect rx="26" ry="26" width="330" height="72" fill="${params.layout.panelColor}" opacity="0.95" />
        <text x="28" y="45" font-size="30" fill="${params.layout.accentColor}" font-weight="700">${escapeXml(item)}</text>
      </g>`).join("");
	const productImage = params.productImageDataUrl ? `<image href="${params.productImageDataUrl}" x="110" y="350" width="860" height="700" preserveAspectRatio="xMidYMid meet" clip-path="url(#productClip)" />` : `<rect x="110" y="350" width="860" height="700" rx="56" fill="${params.layout.panelColor}" />
       <text x="540" y="720" text-anchor="middle" font-size="42" fill="${params.layout.accentColor}" font-weight="700">${escapeXml(uiCopy.waitingForAsset)}</text>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1080" height="1920" viewBox="0 0 1080 1920" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1080" y2="1920" gradientUnits="userSpaceOnUse">
      <stop stop-color="${params.layout.backgroundColor}" />
      <stop offset="1" stop-color="#FFFFFF" />
    </linearGradient>
    <clipPath id="productClip">
      <rect x="110" y="350" width="860" height="700" rx="56" ry="56" />
    </clipPath>
  </defs>

  <rect width="1080" height="1920" fill="url(#bg)" />
  <circle cx="930" cy="250" r="150" fill="${params.layout.accentColor}" opacity="0.12" />
  <circle cx="170" cy="1460" r="220" fill="${params.layout.accentColor}" opacity="0.08" />

  <rect x="72" y="84" rx="28" ry="28" width="260" height="66" fill="${params.layout.accentColor}" />
  <text x="202" y="127" text-anchor="middle" font-size="28" fill="#FFFFFF" font-weight="700">${escapeXml(params.layout.badge)}</text>

  <text x="80" y="220" font-size="66" fill="#1F1720" font-weight="800">${escapeXml(params.layout.headline)}</text>
  <text x="80" y="292" font-size="34" fill="#5C515A" font-weight="500">${escapeXml(params.layout.subheadline)}</text>

  <g>
    <rect x="110" y="350" width="860" height="700" rx="56" fill="#FFFFFF" opacity="0.78" />
    ${productImage}
  </g>

  <rect x="72" y="1090" width="936" height="340" rx="44" fill="#FFFFFF" opacity="0.82" />
  <text x="112" y="1160" font-size="34" fill="#3A3139" font-weight="700">${escapeXml(uiCopy.highlights)}</text>
  ${highlights}

  <rect x="72" y="1468" width="936" height="280" rx="44" fill="${params.layout.panelColor}" opacity="0.98" />
  <text x="112" y="1540" font-size="34" fill="${params.layout.accentColor}" font-weight="800">${escapeXml(sectionLabel)}</text>
  <text x="112" y="1602" font-size="48" fill="#1F1720" font-weight="800">${escapeXml(params.section.title)}</text>
  <text x="112" y="1670" font-size="30" fill="#5A4E58" font-weight="500">${escapeXml(params.section.copy || params.layout.subheadline)}</text>

  <rect x="72" y="1788" width="936" height="88" rx="44" fill="${params.layout.accentColor}" />
  <text x="540" y="1844" text-anchor="middle" font-size="34" fill="#FFFFFF" font-weight="800">${escapeXml(uiCopy.footer)}</text>
</svg>`;
}
function pickPrimaryProductAsset(projectAssets) {
	return projectAssets.find((asset) => asset.isMain) ?? projectAssets.find((asset) => asset.type === "MAIN") ?? projectAssets.find((asset) => [
		"ANGLE",
		"DETAIL",
		"REFERENCE"
	].includes(asset.type)) ?? projectAssets[0] ?? null;
}
function mergeReferenceAssets(projectAssets, explicitReferenceAssets) {
	return [pickPrimaryProductAsset(projectAssets), ...explicitReferenceAssets].filter(Boolean).filter((asset, index, list) => list.findIndex((entry) => entry.id === asset.id) === index);
}
/**
* Upstream relied on Prisma's `orderBy: [{ isMain: "desc" }, { sortOrder: "asc" },
* { createdAt: "asc" }]` on `Project.assets`. The Repository port does not
* promise an ordering for `getDetail`, so it is re-applied here.
*/
function orderProjectAssets(projectAssets) {
	return [...projectAssets].sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime());
}
async function generateWithFallback(params) {
	const errors = [];
	for (const model of params.candidateModels) try {
		return {
			model,
			generated: await params.adapter.generateImage({
				model,
				prompt: params.prompt,
				size: params.size,
				aspectRatio: params.aspectRatio,
				referenceImages: params.referenceImages,
				monitor: {
					projectId: params.projectId,
					sectionId: params.sectionId,
					operation: params.operation
				},
				signal: params.signal
			}),
			attemptedModels: params.candidateModels
		};
	} catch (error) {
		if (isTaskCanceledError(error)) throw error;
		const message = error instanceof Error ? error.message : "Unknown image generation error";
		errors.push(`${model}: ${message}`);
		if (!shouldFallbackToNextImageModel(error)) throw error;
	}
	throw new Error(`所有可用图片模型都生成失败：${errors.join(" | ")}`);
}
async function editWithFallback(params) {
	const errors = [];
	for (const model of params.candidateModels) try {
		return {
			model,
			generated: await params.adapter.editImage({
				model,
				prompt: params.prompt,
				image: params.image,
				size: params.size,
				aspectRatio: params.aspectRatio,
				referenceImages: params.referenceImages,
				monitor: {
					projectId: params.projectId,
					sectionId: params.sectionId,
					operation: params.operation
				},
				signal: params.signal
			}),
			attemptedModels: params.candidateModels
		};
	} catch (error) {
		if (isTaskCanceledError(error)) throw error;
		const message = error instanceof Error ? error.message : "Unknown image edit error";
		errors.push(`${model}: ${message}`);
		if (!shouldFallbackToNextImageModel(error)) throw error;
	}
	throw new Error(`所有可用图片编辑模型都处理失败：${errors.join(" | ")}`);
}
async function generateSvgLayoutSpec(params) {
	const errors = [];
	for (const model of params.candidateModels) try {
		const result = await params.adapter.generateText({
			model,
			systemPrompt: "Return one strict JSON object only. No markdown.",
			userPrompt: params.userPrompt,
			images: params.images,
			monitor: {
				projectId: params.projectId,
				sectionId: params.sectionId,
				operation: params.operation
			},
			signal: params.signal
		});
		return {
			model,
			parsed: svgLayoutSchema.parse(JSON.parse(extractJsonBlock(result.text)))
		};
	} catch (error) {
		if (isTaskCanceledError(error)) throw error;
		errors.push(`${model}: ${error instanceof Error ? error.message : "Unknown SVG layout error"}`);
	}
	throw new Error(`SVG 版式生成失败：${errors.join(" | ")}`);
}
async function generateSvgFallback(params) {
	const modelCandidates = buildSvgModelCandidates(params.provider);
	if (!modelCandidates.length) throw new Error("当前 Provider 没有可用于 SVG 兜底预览的文本模型。");
	const selectedAssets = params.referenceAssets.slice(0, 4);
	const imageInputs = await Promise.all(selectedAssets.map((asset) => assetToDataUrl(params.assets, asset)));
	const layoutSpec = await generateSvgLayoutSpec({
		adapter: params.adapter,
		candidateModels: modelCandidates,
		userPrompt: buildSectionSvgLayoutPrompt(params.section, params.referenceAssets, params.aspectRatio, params.contentLanguage),
		images: imageInputs,
		projectId: params.section.projectId,
		sectionId: params.section.id,
		operation: "svg_fallback_layout",
		signal: params.signal
	});
	const productImageAsset = params.referenceAssets[0] ?? null;
	const productImageDataUrl = productImageAsset ? await assetToDataUrl(params.assets, productImageAsset) : null;
	return {
		svgText: composeSectionSvg({
			section: {
				title: params.section.title,
				copy: params.section.copy,
				type: params.section.type
			},
			layout: layoutSpec.parsed,
			productImageDataUrl,
			contentLanguage: params.contentLanguage
		}),
		model: layoutSpec.model,
		layout: layoutSpec.parsed
	};
}
function createGenerationService(host, deps = {}) {
	const { repository } = host;
	const logger = host.logger ?? noopLogger;
	const assets = deps.assets ?? createAssetStore(host);
	const tasks = deps.tasks ?? createTaskService(host);
	/** Upstream `getProviderAdapter()`, reduced to the two ports that own it. */
	async function resolveProviderAdapter(scope) {
		const resolved = await host.provider.resolve(scope);
		const adapter = new OpenAICompatibleAdapter(resolved.baseUrl, resolved.apiKey, logger);
		return {
			provider: { models: resolved.models },
			adapter
		};
	}
	/**
	* Upstream `prisma.productAsset.findMany({ where: { id: { in: ids } } })`.
	* The Repository port exposes per-id reads instead of an id-set filter, so the
	* requested order is preserved (upstream returned DB order, which nothing
	* downstream depended on — `mergeReferenceAssets` re-ranks by primary asset).
	* Like upstream, this is NOT project-scoped.
	*/
	async function resolveReferenceAssets(referenceAssetIds) {
		if (!referenceAssetIds.length) return [];
		const uniqueIds = [...new Set(referenceAssetIds)];
		return (await Promise.all(uniqueIds.map((id) => repository.asset.get(id)))).filter((asset) => Boolean(asset));
	}
	/**
	* Upstream `persistSectionVersion`: read the last `versionNumber`, mark every
	* sibling inactive, then create the next active version.
	*/
	async function persistSectionVersion(params) {
		const versionNumber = await repository.version.nextVersionNumber(params.sectionId);
		const created = await repository.version.create({
			sectionId: params.sectionId,
			versionNumber,
			promptSnapshot: { prompt: params.promptSnapshot },
			copySnapshot: { copy: params.copySnapshot },
			imageAssetId: params.imageAssetId
		});
		if (!created.isActive) return repository.version.setActive(params.sectionId, created.id);
		return created;
	}
	async function listSectionVersions(sectionId) {
		const ordered = [...await repository.version.list(sectionId)].sort((a, b) => b.versionNumber - a.versionNumber);
		return Promise.all(ordered.map(async (version) => ({
			...version,
			imageAsset: version.imageAssetId ? await repository.asset.get(version.imageAssetId) : null
		})));
	}
	async function activateSectionVersion(sectionId, versionId) {
		const version = await repository.version.get(versionId);
		if (!version || version.sectionId !== sectionId) throw new Error("Version not found.");
		await repository.version.setActive(sectionId, versionId);
		await repository.section.update(sectionId, {
			currentImageAssetId: version.imageAssetId ?? null,
			status: "SUCCESS"
		});
		const activated = await repository.version.get(versionId);
		if (!activated) return null;
		return {
			...activated,
			imageAsset: activated.imageAssetId ? await repository.asset.get(activated.imageAssetId) : null
		};
	}
	async function generateSectionImageInternal(projectId, sectionId, options) {
		const project = await repository.project.getDetail(projectId);
		const section = await repository.section.get(sectionId);
		if (!project) throw new Error("Project not found.");
		if (!section || section.projectId !== projectId) throw new Error("Section not found.");
		const projectAssets = orderProjectAssets(project.assets);
		if (await tasks.findRecentRunningTask({
			projectId,
			sectionId,
			taskType: options?.regenerate ? "REGENERATE" : "GENERATE",
			maxAgeMinutes: 20
		})) throw new Error("当前模块图仍在生成中，请等待这一轮完成后再试。");
		const task = await tasks.createTask({
			projectId,
			sectionId,
			taskType: options?.regenerate ? "REGENERATE" : "GENERATE",
			inputPayload: {
				referenceAssetIds: options?.referenceAssetIds ?? [],
				regenerate: Boolean(options?.regenerate)
			}
		});
		const taskSignal = tasks.registerTaskAbortController(task.id);
		try {
			await options?.onTaskCreated?.(task.id);
			await repository.section.update(sectionId, { status: "GENERATING" });
			await tasks.assertTaskNotCanceled(task.id);
			assertNotCanceled(taskSignal);
			const { provider, adapter } = await resolveProviderAdapter({
				projectId,
				sectionId,
				operation: options?.regenerate ? "regenerate_section_image" : "generate_section_image"
			});
			const generationSettings = getGenerationSettings(project);
			const visualStyleGuide = getProjectVisualStyleGuide(project);
			const generationRequirements = readGenerationRequirements(project.analysis?.normalizedResult);
			const sectionAspectRatio = getSectionAspectRatio(section, generationSettings.imageAspectRatio);
			const outputSize = getOutputSize(sectionAspectRatio);
			const modelCandidates = buildImageModelCandidates(provider, options);
			const selectedModel = modelCandidates[0] ?? null;
			const effectiveReferenceAssets = mergeReferenceAssets(projectAssets, await resolveReferenceAssets(options?.referenceAssetIds ?? []));
			const referenceImages = await Promise.all(effectiveReferenceAssets.map((asset) => assetToDataUrl(assets, asset)));
			await tasks.assertTaskNotCanceled(task.id);
			assertNotCanceled(taskSignal);
			const basePrompt = options?.regenerate ? buildRegenerationPrompt(section, effectiveReferenceAssets, sectionAspectRatio, generationSettings.contentLanguage, generationRequirements) : buildSectionImagePrompt(section, effectiveReferenceAssets, sectionAspectRatio, generationSettings.contentLanguage, generationRequirements);
			const prompt = await buildVisualPromptWithAgent({
				provider,
				adapter,
				mode: "ecommerce_section",
				title: section.title,
				goal: section.goal,
				copy: section.copy,
				basePrompt,
				aspectRatio: sectionAspectRatio,
				contentLanguage: generationSettings.contentLanguage,
				referenceImages,
				referenceAssets: effectiveReferenceAssets,
				productContext: project.analysis?.normalizedResult ?? project.modelSnapshot ?? null,
				visualStyleGuide,
				projectId,
				sectionId,
				operation: options?.regenerate ? "visual_prompt_agent_regenerate_section" : "visual_prompt_agent_generate_section",
				signal: taskSignal
			});
			await tasks.assertTaskNotCanceled(task.id);
			assertNotCanceled(taskSignal);
			let imageAsset;
			let version;
			let usedModel;
			let generationMode;
			try {
				if (!selectedModel) throw new Error("当前 Provider 没有识别到可用于真实图片生成的模型。");
				const generation = await generateWithFallback({
					adapter,
					candidateModels: modelCandidates,
					prompt,
					size: outputSize,
					aspectRatio: sectionAspectRatio,
					referenceImages,
					projectId,
					sectionId,
					operation: options?.regenerate ? "regenerate_section_image" : "generate_section_image",
					signal: taskSignal
				});
				await tasks.assertTaskNotCanceled(task.id);
				assertNotCanceled(taskSignal);
				imageAsset = await assets.saveGeneratedImage({
					projectId,
					sectionId,
					prompt,
					source: generation.generated,
					metadata: {
						mode: "image_api",
						usedModel: generation.model,
						sourceReferenceAssetIds: effectiveReferenceAssets.map((asset) => asset.id),
						primaryReferenceAssetId: effectiveReferenceAssets[0]?.id ?? null
					}
				});
				await tasks.assertTaskNotCanceled(task.id);
				assertNotCanceled(taskSignal);
				usedModel = generation.model;
				generationMode = "image_api";
			} catch (error) {
				if (isTaskCanceledError(error)) throw error;
				if (!generationSettings.allowSvgFallback) {
					const detail = error instanceof Error ? error.message : "Unknown image generation error";
					if (/monthly spending limit|spending limit|billing|quota/i.test(detail)) throw new Error("当前 API Key 的图片生成额度已用尽。请前往代理商控制台提高或移除月度限额，或更换可用的 API Key。");
					if (isTransientImageNetworkFailure(detail)) throw new Error(buildTransientImageNetworkMessage(detail));
					const summary = summarizeProviderImageFailure(detail, "generate");
					throw new Error(`当前 Provider 没有可用的真实图片生成端点。请前往“模型服务配置”页更换支持图片生成的 Provider，或在规划页手动开启“允许 SVG 兜底预览”。原因摘要：${summary}`);
				}
				const fallback = await generateSvgFallback({
					section,
					adapter,
					provider,
					assets,
					referenceAssets: effectiveReferenceAssets,
					aspectRatio: sectionAspectRatio,
					contentLanguage: generationSettings.contentLanguage,
					signal: taskSignal
				});
				await tasks.assertTaskNotCanceled(task.id);
				assertNotCanceled(taskSignal);
				imageAsset = await assets.saveGeneratedImage({
					projectId,
					sectionId,
					prompt,
					source: {
						svgText: fallback.svgText,
						mimeType: "image/svg+xml"
					},
					metadata: {
						mode: "svg_fallback",
						usedModel: fallback.model,
						layout: fallback.layout,
						sourceReferenceAssetIds: effectiveReferenceAssets.map((asset) => asset.id),
						primaryReferenceAssetId: effectiveReferenceAssets[0]?.id ?? null,
						imageApiError: error instanceof Error ? error.message : "Unknown image api error"
					}
				});
				await tasks.assertTaskNotCanceled(task.id);
				assertNotCanceled(taskSignal);
				usedModel = fallback.model;
				generationMode = "svg_fallback";
			}
			version = await persistSectionVersion({
				sectionId,
				imageAssetId: imageAsset.id,
				promptSnapshot: prompt,
				copySnapshot: section.copy
			});
			await repository.section.update(sectionId, {
				status: "SUCCESS",
				currentImageAssetId: imageAsset.id
			});
			await repository.project.update(projectId, { status: "EDITING" });
			await tasks.completeTask(task.id, {
				imageAssetId: imageAsset.id,
				versionId: version.id,
				usedModel,
				generationMode,
				sourceReferenceAssetIds: effectiveReferenceAssets.map((asset) => asset.id)
			});
			return {
				imageAsset,
				version,
				usedModel,
				generationMode
			};
		} catch (error) {
			await repository.section.update(sectionId, { status: isTaskCanceledError(error) ? section.currentImageAssetId ? "SUCCESS" : "IDLE" : "FAILED" });
			if (!isTaskCanceledError(error)) await tasks.failTask(task.id, error instanceof Error ? error.message : "Image generation failed");
			throw error;
		} finally {
			tasks.releaseTaskAbortController(task.id);
		}
	}
	async function generateSectionImage(projectId, sectionId, preferredModelId, referenceAssetIds, onTaskCreated) {
		return generateSectionImageInternal(projectId, sectionId, {
			preferredModelId,
			referenceAssetIds,
			regenerate: false,
			onTaskCreated
		});
	}
	async function regenerateSectionImage(projectId, sectionId, preferredModelId, referenceAssetIds, onTaskCreated) {
		return generateSectionImageInternal(projectId, sectionId, {
			preferredModelId,
			referenceAssetIds,
			regenerate: true,
			onTaskCreated
		});
	}
	async function editSectionImage(projectId, sectionId, options) {
		const project = await repository.project.getDetail(projectId);
		const section = await repository.section.get(sectionId);
		if (!project) throw new Error("Project not found.");
		if (!section || section.projectId !== projectId) throw new Error("Section not found.");
		const currentImageAsset = section.currentImageAssetId ? await repository.asset.get(section.currentImageAssetId) : null;
		if (!currentImageAsset) throw new Error("当前模块还没有可编辑的底图，请先生成一张模块图。");
		const { provider, adapter } = await resolveProviderAdapter({
			projectId,
			sectionId,
			operation: "edit_section_image"
		});
		const generationSettings = getGenerationSettings(project);
		const visualStyleGuide = getProjectVisualStyleGuide(project);
		const generationRequirements = readGenerationRequirements(project.analysis?.normalizedResult);
		const sectionAspectRatio = getSectionAspectRatio(section, generationSettings.imageAspectRatio);
		const outputSize = getOutputSize(sectionAspectRatio);
		const modelCandidates = buildImageModelCandidates(provider, {
			preferredModelId: options?.preferredModelId,
			edit: true,
			regenerate: true
		});
		const selectedModel = modelCandidates[0] ?? null;
		const explicitReferenceAssets = await resolveReferenceAssets(options?.referenceAssetIds ?? []);
		const productReferenceAssets = mergeReferenceAssets(orderProjectAssets(project.assets), explicitReferenceAssets);
		const baseImage = await assetToDataUrl(assets, currentImageAsset);
		const referenceImages = await Promise.all(productReferenceAssets.filter((asset) => asset.id !== section.currentImageAssetId).map((asset) => assetToDataUrl(assets, asset)));
		const editMode = options?.editMode ?? "repaint";
		const effectiveContentLanguage = editMode === "translate" ? normalizeContentLanguage(options?.targetLanguage) : generationSettings.contentLanguage;
		if (await tasks.findRecentRunningTask({
			projectId,
			sectionId,
			taskType: "REGENERATE",
			maxAgeMinutes: 20
		})) throw new Error("当前模块图仍在重绘或增强中，请等待这一轮完成后再试。");
		const task = await tasks.createTask({
			projectId,
			sectionId,
			taskType: "REGENERATE",
			inputPayload: {
				mode: "edit_image",
				editMode,
				targetLanguage: editMode === "translate" ? effectiveContentLanguage : void 0,
				model: selectedModel,
				modelCandidates,
				baseImageAssetId: section.currentImageAssetId,
				referenceAssetIds: options?.referenceAssetIds ?? [],
				effectiveReferenceAssetIds: productReferenceAssets.map((asset) => asset.id),
				allowSvgFallback: generationSettings.allowSvgFallback
			}
		});
		await repository.section.update(sectionId, { status: "GENERATING" });
		try {
			const basePrompt = buildImageEditPrompt(section, productReferenceAssets, editMode, sectionAspectRatio, effectiveContentLanguage, generationRequirements);
			const prompt = await buildVisualPromptWithAgent({
				provider,
				adapter,
				mode: "image_edit",
				title: section.title,
				goal: section.goal,
				copy: section.copy,
				basePrompt,
				aspectRatio: sectionAspectRatio,
				contentLanguage: effectiveContentLanguage,
				referenceImages: [baseImage, ...referenceImages],
				referenceAssets: productReferenceAssets,
				productContext: project.analysis?.normalizedResult ?? project.modelSnapshot ?? null,
				visualStyleGuide,
				projectId,
				sectionId,
				operation: editMode === "translate" ? "visual_prompt_agent_translate_section" : editMode === "enhance" ? "visual_prompt_agent_enhance_section" : "visual_prompt_agent_repaint_section"
			});
			let imageAsset;
			let version;
			let usedModel;
			let generationMode;
			try {
				if (!selectedModel) throw new Error("当前 Provider 没有识别到可用于真实图片编辑的模型。");
				const generation = await editWithFallback({
					adapter,
					candidateModels: modelCandidates,
					prompt,
					image: baseImage,
					size: outputSize,
					aspectRatio: sectionAspectRatio,
					referenceImages,
					projectId,
					sectionId,
					operation: editMode === "translate" ? "translate_section_image" : editMode === "enhance" ? "enhance_section_image" : "repaint_section_image"
				});
				imageAsset = await assets.saveGeneratedImage({
					projectId,
					sectionId,
					prompt,
					source: generation.generated,
					metadata: {
						mode: "image_api",
						usedModel: generation.model,
						editMode,
						targetLanguage: editMode === "translate" ? effectiveContentLanguage : void 0,
						baseImageAssetId: section.currentImageAssetId,
						sourceReferenceAssetIds: productReferenceAssets.map((asset) => asset.id),
						primaryReferenceAssetId: productReferenceAssets[0]?.id ?? null
					}
				});
				usedModel = generation.model;
				generationMode = "image_api";
			} catch (error) {
				if (!generationSettings.allowSvgFallback) {
					const detail = error instanceof Error ? error.message : "Unknown image edit error";
					if (/monthly spending limit|spending limit|billing|quota/i.test(detail)) throw new Error("当前 API Key 的图片编辑/生成额度已用尽。请前往代理商控制台提高或移除月度限额，或更换可用的 API Key。");
					if (isTransientImageNetworkFailure(detail)) throw new Error(buildTransientImageNetworkMessage(detail));
					const summary = summarizeProviderImageFailure(detail, "edit");
					throw new Error(`当前 Provider 没有可用的真实图片生成或编辑端点。请前往“模型服务配置”页更换支持图片编辑的 Provider，或在规划页手动开启“允许 SVG 兜底预览”。原因摘要：${summary}`);
				}
				const fallback = await generateSvgFallback({
					section,
					adapter,
					provider,
					assets,
					referenceAssets: productReferenceAssets,
					aspectRatio: sectionAspectRatio,
					contentLanguage: generationSettings.contentLanguage
				});
				imageAsset = await assets.saveGeneratedImage({
					projectId,
					sectionId,
					prompt,
					source: {
						svgText: fallback.svgText,
						mimeType: "image/svg+xml"
					},
					metadata: {
						mode: "svg_fallback",
						usedModel: fallback.model,
						editMode,
						targetLanguage: editMode === "translate" ? effectiveContentLanguage : void 0,
						baseImageAssetId: section.currentImageAssetId,
						layout: fallback.layout,
						sourceReferenceAssetIds: productReferenceAssets.map((asset) => asset.id),
						primaryReferenceAssetId: productReferenceAssets[0]?.id ?? null,
						imageApiError: error instanceof Error ? error.message : "Unknown image edit api error"
					}
				});
				usedModel = fallback.model;
				generationMode = "svg_fallback";
			}
			version = await persistSectionVersion({
				sectionId,
				imageAssetId: imageAsset.id,
				promptSnapshot: prompt,
				copySnapshot: section.copy
			});
			await repository.section.update(sectionId, {
				status: "SUCCESS",
				currentImageAssetId: imageAsset.id
			});
			await repository.project.update(projectId, { status: "EDITING" });
			await tasks.completeTask(task.id, {
				mode: "edit_image",
				editMode,
				targetLanguage: editMode === "translate" ? effectiveContentLanguage : void 0,
				imageAssetId: imageAsset.id,
				versionId: version.id,
				usedModel,
				generationMode,
				baseImageAssetId: section.currentImageAssetId,
				sourceReferenceAssetIds: productReferenceAssets.map((asset) => asset.id)
			});
			return {
				imageAsset,
				version,
				usedModel,
				generationMode,
				editMode,
				targetLanguage: editMode === "translate" ? effectiveContentLanguage : void 0
			};
		} catch (error) {
			await repository.section.update(sectionId, { status: "FAILED" });
			await tasks.failTask(task.id, error instanceof Error ? error.message : "Image edit failed");
			throw error;
		}
	}
	return {
		generateSectionImage,
		regenerateSectionImage,
		editSectionImage,
		listSectionVersions,
		activateSectionVersion,
		persistSectionVersion
	};
}
//#endregion
//#region src/core/ai/prompts/planning.ts
const sectionTypeGuide = Object.entries(sectionTypeLabels).map(([key, label]) => `${key}=${label}`).join(", ");
function buildSectionPlanningPrompt(analysis, style, platform, detailSectionCount = 6, heroImageCount = 4, contentLanguage = "zh-CN") {
	const styleLabel = styleLabels[style] ?? style;
	const platformLabel = platformLabels[platform] ?? platform;
	const targetLanguage = contentLanguageNamesForPrompt[normalizeContentLanguage(contentLanguage)];
	const planningContext = {
		productName: analysis.productName,
		category: analysis.category,
		subcategory: analysis.subcategory,
		material: analysis.material,
		color: analysis.color,
		styleTags: analysis.styleTags.slice(0, 8),
		targetAudience: analysis.targetAudience.slice(0, 6),
		usageScenarios: analysis.usageScenarios.slice(0, 6),
		coreSellingPoints: analysis.coreSellingPoints.slice(0, 8),
		differentiationPoints: analysis.differentiationPoints.slice(0, 6),
		userConcerns: analysis.userConcerns.slice(0, 6),
		recommendedFocusPoints: analysis.recommendedFocusPoints.slice(0, 8),
		additionalInformation: analysis.additionalInformation,
		generationRequirements: analysis.generationRequirements,
		suggestedSectionPlan: analysis.suggestedSectionPlan.slice(0, 8)
	};
	return [
		"You are a senior e-commerce content strategist and mobile detail-page planner.",
		`Platform: ${platformLabel}`,
		`Style: ${styleLabel}`,
		`Target content language: ${targetLanguage}`,
		"Create a mobile product-detail section plan based on the planning context below.",
		"Return strict JSON only.",
		"First define one project-level visualStyleGuide, then create all sections under that same visual system.",
		"visualStyleGuide must include: styleName, colorPalette, backgroundSystem, lighting, cameraLanguage, typography, layoutRules, propRules, productRenderingRules, negativeStyleConstraints.",
		"The visualStyleGuide is the source of truth for visual consistency across hero images and detail-page images.",
		"Before writing sections, reason from the product analysis as the source of truth: exact product category, visible geometry, mechanism, repeated-part count, materials, colors, size/spec facts, and what the product must not be mistaken for.",
		"Do not create generic manufacturing, craft, measuring-ruler, sticker-sheet, electronics, storage-box, appliance, or unrelated sections unless the product analysis clearly supports them.",
		"For puzzle cubes / speed cubes / Rubik-like cubes, the detail page should explain cube order, turning feel, layer seams, corner/edge/center pieces, color recognition, grip, stability, suitable users, package contents and real dimensions; avoid claiming unrelated sticker cutting, ruler measurement props, batteries, cables, airflow, screens, or appliance functions.",
		`The output must contain exactly ${heroImageCount + detailSectionCount} sections in total.`,
		`You must create exactly ${heroImageCount} hero sections and exactly ${detailSectionCount} non-hero detail sections.`,
		"All hero sections must come first in the output array.",
		`Hero sections represent individual square hero gallery images, so each hero section must have a distinct first-screen communication role across these ${heroImageCount} angles.`,
		"The hero sections should cover different roles such as primary visual, core selling point, scenario mood, trust, and differentiation without repeating the same purpose.",
		"For each hero section, describe a different concrete picture: camera angle, crop, product placement, scene/background, props, lighting, in-image title position, selling-point callouts, CTA placement, and what exact product feature is visible.",
		"Hero section visualPrompts must not reuse the same generic sentence. Each one needs at least 3 concrete visual details unique to that image.",
		"If generationRequirements is provided, treat it as a hard creative brief. Convert requirements such as multi-angle, multi-scene, and different usage methods into distinct hero/detail sections and concrete visualPrompt instructions.",
		"Do not merely repeat generationRequirements as generic text; operationalize it through camera angles, scenes, props, product interaction modes, section goals, and in-image copy.",
		"All non-hero sections must come after the hero sections.",
		"Each section item must include: id, type, title, goal, copy, visualPrompt, editableFields.",
		"Each section.visualPrompt must explicitly cite how it follows the shared visualStyleGuide: same palette, background system, lighting, typography, CTA style, safe margins, product rendering rules, and negative constraints.",
		`All user-facing section titles, goals, copy, and in-image text instructions must be written in ${targetLanguage}.`,
		"visualPrompt must use this exact two-part format:",
		`Primary Prompt: <visual direction in ${targetLanguage}>`,
		"English Prompt: <English image prompt>",
		"The visualPrompt must explicitly require the image model to generate the marketing title, selling points, supporting copy, and CTA directly inside the image, instead of relying on external DOM text.",
		`Allowed section types: ${sectionTypeGuide}`,
		"editableFields should include at least one of: sellingPoints, tone, compositionHint.",
		"editableFields must also include styleRole, sharedStyleAnchors, and localVariation. styleRole describes this section role inside the shared visual system. sharedStyleAnchors lists the visual elements that must remain identical with the rest of the project. localVariation describes what can change only in this one image.",
		"editableFields should also include negativeConstraints as an array of product-specific impossible or undesirable visual outcomes.",
		"Avoid duplicate section goals and avoid repeating the same section type excessively.",
		"The section flow should feel commercially complete and conversion-oriented.",
		"",
		"Return exactly this JSON shape:",
		`{
  "visualStyleGuide": {
    "styleName": "string",
    "colorPalette": "string",
    "backgroundSystem": "string",
    "lighting": "string",
    "cameraLanguage": "string",
    "typography": "string",
    "layoutRules": "string",
    "propRules": "string",
    "productRenderingRules": "string",
    "negativeStyleConstraints": "string"
  },
  "sections": [
    {
      "id": "string",
      "type": "hero | selling_points | scenario | detail_closeup | specs | material | comparison | gift_scene | brand_trust | summary | custom",
      "title": "string",
      "goal": "string",
      "copy": "string",
      "visualPrompt": "Primary Prompt: ...\nEnglish Prompt: ...",
      "editableFields": {
        "styleRole": "string",
        "sharedStyleAnchors": ["string"],
        "localVariation": "string",
        "negativeConstraints": ["string"]
      }
    }
  ]
}`,
		"",
		"Physical realism and product-specific constraints:",
		...[
			"Before writing any visualPrompt, infer how this exact product works physically: inlet/outlet direction, cable/plug position, seams, openings, hinges, buttons, handles, fluid direction, airflow direction, support points, gravity, shadows, and how a hand would hold or use it.",
			"Every section must include product-specific negative constraints in visualPrompt: state what must NOT happen for this product.",
			"Examples: for a hair dryer, airflow must come out of the nozzle only and never blow backward from the rear intake; the power cord must exit from the handle/base and remain visible, never disappearing into a table or wall; hair and fabric should react in the airflow direction. For a lamp, light must emit from the lamp head, not from the cable. For containers, openings, lids, drawers and hinges must align with the real product geometry.",
			"Avoid impossible physics: floating products without support, cables merging into surfaces, reversed airflow, liquids flowing upward, disconnected shadows, impossible reflections, text wrapped through objects, hands gripping through solid parts, and product parts bending in ways the real material cannot.",
			"Use the structured product analysis, which was produced from the uploaded main product image, as the geometry source of truth. Do not redesign the product mechanism. The image itself will be referenced again during image generation."
		].map((item) => `- ${item}`),
		"",
		"Planning context:",
		JSON.stringify(planningContext, null, 2)
	].join("\n");
}
function buildVisualStyleGuidePrompt(analysis, style, platform, contentLanguage = "zh-CN") {
	const styleLabel = styleLabels[style] ?? style;
	const platformLabel = platformLabels[platform] ?? platform;
	const targetLanguage = contentLanguageNamesForPrompt[normalizeContentLanguage(contentLanguage)];
	return [
		"You are a senior e-commerce art director defining one reusable visual system for a product detail page.",
		"Return strict JSON only. No markdown.",
		`Platform: ${platformLabel}`,
		`Requested style: ${styleLabel}`,
		`Target content language: ${targetLanguage}`,
		"Create one project-level visualStyleGuide that keeps hero images and detail-page images visually consistent while still allowing different section content.",
		"The guide must be practical for image generation prompts, specific to this exact product, and written in concise Chinese.",
		"Do not make a generic moodboard. Specify repeatable rules: colors, background, light, camera, typography, layout density, props, product rendering and negative constraints.",
		"",
		"Product analysis:",
		JSON.stringify({
			productName: analysis.productName,
			category: analysis.category,
			subcategory: analysis.subcategory,
			material: analysis.material,
			color: analysis.color,
			styleTags: analysis.styleTags,
			coreSellingPoints: analysis.coreSellingPoints,
			differentiationPoints: analysis.differentiationPoints,
			usageScenarios: analysis.usageScenarios,
			additionalInformation: analysis.additionalInformation,
			generationRequirements: analysis.generationRequirements
		}, null, 2),
		"",
		"Return exactly this JSON shape:",
		`{
  "styleName": "string",
  "colorPalette": "string",
  "backgroundSystem": "string",
  "lighting": "string",
  "cameraLanguage": "string",
  "typography": "string",
  "layoutRules": "string",
  "propRules": "string",
  "productRenderingRules": "string",
  "negativeStyleConstraints": "string"
}`
	].join("\n");
}
//#endregion
//#region src/core/ai/schemas/section-plan.ts
const visualStyleGuideSchema = z.object({
	styleName: z.string().default(""),
	colorPalette: z.string().default(""),
	backgroundSystem: z.string().default(""),
	lighting: z.string().default(""),
	cameraLanguage: z.string().default(""),
	typography: z.string().default(""),
	layoutRules: z.string().default(""),
	propRules: z.string().default(""),
	productRenderingRules: z.string().default(""),
	negativeStyleConstraints: z.string().default("")
});
const sectionPlanItemSchema = z.object({
	id: z.string(),
	type: z.string(),
	title: z.string(),
	goal: z.string(),
	copy: z.string(),
	visualPrompt: z.string(),
	editableFields: z.record(z.string(), z.any()).default({})
});
const sectionPlanOutputSchema = z.union([
	z.object({
		visualStyleGuide: visualStyleGuideSchema.optional(),
		sections: z.array(sectionPlanItemSchema)
	}),
	z.array(sectionPlanItemSchema),
	z.object({ data: z.object({
		visualStyleGuide: visualStyleGuideSchema.optional(),
		sections: z.array(sectionPlanItemSchema)
	}) }),
	z.object({ result: z.object({
		visualStyleGuide: visualStyleGuideSchema.optional(),
		sections: z.array(sectionPlanItemSchema)
	}) })
]).transform((value) => {
	if (Array.isArray(value)) return {
		sections: value,
		visualStyleGuide: void 0
	};
	if ("sections" in value) return {
		sections: value.sections,
		visualStyleGuide: value.visualStyleGuide
	};
	if ("data" in value) return {
		sections: value.data.sections,
		visualStyleGuide: value.data.visualStyleGuide
	};
	return {
		sections: value.result.sections,
		visualStyleGuide: value.result.visualStyleGuide
	};
});
//#endregion
//#region src/core/services/planner-service.ts
/**
* Planner service — preview-count planning, section planning, section CRUD.
*
* Ported from upstream `lib/services/planner-service.ts` (ziguishian/MxPage, MIT).
*
*  1. `prisma.*` → injected `host.repository.*`.
*  2. `getProviderAdapter()` → `await host.provider.resolve({ projectId, operation })`
*     plus `new OpenAICompatibleAdapter(resolved.baseUrl, resolved.apiKey, host.logger)`.
*  3. `patchProjectModelSnapshot(...)` → `repository.project.mergeModelSnapshot(...)`.
*     The upstream compare-and-swap loop over `Project.updatedAt` is gone: it
*     existed to defuse two Next.js request handlers racing on the same JSON
*     column, and a single-writer host has no such race.
*  4. `readStorageFile(rel)` → `assetStore.readStorageFile(rel)`; nothing here
*     touches `process.cwd()`.
*  5. `nanoid` → `nanoidLike` backed by `node:crypto` (the dependency is dropped).
*  6. `Prisma.JsonNull` / `InputJsonValue` coercions are gone — JSON columns are
*     plain values.
*  7. `prisma.$transaction([...])` blocks became sequential `await`s. The
*     Repository port has no transaction primitive; see the note on
*     `normalizeProjectSections`.
*
* The static fallback templates (`heroFallbackSections`, `detailFallbackSections`,
* `buildFallbackPlanFromTemplates`) and every Chinese user-facing string are kept
* verbatim — they are what keeps a project plannable when the model misbehaves.
*/
const previewConfigSchema = z.object({
	heroImageCount: z.number().int().min(1).max(5),
	detailSectionCount: z.number().int().min(1).max(10),
	imageAspectRatio: z.enum(["3:4", "9:16"]).default("9:16"),
	contentLanguage: z.enum(contentLanguageOptions).default("zh-CN")
});
const previewDecisionSchema = z.object({
	heroImageCount: z.number().int().min(1).max(5),
	detailSectionCount: z.number().int().min(1).max(10),
	reason: z.string().default("")
});
/** `nanoid(6)` with nanoid's default URL-safe alphabet, without the dependency. */
function nanoidLike(size = 6) {
	const alphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
	const bytes = randomBytes(size);
	let id = "";
	for (const byte of bytes) id += alphabet[byte & 63];
	return id;
}
const heroFallbackSections = [
	{
		id: "hero_01",
		type: "hero",
		title: "第一屏主视觉",
		goal: "快速建立商品记忆点，突出第一眼吸引力。",
		copy: "用一张完成度很高的主视觉图，把商品核心价值和气质一次讲清楚。",
		visualPrompt: "中文提示：1:1 电商首张主视觉，商品以 3/4 角度居中偏下，占画面 55%-65%，浅色高级背景，左上保留大标题区，右侧用 2-3 个短卖点标签围绕真实结构标注。必须保持商品真实几何、开口/线缆/风口/按钮方向正确，不出现悬浮、反向风、线缆插入桌面等不合理物理现象。\nEnglish Prompt: Square e-commerce primary hero image, product in a three-quarter view centered slightly lower, occupying 55-65% of the canvas, premium light background, large headline area at top-left, 2-3 selling point tags around real product structures. Preserve real product geometry and avoid impossible physics such as floating, reversed airflow, or cables merging into surfaces.",
		editableFields: {
			tone: "高级质感",
			compositionHint: "居中构图"
		}
	},
	{
		id: "hero_02",
		type: "hero",
		title: "核心卖点头图",
		goal: "用一张强转化头图把最值得买的理由直接讲透。",
		copy: "把商品最强卖点直接做进画面标题和图内短句里，让用户第一时间知道为什么值得买。",
		visualPrompt: "中文提示：1:1 核心卖点头图，画面采用近景产品 + 功能分解标注，商品主体放在右侧或中间，左侧放强转化标题、3 个短卖点和 CTA。镜头要明确展示最关键功能部位，例如喷口/开口/抽屉/按键/材质接缝；所有标注线必须指向真实部件。禁止出现结构错位、功能方向反转、线缆断裂或穿进桌面。\nEnglish Prompt: Square selling-point hero image with close product view and functional annotations. Place product at center or right, strong conversion headline, three short selling points, and CTA on the left. Clearly show the key functional part such as nozzle, opening, drawer, button, or material seam. Annotation lines must point to real parts; avoid misaligned structure, reversed function direction, broken cables, or cables entering furniture.",
		editableFields: {
			tone: "转化导向",
			compositionHint: "主体 + 卖点文案同屏"
		}
	},
	{
		id: "hero_03",
		type: "hero",
		title: "场景氛围头图",
		goal: "让用户快速代入使用场景和生活方式气质。",
		copy: "通过场景化构图和图内标题文案，让商品与生活方式、使用时刻建立直接关联。",
		visualPrompt: "中文提示：1:1 场景氛围头图，把商品放入真实使用场景，采用中景构图，周围只放 2-4 个相关道具来说明使用时刻，背景有生活方式氛围但不能抢主体。图内标题放在上方留白，场景价值短句放在底部半透明信息条。商品必须有合理支撑、阴影和使用方向；如果是电器，线缆和风/光/热方向必须符合真实工作逻辑。\nEnglish Prompt: Square lifestyle hero image showing the product in a real usage scene with medium shot composition and 2-4 relevant props. Background should add lifestyle mood without stealing focus. Place headline in upper whitespace and scene-value copy in a subtle bottom information bar. Product must have realistic support, shadows, and use direction; for appliances, cable and airflow/light/heat direction must follow real mechanics.",
		editableFields: {
			tone: "氛围感",
			compositionHint: "场景化构图"
		}
	},
	{
		id: "hero_04",
		type: "hero",
		title: "细节信任头图",
		goal: "用品质、工艺或材质细节建立第一屏信任感。",
		copy: "通过近景细节和简洁文案，让用户第一眼感知品质感、工艺感和完成度。",
		visualPrompt: "中文提示：电商头图，强调品质细节、材质或工艺，画面高级克制，图内直接排版中文品质标题和信任感短句，适合 1:1 头图轮播。\nEnglish Prompt: Square e-commerce hero image focused on craftsmanship and material trust, with elegant composition and Chinese quality-driven copy integrated into the image.",
		editableFields: {
			tone: "品质背书",
			compositionHint: "细节近景"
		}
	},
	{
		id: "hero_05",
		type: "hero",
		title: "差异化亮点头图",
		goal: "突出相对竞品或常规选择的差异化优势。",
		copy: "围绕核心差异化特点，用更直接的对比式表达完成最后一张头图收口。",
		visualPrompt: "中文提示：电商头图，突出差异化优势和购买理由，图内直接排版中文对比式标题、优势短句和行动号召，适合 1:1 头图轮播。\nEnglish Prompt: Square e-commerce hero image emphasizing differentiation and buying reasons, with Chinese comparison-style headline, advantage copy, and CTA built directly into the image.",
		editableFields: {
			tone: "差异化强调",
			compositionHint: "对比式信息布局"
		}
	}
];
const detailFallbackSections = [
	{
		id: "selling_points_01",
		type: "selling_points",
		title: "核心卖点速览",
		goal: "让用户快速理解最值得购买的理由。",
		copy: "用图内标题、卖点短句和对比式信息，把购买理由在一屏内讲清楚。",
		visualPrompt: "中文提示：电商卖点模块，商品清晰展示，图内直接排版中文卖点标题、短句与功能标签，整体干净有转化感。\nEnglish Prompt: Conversion-focused selling-points section with the product clearly shown and Chinese selling-point copy designed directly inside the image.",
		editableFields: {
			sellingPoints: [],
			tone: "转化导向",
			compositionHint: "卖点信息分区排版"
		}
	},
	{
		id: "detail_closeup_01",
		type: "detail_closeup",
		title: "细节特写",
		goal: "强化材质、工艺与真实质感。",
		copy: "通过近景放大，把材质、边缘和工艺细节讲透。",
		visualPrompt: "中文提示：电商细节特写图，突出纹理、边缘、表面光泽与做工，并在图内加入中文短标题和工艺说明。\nEnglish Prompt: Detailed close-up e-commerce image highlighting texture, finish, edges, and craftsmanship, with concise Chinese copy integrated into the composition.",
		editableFields: {
			tone: "细节说明",
			compositionHint: "近景微距"
		}
	},
	{
		id: "scenario_01",
		type: "scenario",
		title: "场景使用展示",
		goal: "让用户更容易代入真实使用场景。",
		copy: "把商品放进真实场景里，提升想象空间和购买欲望。",
		visualPrompt: "中文提示：生活方式场景图，商品仍为主角，图内直接排版中文场景标题和使用价值文案，整体自然有氛围。\nEnglish Prompt: Lifestyle usage scene with the product as the focal point, featuring integrated Chinese copy about the usage scenario and emotional value.",
		editableFields: {
			tone: "生活方式",
			compositionHint: "场景化展示"
		}
	},
	{
		id: "specs_01",
		type: "specs",
		title: "规格信息说明",
		goal: "把参数、尺寸和适配信息讲清楚。",
		copy: "通过结构化图文版式，让规格信息一眼看懂。",
		visualPrompt: "中文提示：规格参数型详情图，商品搭配尺寸线、参数表和中文说明排版，信息清晰整洁，适合移动端浏览。\nEnglish Prompt: Specification-focused detail image combining the product with dimensions, parameter layout, and Chinese explanatory copy designed directly in-image.",
		editableFields: {
			tone: "专业说明",
			compositionHint: "参数表格式"
		}
	},
	{
		id: "material_01",
		type: "material",
		title: "材质工艺说明",
		goal: "补充专业感与品质背书。",
		copy: "把用户不容易从外观看懂的材质和工艺价值解释清楚。",
		visualPrompt: "中文提示：材质工艺详情图，突出材质纹理、工艺结构和品质细节，图内加入中文短标题和价值说明。\nEnglish Prompt: Material and craftsmanship detail image that emphasizes texture and premium construction, with Chinese value statements integrated into the image.",
		editableFields: {
			tone: "专业背书",
			compositionHint: "结构与纹理并重"
		}
	},
	{
		id: "comparison_01",
		type: "comparison",
		title: "差异化对比",
		goal: "清楚说明为什么值得选这款商品。",
		copy: "用优势对比和价值提炼，帮助用户更快完成决策。",
		visualPrompt: "中文提示：对比说明型详情图，突出本品优势、差异点和购买理由，图内直接设计中文标题和对比信息模块。\nEnglish Prompt: Comparison-style detail page image emphasizing advantages, differentiation, and buying reasons, with Chinese comparison copy embedded inside the image.",
		editableFields: {
			tone: "价值对比",
			compositionHint: "左右或上下对比版式"
		}
	},
	{
		id: "brand_trust_01",
		type: "brand_trust",
		title: "品牌与信任背书",
		goal: "提升品牌感和成交信任感。",
		copy: "通过品牌理念、工艺标准或服务承诺，增加下单安心感。",
		visualPrompt: "中文提示：品牌背书型详情图，图内加入品牌理念、工艺标准或服务承诺等中文信息，整体克制专业。\nEnglish Prompt: Brand trust section image with Chinese copy about brand values, quality assurance, or service promise built directly into the image.",
		editableFields: {
			tone: "信任建立",
			compositionHint: "品牌叙事排版"
		}
	},
	{
		id: "summary_01",
		type: "summary",
		title: "购买理由总结",
		goal: "形成最后一轮转化推动。",
		copy: "通过总结式收口，帮助用户更快完成购买决策。",
		visualPrompt: "中文提示：总结收口型详情图，商品主体清晰，图内直接放入中文总结标题、购买理由和行动号召。\nEnglish Prompt: Conversion-closing summary image with strong product focus and Chinese summary copy plus CTA integrated directly into the visual.",
		editableFields: {
			tone: "收口转化",
			compositionHint: "稳定收束"
		}
	}
];
const sectionTypeMap = {
	hero: "HERO",
	selling_points: "SELLING_POINTS",
	scenario: "SCENARIO",
	detail_closeup: "DETAIL_CLOSEUP",
	specs: "SPECS",
	material: "MATERIAL",
	comparison: "COMPARISON",
	gift_scene: "GIFT_SCENE",
	brand_trust: "BRAND_TRUST",
	summary: "SUMMARY",
	custom: "CUSTOM"
};
function normalizeSectionType(type) {
	const normalized = type.trim().toLowerCase();
	return sectionTypeMap[normalized] ?? "CUSTOM";
}
function ensureBilingualPrompt(prompt, sectionTitle) {
	const trimmed = prompt.trim();
	if (trimmed.includes("English Prompt:") && (trimmed.includes("中文提示：") || trimmed.includes("Primary Prompt:"))) return trimmed;
	return `Primary Prompt: ${trimmed || `${sectionTitle}，突出商品主体、商业排版和图内卖点信息，适合移动端电商详情页。`}\nEnglish Prompt: A premium e-commerce section visual for ${sectionTitle}, with the marketing copy designed directly inside the image and a strong conversion-focused composition.`;
}
function normalizeEditableFields(value) {
	const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	return {
		...raw,
		styleRole: typeof raw.styleRole === "string" ? raw.styleRole : "Follow the project-level visual style guide while serving this section goal.",
		sharedStyleAnchors: Array.isArray(raw.sharedStyleAnchors) ? raw.sharedStyleAnchors : [
			"consistent color palette",
			"consistent background system",
			"consistent lighting direction",
			"consistent typography and CTA style",
			"accurate product proportions and materials"
		],
		localVariation: typeof raw.localVariation === "string" ? raw.localVariation : "Only vary the section-specific selling point, composition angle, and information hierarchy."
	};
}
function pickPlanningReferenceAssets(assets) {
	return [...assets].filter((asset) => [
		"MAIN",
		"ANGLE",
		"DETAIL",
		"REFERENCE"
	].includes(asset.type)).sort((a, b) => {
		const score = (asset) => {
			if (asset.isMain) return 0;
			if (asset.type === "MAIN") return 1;
			if (asset.type === "ANGLE") return 2;
			if (asset.type === "DETAIL") return 3;
			return 4;
		};
		return score(a) - score(b) || a.sortOrder - b.sortOrder;
	}).slice(0, 3);
}
async function assetToPlanningDataUrl(asset, readStorageFile) {
	const buffer = await readStorageFile(asset.filePath);
	return `data:${asset.mimeType ?? "image/png"};base64,${buffer.toString("base64")}`;
}
async function collectPlanningReferenceImages(assets, readStorageFile) {
	const selectedAssets = pickPlanningReferenceAssets(assets);
	return Promise.all(selectedAssets.map((asset) => assetToPlanningDataUrl(asset, readStorageFile)));
}
function readPreviewConfig(snapshot) {
	const raw = (snapshot ?? {}).previewConfig;
	return previewConfigSchema.parse({
		heroImageCount: Number(raw?.heroImageCount ?? 4),
		detailSectionCount: Number(raw?.detailSectionCount ?? 6),
		imageAspectRatio: raw?.imageAspectRatio ?? "9:16",
		contentLanguage: normalizeContentLanguage(raw?.contentLanguage)
	});
}
function buildProjectVisualStyleGuideFallback(project) {
	const analysis = project.analysis?.normalizedResult ?? {};
	return buildDefaultVisualStyleGuide({
		productName: typeof analysis.productName === "string" ? analysis.productName : void 0,
		styleLabel: project.style,
		platformLabel: project.platform
	});
}
function resolvePlanningVisualStyleGuide(project, plannedGuide) {
	const fallback = buildProjectVisualStyleGuideFallback(project);
	const existingGuide = readVisualStyleGuide(project.modelSnapshot, fallback);
	if (existingGuide) return existingGuide;
	if (hasVisualStyleGuide(plannedGuide)) return normalizeVisualStyleGuide(plannedGuide, fallback);
	return fallback;
}
function readModelCapabilities(model) {
	return model.capabilities ?? {};
}
function isVisionTextModel(model) {
	const capabilities = readModelCapabilities(model);
	return Boolean(capabilities.text && capabilities.vision);
}
function pickMultimodalPlanningModel(models, preferredModelId) {
	if (preferredModelId) return preferredModelId;
	const visionTextModels = models.filter(isVisionTextModel);
	return visionTextModels.find((item) => item.isDefaultPlanning)?.modelId ?? visionTextModels.find((item) => item.isDefaultAnalysis)?.modelId ?? visionTextModels.find((item) => /gpt-4o|gpt-4\.1|gpt-5|gemini|qwen.*vl|kimi|moonshot/i.test(item.modelId))?.modelId ?? visionTextModels[0]?.modelId ?? models.find((item) => item.isDefaultPlanning)?.modelId ?? models.find((item) => item.isDefaultAnalysis)?.modelId ?? models.find((item) => item.capabilities.structured_output)?.modelId ?? null;
}
function createPlannerService(host, deps) {
	const { repository } = host;
	const logger = host.logger;
	const tasks = deps?.tasks ?? createTaskService(host);
	const assetStore = deps?.assets ?? createAssetStore(host);
	const readStorageFile = (relativePath) => assetStore.readStorageFile(relativePath);
	/**
	* Upstream ran this as one `prisma.$transaction([...update])`. The Repository
	* port exposes no transaction primitive, so the updates run sequentially. Each
	* row is a full-row rewrite of `order` + `sectionKey`, so a partial failure
	* leaves some rows renamed — recoverable by calling `normalizeProjectSections`
	* again, and not observable by a single-writer host mid-flight.
	*/
	async function normalizeProjectSections(projectId) {
		if (!await repository.project.get(projectId)) throw new Error("Project not found.");
		const projectSections = await repository.section.list(projectId);
		let heroCursor = 0;
		let detailCursor = 0;
		for (const [index, section] of projectSections.entries()) {
			const isHero = section.type === "HERO";
			if (isHero) heroCursor += 1;
			else detailCursor += 1;
			await repository.section.update(section.id, {
				order: index,
				sectionKey: isHero ? `hero_${String(heroCursor).padStart(2, "0")}` : `detail_${String(detailCursor).padStart(2, "0")}_${section.type.toLowerCase()}`
			});
		}
		await repository.project.mergeModelSnapshot(projectId, { previewConfig: {
			heroImageCount: heroCursor,
			detailSectionCount: detailCursor
		} });
	}
	async function assertSectionMutationAllowed(projectId, options) {
		if (!await repository.project.get(projectId)) throw new Error("Project not found.");
		const projectSections = await repository.section.list(projectId);
		let heroCount = projectSections.filter((section) => section.type === "HERO").length;
		let detailCount = projectSections.filter((section) => section.type !== "HERO").length;
		if (options.addingType) {
			if (normalizeSectionType(options.addingType) === "HERO") {
				if (heroCount >= 5) throw new Error("头图最多保留 5 张，请先删除或改成详情页后再新增。");
				heroCount += 1;
			} else {
				if (detailCount >= 10) throw new Error("详情页最多保留 10 张，请先删除或改成头图后再新增。");
				detailCount += 1;
			}
		}
		if (options.deletingSectionId) {
			const target = projectSections.find((section) => section.id === options.deletingSectionId);
			if (!target) throw new Error("Section not found.");
			if (target.type === "HERO") {
				if (heroCount <= 3) throw new Error("头图至少保留 1 张，不能继续删除。");
				heroCount -= 1;
			} else {
				if (detailCount <= 4) throw new Error("详情页至少保留 1 张，不能继续删除。");
				detailCount -= 1;
			}
		}
		if (options.updatingSectionId && options.nextType) {
			const target = projectSections.find((section) => section.id === options.updatingSectionId);
			if (!target) throw new Error("Section not found.");
			const currentType = target.type;
			const nextType = normalizeSectionType(options.nextType);
			if (currentType !== nextType) {
				if (currentType === "HERO" && nextType !== "HERO") {
					if (heroCount <= 3) throw new Error("头图至少保留 1 张，不能把当前头图改成详情页。");
					if (detailCount >= 10) throw new Error("详情页最多保留 10 张，请先删除多余详情页后再转换。");
				}
				if (currentType !== "HERO" && nextType === "HERO") {
					if (detailCount <= 4) throw new Error("详情页至少保留 1 张，不能把当前详情页改成头图。");
					if (heroCount >= 5) throw new Error("头图最多保留 5 张，请先删除多余头图后再转换。");
				}
			}
		}
	}
	function buildPreviewDecisionPrompt(analysis, contentLanguage) {
		const context = {
			productName: analysis.productName,
			category: analysis.category,
			subcategory: analysis.subcategory,
			styleTags: Array.isArray(analysis.styleTags) ? analysis.styleTags.slice(0, 6) : [],
			usageScenarios: Array.isArray(analysis.usageScenarios) ? analysis.usageScenarios.slice(0, 6) : [],
			coreSellingPoints: Array.isArray(analysis.coreSellingPoints) ? analysis.coreSellingPoints.slice(0, 8) : [],
			differentiationPoints: Array.isArray(analysis.differentiationPoints) ? analysis.differentiationPoints.slice(0, 6) : [],
			suggestedSectionPlan: Array.isArray(analysis.suggestedSectionPlan) ? analysis.suggestedSectionPlan.slice(0, 8) : []
		};
		return [
			"You are a senior e-commerce creative strategist deciding the right image count plan for a product detail page.",
			"Return strict JSON only.",
			"heroImageCount must be an integer between 1 and 5.",
			"detailSectionCount must be an integer between 1 and 10.",
			`The target content language for the final page is ${contentLanguage}.`,
			"Hero images should be enough to cover distinct first-screen communication angles such as hero visual, selling point emphasis, scenario mood, trust, or differentiation.",
			"Detail sections should be enough to fully explain selling points, craftsmanship, specs, trust, and use cases without becoming repetitive.",
			"If the product is simple, reduce quantity. If the product needs richer explanation, increase quantity.",
			"",
			"Product context:",
			JSON.stringify(context, null, 2)
		].join("\n");
	}
	function buildFallbackDetail(index) {
		const template = detailFallbackSections[index % detailFallbackSections.length];
		return {
			type: normalizeSectionType(template.type),
			title: template.title,
			goal: template.goal,
			copy: template.copy,
			visualPrompt: template.visualPrompt,
			editableData: template.editableFields
		};
	}
	function readAnalysisText(analysis, key) {
		const value = analysis?.[key];
		return typeof value === "string" ? value.trim() : "";
	}
	function readAnalysisList(analysis, key, limit = 6) {
		const value = analysis?.[key];
		return Array.isArray(value) ? value.filter((item) => typeof item === "string" && Boolean(item.trim())).slice(0, limit) : [];
	}
	function buildFallbackPromptAppendix(analysis, sectionRole) {
		if (!analysis) return "";
		const context = [
			readAnalysisText(analysis, "productName") ? `商品名称：${readAnalysisText(analysis, "productName")}` : "",
			readAnalysisText(analysis, "category") ? `品类：${readAnalysisText(analysis, "category")}` : "",
			readAnalysisText(analysis, "subcategory") ? `子类目：${readAnalysisText(analysis, "subcategory")}` : "",
			readAnalysisText(analysis, "material") ? `材质：${readAnalysisText(analysis, "material")}` : "",
			readAnalysisText(analysis, "color") ? `颜色：${readAnalysisText(analysis, "color")}` : "",
			readAnalysisList(analysis, "usageScenarios").length ? `使用场景：${readAnalysisList(analysis, "usageScenarios").join(" / ")}` : "",
			readAnalysisList(analysis, "coreSellingPoints").length ? `核心卖点：${readAnalysisList(analysis, "coreSellingPoints").join(" / ")}` : "",
			readAnalysisText(analysis, "additionalInformation") ? `补充事实：${readAnalysisText(analysis, "additionalInformation")}` : "",
			readAnalysisText(analysis, "generationRequirements") ? `生图补充要求：${readAnalysisText(analysis, "generationRequirements")}` : ""
		].filter(Boolean);
		if (!context.length) return "";
		return [
			"",
			`兜底规划增强要求：当前模块角色为「${sectionRole}」。必须基于以下商品事实和生图补充要求改写画面，不要生成通用商品模板：`,
			...context,
			"必须把多角度、多使用场景、不同使用方式落实为具体镜头、场景、道具、手部交互、细节特写或构图差异。",
			"同一项目中的每张图都应保持商品主体一致，但镜头、场景、道具、卖点和图内文案要有明确差异。"
		].join("\n");
	}
	function enrichFallbackSection(section, analysis) {
		const appendix = buildFallbackPromptAppendix(analysis, section.title);
		if (!appendix) return section;
		return {
			...section,
			visualPrompt: `${section.visualPrompt}${appendix}`,
			editableData: {
				...section.editableData,
				generationRequirements: readAnalysisText(analysis, "generationRequirements"),
				productContext: {
					productName: readAnalysisText(analysis, "productName"),
					category: readAnalysisText(analysis, "category"),
					usageScenarios: readAnalysisList(analysis, "usageScenarios"),
					coreSellingPoints: readAnalysisList(analysis, "coreSellingPoints")
				}
			}
		};
	}
	function buildFallbackHero(index) {
		const template = heroFallbackSections[index % heroFallbackSections.length];
		return {
			type: "HERO",
			title: template.title,
			goal: template.goal,
			copy: template.copy,
			visualPrompt: template.visualPrompt,
			editableData: template.editableFields
		};
	}
	function buildNormalizedSections(rawSections, heroImageCount, detailSectionCount, analysis) {
		const normalized = rawSections.map((section, index) => ({
			type: normalizeSectionType(section.type),
			title: section.title || `模块 ${index + 1}`,
			goal: section.goal || "突出商品卖点",
			copy: section.copy || "",
			visualPrompt: ensureBilingualPrompt(section.visualPrompt || "", section.title || `模块 ${index + 1}`),
			editableData: normalizeEditableFields(section.editableFields)
		}));
		const heroPool = normalized.filter((section) => section.type === "HERO");
		const detailPool = normalized.filter((section) => section.type !== "HERO");
		const finalHeroes = heroPool.slice(0, heroImageCount);
		while (finalHeroes.length < heroImageCount) finalHeroes.push(enrichFallbackSection(buildFallbackHero(finalHeroes.length), analysis));
		const finalDetails = detailPool.slice(0, detailSectionCount);
		while (finalDetails.length < detailSectionCount) finalDetails.push(enrichFallbackSection(buildFallbackDetail(finalDetails.length), analysis));
		return [...finalHeroes, ...finalDetails].map((section, index) => {
			if (section.type === "HERO") return {
				...section,
				sectionKey: `hero_${String(index + 1).padStart(2, "0")}`,
				order: index
			};
			const detailIndex = index + 1 - finalHeroes.length;
			return {
				...section,
				sectionKey: `detail_${String(detailIndex).padStart(2, "0")}_${section.type.toLowerCase()}`,
				order: index
			};
		});
	}
	function buildFallbackPlanFromTemplates(heroImageCount, detailSectionCount, analysis) {
		return buildNormalizedSections([], heroImageCount, detailSectionCount, analysis);
	}
	function shouldFallbackToTemplatePlan(error) {
		if (error instanceof z.ZodError) return true;
		if (!(error instanceof Error)) return false;
		const message = error.message;
		return /"sections"|expected array|invalid input: expected array|received undefined|section/i.test(message) || /timed out|timeout|aborted|network|fetch failed|ECONNRESET|ETIMEDOUT|provider request timed out|provider request failed \(504\)|gateway time-out/i.test(message) || message.includes("超时") || message.includes("网络") || message.includes("Provider 请求");
	}
	/**
	* Resolves the provider channel for one AI operation and builds an adapter
	* over it. Replaces upstream's `getProviderAdapter()`, which read Prisma rows
	* *and* required a per-request API key from `AsyncLocalStorage`.
	*/
	async function resolvePlanningAdapter(projectId, operation) {
		const resolved = await host.provider.resolve({
			projectId,
			operation
		});
		return {
			adapter: new OpenAICompatibleAdapter(resolved.baseUrl, resolved.apiKey, logger),
			models: resolved.models
		};
	}
	/**
	* Replaces upstream's `project.findUnique({ include: { analysis, assets } })`.
	*
	* The project row is a *precondition* of every caller, so it is asserted here
	* rather than at each call site — same as upstream, which only ever reached
	* these bodies through a route that had already loaded the project. This also
	* narrows `project` for the whole calling scope.
	*/
	async function loadPlanningContext(projectId) {
		const project = await repository.project.get(projectId);
		const analysis = await repository.analysis.get(projectId);
		const assets = await repository.asset.list({ projectId });
		if (!project) throw new Error("Project not found.");
		return {
			project,
			analysis,
			assets
		};
	}
	async function decidePreviewConfigWithAi(projectId, preferredModelId, signal) {
		const { project, analysis, assets } = await loadPlanningContext(projectId);
		if (!analysis) throw new Error("请先完成商品分析，再进行页面规划。");
		const { adapter, models } = await resolvePlanningAdapter(projectId, "preview_count_planning");
		const model = pickMultimodalPlanningModel(models, preferredModelId);
		if (!model) throw new Error("当前没有可用的文案规划模型。");
		const currentPreviewConfig = readPreviewConfig(project.modelSnapshot);
		const planningReferenceImages = await collectPlanningReferenceImages(assets, readStorageFile);
		const prompt = buildPreviewDecisionPrompt(analysis.normalizedResult, currentPreviewConfig.contentLanguage);
		const result = await adapter.generateStructured({
			model,
			systemPrompt: "Return strict JSON only.",
			userPrompt: prompt,
			schema: previewDecisionSchema,
			images: planningReferenceImages,
			timeoutMs: 9e4,
			signal,
			monitor: {
				projectId,
				operation: "preview_count_planning"
			}
		});
		const current = readPreviewConfig(project.modelSnapshot);
		const decided = previewConfigSchema.parse({
			heroImageCount: result.parsed.heroImageCount,
			detailSectionCount: result.parsed.detailSectionCount,
			imageAspectRatio: current.imageAspectRatio,
			contentLanguage: current.contentLanguage
		});
		await repository.project.mergeModelSnapshot(projectId, {
			previewConfig: {
				heroImageCount: decided.heroImageCount,
				detailSectionCount: decided.detailSectionCount
			},
			previewConfigSource: "ai",
			previewConfigReason: result.parsed.reason
		});
		return {
			previewConfig: decided,
			reason: result.parsed.reason
		};
	}
	async function planSections(projectId, options) {
		const { project, analysis, assets } = await loadPlanningContext(projectId);
		if (!analysis) throw new Error("请先完成商品分析，再进行页面规划。");
		const { adapter, models } = await resolvePlanningAdapter(projectId, "section_planning");
		const model = pickMultimodalPlanningModel(models, options?.modelId);
		if (!model) throw new Error("当前没有可用的文案规划模型。");
		if (await tasks.findRecentRunningTask({
			projectId,
			taskType: "PLAN",
			maxAgeMinutes: 10
		})) throw new Error("当前页面规划仍在进行中，请等待这一轮完成后再试。");
		let previewConfig = options?.previewConfig != null ? previewConfigSchema.parse(options.previewConfig) : readPreviewConfig(project.modelSnapshot);
		let previewDecisionReason = "";
		const task = await tasks.createTask({
			projectId,
			taskType: "PLAN",
			inputPayload: {
				model,
				previewConfig,
				autoDecideCounts: Boolean(options?.autoDecideCounts)
			}
		});
		const taskSignal = tasks.registerTaskAbortController(task.id);
		try {
			if (options?.autoDecideCounts) {
				const decision = await decidePreviewConfigWithAi(projectId, model, taskSignal);
				previewConfig = decision.previewConfig;
				previewDecisionReason = decision.reason;
			} else await repository.project.mergeModelSnapshot(projectId, { previewConfig });
			const planningReferenceImages = await collectPlanningReferenceImages(assets, readStorageFile);
			const prompt = buildSectionPlanningPrompt(analysis.normalizedResult, project.style, project.platform, previewConfig.detailSectionCount, previewConfig.heroImageCount, previewConfig.contentLanguage);
			const result = await adapter.generateStructured({
				model,
				systemPrompt: "Return strict JSON only. sections must be complete.",
				userPrompt: prompt,
				schema: sectionPlanOutputSchema,
				images: planningReferenceImages,
				timeoutMs: 18e4,
				signal: taskSignal,
				monitor: {
					projectId,
					operation: "section_planning"
				}
			});
			await tasks.assertTaskNotCanceled(task.id);
			await repository.section.deleteAll(projectId);
			const rawSections = Array.isArray(result.parsed.sections) ? result.parsed.sections : [];
			const sections = rawSections.length > 0 ? buildNormalizedSections(rawSections, previewConfig.heroImageCount, previewConfig.detailSectionCount, analysis.normalizedResult) : buildFallbackPlanFromTemplates(previewConfig.heroImageCount, previewConfig.detailSectionCount, analysis.normalizedResult);
			const visualStyleGuide = resolvePlanningVisualStyleGuide({
				modelSnapshot: project.modelSnapshot,
				style: project.style,
				platform: project.platform,
				analysis
			}, result.parsed.visualStyleGuide);
			await repository.section.createMany(sections.map((section) => ({
				projectId,
				sectionKey: section.sectionKey,
				type: section.type,
				title: section.title,
				goal: section.goal,
				copy: section.copy,
				visualPrompt: section.visualPrompt,
				order: section.order,
				editableData: section.editableData
			})));
			await tasks.assertTaskNotCanceled(task.id);
			await repository.project.update(projectId, { status: "PLANNED" });
			await repository.project.mergeModelSnapshot(projectId, {
				planningModelId: model,
				previewConfigSource: options?.autoDecideCounts ? "ai" : "manual",
				previewConfigReason: previewDecisionReason,
				visualStyleGuide
			});
			const saved = await repository.section.list(projectId);
			await tasks.completeTask(task.id, {
				sections: saved,
				previewConfig,
				previewDecisionReason,
				visualStyleGuide
			});
			return {
				sections: saved,
				previewConfig,
				previewDecisionReason,
				visualStyleGuide
			};
		} catch (error) {
			if (error instanceof Error && error.message === "Task canceled.") throw error;
			if (shouldFallbackToTemplatePlan(error)) try {
				await tasks.assertTaskNotCanceled(task.id);
				await repository.section.deleteAll(projectId);
				const fallbackSections = buildFallbackPlanFromTemplates(previewConfig.heroImageCount, previewConfig.detailSectionCount, analysis.normalizedResult);
				await repository.section.createMany(fallbackSections.map((section) => ({
					projectId,
					sectionKey: section.sectionKey,
					type: section.type,
					title: section.title,
					goal: section.goal,
					copy: section.copy,
					visualPrompt: section.visualPrompt,
					order: section.order,
					editableData: section.editableData
				})));
				await tasks.assertTaskNotCanceled(task.id);
				const fallbackVisualStyleGuide = resolvePlanningVisualStyleGuide({
					modelSnapshot: project.modelSnapshot,
					style: project.style,
					platform: project.platform,
					analysis
				});
				await repository.project.update(projectId, { status: "PLANNED" });
				await repository.project.mergeModelSnapshot(projectId, {
					planningModelId: model,
					previewConfigSource: options?.autoDecideCounts ? "ai" : "manual",
					previewConfigReason: `${previewDecisionReason ? `${previewDecisionReason}；` : ""}AI 返回结构不完整，已自动切换为模板规划。`,
					visualStyleGuide: fallbackVisualStyleGuide
				});
				const saved = await repository.section.list(projectId);
				await tasks.completeTask(task.id, {
					sections: saved,
					previewConfig,
					previewDecisionReason,
					fallbackMode: "template_plan",
					visualStyleGuide: fallbackVisualStyleGuide
				});
				return {
					sections: saved,
					previewConfig,
					previewDecisionReason,
					fallbackMode: "template_plan",
					visualStyleGuide: fallbackVisualStyleGuide
				};
			} catch (fallbackError) {
				if (fallbackError instanceof Error && fallbackError.message === "Task canceled.") throw fallbackError;
				await tasks.failTask(task.id, "AI 规划结果格式不完整，且模板规划回退失败。");
				throw new Error("AI 规划结果格式不完整，请稍后重试。");
			}
			const message = error instanceof Error ? error.message.includes("timed out") ? "页面规划请求超时，请稍后重试，或在 AI 配置里改用更快的规划模型。" : error.message : "页面规划失败";
			await tasks.failTask(task.id, message);
			throw new Error(message);
		} finally {
			tasks.releaseTaskAbortController(task.id);
		}
	}
	async function regenerateVisualStyleGuide(projectId, preferredModelId) {
		const { project, analysis, assets } = await loadPlanningContext(projectId);
		if (!analysis) throw new Error("Please finish product analysis before generating the visual style guide.");
		const { adapter, models } = await resolvePlanningAdapter(projectId, "visual_style_guide_regenerate");
		const model = pickMultimodalPlanningModel(models, preferredModelId);
		if (!model) throw new Error("No available planning model is configured.");
		const previewConfig = readPreviewConfig(project.modelSnapshot);
		const planningReferenceImages = await collectPlanningReferenceImages(assets, readStorageFile);
		const prompt = buildVisualStyleGuidePrompt(analysis.normalizedResult, project.style, project.platform, previewConfig.contentLanguage);
		const visualStyleGuide = normalizeVisualStyleGuide((await adapter.generateStructured({
			model,
			systemPrompt: "Return strict JSON only.",
			userPrompt: prompt,
			schema: visualStyleGuideSchema,
			images: planningReferenceImages,
			timeoutMs: 12e4,
			monitor: {
				projectId,
				operation: "visual_style_guide_regenerate"
			}
		})).parsed, buildProjectVisualStyleGuideFallback({
			style: project.style,
			platform: project.platform,
			analysis
		}));
		return {
			visualStyleGuide,
			project: await repository.project.mergeModelSnapshot(projectId, {
				visualStyleGuide,
				visualStyleGuideModelId: model,
				visualStyleGuideUpdatedAt: (/* @__PURE__ */ new Date()).toISOString()
			})
		};
	}
	async function createSection(projectId, input) {
		await assertSectionMutationAllowed(projectId, { addingType: input.type });
		const count = (await repository.section.list(projectId)).length;
		const created = await repository.section.create({
			projectId,
			sectionKey: normalizeSectionType(input.type) === "HERO" ? `hero_${String(count + 1).padStart(2, "0")}` : `detail_${String(count + 1).padStart(2, "0")}_${nanoidLike(6)}`,
			type: normalizeSectionType(input.type),
			title: input.title,
			goal: input.goal,
			copy: input.copy,
			visualPrompt: ensureBilingualPrompt(input.visualPrompt, input.title),
			order: count,
			editableData: input.editableFields ?? {}
		});
		await normalizeProjectSections(projectId);
		return created;
	}
	async function updateSection(sectionId, input) {
		const current = await repository.section.get(sectionId);
		if (!current) throw new Error("Section not found.");
		if ("type" in input && typeof input.type === "string") await assertSectionMutationAllowed(current.projectId, {
			updatingSectionId: sectionId,
			nextType: input.type
		});
		const payload = { ...input };
		if ("visualPrompt" in payload && typeof payload.visualPrompt === "string") payload.visualPrompt = ensureBilingualPrompt(payload.visualPrompt, String(payload.title ?? "当前模块"));
		if ("type" in payload && typeof payload.type === "string") payload.type = normalizeSectionType(payload.type);
		const updated = await repository.section.update(sectionId, payload);
		await normalizeProjectSections(current.projectId);
		return updated;
	}
	async function deleteSection(sectionId) {
		const current = await repository.section.get(sectionId);
		if (!current) throw new Error("Section not found.");
		await assertSectionMutationAllowed(current.projectId, { deletingSectionId: sectionId });
		await repository.section.delete(sectionId);
		await normalizeProjectSections(current.projectId);
		return current;
	}
	async function reorderSections(projectId, orderedSectionIds) {
		for (const [index, sectionId] of orderedSectionIds.entries()) await repository.section.update(sectionId, { order: index });
		await normalizeProjectSections(projectId);
		return repository.section.list(projectId);
	}
	return {
		buildFallbackPlanFromTemplates,
		planSections,
		regenerateVisualStyleGuide,
		createSection,
		updateSection,
		deleteSection,
		reorderSections
	};
}
//#endregion
//#region src/core/ai/schemas/xiaohongshu.ts
const xiaohongshuPageSchema = z.object({
	pageNumber: z.coerce.number().int().min(1).default(1),
	title: z.string().default(""),
	subtitle: z.string().default(""),
	body: z.string().default(""),
	visualDirection: z.string().default(""),
	layout: z.string().default(""),
	imagePrompt: z.string().default(""),
	negativePrompt: z.string().default("")
});
const xiaohongshuPlanSchema = z.object({
	topic: z.string().default(""),
	audience: z.string().default(""),
	coreInsight: z.string().default(""),
	titleOptions: z.array(z.string()).default([]),
	coverTitle: z.string().default(""),
	coverSubtitle: z.string().default(""),
	pages: z.array(xiaohongshuPageSchema).default([]),
	caption: z.string().default(""),
	hashtags: z.array(z.string()).default([]),
	exportNote: z.string().default("")
});
//#endregion
//#region src/core/services/xiaohongshu-service.ts
const defaultImageAspectRatio = "3:4";
function normalizeImageCount(value) {
	const count = Number(value);
	return Number.isFinite(count) ? Math.min(8, Math.max(3, Math.round(count))) : 5;
}
function normalizeAspectRatio(value) {
	return value === "1:1" || value === "3:4" || value === "9:16" ? value : defaultImageAspectRatio;
}
function buildXiaohongshuPrompt(input) {
	const imageCount = normalizeImageCount(input.imageCount);
	const imageAspectRatio = normalizeAspectRatio(input.imageAspectRatio);
	return [
		`Return strict JSON only. Plan a ${imageCount}-page Xiaohongshu carousel in Simplified Chinese.`,
		"",
		"JSON shape:",
		"{ topic, audience, coreInsight, titleOptions, coverTitle, coverSubtitle, pages, caption, hashtags, exportNote }",
		`pages must contain exactly ${imageCount} items. Each page must include pageNumber, title, subtitle, body, visualDirection, layout, imagePrompt, negativePrompt.`,
		`The target image aspect ratio is ${imageAspectRatio}; every visualDirection, layout and imagePrompt must be designed for this ratio.`,
		"Each page must have a distinct visual role. Do not repeat the same imagePrompt across pages.",
		"imagePrompt should be detailed enough for later user editing: include subject, composition, scene, typography, colors, lighting and constraints in 220-450 Chinese characters.",
		"Mention concrete visual composition: subject, background, text position, color mood, props and safe margins.",
		"Add product/topic-specific physical constraints: correct airflow direction, cable routes, gravity, hinges, openings, liquid/light direction, support surfaces and contact shadows.",
		"Avoid medical/legal/financial guaranteed claims.",
		input.images?.length ? "Reference images are attached. Use them only to understand product/object/style and constraints." : "No reference image was uploaded.",
		"",
		`Topic: ${input.topic}`
	].join("\n");
}
function makeFallbackPage(index, topic, imageAspectRatio) {
	const templates = [
		{
			title: `${topic}，先看这一页`,
			subtitle: "封面钩子",
			body: "用一句强钩子说明这组图文能解决什么问题，让用户愿意继续滑动。",
			visualDirection: "主视觉封面，主体居中偏上，标题大而清晰，背景干净有质感。",
			layout: "顶部大标题，中部主体视觉，底部一句价值承诺。"
		},
		{
			title: "为什么你会遇到这个问题",
			subtitle: "痛点拆解",
			body: "点出用户常见误区和真实使用场景，建立共鸣。",
			visualDirection: "左右或上下对比画面，展示错误做法与正确方向，信息分区清楚。",
			layout: "上方标题，中部对比模块，下方短要点。"
		},
		{
			title: "核心方法拆成 3 步",
			subtitle: "实操方法",
			body: "把最重要的判断标准拆成 2-3 个短要点，方便收藏照做。",
			visualDirection: "步骤卡片式构图，使用数字标签和清晰图标感元素。",
			layout: "上标题，中部三步卡片，底部提醒。"
		},
		{
			title: "这样做更容易出效果",
			subtitle: "场景示范",
			body: "给出可以直接照着做的画面、动作或使用场景。",
			visualDirection: "真实生活场景示范，主体明确，背景辅助氛围但不抢焦点。",
			layout: "大图场景加浮层要点，保留足够留白。"
		},
		{
			title: "最后记住这几点",
			subtitle: "总结收藏",
			body: "收束为清晰结论，引导收藏、评论或行动。",
			visualDirection: "总结清单页，温和 CTA，整体干净适合收藏。",
			layout: "标题、清单、底部 CTA 三段式。"
		},
		{
			title: "细节别踩坑",
			subtitle: "避坑提醒",
			body: "列出最容易被忽略的 2-3 个细节，提醒用户检查。",
			visualDirection: "检查清单画面，重点错误项用轻量标记突出，不制造焦虑。",
			layout: "左侧视觉示意，右侧短句清单。"
		},
		{
			title: "适合谁，不适合谁",
			subtitle: "选择判断",
			body: "帮助用户判断自己是否适合这个方案，降低决策成本。",
			visualDirection: "人群/场景分栏图，表达适用边界，信息清晰不拥挤。",
			layout: "两栏判断卡片，底部一句建议。"
		},
		{
			title: "一页保存版",
			subtitle: "快速复盘",
			body: "把整组选题浓缩成一页保存清单，方便用户回看。",
			visualDirection: "保存版信息图，层级明确，重点句突出，背景简洁。",
			layout: "中心清单，周围少量辅助图形，底部收藏提示。"
		}
	];
	const template = templates[index] ?? templates[templates.length - 1];
	return {
		pageNumber: index + 1,
		title: template.title,
		subtitle: template.subtitle,
		body: template.body,
		visualDirection: `${imageAspectRatio} 小红书图文页。${template.visualDirection}`,
		layout: template.layout,
		imagePrompt: "",
		negativePrompt: "不要乱码，不要文字拥挤，不要主体变形，不要违反真实物理规律的画面。"
	};
}
/**
* The offline path: a complete, publishable plan built with zero provider
* calls. Exported (upstream kept it module-private) so a host can offer
* "plan without a key" explicitly instead of waiting for a timeout.
*/
function buildFallbackXiaohongshuPlan(topic, imageCount = 5, imageAspectRatio = defaultImageAspectRatio) {
	const normalizedCount = normalizeImageCount(imageCount);
	return normalizeXiaohongshuPlan({
		topic,
		audience: "对该选题感兴趣、希望快速获得实用建议的小红书用户",
		coreInsight: "用户需要一套清晰、可收藏、能快速照着执行的图文内容。",
		titleOptions: [
			`${topic}，这篇讲清楚`,
			`${topic}实用指南`,
			`别再乱做${topic}`
		],
		coverTitle: `${topic}，这篇讲清楚`,
		coverSubtitle: "一组可直接发布的小红书图文思路",
		pages: Array.from({ length: normalizedCount }, (_, index) => makeFallbackPage(index, topic, imageAspectRatio)),
		caption: `${topic}\n\n整理了一组可以直接参考的小红书图文思路，适合收藏后慢慢看。`,
		hashtags: [
			"#小红书图文",
			"#实用干货",
			"#内容规划",
			"#图文设计",
			"#AI创作"
		],
		exportNote: "Provider 超时或返回不稳定时自动生成的本地兜底规划。"
	}, topic, normalizedCount, imageAspectRatio);
}
function shouldUseLocalFallback(error) {
	if (!(error instanceof Error)) return false;
	return /timed out|timeout|aborterror|network error|fetch failed|structured parse|invalid json/i.test(error.message);
}
function normalizeXiaohongshuPlan(plan, topic, imageCount = 5, imageAspectRatio = defaultImageAspectRatio) {
	const targetCount = normalizeImageCount(imageCount);
	const normalizedTopic = plan.topic.trim() || topic;
	const sourcePages = Array.isArray(plan.pages) ? plan.pages.slice(0, targetCount) : [];
	while (sourcePages.length < targetCount) sourcePages.push(makeFallbackPage(sourcePages.length, normalizedTopic, imageAspectRatio));
	const pages = sourcePages.map((page, index) => {
		const fallback = makeFallbackPage(index, normalizedTopic, imageAspectRatio);
		const title = page.title.trim() || fallback.title;
		const body = page.body.trim() || fallback.body;
		const visualDirection = page.visualDirection.trim() || `${imageAspectRatio} 小红书图文页，主体清晰，中文标题居上，内容分区明确，留白充足。`;
		const layout = page.layout.trim() || fallback.layout;
		const negativePrompt = page.negativePrompt.trim() || "不要乱码、不要文字拥挤、不要不符合真实物理逻辑的画面。";
		return {
			...page,
			pageNumber: index + 1,
			title,
			subtitle: page.subtitle.trim(),
			body,
			visualDirection,
			layout,
			negativePrompt,
			imagePrompt: page.imagePrompt.trim() || [
				`小红书 ${imageAspectRatio} 图文第 ${index + 1} 页。`,
				`主题：${normalizedTopic}`,
				`标题：${title}`,
				page.subtitle ? `副标题：${page.subtitle}` : "",
				`正文要点：${body}`,
				`画面描述：${visualDirection}`,
				`版式：${layout}`,
				`避免：${negativePrompt}`
			].filter(Boolean).join("\n")
		};
	});
	const titleOptions = plan.titleOptions.map((item) => item.trim()).filter(Boolean).slice(0, 8);
	while (titleOptions.length < 3) titleOptions.push(`${normalizedTopic}，这篇讲清楚`, `${normalizedTopic}实用指南`, `别再乱做${normalizedTopic}`);
	const hashtags = plan.hashtags.map((item) => item.trim()).filter(Boolean).slice(0, 12);
	while (hashtags.length < 5) hashtags.push("#小红书图文", "#实用干货", "#内容规划", "#图文设计", "#AI创作");
	return {
		...plan,
		topic: normalizedTopic,
		audience: plan.audience.trim() || "对该选题感兴趣、希望快速获得实用建议的小红书用户",
		coreInsight: plan.coreInsight.trim() || "用户需要一套清晰、可执行、容易收藏的图文内容。",
		coverTitle: plan.coverTitle.trim() || titleOptions[0] || normalizedTopic,
		coverSubtitle: plan.coverSubtitle.trim(),
		titleOptions: [...new Set(titleOptions)].slice(0, 8),
		pages,
		caption: plan.caption.trim() || `${normalizedTopic}\n\n整理了一组可以直接参考的小红书图文思路，适合收藏后慢慢看。`,
		hashtags: [...new Set(hashtags)].slice(0, 12),
		exportNote: plan.exportNote.trim()
	};
}
/**
* THE data-URL producer of this service. A provider that answers with
* `b64_json` yields an inline `data:image/png;base64,...` payload (the MIME is
* hardcoded upstream — a provider returning JPEG bytes still gets labelled
* PNG); otherwise the provider's own URL is passed through untouched. Throws
* when neither is present, which is what the callers' per-model retry chain
* catches.
*/
function imageResultToUrl(result) {
	if (result.b64Json) return `data:image/png;base64,${result.b64Json}`;
	if (result.url) return result.url;
	throw new Error("图像模型没有返回可用图片。");
}
function unique(values) {
	return values.filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);
}
function readCapabilities(model) {
	return model.capabilities ?? {};
}
function getImageGenerationModels(provider) {
	return unique([
		provider.models.find((item) => item.isDefaultHeroImage)?.modelId,
		provider.models.find((item) => item.isDefaultDetailImage)?.modelId,
		provider.models.find((item) => readCapabilities(item).image_gen)?.modelId
	]);
}
function getImageEditModels(provider) {
	return unique([
		provider.models.find((item) => item.isDefaultImageEdit)?.modelId,
		provider.models.find((item) => readCapabilities(item).image_edit)?.modelId,
		provider.models.find((item) => item.isDefaultHeroImage)?.modelId
	]);
}
function buildPageImagePrompt(plan, page, imageAspectRatio) {
	return [
		page.imagePrompt.trim() || [
			`小红书 ${imageAspectRatio} 图文第 ${page.pageNumber} 页。`,
			`页面标题：${page.title}`,
			page.subtitle ? `副标题：${page.subtitle}` : "",
			`正文要点：${page.body}`,
			`画面描述：${page.visualDirection}`,
			`版式：${page.layout}`,
			page.negativePrompt ? `禁止：${page.negativePrompt}` : ""
		].filter(Boolean).join("\n"),
		"",
		`生成一张适合小红书图文轮播的 ${imageAspectRatio} 图片。`,
		"图内必须包含中文标题、核心短句和必要的信息层级，文字要清晰，不要乱码，不要挤压。",
		"整体要像真实可发布的小红书图文页，而不是网页截图或空白海报。",
		`整组内容主题：${plan.topic}`,
		`目标人群：${plan.audience}`,
		`核心洞察：${plan.coreInsight}`
	].join("\n");
}
async function runImageModel(models, runner, emptyMessage) {
	const errors = [];
	for (const model of models) try {
		return {
			model,
			result: await runner(model)
		};
	} catch (error) {
		errors.push(`${model}: ${error instanceof Error ? error.message : "未知错误"}`);
	}
	throw new Error(models.length === 0 ? emptyMessage : errors.join(" | "));
}
/**
* Xiaohongshu service factory. Uses only `host.provider` (and `host.logger` for
* adapter usage events) — `host.repository` and `host.storage` are deliberately
* untouched, because nothing on this path is persisted server-side.
*/
function createXiaohongshuService(host, deps = {}) {
	const buildVisualPrompt = deps.buildVisualPrompt ?? buildVisualPromptWithAgent;
	const createAdapter = deps.createAdapter ?? ((resolved) => new OpenAICompatibleAdapter(resolved.baseUrl, resolved.apiKey, host.logger));
	const now = deps.now ?? (() => /* @__PURE__ */ new Date());
	/**
	* Upstream's `getProviderAdapter()`: one resolution per entry point, reused
	* for the Visual Prompt Agent and the image call. Only `models` is handed on.
	*/
	async function resolveProviderAdapter(scope) {
		const resolved = await host.provider.resolve(scope);
		return {
			provider: { models: resolved.models },
			adapter: createAdapter(resolved)
		};
	}
	async function planXiaohongshuPost(input) {
		const topic = input.topic.trim();
		if (!topic) throw new Error("请输入小红书图文选题。");
		const imageCount = normalizeImageCount(input.imageCount);
		const imageAspectRatio = normalizeAspectRatio(input.imageAspectRatio);
		const { provider, adapter } = await resolveProviderAdapter({ operation: "xiaohongshu_planning" });
		const model = provider.models.find((item) => item.isDefaultPlanning)?.modelId ?? provider.models.find((item) => readCapabilities(item).structured_output)?.modelId ?? provider.models.find((item) => readCapabilities(item).text)?.modelId;
		if (!model) throw new Error("当前没有可用的小红书图文规划模型。");
		try {
			return normalizeXiaohongshuPlan((await adapter.generateStructured({
				model,
				systemPrompt: "Return strict JSON only.",
				userPrompt: buildXiaohongshuPrompt({
					...input,
					topic,
					imageCount,
					imageAspectRatio
				}),
				images: input.images?.slice(0, 2),
				schema: xiaohongshuPlanSchema,
				timeoutMs: 45e3,
				monitor: { operation: "xiaohongshu_planning" },
				signal: input.signal
			})).parsed, topic, imageCount, imageAspectRatio);
		} catch (error) {
			if (shouldUseLocalFallback(error)) return buildFallbackXiaohongshuPlan(topic, imageCount, imageAspectRatio);
			throw error;
		}
	}
	async function generateXiaohongshuImages(plan, referenceImages = [], options = {}) {
		const imageAspectRatio = normalizeAspectRatio(options.imageAspectRatio);
		const { provider, adapter } = await resolveProviderAdapter({ operation: "xiaohongshu_image_generate" });
		const models = getImageGenerationModels(provider);
		const pages = typeof options.pageNumber === "number" ? plan.pages.filter((page) => page.pageNumber === options.pageNumber) : plan.pages;
		if (pages.length === 0) throw new Error("没有找到要生成的小红书页面。");
		const images = [];
		for (const page of pages) {
			const basePrompt = buildPageImagePrompt(plan, page, imageAspectRatio);
			const prompt = await buildVisualPrompt({
				provider,
				adapter,
				mode: "xiaohongshu_page",
				title: page.title,
				goal: `为小红书选题“${plan.topic}”生成第 ${page.pageNumber} 页图文。`,
				copy: [
					page.subtitle,
					page.body,
					`整组洞察：${plan.coreInsight}`
				].filter(Boolean).join("\n"),
				basePrompt,
				aspectRatio: imageAspectRatio,
				contentLanguage: "zh-CN",
				referenceImages,
				productContext: {
					topic: plan.topic,
					audience: plan.audience,
					coreInsight: plan.coreInsight,
					coverTitle: plan.coverTitle,
					caption: plan.caption,
					hashtags: plan.hashtags,
					currentPage: page,
					imageAspectRatio
				},
				operation: "xiaohongshu_visual_prompt_agent_generate",
				signal: options.signal
			});
			const generated = await runImageModel(models, (model) => adapter.generateImage({
				model,
				prompt,
				aspectRatio: imageAspectRatio,
				referenceImages,
				timeoutMs: 12e4,
				monitor: { operation: "xiaohongshu_image_generate" },
				signal: options.signal
			}), "当前没有可用的小红书图像生成模型。");
			images.push({
				pageNumber: page.pageNumber,
				title: page.title,
				prompt,
				model: generated.model,
				imageUrl: imageResultToUrl(generated.result),
				revisedPrompt: generated.result.revisedPrompt ?? "",
				updatedAt: now().toISOString()
			});
		}
		return images;
	}
	async function editXiaohongshuImage(input) {
		const imageAspectRatio = normalizeAspectRatio(input.imageAspectRatio);
		const { provider, adapter } = await resolveProviderAdapter({ operation: "xiaohongshu_image_edit" });
		const models = getImageEditModels(provider);
		const basePrompt = [
			input.prompt,
			"",
			input.page ? `当前页标题：${input.page.title}` : "",
			input.page ? `当前页正文：${input.page.body}` : "",
			`保留原图的小红书 ${imageAspectRatio} 图文风格和主体结构，只修改用户指出的问题。`,
			"中文文字必须清晰，不要产生乱码，不要把文字压到边缘。"
		].filter(Boolean).join("\n");
		const prompt = await buildVisualPrompt({
			provider,
			adapter,
			mode: "image_edit",
			title: input.page?.title ?? "小红书图文单页修改",
			goal: "按用户修改意见精修当前小红书图文页，保留原图主体和整体风格。",
			copy: input.page?.body ?? "",
			basePrompt,
			aspectRatio: imageAspectRatio,
			contentLanguage: "zh-CN",
			referenceImages: [input.imageUrl],
			productContext: {
				page: input.page ?? null,
				userEditInstruction: input.prompt,
				imageAspectRatio
			},
			operation: "xiaohongshu_visual_prompt_agent_edit",
			signal: input.signal
		});
		const edited = await runImageModel(models, (model) => adapter.editImage({
			model,
			image: input.imageUrl,
			prompt,
			aspectRatio: imageAspectRatio,
			timeoutMs: 12e4,
			monitor: { operation: "xiaohongshu_image_edit" },
			signal: input.signal
		}), "当前没有可用的小红书图像编辑模型。");
		return {
			imageUrl: imageResultToUrl(edited.result),
			model: edited.model,
			revisedPrompt: edited.result.revisedPrompt ?? "",
			updatedAt: now().toISOString()
		};
	}
	return {
		planXiaohongshuPost,
		generateXiaohongshuImages,
		editXiaohongshuImage
	};
}
//#endregion
//#region src/util/redact.ts
function redactSecrets(text) {
	return text.replace(/\bsk-\S+/g, "[REDACTED]").replace(/Bearer\s+\S+/g, "Bearer [REDACTED]");
}
//#endregion
//#region src/host/logger.ts
/**
* Host implementation of the Logger port.
*
* Upstream's `logApiUsage` wrote into an 18 KB in-app HTTP ledger
* (`lib/monitor/api-usage.ts`) with request/response byte counts and a 23 KB
* admin page. A DSH plugin has no such surface, so usage events are appended to
* a JSONL file under the workspace (kept bounded) and mirrored to the plugin
* console at debug level.
*/
const MAX_LEDGER_BYTES = 2097152;
function fmt(prefix, message, meta) {
	return redactSecrets(`[mxpage] ${prefix}${message}${meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ""}`);
}
function createFileLogger(options = {}) {
	const ledgerPath = options.ledgerDir ? path.join(options.ledgerDir, "usage.jsonl") : null;
	let ledgerBroken = false;
	async function appendUsage(event) {
		if (!ledgerPath || ledgerBroken) return;
		try {
			await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
			const info = await fs.stat(ledgerPath).catch(() => null);
			if (info && info.size > MAX_LEDGER_BYTES) await fs.writeFile(ledgerPath, "", "utf8");
			const line = JSON.stringify({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				...event
			});
			await fs.appendFile(ledgerPath, `${redactSecrets(line)}\n`, "utf8");
		} catch {
			ledgerBroken = true;
		}
	}
	return {
		debug(message, meta) {
			if (options.verbose) console.debug(fmt("debug: ", message, meta));
		},
		info(message, meta) {
			console.log(fmt("", message, meta));
		},
		warn(message, meta) {
			console.warn(fmt("warn: ", message, meta));
		},
		error(message, meta) {
			console.error(fmt("error: ", message, meta));
		},
		usage(event) {
			if (options.verbose) console.debug(fmt("usage: ", `${event.method ?? "POST"} ${event.endpoint ?? "?"}`, {
				status: event.status,
				ok: event.ok,
				model: event.model,
				ms: event.durationMs,
				attempts: event.attemptCount
			}));
			appendUsage(event);
		}
	};
}
//#endregion
//#region src/core/ai/capability-detector.ts
const emptyCapabilityMap = () => ({
	text: false,
	vision: false,
	image_gen: false,
	image_edit: false,
	structured_output: false,
	fast: false,
	cheap: false,
	high_quality: false
});
const emptyRoleMap = () => ({
	analysis: false,
	planning: false,
	hero_image: false,
	detail_image: false,
	image_edit: false
});
function modelText(model) {
	if (typeof model === "string") return model.toLowerCase();
	return [
		model.id,
		model.label,
		model.type,
		model.category,
		...model.modalities ?? []
	].filter(Boolean).join(" ").toLowerCase();
}
function detectModelCapabilities(model) {
	const id = (typeof model === "string" ? model : model.id).toLowerCase();
	const text = modelText(model);
	const map = emptyCapabilityMap();
	const isGptImageModel = /(?:^|[-_\s])gpt[-_\s]?image(?:[-_\s]?(?:\d+(?:\.\d+)?|mini))?|chatgpt-image/.test(id);
	const isDallE2 = /dall[-_\s]?e[-_\s]?2/.test(id);
	const isImageTyped = /(^|\b)(image|images|image_generation|image-gen|image_gen)(\b|$)/.test(text);
	const isImageEditTyped = /(image_edit|image-edit|edit|edits|inpaint|mask|retouch)/.test(text);
	const isVisionTyped = /(vision|visual|multimodal|image_input|image-input)/.test(text);
	const isTextTyped = /(^|\b)(text|chat|llm|language|completion|completions)(\b|$)/.test(text);
	const isUtilityModel = /(embedding|embed|rerank|ranker|moderation|whisper|tts|speech|transcrib|audio|sora|video)/.test(id);
	if ((/(^|[-_])o[134](?:[-_]|$)|gpt|gemini|claude|qwen|qwq|qvq|glm|deepseek|chat|instruct|command|llama|mistral|mixtral|moonshot|kimi|yi-|ernie|hunyuan|spark|doubao|minimax|abab|grok|reka|cohere|sonar/.test(id) || isTextTyped) && !isUtilityModel && !isImageTyped) {
		map.text = true;
		map.structured_output = true;
	}
	if (/(vision|vl|4o|omni|gemini|multimodal|qwen-vl|qvq|pixtral|llava|visual|claude-3|claude-sonnet|claude-opus|gpt-4\.1|gpt-5)/.test(id) || isVisionTyped) {
		map.vision = true;
		map.text = true;
		map.structured_output = true;
	}
	if (/(image|imagen|flux|sdxl|stable-diffusion|stable.?image|banana|nano-banana|recraft|dall[-_ ]?e|seedream|jimeng|midjourney|mj-|ideogram|hidream|kolors|wanx|cogview|playground|leonardo)/.test(id) || isImageTyped) {
		map.image_gen = true;
		map.high_quality = true;
	}
	if (/(edit|inpaint|mask|kontext|retouch|erase|remove.?background)/.test(id) || isImageEditTyped) map.image_edit = true;
	if (isGptImageModel) {
		map.image_gen = true;
		map.image_edit = true;
		map.high_quality = true;
	}
	if (isDallE2) map.image_edit = true;
	if (/(flash|mini|nano|lite|turbo|instant)/.test(id)) {
		map.fast = true;
		map.cheap = true;
	}
	if (/(pro|ultra|4\\.1|opus|quality|max)/.test(id)) map.high_quality = true;
	if (!Object.values(map).some(Boolean) && !isUtilityModel) map.text = true;
	return map;
}
function detectModelRoles(capabilities) {
	const roles = emptyRoleMap();
	if (capabilities.text) {
		roles.analysis = true;
		roles.planning = true;
	}
	if (capabilities.image_gen) {
		roles.hero_image = true;
		roles.detail_image = true;
	}
	if (capabilities.image_edit) roles.image_edit = true;
	return roles;
}
function normalizeDetectedModels(models) {
	return models.map((model) => {
		const capabilities = detectModelCapabilities(model);
		return {
			modelId: model.id,
			label: model.label ?? model.id,
			capabilities,
			roles: detectModelRoles(capabilities),
			quality: capabilities.high_quality ? "high" : capabilities.fast ? "balanced" : "standard",
			latency: capabilities.fast ? "fast" : "standard",
			cost: capabilities.cheap ? "low" : capabilities.high_quality ? "high" : "medium",
			isAvailable: true
		};
	});
}
//#endregion
//#region src/core/ports/provider.ts
/** Thrown when no usable channel is configured. */
var ProviderUnavailableError = class extends Error {
	code = "MXPAGE_NO_IMAGE_KEY";
	constructor(message = "no provider channel configured") {
		super(message);
		this.name = "ProviderUnavailableError";
	}
};
//#endregion
//#region src/host/provider-resolver.ts
/**
* Host implementation of the ProviderResolver port.
*
* Maps the plugin's channel list onto `ResolvedProvider`, which is what
* `mxpage-core` needs: `{ baseUrl, apiKey, models[] }`.
*
* Why this is cheap: upstream MxPage keeps provider credentials in the browser
* (`localStorage` → `x-mxpage-api-key` header) and its server-side
* `ProviderConfig.apiKeyEncrypted` column is always `encryptSecret("")`.
* `getProviderAdapter()` *throws* without a request-scoped key. So there is no
* server-side key store to migrate — a channel list is a drop-in replacement.
*
* Model catalog: when a channel lists `models` explicitly they are used as-is;
* otherwise the catalog is discovered with `GET /models` and classified by name
* via `normalizeDetectedModels`. Upstream never probes real image endpoints
* ("已跳过…避免消耗图像额度"), so `real_image_gen` / `real_image_edit` stay
* undefined and a gateway that advertises an image model it cannot serve is
* discovered by failing. `discover: true` on a channel opts into one probe.
*/
const CATALOG_TTL_MS = 6e5;
function readChannelKey(channel) {
	if (channel.apiKeyEnv) {
		const fromEnv = process.env[channel.apiKeyEnv];
		if (fromEnv && fromEnv.trim()) return fromEnv.trim();
	}
	if (channel.apiKey && channel.apiKey.trim()) return channel.apiKey.trim();
	return "";
}
function explicitCatalog(channel) {
	return (channel.models ?? []).map((modelId) => {
		const [detected] = normalizeDetectedModels([{
			id: modelId,
			label: modelId
		}]);
		const looksLikeImage = detected.capabilities.image_gen || detected.capabilities.image_edit || /image|imagen|flux|banana|seedream|grok-imagine|dall|qwen-image|glm-image/i.test(modelId);
		return {
			modelId,
			label: modelId,
			capabilities: {
				...detected.capabilities,
				image_gen: looksLikeImage,
				image_edit: looksLikeImage
			},
			roles: detected.roles,
			isDefaultHeroImage: channel.imageModel ? channel.imageModel === modelId : void 0,
			isDefaultDetailImage: channel.imageModel ? channel.imageModel === modelId : void 0,
			isDefaultImageEdit: channel.imageModel ? channel.imageModel === modelId : void 0,
			isDefaultAnalysis: channel.textModel ? channel.textModel === modelId : void 0,
			isDefaultPlanning: channel.textModel ? channel.textModel === modelId : void 0
		};
	});
}
function createProviderResolver(options) {
	const { config } = options;
	const logger = options.logger ?? noopLogger;
	const catalogs = /* @__PURE__ */ new Map();
	function activeChannels() {
		return (config.channels ?? []).filter((channel) => !channel.disabled && !!channel.baseUrl?.trim());
	}
	async function catalogFor(channel) {
		if (channel.models?.length) return explicitCatalog(channel);
		const cached = catalogs.get(channel.id);
		if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.models;
		const apiKey = readChannelKey(channel);
		const adapter = new OpenAICompatibleAdapter(channel.baseUrl, apiKey, logger);
		try {
			const models = normalizeDetectedModels((await adapter.listModels()).map((item) => ({
				id: item.id,
				label: item.label,
				type: item.type ?? void 0,
				category: item.category ?? void 0,
				modalities: item.modalities ?? void 0
			}))).map((detected) => ({
				modelId: detected.modelId,
				label: detected.label,
				capabilities: detected.capabilities,
				roles: detected.roles,
				isDefaultHeroImage: channel.imageModel ? channel.imageModel === detected.modelId : void 0,
				isDefaultDetailImage: channel.imageModel ? channel.imageModel === detected.modelId : void 0,
				isDefaultImageEdit: channel.imageModel ? channel.imageModel === detected.modelId : void 0,
				isDefaultAnalysis: channel.textModel ? channel.textModel === detected.modelId : void 0,
				isDefaultPlanning: channel.textModel ? channel.textModel === detected.modelId : void 0
			}));
			catalogs.set(channel.id, {
				models,
				fetchedAt: Date.now()
			});
			logger.info("[mxpage] discovered model catalog", {
				channel: channel.id,
				count: models.length
			});
			return models;
		} catch (error) {
			logger.warn("[mxpage] model discovery failed; falling back to configured models", {
				channel: channel.id,
				error: error instanceof Error ? error.message : String(error)
			});
			catalogs.set(channel.id, {
				models: [],
				fetchedAt: Date.now() - CATALOG_TTL_MS + 6e4
			});
			return [];
		}
	}
	return { async resolve(scope) {
		const channels = activeChannels();
		if (channels.length === 0) throw new ProviderUnavailableError("未配置任何渠道。请在 设置 → 插件 → MxPage 中添加一个 OpenAI 兼容渠道（baseUrl + 密钥）。");
		const requested = scope?.channelId ? channels.find((channel) => channel.id === scope.channelId) : void 0;
		const ordered = requested ? [requested] : channels;
		let lastError = null;
		for (const channel of ordered) {
			const apiKey = readChannelKey(channel);
			if (!apiKey) {
				lastError = new ProviderUnavailableError(`渠道 ${channel.id} 未配置密钥（apiKeyEnv=${channel.apiKeyEnv ?? "(未设置)"}）。`);
				logger.warn("[mxpage] channel has no key, skipping", { channel: channel.id });
				continue;
			}
			const models = await catalogFor(channel);
			if (models.length === 0) {
				lastError = new ProviderUnavailableError(`渠道 ${channel.id} 没有可用模型（GET /models 失败且未显式配置 models）。`);
				continue;
			}
			return {
				id: channel.id,
				label: channel.label ?? channel.id,
				baseUrl: channel.baseUrl,
				apiKey,
				models
			};
		}
		throw lastError instanceof Error ? lastError : new ProviderUnavailableError("所有渠道都不可用。");
	} };
}
//#endregion
//#region src/host/repository.ts
/**
* Host implementation of the Repository port.
*
* Deliberately NOT Prisma. Upstream's schema is 7 models / 6 enums, and Prisma
* ships a query-engine binary that cannot be bundled into a DSH plugin (the
* upstream project itself had to `asarUnpack` it for Electron). A single
* atomically-written JSON document is equivalent at this scale and has zero
* native dependencies.
*
* The on-disk schema mirrors upstream's Prisma models 1:1 so a later migration
* to SQLite is mechanical.
*/
const DATE_FIELDS = [
	"createdAt",
	"updatedAt",
	"startedAt",
	"completedAt"
];
function revive(value) {
	if (Array.isArray(value)) return value.map(revive);
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, raw] of Object.entries(value)) out[key] = DATE_FIELDS.includes(key) && typeof raw === "string" ? new Date(raw) : revive(raw);
		return out;
	}
	return value;
}
function serialize(value) {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(serialize);
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, raw] of Object.entries(value)) out[key] = serialize(raw);
		return out;
	}
	return value;
}
function emptyDb() {
	return {
		version: 1,
		projects: [],
		assets: [],
		analyses: [],
		sections: [],
		versions: [],
		tasks: []
	};
}
const TERMINAL = [
	"SUCCESS",
	"FAILED",
	"CANCELED"
];
const isTerminal = (status) => TERMINAL.includes(status);
function createJsonRepository(options) {
	const file = path.resolve(options.file);
	let db = null;
	let writeChain = Promise.resolve();
	async function load() {
		if (db) return db;
		try {
			const raw = await fs.readFile(file, "utf8");
			const parsed = JSON.parse(raw);
			db = {
				...emptyDb(),
				...revive(parsed)
			};
		} catch {
			db = emptyDb();
		}
		return db;
	}
	/** Serialized, atomic: write a sibling temp file then rename over the target. */
	function persist() {
		writeChain = writeChain.then(async () => {
			if (!db) return;
			await fs.mkdir(path.dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(tmp, JSON.stringify(serialize(db), null, 2), "utf8");
			await fs.rename(tmp, file);
		});
		return writeChain;
	}
	const now = () => /* @__PURE__ */ new Date();
	function findProject(id) {
		return db.projects.find((item) => item.id === id);
	}
	const project = {
		async get(id) {
			await load();
			return findProject(id) ?? null;
		},
		async getDetail(id) {
			await load();
			const found = findProject(id);
			if (!found) return null;
			const sections = db.sections.filter((section) => section.projectId === id).sort((a, b) => a.order - b.order).map((section) => ({
				...section,
				versions: db.versions.filter((version) => version.sectionId === section.id).sort((a, b) => a.versionNumber - b.versionNumber)
			}));
			return {
				...found,
				assets: db.assets.filter((asset) => asset.projectId === id).sort((a, b) => a.sortOrder - b.sortOrder),
				analysis: db.analyses.find((item) => item.projectId === id) ?? null,
				sections
			};
		},
		async list(filter = {}) {
			await load();
			let items = db.projects.slice();
			if (!filter.includeSystem) items = items.filter((item) => item.platform !== SYSTEM_TASK_PLATFORM);
			if (filter.status) items = items.filter((item) => item.status === filter.status);
			items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
			return filter.limit ? items.slice(0, filter.limit) : items;
		},
		async create(input) {
			await load();
			const timestamp = now();
			const record = {
				id: `prj_${randomUUID()}`,
				name: input.name,
				status: "DRAFT",
				platform: input.platform,
				style: input.style,
				description: input.description ?? null,
				modelSnapshot: null,
				createdAt: timestamp,
				updatedAt: timestamp
			};
			db.projects.push(record);
			await persist();
			return record;
		},
		async update(id, patch) {
			await load();
			const record = findProject(id);
			if (!record) throw new Error(`project not found: ${id}`);
			if (patch.name !== void 0) record.name = patch.name;
			if (patch.status !== void 0) record.status = patch.status;
			if (patch.platform !== void 0) record.platform = patch.platform;
			if (patch.style !== void 0) record.style = patch.style;
			if (patch.description !== void 0) record.description = patch.description;
			if (patch.modelSnapshot !== void 0) record.modelSnapshot = patch.modelSnapshot;
			record.updatedAt = now();
			await persist();
			return record;
		},
		async delete(id) {
			await load();
			const sectionIds = db.sections.filter((section) => section.projectId === id).map((section) => section.id);
			db.projects = db.projects.filter((item) => item.id !== id);
			db.assets = db.assets.filter((item) => item.projectId !== id);
			db.analyses = db.analyses.filter((item) => item.projectId !== id);
			db.sections = db.sections.filter((item) => item.projectId !== id);
			db.versions = db.versions.filter((item) => !sectionIds.includes(item.sectionId));
			db.tasks = db.tasks.filter((item) => item.projectId !== id);
			await persist();
		},
		/**
		* Upstream's `patchProjectModelSnapshot` did a compare-and-swap loop over
		* `Project.updatedAt` to survive concurrent writers. Single-writer host, so
		* a plain shallow merge is sufficient.
		*/
		async mergeModelSnapshot(id, patch) {
			await load();
			const record = findProject(id);
			if (!record) throw new Error(`project not found: ${id}`);
			record.modelSnapshot = {
				...record.modelSnapshot ?? {},
				...patch
			};
			record.updatedAt = now();
			await persist();
			return record;
		},
		async findOrCreateSystemProject() {
			await load();
			const existing = db.projects.find((item) => item.platform === SYSTEM_TASK_PLATFORM);
			if (existing) return existing;
			const timestamp = now();
			const record = {
				id: `prj_${randomUUID()}`,
				name: "__mxpage_system_task__",
				status: "DRAFT",
				platform: SYSTEM_TASK_PLATFORM,
				style: "generic_clean",
				description: null,
				modelSnapshot: null,
				createdAt: timestamp,
				updatedAt: timestamp
			};
			db.projects.push(record);
			await persist();
			return record;
		}
	};
	const asset = {
		async create(input) {
			await load();
			const record = {
				id: `ast_${randomUUID()}`,
				projectId: input.projectId,
				sectionId: input.sectionId ?? null,
				type: input.type,
				filePath: input.filePath,
				fileName: input.fileName,
				mimeType: input.mimeType ?? null,
				sortOrder: input.sortOrder,
				metadata: input.metadata ?? null,
				isMain: input.isMain,
				createdAt: now()
			};
			db.assets.push(record);
			await persist();
			return record;
		},
		async get(id) {
			await load();
			return db.assets.find((item) => item.id === id) ?? null;
		},
		async list(filter) {
			await load();
			let items = db.assets.slice();
			if (filter.projectId) items = items.filter((item) => item.projectId === filter.projectId);
			if (filter.type) items = items.filter((item) => item.type === filter.type);
			if (filter.sectionId !== void 0) items = items.filter((item) => (item.sectionId ?? null) === filter.sectionId);
			items.sort((a, b) => a.sortOrder - b.sortOrder);
			return items;
		},
		async count(projectId) {
			await load();
			return db.assets.filter((item) => item.projectId === projectId).length;
		},
		async setMain(projectId, assetId) {
			await load();
			for (const item of db.assets) if (item.projectId === projectId) item.isMain = item.id === assetId;
			await persist();
		},
		async updateSortOrder(assetId, sortOrder) {
			await load();
			const record = db.assets.find((item) => item.id === assetId);
			if (!record) return;
			record.sortOrder = sortOrder;
			await persist();
		},
		async updateSectionId(assetId, sectionId) {
			await load();
			const record = db.assets.find((item) => item.id === assetId);
			if (!record) return;
			record.sectionId = sectionId;
			await persist();
		},
		async updateMetadata(assetId, metadata) {
			await load();
			const record = db.assets.find((item) => item.id === assetId);
			if (!record) return;
			record.metadata = {
				...record.metadata ?? {},
				...metadata
			};
			await persist();
		},
		async delete(id) {
			await load();
			db.assets = db.assets.filter((item) => item.id !== id);
			await persist();
		},
		async isReferenced(assetId) {
			await load();
			if (db.sections.some((section) => section.currentImageAssetId === assetId)) return true;
			return db.versions.some((version) => version.imageAssetId === assetId);
		}
	};
	const analysis = {
		async get(projectId) {
			await load();
			return db.analyses.find((item) => item.projectId === projectId) ?? null;
		},
		async upsert(projectId, data) {
			await load();
			const existing = db.analyses.find((item) => item.projectId === projectId);
			if (existing) {
				existing.rawResult = data.rawResult;
				existing.normalizedResult = data.normalizedResult;
				existing.updatedAt = now();
				await persist();
				return existing;
			}
			const timestamp = now();
			const record = {
				id: `ana_${randomUUID()}`,
				projectId,
				rawResult: data.rawResult,
				normalizedResult: data.normalizedResult,
				createdAt: timestamp,
				updatedAt: timestamp
			};
			db.analyses.push(record);
			await persist();
			return record;
		}
	};
	const section = {
		async get(id) {
			await load();
			return db.sections.find((item) => item.id === id) ?? null;
		},
		async getByKey(projectId, sectionKey) {
			await load();
			return db.sections.find((item) => item.projectId === projectId && item.sectionKey === sectionKey) ?? null;
		},
		async list(projectId) {
			await load();
			return db.sections.filter((item) => item.projectId === projectId).sort((a, b) => a.order - b.order);
		},
		async listWithVersions(projectId) {
			await load();
			return db.sections.filter((item) => item.projectId === projectId).sort((a, b) => a.order - b.order).map((item) => ({
				...item,
				versions: db.versions.filter((version) => version.sectionId === item.id).sort((a, b) => a.versionNumber - b.versionNumber)
			}));
		},
		async create(input) {
			await load();
			const timestamp = now();
			const record = {
				id: `sec_${randomUUID()}`,
				projectId: input.projectId,
				sectionKey: input.sectionKey,
				type: input.type,
				title: input.title,
				goal: input.goal,
				copy: input.copy,
				visualPrompt: input.visualPrompt,
				order: input.order,
				status: "IDLE",
				currentImageAssetId: null,
				editableData: input.editableData ?? null,
				createdAt: timestamp,
				updatedAt: timestamp
			};
			db.sections.push(record);
			await persist();
			return record;
		},
		async createMany(inputs) {
			await load();
			const created = [];
			for (const input of inputs) {
				const timestamp = now();
				const record = {
					id: `sec_${randomUUID()}`,
					projectId: input.projectId,
					sectionKey: input.sectionKey,
					type: input.type,
					title: input.title,
					goal: input.goal,
					copy: input.copy,
					visualPrompt: input.visualPrompt,
					order: input.order,
					status: "IDLE",
					currentImageAssetId: null,
					editableData: input.editableData ?? null,
					createdAt: timestamp,
					updatedAt: timestamp
				};
				db.sections.push(record);
				created.push(record);
			}
			await persist();
			return created;
		},
		async update(id, patch) {
			await load();
			const record = db.sections.find((item) => item.id === id);
			if (!record) throw new Error(`section not found: ${id}`);
			Object.assign(record, patch);
			record.updatedAt = now();
			await persist();
			return record;
		},
		async updateMany(ids, patch) {
			await load();
			for (const record of db.sections) {
				if (!ids.includes(record.id)) continue;
				Object.assign(record, patch);
				record.updatedAt = now();
			}
			await persist();
		},
		async delete(id) {
			await load();
			db.sections = db.sections.filter((item) => item.id !== id);
			db.versions = db.versions.filter((item) => item.sectionId !== id);
			await persist();
		},
		/** Upstream `planSections` wipes everything before re-planning. */
		async deleteAll(projectId) {
			await load();
			const doomed = db.sections.filter((item) => item.projectId === projectId).map((item) => item.id);
			db.sections = db.sections.filter((item) => item.projectId !== projectId);
			db.versions = db.versions.filter((item) => !doomed.includes(item.sectionId));
			await persist();
		},
		async reorder(projectId, orderedSectionIds) {
			await load();
			orderedSectionIds.forEach((id, index) => {
				const record = db.sections.find((item) => item.id === id && item.projectId === projectId);
				if (record) record.order = index;
			});
			await persist();
		}
	};
	const version = {
		async list(sectionId) {
			await load();
			return db.versions.filter((item) => item.sectionId === sectionId).sort((a, b) => a.versionNumber - b.versionNumber);
		},
		async get(id) {
			await load();
			return db.versions.find((item) => item.id === id) ?? null;
		},
		async nextVersionNumber(sectionId) {
			await load();
			const numbers = db.versions.filter((item) => item.sectionId === sectionId).map((item) => item.versionNumber);
			return numbers.length ? Math.max(...numbers) + 1 : 1;
		},
		async create(input) {
			await load();
			const versionNumber = input.versionNumber ?? await version.nextVersionNumber(input.sectionId);
			const record = {
				id: `ver_${randomUUID()}`,
				sectionId: input.sectionId,
				versionNumber,
				promptSnapshot: input.promptSnapshot ?? null,
				copySnapshot: input.copySnapshot ?? null,
				imageAssetId: input.imageAssetId ?? null,
				isActive: false,
				createdAt: now()
			};
			db.versions.push(record);
			await persist();
			return record;
		},
		async setActive(sectionId, versionId) {
			await load();
			let activated = null;
			for (const record of db.versions) {
				if (record.sectionId !== sectionId) continue;
				record.isActive = record.id === versionId;
				if (record.isActive) activated = record;
			}
			if (!activated) throw new Error(`version not found in section: ${versionId}`);
			await persist();
			return activated;
		}
	};
	return {
		project,
		asset,
		analysis,
		section,
		version,
		task: {
			async create(input) {
				await load();
				const timestamp = now();
				const status = input.status ?? "RUNNING";
				const record = {
					id: `tsk_${randomUUID()}`,
					projectId: input.projectId,
					sectionId: input.sectionId ?? null,
					taskType: input.taskType,
					status,
					inputPayload: input.inputPayload ?? null,
					outputPayload: input.outputPayload ?? null,
					errorMessage: null,
					startedAt: status === "RUNNING" ? timestamp : null,
					completedAt: null,
					createdAt: timestamp,
					updatedAt: timestamp
				};
				db.tasks.push(record);
				await persist();
				return record;
			},
			async get(id) {
				await load();
				return db.tasks.find((item) => item.id === id) ?? null;
			},
			async update(id, patch) {
				await load();
				const record = db.tasks.find((item) => item.id === id);
				if (!record) throw new Error(`task not found: ${id}`);
				if (patch.status !== void 0) record.status = patch.status;
				if (patch.inputPayload !== void 0) record.inputPayload = patch.inputPayload;
				if (patch.outputPayload !== void 0) record.outputPayload = patch.outputPayload;
				if (patch.errorMessage !== void 0) record.errorMessage = patch.errorMessage;
				if (patch.startedAt !== void 0) record.startedAt = patch.startedAt;
				if (patch.completedAt !== void 0) record.completedAt = patch.completedAt;
				record.updatedAt = now();
				await persist();
				return record;
			},
			/** Terminal-state sticky — upstream relies on this for correctness. */
			async mergeProgress(id, patch) {
				await load();
				const record = db.tasks.find((item) => item.id === id);
				if (!record || isTerminal(record.status)) return record ?? null;
				record.outputPayload = {
					...record.outputPayload ?? {},
					...patch
				};
				record.updatedAt = now();
				await persist();
				return record;
			},
			async list(projectId, limit) {
				await load();
				const items = db.tasks.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
				return limit ? items.slice(0, limit) : items;
			},
			async findRecentRunning(filter) {
				await load();
				const maxAgeMinutes = filter.maxAgeMinutes ?? 10;
				const startedAfter = Date.now() - maxAgeMinutes * 6e4;
				const types = Array.isArray(filter.taskType) ? filter.taskType : [filter.taskType];
				return db.tasks.filter((item) => item.projectId === filter.projectId && (item.sectionId ?? null) === (filter.sectionId ?? null) && types.includes(item.taskType) && item.status === "RUNNING" && !!item.startedAt && item.startedAt.getTime() >= startedAfter).sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0))[0] ?? null;
			},
			/**
			* Marks stale bulk GENERATE tasks FAILED. Never re-dispatches — upstream
			* only ever failed orphans after a restart.
			*/
			async recoverStale(projectId, staleMs) {
				await load();
				const cutoff = Date.now() - staleMs;
				const recovered = [];
				for (const record of db.tasks) {
					if (record.projectId !== projectId) continue;
					if (record.taskType !== "GENERATE" || record.sectionId !== null) continue;
					if (record.status !== "PENDING" && record.status !== "RUNNING") continue;
					if (record.updatedAt.getTime() > cutoff) continue;
					record.status = "FAILED";
					record.completedAt = now();
					record.errorMessage = "批量生成后台执行已中断，系统已结束遗留任务，请重新生成未完成模块。";
					record.updatedAt = now();
					recovered.push(record);
				}
				if (recovered.length) await persist();
				return recovered;
			}
		},
		async close() {
			await writeChain;
		}
	};
}
//#endregion
//#region src/host/storage-driver.ts
/**
* Host implementation of the StorageDriver port: a filesystem root under
* `$DSH_HOME/mxpage`, with `publicUrl()` returning `null` because a DSH plugin
* has no HTTP file route. Callers fall back to base64 attachments.
*/
function toAbsolute(root, relPath) {
	const normalized = normalizeRelPath(relPath);
	const absolute = path.resolve(root, normalized);
	const relative = path.relative(root, absolute);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`path escapes storage root: ${relPath}`);
	return absolute;
}
function createFileStorageDriver(rootDir) {
	const root = path.resolve(rootDir);
	return {
		rootDir: () => root,
		async read(relPath) {
			return fs.readFile(toAbsolute(root, relPath));
		},
		async write(relPath, data) {
			const absolute = toAbsolute(root, relPath);
			await fs.mkdir(path.dirname(absolute), { recursive: true });
			await fs.writeFile(absolute, data);
		},
		async stat(relPath) {
			try {
				const info = await fs.stat(toAbsolute(root, relPath));
				return {
					size: info.size,
					mtimeMs: info.mtimeMs
				};
			} catch {
				return null;
			}
		},
		async exists(relPath) {
			try {
				await fs.access(toAbsolute(root, relPath));
				return true;
			} catch {
				return false;
			}
		},
		async remove(relPath) {
			await fs.rm(toAbsolute(root, relPath), { force: true });
		},
		async removeDir(relDir) {
			await fs.rm(toAbsolute(root, relDir), {
				recursive: true,
				force: true
			});
		},
		async ensureDir(relDir) {
			await fs.mkdir(toAbsolute(root, relDir), { recursive: true });
		},
		async list(relDir) {
			const absolute = toAbsolute(root, relDir);
			if (!existsSync(absolute)) return [];
			const out = [];
			async function walk(dir) {
				for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name);
					if (entry.isDirectory()) await walk(full);
					else out.push(path.relative(root, full).split(path.sep).join("/"));
				}
			}
			await walk(absolute);
			return out.sort();
		},
		/** No HTTP file route inside a DSH plugin — attachments are the channel. */
		publicUrl() {
			return null;
		}
	};
}
//#endregion
//#region src/host/task-runner.ts
/**
* Host implementation of the TaskRunner port.
*
* Upstream's `runTaskInBackground` was `void handler().catch(console.error)`:
* no queue, no scheduler, no re-dispatch after restart, and a cancellation
* registry disabled in production. This runner is an in-process queue with a
* concurrency limit — the same shape `@dickpy/dsh-imagegen` uses for its
* `GenerationTaskQueue`, which is the established pattern for DSH plugins
* (there is no host job service to delegate to).
*
* Durability note: a plugin restart still orphans in-flight work, exactly as
* upstream. `repository.task.recoverStale` marks such rows FAILED; nothing
* re-dispatches them, matching upstream semantics.
*/
function createQueuedTaskRunner(options) {
	const { repository } = options;
	const concurrency = Math.max(1, options.concurrency ?? 2);
	const handles = /* @__PURE__ */ new Map();
	const entries = /* @__PURE__ */ new Map();
	const queue = [];
	let running = 0;
	async function execute(id, spec) {
		const entry = entries.get(id);
		if (!entry) return;
		try {
			const value = await spec.run({
				signal: entry.controller.signal,
				progress: { async patch(patch) {
					await repository.task.mergeProgress(id, patch).catch(() => null);
				} }
			});
			entry.resolve({
				ok: true,
				value
			});
		} catch (error) {
			entry.resolve({
				ok: false,
				error: error instanceof Error ? error : new Error(String(error))
			});
		} finally {
			entries.delete(id);
			handles.delete(id);
		}
	}
	function drain() {
		while (running < concurrency) {
			const next = queue.shift();
			if (!next) return;
			const handle = handles.get(next.id);
			if (!handle || handle.cancelled) continue;
			running += 1;
			execute(next.id, next.spec).finally(() => {
				running -= 1;
				drain();
			});
		}
	}
	return {
		start(spec) {
			const id = `${spec.kind}_${randomUUID().slice(0, 8)}`;
			const controller = new AbortController();
			let canceled = false;
			let resolveDone;
			const done = new Promise((resolve) => {
				resolveDone = resolve;
			});
			entries.set(id, {
				controller,
				resolve: resolveDone
			});
			const handle = {
				id,
				get cancelled() {
					return canceled;
				},
				cancel(reason) {
					if (canceled) return;
					canceled = true;
					controller.abort(new TaskCanceledError(reason));
					resolveDone({
						ok: false,
						error: new TaskCanceledError(reason)
					});
					entries.delete(id);
					handles.delete(id);
				},
				done
			};
			handles.set(id, handle);
			queue.push({
				id,
				spec
			});
			drain();
			return handle;
		},
		get(id) {
			return handles.get(id);
		}
	};
}
//#endregion
//#region src/host/index.ts
/**
* Host assembly: wires the five port implementations plus every core service
* into one runtime object.
*
* This is the ONLY place that knows about both `mxpage-core` and the DSH
* environment, which is what keeps `src/core/**` host-agnostic.
*/
/**
* Resolves the project root. Mirrors v0.1's layout (`$DSH_HOME/mxpage`) so
* existing work is picked up rather than orphaned.
*/
function resolveStoreRoot(config) {
	if (config.workspaceDir && config.workspaceDir.trim()) return config.workspaceDir.trim();
	return join(process.env.DSH_HOME ?? homedir(), "mxpage");
}
function createMxpageRuntime(config) {
	const storeRoot = resolveStoreRoot(config);
	const logger = createFileLogger({ ledgerDir: storeRoot });
	const repository = createJsonRepository({ file: join(storeRoot, "db.json") });
	const storage = createFileStorageDriver(storeRoot);
	const provider = createProviderResolver({
		config,
		logger
	});
	const runner = createQueuedTaskRunner({
		repository,
		concurrency: Math.max(1, config.maxParallelSections)
	});
	const host = {
		repository,
		storage,
		provider,
		logger,
		tasks: runner
	};
	const assets = createAssetStore(host);
	const tasks = createTaskService(host);
	return {
		host,
		storeRoot,
		assets,
		tasks,
		analysis: createAnalysisService(host, {
			taskService: tasks,
			assetStore: assets
		}),
		planner: createPlannerService(host, {
			tasks,
			assets
		}),
		generation: createGenerationService(host, {
			tasks,
			assets
		}),
		exportService: createExportService(host, {
			assetStore: assets,
			taskService: tasks
		}),
		xiaohongshu: createXiaohongshuService(host),
		runner,
		logger
	};
}
//#endregion
//#region src/tools/register.ts
/**
* DSH tool surface for MxPage.
*
* Every tool is a thin wrapper over `mxpage-core` services — no business logic
* lives here. Tool names are `mxpage_*` only; the plugin never registers
* `generate_image` / `edit_image`, because image channels are reached through
* the ProviderResolver port instead of competing with `dsh-imagegen`.
*
* Envelope convention (kept from the upstream tool contract):
*   - business failures → `{ ok: false, error: <CODE>, message? }` inside a
*     successful tool result
*   - infrastructure failures → `throw`
*/
const objectSchema = {
	type: "object",
	additionalProperties: true
};
function renderJson(_args, value) {
	return [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}];
}
/**
* Envelope helpers.
*
* `defineTool` constrains `execute` to resolve to `Record<string, JsonValue>`,
* but our services legitimately return domain objects (Dates, `unknown` JSON
* columns) that `render` serializes. Rather than sprinkle per-call casts, the
* helpers declare `never` so they satisfy any execute signature while still
* producing the correct runtime shape. The envelope contract is asserted by
* `assertEnvelope` in the test suite instead of by the compiler.
*/
function ok(data) {
	return {
		ok: true,
		...data
	};
}
/** Business failure. `message` is always present so the shape is index-safe. */
function fail(error, message = "") {
	return {
		ok: false,
		error,
		message
	};
}
/** Maps a thrown error onto the stable upstream error codes. */
function toFailure(error) {
	const message = redactSecrets(error instanceof Error ? error.message : String(error));
	return {
		ok: false,
		error: /429|rate limit|quota|insufficient_quota|额度|限流/i.test(message) ? "MXPAGE_HTTP_429" : /401|403|unauthorized|invalid token|api key|密钥|未配置/i.test(message) ? "MXPAGE_HTTP_401" : /400|unsupported|invalid_value|不支持/i.test(message) ? "MXPAGE_HTTP_400" : /cancel|取消/i.test(message) ? "MXPAGE_CANCELLED" : /not found|不存在/i.test(message) ? "MXPAGE_NOT_FOUND" : "MXPAGE_ERROR",
		message
	};
}
const SECTION_ROLES = [
	"main",
	"angle",
	"detail",
	"reference"
];
const ASPECT_ENUM = [
	"1:1",
	"3:4",
	"9:16"
];
/**
* Upstream's detail-page preview config only accepts the two vertical ratios
* (1:1 belongs to the square hero gallery), so the planning tool is narrower
* than the generation tools.
*/
const DETAIL_ASPECT_ENUM = ["3:4", "9:16"];
function registerMxpageTools(ctx, config, runtime) {
	const storeRoot = resolveStoreRoot(config);
	const { analysis, planner, generation, exportService, xiaohongshu, tasks, assets, host } = runtime;
	/** Reads a produced asset and hands its bytes to the host attachment store. */
	async function attachAsset(asset) {
		if (!ctx.attachments.saveImage) return void 0;
		const bytes = await assets.readStorageFile(asset.filePath);
		return ctx.attachments.saveImage({
			data: new Uint8Array(bytes),
			mediaType: asset.mimeType ?? "image/png",
			name: asset.fileName
		});
	}
	/**
	* Materializes a chat attachment (an image the user pasted into the
	* conversation) into bytes. Prefers the host path when the host exposes one,
	* otherwise reads through the attachment store.
	*/
	async function readAttachment(attachmentId, signal) {
		const id = attachmentId.trim();
		if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) throw new Error("invalid attachment id");
		const hostPath = ctx.attachments.imageHostPath?.({ attachmentId: id });
		if (hostPath) return {
			data: await readLocalFile(hostPath),
			fileName: basename(hostPath),
			mimeType: guessMime(hostPath)
		};
		if (ctx.attachments.readImage) {
			const stored = await ctx.attachments.readImage({ attachmentId: id }, signal);
			const fileName = stored.ref?.name ?? `${id}.png`;
			return {
				data: Buffer.from(stored.data),
				fileName,
				mimeType: stored.ref?.mediaType ?? guessMime(fileName)
			};
		}
		throw new Error("无法读取附件：宿主未提供 attachments.readImage 或 imageHostPath");
	}
	/** Normalizes the `image_paths` + `attachment_ids` pair into one source list. */
	async function collectSources(imagePaths, attachmentIds, signal) {
		const sources = [];
		for (const source of imagePaths ?? []) sources.push({
			data: await readLocalFile(source),
			fileName: basename(source),
			mimeType: guessMime(source)
		});
		for (const id of attachmentIds ?? []) sources.push(await readAttachment(id, signal));
		return sources;
	}
	const disposers = [];
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_create_project",
		description: "Create an MxPage ecommerce project from 1–10 product photos, supplied either as chat attachments (attachment_ids) or as workspace files (image_paths). Bytes are copied, never moved; the first image becomes the main reference. Returns the project id used by every other mxpage_* tool.",
		parameters: {
			name: {
				type: "string",
				description: "Project name. Defaults to untitled."
			},
			image_paths: {
				type: "array",
				items: { type: "string" },
				description: "Absolute paths to existing image files on this machine."
			},
			attachment_ids: {
				type: "array",
				items: { type: "string" },
				description: "Image attachment ids from the current conversation — the normal way to use a photo the user just pasted. Combined with image_paths, 1–10 total."
			},
			platform: {
				type: "string",
				description: "general_ecommerce | taobao_tmall | pinduoduo | xiaohongshu | douyin_ecommerce"
			},
			style: {
				type: "string",
				description: "generic_clean | premium | soft_lifestyle | conversion_focused | tech"
			},
			language: {
				type: "string",
				description: "In-image copy language, e.g. zh-CN | en-US | ja-JP | ko-KR"
			},
			aspect_ratio: {
				type: "string",
				enum: [...ASPECT_ENUM],
				description: "Detail-page aspect ratio. Defaults to 3:4."
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args, exec) {
			try {
				const sources = await collectSources(args.image_paths, args.attachment_ids, exec.signal);
				if (sources.length < 1 || sources.length > 10) return fail("MXPAGE_INPUT", "supply 1–10 product photos via image_paths and/or attachment_ids");
				const project = await host.repository.project.create({
					name: args.name ?? "untitled",
					platform: args.platform ?? config.defaultPlatform,
					style: args.style ?? config.defaultStyle
				});
				const stored = [];
				for (const [index, source] of sources.entries()) {
					const asset = await assets.saveUploadAsset({
						projectId: project.id,
						type: index === 0 ? "MAIN" : "REFERENCE",
						fileName: source.fileName,
						mimeType: source.mimeType,
						fileBuffer: source.data,
						sortOrder: index,
						isMain: index === 0
					});
					stored.push(asset.filePath);
				}
				await host.repository.project.mergeModelSnapshot(project.id, { previewConfig: {
					heroImageCount: config.defaultHeroCount,
					detailSectionCount: config.defaultDetailCount,
					imageAspectRatio: config.defaultDetailAspectRatio,
					contentLanguage: args.language ?? config.defaultLanguage
				} });
				return ok({
					projectId: project.id,
					assetCount: stored.length,
					mainAssetPath: stored[0],
					workspaceDir: storeRoot
				});
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_add_asset",
		description: "Append one product photo to an existing MxPage project, from a chat attachment or a workspace file. Pass role=main to make it the primary reference; the previous main becomes a reference. Max 10 assets per project.",
		parameters: {
			project_id: {
				type: "string",
				required: true
			},
			image_path: {
				type: "string",
				description: "Absolute path to an existing image file."
			},
			attachment_id: {
				type: "string",
				description: "Image attachment id from the current conversation. Supply this or image_path."
			},
			role: {
				type: "string",
				enum: [...SECTION_ROLES],
				description: "Defaults to reference."
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args, exec) {
			try {
				const projectId = args.project_id;
				const role = (args.role ?? "reference").toLowerCase();
				const count = await host.repository.asset.count(projectId);
				if (count >= 10) return fail("MXPAGE_INPUT", "max 10 assets per project");
				const imagePath = args.image_path;
				const attachmentId = args.attachment_id;
				if (!imagePath && !attachmentId) return fail("MXPAGE_INPUT", "supply image_path or attachment_id");
				const source = imagePath ? {
					data: await readLocalFile(imagePath),
					fileName: basename(imagePath),
					mimeType: guessMime(imagePath)
				} : await readAttachment(attachmentId, exec.signal);
				const asset = await assets.saveUploadAsset({
					projectId,
					type: role.toUpperCase(),
					fileName: source.fileName,
					mimeType: source.mimeType,
					fileBuffer: source.data,
					sortOrder: count,
					isMain: role === "main"
				});
				if (role === "main") await host.repository.asset.setMain(projectId, asset.id);
				return ok({
					projectId,
					assetId: asset.id,
					assetCount: count + 1
				});
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_project_status",
		description: "Read-only snapshot of an MxPage project: status, analysis presence, every section with its generation status and version count, plus any running task.",
		parameters: { project_id: {
			type: "string",
			required: true
		} },
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args) {
			try {
				const projectId = args.project_id;
				const detail = await host.repository.project.getDetail(projectId);
				if (!detail) return fail("MXPAGE_NOT_FOUND", `unknown project ${projectId}`);
				const recent = await host.repository.task.list(projectId, 5);
				return ok({
					projectId,
					name: detail.name,
					status: detail.status,
					assetCount: detail.assets.length,
					analyzed: !!detail.analysis,
					previewConfig: detail.modelSnapshot?.previewConfig ?? null,
					sections: detail.sections.map((section) => ({
						id: section.id,
						sectionKey: section.sectionKey,
						type: section.type,
						title: section.title,
						order: section.order,
						status: section.status,
						hasImage: !!section.currentImageAssetId,
						versionCount: section.versions.length
					})),
					runningTasks: recent.filter((task) => task.status === "RUNNING" || task.status === "PENDING").map((task) => ({
						id: task.id,
						taskType: task.taskType,
						status: task.status,
						progress: task.outputPayload ?? null
					}))
				});
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_analyze_product",
		description: "Vision analysis of a project's product photos: category, material, selling points, audience and a suggested section plan. Must run before mxpage_plan_page.",
		parameters: {
			project_id: {
				type: "string",
				required: true
			},
			model: {
				type: "string",
				description: "Override the analysis model id."
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args) {
			try {
				const result = await analysis.analyzeProject(args.project_id, args.model ?? null);
				return ok({
					projectId: args.project_id,
					analysis: result.normalizedResult
				});
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_plan_page",
		description: "Plan the detail page: one project-level visual style guide plus hero and detail sections, each with copy, a two-part visual prompt and negative constraints. WARNING: re-planning deletes all existing sections, versions and their images. Requires a prior mxpage_analyze_product.",
		parameters: {
			project_id: {
				type: "string",
				required: true
			},
			hero_count: {
				type: "integer",
				description: "1–5 hero images. Defaults to 3."
			},
			detail_count: {
				type: "integer",
				description: "1–10 detail sections. Defaults to 6."
			},
			aspect_ratio: {
				type: "string",
				enum: [...DETAIL_ASPECT_ENUM]
			},
			language: {
				type: "string",
				description: "In-image copy language."
			},
			auto_decide_counts: {
				type: "boolean",
				description: "Let the model choose hero/detail counts."
			},
			model: {
				type: "string",
				description: "Override the planning model id."
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args) {
			try {
				const projectId = args.project_id;
				const detail = await host.repository.project.getDetail(projectId);
				if (!detail) return fail("MXPAGE_NOT_FOUND", `unknown project ${projectId}`);
				if (!detail.analysis) return fail("MXPAGE_STATE", "run mxpage_analyze_product first");
				const result = await planner.planSections(projectId, {
					modelId: args.model ?? null,
					previewConfig: {
						heroImageCount: clamp(args.hero_count, 1, 5, config.defaultHeroCount),
						detailSectionCount: clamp(args.detail_count, 1, 10, config.defaultDetailCount),
						imageAspectRatio: args.aspect_ratio ?? config.defaultDetailAspectRatio,
						contentLanguage: args.language ?? config.defaultLanguage
					},
					autoDecideCounts: args.auto_decide_counts === true
				});
				return ok({
					projectId,
					visualStyleGuide: result.visualStyleGuide,
					previewConfig: result.previewConfig,
					fallbackMode: result.fallbackMode ?? null,
					sections: result.sections.map((section) => ({
						id: section.id,
						sectionKey: section.sectionKey,
						type: section.type,
						title: section.title,
						order: section.order
					}))
				});
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_generate_section",
		description: "Generate one section image. Runs the Visual Prompt Agent first unless prompt_override is given, then calls the image API with the main product photo (plus the first successful hero) as references. Creates a new version; never overwrites. Consumes paid image quota.",
		parameters: {
			project_id: {
				type: "string",
				required: true
			},
			section_id: {
				type: "string",
				required: true
			},
			prompt_override: {
				type: "string",
				description: "Skip the Visual Prompt Agent and use this prompt verbatim."
			},
			reference_asset_ids: {
				type: "array",
				items: { type: "string" },
				description: "Override the default reference assets."
			},
			model: {
				type: "string",
				description: "Override the image model id."
			},
			regenerate: {
				type: "boolean",
				description: "Use the regeneration variant (keeps product identity, improves quality)."
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args) {
			try {
				const projectId = args.project_id;
				const sectionId = args.section_id;
				const result = await (args.regenerate === true ? generation.regenerateSectionImage : generation.generateSectionImage)(projectId, sectionId, args.model ?? null, args.reference_asset_ids);
				const attachment = await attachAsset(result.imageAsset);
				return ok({
					projectId,
					sectionId,
					versionId: result.version.id,
					versionNumber: result.version.versionNumber,
					modelUsed: result.usedModel,
					generationMode: result.generationMode,
					outputPath: result.imageAsset.filePath,
					attachmentId: attachment?.attachmentId
				});
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_edit_section",
		description: "Edit an existing section image: repaint (new composition), enhance (same framing, better realism) or translate (re-letter every in-image word into the target language). Creates a new version; never overwrites.",
		parameters: {
			project_id: {
				type: "string",
				required: true
			},
			section_id: {
				type: "string",
				required: true
			},
			mode: {
				type: "string",
				enum: [
					"repaint",
					"enhance",
					"translate"
				],
				required: true
			},
			instruction: {
				type: "string",
				description: "Extra direction for repaint/enhance."
			},
			target_language: {
				type: "string",
				description: "Required when mode=translate."
			},
			model: {
				type: "string",
				description: "Override the image model id."
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args) {
			try {
				const editMode = args.mode;
				if (editMode === "translate" && !args.target_language) return fail("MXPAGE_MISSING_LANGUAGE", "target_language is required when mode=translate");
				const result = await generation.editSectionImage(args.project_id, args.section_id, {
					preferredModelId: args.model ?? null,
					editMode,
					targetLanguage: args.target_language
				});
				const attachment = await attachAsset(result.imageAsset);
				return ok({
					projectId: args.project_id,
					sectionId: args.section_id,
					editMode: result.editMode,
					versionId: result.version.id,
					modelUsed: result.usedModel,
					outputPath: result.imageAsset.filePath,
					attachmentId: attachment?.attachmentId
				});
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_generate_page",
		description: "Generate the whole page in the background: hero sections first, then detail sections. Returns a job id immediately — poll with mxpage_job_status. Each image consumes paid image API quota, so confirm with the user before starting a full page.",
		parameters: {
			project_id: {
				type: "string",
				required: true
			},
			section_ids: {
				type: "array",
				items: { type: "string" },
				description: "Subset to generate. Defaults to every section without an image."
			},
			mode: {
				type: "string",
				enum: ["missing", "all"],
				description: "missing (default) skips sections that already have an image."
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args, exec) {
			try {
				const projectId = args.project_id;
				const mode = args.mode ?? "missing";
				let sectionIds = args.section_ids;
				if (!sectionIds?.length) sectionIds = (await host.repository.section.list(projectId)).filter((section) => mode === "all" ? true : !section.currentImageAssetId).sort((a, b) => a.order - b.order).map((section) => section.id);
				if (sectionIds.length === 0) return fail("MXPAGE_STATE", "nothing to generate");
				if (exec.signal?.aborted) return fail("MXPAGE_CANCELLED", "canceled before start");
				const total = sectionIds.length;
				return ok({
					kind: "background",
					jobId: runtime.runner.start({
						kind: "mxpage_page",
						label: `Generate ${total} section(s)`,
						owner: projectId,
						async run(runCtx) {
							let done = 0;
							for (const sectionId of sectionIds) {
								if (runCtx.signal.aborted) break;
								await runCtx.progress.patch({
									currentSectionId: sectionId,
									completedItems: done,
									totalItems: total,
									heartbeatAt: (/* @__PURE__ */ new Date()).toISOString()
								});
								await generation.generateSectionImage(projectId, sectionId);
								done += 1;
							}
							return {
								projectId,
								completed: done,
								total
							};
						}
					}).id,
					total
				});
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_job_status",
		description: "Check a background page-generation job started by mxpage_generate_page.",
		parameters: { job_id: {
			type: "string",
			required: true
		} },
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args) {
			const jobId = args.job_id;
			const handle = runtime.runner.get?.(jobId);
			if (handle) return ok({
				jobId,
				state: handle.cancelled ? "stopping" : "running"
			});
			const persisted = await host.repository.task.get(jobId);
			if (!persisted) return fail("MXPAGE_NOT_FOUND", `unknown job ${jobId}`);
			return ok({
				jobId,
				state: persisted.status.toLowerCase(),
				progress: persisted.outputPayload ?? null,
				error: persisted.errorMessage ?? null
			});
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_job_cancel",
		description: "Cancel a running mxpage_generate_page job. Sections already generated stay on disk.",
		parameters: { job_id: {
			type: "string",
			required: true
		} },
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args) {
			const jobId = args.job_id;
			const handle = runtime.runner.get?.(jobId);
			if (handle) {
				handle.cancel("canceled by tool");
				return ok({
					jobId,
					cancelled: true
				});
			}
			const persisted = await host.repository.task.get(jobId);
			if (persisted && (persisted.status === "RUNNING" || persisted.status === "PENDING")) {
				await tasks.cancelTask(jobId);
				return ok({
					jobId,
					cancelled: true
				});
			}
			return fail("MXPAGE_NOT_FOUND", `no running job ${jobId}`);
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_export_page",
		description: "Export a project as a ZIP (00-头图/ + 01-详情页/ + export-manifest.json) or as raw project JSON.",
		parameters: {
			project_id: {
				type: "string",
				required: true
			},
			format: {
				type: "string",
				enum: ["zip", "json"],
				description: "Defaults to zip."
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args) {
			try {
				const projectId = args.project_id;
				if ((args.format ?? "zip") === "json") {
					const detail = await host.repository.project.getDetail(projectId);
					if (!detail) return fail("MXPAGE_NOT_FOUND", `unknown project ${projectId}`);
					return ok({
						projectId,
						format: "json",
						project: detail
					});
				}
				return ok({
					projectId,
					format: "zip",
					archive: await exportService.buildImageArchive(projectId)
				});
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_xiaohongshu_plan",
		description: "Step 1 of the Xiaohongshu carousel flow: plan N pages (title, body copy, per-page image prompt) from a topic. Falls back to a fully local Chinese template plan when the model is unavailable.",
		parameters: {
			topic: {
				type: "string",
				required: true,
				description: "Post topic or product angle."
			},
			image_count: {
				type: "integer",
				description: "3–8 pages. Defaults to 5."
			},
			aspect_ratio: {
				type: "string",
				enum: [...ASPECT_ENUM],
				description: "Defaults to 3:4."
			},
			reference_image_paths: {
				type: "array",
				items: { type: "string" },
				description: "Up to 4 reference images by absolute path."
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args, exec) {
			try {
				const paths = args.reference_image_paths ?? [];
				const images = [];
				for (const source of paths.slice(0, 4)) {
					const buffer = await readLocalFile(source);
					images.push(`data:${guessMime(source)};base64,${buffer.toString("base64")}`);
				}
				return ok({ plan: await xiaohongshu.planXiaohongshuPost({
					topic: args.topic,
					imageCount: clamp(args.image_count, 3, 8, 5),
					imageAspectRatio: args.aspect_ratio ?? "3:4",
					images,
					signal: exec.signal
				}) });
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_xiaohongshu_generate",
		description: "Step 3 of the Xiaohongshu flow: generate every carousel image from a plan produced by mxpage_xiaohongshu_plan. Each page runs the Visual Prompt Agent first. Returns one image per page.",
		parameters: {
			plan_json: {
				type: "string",
				required: true,
				description: "The `plan` object from mxpage_xiaohongshu_plan, JSON-encoded."
			},
			aspect_ratio: {
				type: "string",
				enum: [...ASPECT_ENUM]
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args, exec) {
			try {
				const plan = JSON.parse(args.plan_json);
				return ok({ pages: (await xiaohongshu.generateXiaohongshuImages(plan, void 0, {
					imageAspectRatio: args.aspect_ratio ?? void 0,
					signal: exec.signal
				})).map((page) => ({
					pageNumber: page.pageNumber,
					title: page.title,
					model: page.model,
					revisedPrompt: page.revisedPrompt,
					imageUrl: page.imageUrl
				})) });
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_xiaohongshu_edit",
		description: "Step 4 of the Xiaohongshu flow: edit one carousel image (re-letter, restyle, fix details) while keeping the rest of the composition.",
		parameters: {
			image_url: {
				type: "string",
				required: true,
				description: "A data URL or provider URL returned by mxpage_xiaohongshu_generate."
			},
			prompt: {
				type: "string",
				required: true,
				description: "What to change."
			},
			aspect_ratio: {
				type: "string",
				enum: [...ASPECT_ENUM]
			}
		},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute(args, exec) {
			try {
				return ok({ edited: await xiaohongshu.editXiaohongshuImage({
					imageUrl: args.image_url,
					prompt: args.prompt,
					imageAspectRatio: args.aspect_ratio ?? void 0,
					signal: exec.signal
				}) });
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "mxpage_channels",
		description: "Diagnose the MxPage channel configuration: which channel is active, its model catalog, and whether any image-capable model was found. Use this first when generation fails.",
		parameters: {},
		output: {
			schema: objectSchema,
			render: renderJson
		},
		async execute() {
			try {
				const resolved = await host.provider.resolve({ operation: "diagnostics" });
				const imageModels = resolved.models.filter((model) => model.capabilities.image_gen || model.capabilities.image_edit);
				const visionModels = resolved.models.filter((model) => model.capabilities.vision);
				return ok({
					channel: {
						id: resolved.id,
						label: resolved.label,
						baseUrl: resolved.baseUrl
					},
					modelCount: resolved.models.length,
					imageModels: imageModels.map((model) => model.modelId),
					visionModels: visionModels.map((model) => model.modelId),
					storeRoot,
					warning: imageModels.length === 0 ? "No image-capable model found. Capability is inferred from the model name because upstream skips real endpoint probing to avoid burning image quota, so a gateway that lists a model it cannot serve is discovered only by failing." : null
				});
			} catch (error) {
				return toFailure(error);
			}
		}
	})));
	return disposers;
}
function clamp(value, min, max, fallback) {
	if (typeof value !== "number" || Number.isNaN(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}
function basename(filePath) {
	const parts = filePath.split(/[\\/]/);
	return parts[parts.length - 1] || "image.png";
}
function guessMime(filePath) {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return "image/png";
}
async function readLocalFile(filePath) {
	const { readFile } = await import("node:fs/promises");
	return readFile(filePath);
}
//#endregion
//#region src/index.ts
const name = "mxpage";
/**
* Host services this plugin needs. Verified against a working plugin
* (`@dickpy/dsh-imagegen`, which does `ctx.inject(['tools','attachments','commands'], …)`):
* `tools` and `attachments` are real service names.
*
* `jobs` is deliberately absent — `@deepseek-ai/dsh-jobs` is not a real package.
* Background work is owned by the plugin's own queued TaskRunner, exactly as
* `dsh-imagegen` owns its in-process `GenerationTaskQueue`.
*/
const inject = ["tools", "attachments"];
function apply(ctx, config) {
	const runtime = createMxpageRuntime(config);
	ctx.inject(["tools", "attachments"], (tctx) => {
		tctx.effect(() => {
			const disposers = registerMxpageTools(tctx, config, runtime);
			return () => {
				for (const dispose of disposers) try {
					dispose?.();
				} catch {}
			};
		});
	});
}
//#endregion
export { Config, apply, inject, name };
