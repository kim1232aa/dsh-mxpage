import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/config.ts
const Config = Schema.object({
	imageBaseUrl: Schema.string().default("https://api.openai.com/v1").description("图像 API 根路径，需含 /v1"),
	imageApiKeyEnv: Schema.string().default("MXPAGE_IMAGE_API_KEY").description("图像 API Key 所在环境变量名，不写明文 key"),
	imageModel: Schema.string().default("gpt-image-2").description("默认图像模型"),
	textBaseUrl: Schema.string().description("可选：独立文本/视觉端点。空则优先 ctx.llm"),
	textApiKeyEnv: Schema.string(),
	textModel: Schema.string(),
	workspaceDir: Schema.string().description("项目根。空则 $DSH_HOME/mxpage/projects"),
	defaultLanguage: Schema.union([
		"zh-CN",
		"en",
		"ja",
		"ko"
	]).default("zh-CN"),
	defaultHeroCount: Schema.number().default(3),
	defaultDetailCount: Schema.number().default(6),
	defaultDetailAspectRatio: Schema.union(["3:4", "9:16"]).default("3:4"),
	timeoutMs: Schema.number().default(18e4),
	analyzeTimeoutMs: Schema.number().default(12e4),
	maxReferenceImages: Schema.number().default(4),
	maxParallelSections: Schema.number().default(2),
	generateAsJob: Schema.boolean().default(true),
	allowSvgFallback: Schema.boolean().default(false)
});
//#endregion
//#region src/util/paths.ts
function assertInside(root, target) {
	const resolvedRoot = resolve(root);
	const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(resolvedRoot, target);
	const rel = relative(resolvedRoot, resolvedTarget);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes project root: ${target}`);
	return resolvedTarget;
}
//#endregion
//#region src/service/state-machine.ts
const TRANSITIONS = {
	created: ["analyzing", "failed"],
	analyzing: ["analyzed", "failed"],
	analyzed: ["planning", "failed"],
	planning: ["planned", "failed"],
	planned: [
		"generating",
		"editing",
		"failed"
	],
	generating: ["generated", "failed"],
	generated: [
		"editing",
		"generating",
		"failed"
	],
	editing: ["generated", "failed"],
	failed: [
		"analyzing",
		"planning",
		"generating",
		"editing"
	]
};
function assertTransition(from, to) {
	if (!TRANSITIONS[from]?.includes(to)) throw new Error(`illegal status transition: ${from} → ${to}`);
	return to;
}
//#endregion
//#region src/service/project-store.ts
const MAX_ASSETS = 10;
function assertExistingFile(path) {
	if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`image file not found: ${path}`);
}
function uniqueBasename(dir, name) {
	const ext = extname(name);
	const stem = basename(name, ext);
	let candidate = name;
	let n = 1;
	while (existsSync(join(dir, candidate))) {
		candidate = `${stem}-${n}${ext}`;
		n += 1;
	}
	return candidate;
}
function createStore(rootDir) {
	function projectDir(projectId) {
		return assertInside(rootDir, join(rootDir, "projects", projectId));
	}
	function persist(record) {
		const dir = projectDir(record.id);
		const file = assertInside(dir, join(dir, "project.json"));
		writeFileSync(file, JSON.stringify(record, null, 2));
	}
	function copyIntoAssets(dir, absImagePath) {
		assertExistingFile(absImagePath);
		const assetsDir = join(dir, "assets");
		mkdirSync(assetsDir, { recursive: true });
		const dest = assertInside(dir, join(assetsDir, uniqueBasename(assetsDir, basename(absImagePath))));
		copyFileSync(absImagePath, dest);
		return dest;
	}
	function read(projectId) {
		const dir = projectDir(projectId);
		const file = assertInside(dir, join(dir, "project.json"));
		if (!existsSync(file)) throw new Error(`project not found: ${projectId}`);
		return JSON.parse(readFileSync(file, "utf8"));
	}
	function create(input) {
		const imagePaths = input.imagePaths;
		if (!Array.isArray(imagePaths) || imagePaths.length < 1 || imagePaths.length > MAX_ASSETS) throw new Error("imagePaths required (1–10 existing files)");
		for (const src of imagePaths) assertExistingFile(src);
		const mainSrc = resolve(input.mainImagePath ?? imagePaths[0]);
		if (!imagePaths.some((src) => resolve(src) === mainSrc)) throw new Error("mainImagePath is not in imagePaths");
		const id = `mxp_${randomUUID()}`;
		const dir = projectDir(id);
		const assets = [];
		let mainAssetPath = "";
		for (const src of imagePaths) {
			const dest = copyIntoAssets(dir, src);
			const role = resolve(src) === mainSrc ? "main" : "reference";
			assets.push({
				path: dest,
				role
			});
			if (role === "main") mainAssetPath = dest;
		}
		const record = {
			id,
			name: input.name ?? "untitled",
			status: "created",
			language: input.language ?? "zh-CN",
			aspectRatio: input.aspectRatio ?? "3:4",
			mainAssetPath,
			assets,
			workspaceDir: dir
		};
		persist(record);
		return record;
	}
	function addAsset(projectId, absImagePath, role) {
		const rec = read(projectId);
		if (rec.assets.length >= MAX_ASSETS) throw new Error("max 10 assets");
		const dest = copyIntoAssets(projectDir(projectId), absImagePath);
		if (role === "main") {
			for (const asset of rec.assets) if (asset.role === "main") asset.role = "reference";
			rec.mainAssetPath = dest;
		}
		rec.assets.push({
			path: dest,
			role
		});
		persist(rec);
		return rec;
	}
	function write(projectId, patch) {
		const current = read(projectId);
		if (patch.status !== void 0) assertTransition(current.status, patch.status);
		const next = {
			...current,
			...patch,
			id: current.id
		};
		persist(next);
		return next;
	}
	return {
		create,
		addAsset,
		read,
		write,
		projectDir
	};
}
//#endregion
//#region src/util/redact.ts
function redactSecrets(text) {
	return text.replace(/\bsk-\S+/g, "[REDACTED]").replace(/Bearer\s+\S+/g, "Bearer [REDACTED]");
}
//#endregion
//#region src/tools/add-asset.ts
const ROLES = [
	"main",
	"angle",
	"detail",
	"reference"
];
function addAssetTool(opts) {
	return defineTool({
		name: "mxpage_add_asset",
		description: "Add a product or reference image to an existing mxpage project. Pass image_path. Replacing the main image requires role=main. P1 does not read attachment_id.",
		parameters: {
			project_id: {
				type: "string",
				required: true,
				description: "Existing mxpage project id"
			},
			image_path: {
				type: "string",
				description: "Workspace-relative or absolute image path to copy"
			},
			attachment_id: {
				type: "string",
				description: "Unused in P1; pass image_path instead"
			},
			role: {
				type: "string",
				enum: ROLES,
				required: true,
				description: "Asset role. Use main only when replacing the anchoring product photo."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args) => {
			if (!args.image_path) {
				if (args.attachment_id) return {
					ok: false,
					error: "请提供 image_path（P1 暂不从附件读取）"
				};
				return {
					ok: false,
					error: redactSecrets("请提供 image_path")
				};
			}
			const abs = assertInside(opts.storeRoot, args.image_path);
			const record = opts.store.addAsset(args.project_id, abs, args.role);
			return {
				ok: true,
				projectId: record.id,
				assetCount: record.assets.length,
				mainAssetPath: record.mainAssetPath
			};
		}
	});
}
//#endregion
//#region src/tools/create-project.ts
const LANGUAGES = [
	"zh-CN",
	"en",
	"ja",
	"ko"
];
const ASPECT_RATIOS = [
	"1:1",
	"3:4",
	"9:16"
];
function createProjectTool(opts) {
	return defineTool({
		name: "mxpage_create_project",
		description: "Create an mxpage project and copy product photos into assets/ (does not move sources). Call this before generate_section. image_paths are workspace-relative or absolute, 1–10 files.",
		parameters: {
			name: {
				type: "string",
				description: "Project display name; default untitled"
			},
			image_paths: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Product image paths (1–10). Copied into the project; sources are left in place."
			},
			main_image_path: {
				type: "string",
				description: "Main product image; default first image_paths entry"
			},
			language: {
				type: "string",
				enum: LANGUAGES,
				description: "Content language"
			},
			aspect_ratio: {
				type: "string",
				enum: ASPECT_RATIOS,
				description: "Default detail aspect ratio"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args) => {
			const imagePaths = args.image_paths.map((path) => assertInside(opts.storeRoot, path));
			const mainImagePath = args.main_image_path === void 0 ? void 0 : assertInside(opts.storeRoot, args.main_image_path);
			const record = opts.store.create({
				name: args.name,
				imagePaths,
				mainImagePath,
				language: args.language ?? opts.config.defaultLanguage,
				aspectRatio: args.aspect_ratio
			});
			return {
				ok: true,
				projectId: record.id,
				assetCount: record.assets.length,
				mainAssetPath: record.mainAssetPath,
				workspaceDir: record.workspaceDir
			};
		}
	});
}
function fail$1(message) {
	throw new Error(redactSecrets(message));
}
function readU32BE(bytes, offset) {
	return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}
function parsePngSize(bytes) {
	if (bytes.length < 24) return null;
	const sig = [
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	];
	for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
	if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return null;
	return {
		width: readU32BE(bytes, 16),
		height: readU32BE(bytes, 20)
	};
}
function parseJpegSize(bytes) {
	if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
	let i = 2;
	while (i < bytes.length - 8) {
		if (bytes[i] !== 255) {
			i += 1;
			continue;
		}
		const marker = bytes[i + 1];
		if (marker === 255) {
			i += 1;
			continue;
		}
		if (marker >= 192 && marker <= 195 || marker >= 197 && marker <= 199 || marker >= 201 && marker <= 203 || marker >= 205 && marker <= 207) {
			const height = bytes[i + 5] << 8 | bytes[i + 6];
			return {
				width: bytes[i + 7] << 8 | bytes[i + 8],
				height
			};
		}
		if (marker === 216 || marker === 217 || marker === 1 || marker >= 208 && marker <= 215) {
			i += 2;
			continue;
		}
		if (i + 3 >= bytes.length) return null;
		const length = bytes[i + 2] << 8 | bytes[i + 3];
		if (length < 2) return null;
		i += 2 + length;
	}
	return null;
}
function readImageFile(absPath) {
	if (statSync(absPath).size > 20971520) fail$1("image exceeds 20MiB");
	const bytes = new Uint8Array(readFileSync(absPath));
	if (bytes.byteLength > 20971520) fail$1("image exceeds 20MiB");
	const png = parsePngSize(bytes);
	if (png) {
		if (png.width > 8192 || png.height > 8192) fail$1("image edge exceeds 8192");
		return {
			bytes,
			mediaType: "image/png"
		};
	}
	const jpeg = parseJpegSize(bytes);
	if (jpeg) {
		if (jpeg.width > 8192 || jpeg.height > 8192) fail$1("image edge exceeds 8192");
		return {
			bytes,
			mediaType: "image/jpeg"
		};
	}
	fail$1("unsupported image format");
}
//#endregion
//#region src/pipeline/generate.ts
const MISSING_PROMPT = "missing prompt; call mxpage_refine_prompt or pass prompt_override";
function fail(error) {
	return {
		ok: false,
		error: redactSecrets(error)
	};
}
function readPromptFile(projectDir, sectionKey) {
	const file = assertInside(projectDir, join(projectDir, "prompts", `${sectionKey}.json`));
	if (!existsSync(file)) return void 0;
	try {
		const data = JSON.parse(readFileSync(file, "utf8"));
		if (typeof data.finalPrompt === "string" && data.finalPrompt.trim()) return data.finalPrompt;
		if (typeof data.prompt === "string" && data.prompt.trim()) return data.prompt;
	} catch {
		return;
	}
}
function resolvePrompt(projectDir, sectionKey, promptOverride) {
	if (promptOverride !== void 0 && promptOverride.trim() !== "") return promptOverride;
	return readPromptFile(projectDir, sectionKey);
}
function latestVersionId(projectDir, sectionKey) {
	const dir = join(projectDir, "versions", sectionKey);
	if (!existsSync(dir)) return void 0;
	let max = 0;
	for (const name of readdirSync(dir)) {
		const match = /^v(\d+)\.png$/.exec(name);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max > 0 ? `v${max}` : void 0;
}
function nextVersionId(projectDir, sectionKey) {
	const current = latestVersionId(projectDir, sectionKey);
	if (!current) return "v1";
	return `v${Number(current.slice(1)) + 1}`;
}
function listOutputSections(projectDir) {
	const outputDir = join(projectDir, "output");
	if (!existsSync(outputDir)) return [];
	return readdirSync(outputDir).filter((name) => name.endsWith(".png")).sort().map((name) => {
		const key = name.slice(0, -4);
		return {
			key,
			outputPath: join(outputDir, name),
			versionId: latestVersionId(projectDir, key)
		};
	});
}
function firstHeroOutput(projectDir) {
	const outputDir = join(projectDir, "output");
	if (!existsSync(outputDir)) return void 0;
	const first = readdirSync(outputDir).filter((name) => /^hero_.*\.png$/i.test(name)).sort()[0];
	return first ? join(outputDir, first) : void 0;
}
function defaultReferencePaths(record, max) {
	const paths = [];
	if (record.mainAssetPath) paths.push(record.mainAssetPath);
	const hero = firstHeroOutput(record.workspaceDir);
	if (hero && !paths.includes(hero)) paths.push(hero);
	return paths.slice(0, max);
}
function toBlob$1(absPath) {
	const { bytes, mediaType } = readImageFile(absPath);
	return {
		bytes,
		mediaType,
		filename: basename(absPath)
	};
}
function loadReferences(storeRoot, record, config, referencePaths) {
	return (referencePaths !== void 0 ? referencePaths.map((path) => assertInside(storeRoot, path)) : defaultReferencePaths(record, config.maxReferenceImages)).slice(0, config.maxReferenceImages).filter((path) => existsSync(path)).map(toBlob$1);
}
async function generateSection(deps, args, signal) {
	const record = deps.store.read(args.projectId);
	const prompt = resolvePrompt(record.workspaceDir, args.sectionKey, args.promptOverride);
	if (!prompt) return fail(MISSING_PROMPT);
	const model = args.model ?? deps.config.imageModel;
	const size = args.size ?? "1024x1024";
	const references = loadReferences(deps.storeRoot, record, deps.config, args.referencePaths);
	const generated = await deps.images.generate({
		prompt,
		size,
		model,
		references,
		signal
	});
	if (signal.aborted) throw new Error("已取消");
	const projectDir = record.workspaceDir;
	const versionId = nextVersionId(projectDir, args.sectionKey);
	const outputDir = assertInside(projectDir, join(projectDir, "output"));
	const versionDir = assertInside(projectDir, join(projectDir, "versions", args.sectionKey));
	mkdirSync(outputDir, { recursive: true });
	mkdirSync(versionDir, { recursive: true });
	const outputPath = assertInside(projectDir, join(outputDir, `${args.sectionKey}.png`));
	const versionPath = assertInside(projectDir, join(versionDir, `${versionId}.png`));
	const buf = Buffer.from(generated.bytes);
	writeFileSync(outputPath, buf);
	writeFileSync(versionPath, buf);
	const ref = await deps.saveImage({
		data: generated.bytes,
		mediaType: "image/png",
		name: `${args.sectionKey}.png`
	});
	return {
		ok: true,
		projectId: record.id,
		sectionKey: args.sectionKey,
		outputPath,
		attachmentId: ref.attachmentId,
		modelUsed: model,
		versionId
	};
}
//#endregion
//#region src/provider/openai-images.ts
function mapImageError(status, body) {
	if (status === 401) return {
		ok: false,
		error: "图像 API 密钥无效或未配置"
	};
	if (status === 429) return {
		ok: false,
		error: "额度或速率限制"
	};
	if (status === 400 && /model/i.test(body)) return {
		ok: false,
		error: "模型不支持"
	};
	const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
	return {
		ok: false,
		error: redactSecrets(`图像 API 请求失败 (${status})${snippet ? `: ${snippet}` : ""}`)
	};
}
function throwRedacted(message) {
	throw new Error(redactSecrets(message));
}
function throwMapped(status, body) {
	throwRedacted(mapImageError(status, body).error);
}
function throwCancelled() {
	throw new Error("已取消");
}
function isAbort(err, signal) {
	if (signal.aborted) return true;
	return Boolean(err && typeof err === "object" && "name" in err && err.name === "AbortError");
}
function endpoint(baseUrl, path) {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
function toBlob(image) {
	const copy = new Uint8Array(image.bytes.byteLength);
	copy.set(image.bytes);
	return new Blob([copy], { type: image.mediaType || "application/octet-stream" });
}
function appendImage(form, image) {
	form.append("image", toBlob(image), image.filename);
}
function parsePngResult(payload) {
	const b64 = payload?.data?.[0]?.b64_json;
	if (!b64) throwRedacted("图像 API 返回空数据");
	return {
		bytes: new Uint8Array(Buffer.from(b64, "base64")),
		mediaType: "image/png"
	};
}
function editForm(prompt, model, size, images) {
	const form = new FormData();
	form.append("prompt", prompt);
	form.append("model", model);
	form.append("size", size);
	for (const image of images) appendImage(form, image);
	return form;
}
function createImagesClient(opts) {
	const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
	async function request(path, init, signal) {
		if (signal.aborted) throwCancelled();
		let res;
		try {
			res = await fetchFn(endpoint(opts.baseUrl, path), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${opts.apiKey}`,
					...init.headers
				},
				body: init.body,
				signal
			});
		} catch (err) {
			if (isAbort(err, signal)) throwCancelled();
			throwRedacted(err instanceof Error ? err.message : String(err));
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throwMapped(res.status, body);
		}
		let payload;
		try {
			payload = await res.json();
		} catch (err) {
			if (isAbort(err, signal)) throwCancelled();
			throwRedacted(err instanceof Error ? err.message : "图像 API 响应无效");
		}
		return parsePngResult(payload);
	}
	return {
		generate(input) {
			if (input.references.length > 0) return request("/images/edits", { body: editForm(input.prompt, input.model, input.size, input.references) }, input.signal);
			return request("/images/generations", {
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: input.model,
					prompt: input.prompt,
					size: input.size
				})
			}, input.signal);
		},
		edit(input) {
			return request("/images/edits", { body: editForm(input.prompt, input.model, input.size, [input.image, ...input.references]) }, input.signal);
		}
	};
}
//#endregion
//#region src/tools/generate-section.ts
const SIZES = ["1024x1024", "1024x1536"];
const MISSING_KEY = "未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）";
function generateSectionTool(opts) {
	return defineTool({
		name: "mxpage_generate_section",
		description: "Generate one page section image (e.g. hero_01). Pass prompt_override in P1, or refine_prompt first so prompts/<sectionKey>.json exists. Writes output/<sectionKey>.png and returns attachmentId. Default size 1024x1024; default references are the main asset plus the first hero output.",
		parameters: {
			project_id: {
				type: "string",
				required: true,
				description: "Existing mxpage project id"
			},
			section_key: {
				type: "string",
				required: true,
				description: "e.g. hero_01"
			},
			prompt_override: {
				type: "string",
				description: "skip VPA"
			},
			reference_paths: {
				type: "array",
				items: { type: "string" },
				description: "Extra reference images; default main asset + first hero output"
			},
			size: {
				type: "string",
				enum: SIZES,
				description: "Output size; default 1024x1024"
			},
			model: {
				type: "string",
				description: "Image model override"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		timeoutMs: 18e4,
		isConcurrencySafe: () => false,
		execute: async (args, exec) => {
			const images = resolveImages(opts.config, opts.images);
			if (images === void 0) return {
				ok: false,
				error: MISSING_KEY
			};
			return generateSection({
				store: opts.store,
				storeRoot: opts.storeRoot,
				config: opts.config,
				images,
				saveImage: opts.saveImage
			}, {
				projectId: args.project_id,
				sectionKey: args.section_key,
				promptOverride: args.prompt_override,
				referencePaths: args.reference_paths,
				size: args.size,
				model: args.model
			}, exec.signal);
		}
	});
}
function resolveImages(config, injected) {
	if (injected) return injected;
	const apiKey = process.env[config.imageApiKeyEnv];
	if (!apiKey) return void 0;
	return createImagesClient({
		baseUrl: config.imageBaseUrl,
		apiKey
	});
}
//#endregion
//#region src/tools/project-status.ts
function projectStatusTool(opts) {
	return defineTool({
		name: "mxpage_project_status",
		description: "Read-only mxpage project status. Safe to call at status=created, before analyze. Returns assets and generated sections (key, outputPath, versionId).",
		parameters: { project_id: {
			type: "string",
			required: true,
			description: "Existing mxpage project id"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args) => {
			const record = opts.store.read(args.project_id);
			return {
				ok: true,
				status: record.status,
				language: record.language,
				aspectRatio: record.aspectRatio,
				mainAssetPath: record.mainAssetPath,
				assets: record.assets,
				sections: listOutputSections(record.workspaceDir)
			};
		}
	});
}
//#endregion
//#region src/tools/register.ts
function resolveStoreRoot(config) {
	if (config.workspaceDir) return config.workspaceDir;
	return join(process.env.DSH_HOME ?? homedir(), "mxpage");
}
function registerMxpageTools(ctx, config, deps) {
	const storeRoot = resolveStoreRoot(config);
	const store = createStore(storeRoot);
	ctx.tools.register(createProjectTool({
		store,
		storeRoot,
		config
	}));
	ctx.tools.register(addAssetTool({
		store,
		storeRoot
	}));
	ctx.tools.register(projectStatusTool({ store }));
	ctx.tools.register(generateSectionTool({
		store,
		storeRoot,
		config,
		saveImage: (input) => ctx.attachments.saveImage(input),
		images: deps?.images
	}));
}
//#endregion
//#region src/index.ts
const name = "mxpage";
const inject = [
	"tools",
	"attachments",
	"jobs"
];
function apply(ctx, config) {
	registerMxpageTools(ctx, config);
}
//#endregion
export { Config, apply, inject, name };
