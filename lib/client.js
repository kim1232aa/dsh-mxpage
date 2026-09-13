window.__ModuleLoader__.load({
	id: "dsh-mxpage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// The web shell has no Node `process` global; the bundled react-dom
		// development branch checks read process.env.NODE_ENV. Shim it so the
		// factory never throws "process is not defined" in the browser.
		var process = { env: { NODE_ENV: "production" } };
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
		//#endregion
		let react = require("react");
		//#endregion
		//#region src/shared/routes.ts
		var import_client = (/* @__PURE__ */ __commonJSMin(((exports) => {
			var m = require("react-dom");
			if (process.env.NODE_ENV === "production") {
				exports.createRoot = m.createRoot;
				exports.hydrateRoot = m.hydrateRoot;
			} else {
				var i = m.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
				exports.createRoot = function(c, o) {
					i.usingClientEntryPoint = true;
					try {
						return m.createRoot(c, o);
					} finally {
						i.usingClientEntryPoint = false;
					}
				};
				exports.hydrateRoot = function(c, h, o) {
					i.usingClientEntryPoint = true;
					try {
						return m.hydrateRoot(c, h, o);
					} finally {
						i.usingClientEntryPoint = false;
					}
				};
			}
		})))();
		/**
		* Route paths shared by the host (`src/host/routes.ts`) and the browser panel
		* (`src/client/api.ts`).
		*
		* Kept dependency-free on purpose: importing these constants from the host
		* module would drag `node:http` and the DSH webserver types into the browser
		* bundle.
		*/
		const API_PREFIX = "/api/dsh-mxpage";
		const ROUTES = {
			projects: `${API_PREFIX}/projects`,
			projectCreate: `${API_PREFIX}/projects/create`,
			project: `${API_PREFIX}/project`,
			upload: `${API_PREFIX}/upload`,
			analyze: `${API_PREFIX}/analyze`,
			plan: `${API_PREFIX}/plan`,
			styleGuide: `${API_PREFIX}/style-guide`,
			section: `${API_PREFIX}/section`,
			sectionCreate: `${API_PREFIX}/section/create`,
			sectionDelete: `${API_PREFIX}/section/delete`,
			reorder: `${API_PREFIX}/reorder`,
			generate: `${API_PREFIX}/generate`,
			edit: `${API_PREFIX}/edit`,
			generatePage: `${API_PREFIX}/generate-page`,
			job: `${API_PREFIX}/job`,
			jobCancel: `${API_PREFIX}/job/cancel`,
			versions: `${API_PREFIX}/versions`,
			versionActivate: `${API_PREFIX}/versions/activate`,
			export: `${API_PREFIX}/export`,
			image: `${API_PREFIX}/image`,
			channels: `${API_PREFIX}/channels`,
			xhsPlan: `${API_PREFIX}/xiaohongshu/plan`,
			xhsGenerate: `${API_PREFIX}/xiaohongshu/generate`,
			xhsEdit: `${API_PREFIX}/xiaohongshu/edit`
		};
		//#endregion
		//#region src/client/api.ts
		/**
		* Browser-half data entry point.
		*
		* Thin fetch wrappers over the host routes registered in `src/host/routes.ts`.
		* Every response carries the `{ ok, ... }` envelope; `readEnvelope` unwraps it
		* and turns failures into an `MxpageApiError` carrying the host's stable code.
		*/
		var MxpageApiError = class extends Error {
			code;
			constructor(message, code) {
				super(message);
				this.name = "MxpageApiError";
				this.code = code;
			}
		};
		async function readEnvelope(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				throw new MxpageApiError(`HTTP ${response.status}: invalid JSON response`, "bad-response");
			}
			if (body === null || typeof body !== "object") throw new MxpageApiError(`HTTP ${response.status}: malformed response`, "bad-response");
			const record = body;
			if (record.ok !== true) throw new MxpageApiError(typeof record.message === "string" ? record.message : `HTTP ${response.status}`, typeof record.code === "string" ? record.code : "mxpage-error");
			return body;
		}
		async function post(path, body = {}) {
			return readEnvelope(await fetch(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				cache: "no-store"
			}));
		}
		async function get(path, params = {}) {
			const search = new URLSearchParams(params).toString();
			return readEnvelope(await fetch(search ? `${path}?${search}` : path, {
				method: "GET",
				cache: "no-store"
			}));
		}
		/** Reads a browser File as bare base64 (no data-URL prefix). */
		function fileToBase64(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					resolve(String(reader.result ?? "").replace(/^data:[^;]+;base64,/, ""));
				};
				reader.onerror = () => reject(reader.error ?? /* @__PURE__ */ new Error("failed to read file"));
				reader.readAsDataURL(file);
			});
		}
		var MxpageApi = class {
			listProjects() {
				return post(ROUTES.projects);
			}
			/**
			* Create a project and upload its product photos in one call. Reads the files
			* in the browser and posts them as base64, matching the host's JSON-only
			* transport (there is no multipart route).
			*/
			async createProjectWithUpload(name, files, options = {}) {
				const payload = await Promise.all(files.map(async (file) => ({
					fileName: file.name,
					mimeType: file.type || "image/png",
					base64Data: await fileToBase64(file)
				})));
				return post(ROUTES.projectCreate, {
					name,
					files: payload,
					...options
				});
			}
			getProject(id) {
				return get(ROUTES.project, { id });
			}
			upload(input) {
				return post(ROUTES.upload, input);
			}
			analyze(projectId, model) {
				return post(ROUTES.analyze, {
					projectId,
					model
				});
			}
			plan(projectId, previewConfig, options = {}) {
				return post(ROUTES.plan, {
					projectId,
					previewConfig,
					...options
				});
			}
			regenerateStyleGuide(projectId, model) {
				return post(ROUTES.styleGuide, {
					projectId,
					model
				});
			}
			updateSection(sectionId, patch) {
				return post(ROUTES.section, {
					sectionId,
					patch
				});
			}
			createSection(projectId, input) {
				return post(ROUTES.sectionCreate, {
					projectId,
					...input
				});
			}
			deleteSection(sectionId) {
				return post(ROUTES.sectionDelete, { sectionId });
			}
			reorder(projectId, orderedSectionIds) {
				return post(ROUTES.reorder, {
					projectId,
					orderedSectionIds
				});
			}
			generateSection(projectId, sectionId, options = {}) {
				return post(ROUTES.generate, {
					projectId,
					sectionId,
					...options
				});
			}
			editSection(projectId, sectionId, editMode, extra = {}) {
				return post(ROUTES.edit, {
					projectId,
					sectionId,
					editMode,
					...extra
				});
			}
			generatePage(projectId, mode) {
				return post(ROUTES.generatePage, {
					projectId,
					mode
				});
			}
			jobStatus(jobId) {
				return get(ROUTES.job, { id: jobId });
			}
			cancelJob(jobId) {
				return post(ROUTES.jobCancel, { jobId });
			}
			listVersions(sectionId) {
				return get(ROUTES.versions, { sectionId });
			}
			activateVersion(sectionId, versionId) {
				return post(ROUTES.versionActivate, {
					sectionId,
					versionId
				});
			}
			exportProject(projectId, format) {
				return post(ROUTES.export, {
					projectId,
					format
				});
			}
			channels() {
				return post(ROUTES.channels);
			}
			xhsPlan(topic, imageCount, aspectRatio) {
				return post(ROUTES.xhsPlan, {
					topic,
					imageCount,
					aspectRatio
				});
			}
			xhsGenerate(plan, aspectRatio) {
				return post(ROUTES.xhsGenerate, {
					plan,
					aspectRatio
				});
			}
			xhsEdit(imageUrl, prompt, aspectRatio) {
				return post(ROUTES.xhsEdit, {
					imageUrl,
					prompt,
					aspectRatio
				});
			}
		};
		//#endregion
		//#region node_modules/react/cjs/react-jsx-runtime.production.min.js
		/**
		* @license React
		* react-jsx-runtime.production.min.js
		*
		* Copyright (c) Facebook, Inc. and its affiliates.
		*
		* This source code is licensed under the MIT license found in the
		* LICENSE file in the root directory of this source tree.
		*/
		var require_react_jsx_runtime_production_min = /* @__PURE__ */ __commonJSMin(((exports) => {
			var f = require("react");
			var k = Symbol.for("react.element");
			var l = Symbol.for("react.fragment");
			var m = Object.prototype.hasOwnProperty;
			var n = f.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner;
			var p = {
				key: !0,
				ref: !0,
				__self: !0,
				__source: !0
			};
			function q(c, a, g) {
				var b, d = {}, e = null, h = null;
				void 0 !== g && (e = "" + g);
				void 0 !== a.key && (e = "" + a.key);
				void 0 !== a.ref && (h = a.ref);
				for (b in a) m.call(a, b) && !p.hasOwnProperty(b) && (d[b] = a[b]);
				if (c && c.defaultProps) for (b in a = c.defaultProps, a) void 0 === d[b] && (d[b] = a[b]);
				return {
					$$typeof: k,
					type: c,
					key: e,
					ref: h,
					props: d,
					_owner: n.current
				};
			}
			exports.Fragment = l;
			exports.jsx = q;
			exports.jsxs = q;
		}));
		//#endregion
		//#region node_modules/react/cjs/react-jsx-runtime.development.js
		/**
		* @license React
		* react-jsx-runtime.development.js
		*
		* Copyright (c) Facebook, Inc. and its affiliates.
		*
		* This source code is licensed under the MIT license found in the
		* LICENSE file in the root directory of this source tree.
		*/
		var require_react_jsx_runtime_development = /* @__PURE__ */ __commonJSMin(((exports) => {
			if (process.env.NODE_ENV !== "production") (function() {
				"use strict";
				var React = require("react");
				var REACT_ELEMENT_TYPE = Symbol.for("react.element");
				var REACT_PORTAL_TYPE = Symbol.for("react.portal");
				var REACT_FRAGMENT_TYPE = Symbol.for("react.fragment");
				var REACT_STRICT_MODE_TYPE = Symbol.for("react.strict_mode");
				var REACT_PROFILER_TYPE = Symbol.for("react.profiler");
				var REACT_PROVIDER_TYPE = Symbol.for("react.provider");
				var REACT_CONTEXT_TYPE = Symbol.for("react.context");
				var REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
				var REACT_SUSPENSE_TYPE = Symbol.for("react.suspense");
				var REACT_SUSPENSE_LIST_TYPE = Symbol.for("react.suspense_list");
				var REACT_MEMO_TYPE = Symbol.for("react.memo");
				var REACT_LAZY_TYPE = Symbol.for("react.lazy");
				var REACT_OFFSCREEN_TYPE = Symbol.for("react.offscreen");
				var MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
				var FAUX_ITERATOR_SYMBOL = "@@iterator";
				function getIteratorFn(maybeIterable) {
					if (maybeIterable === null || typeof maybeIterable !== "object") return null;
					var maybeIterator = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable[FAUX_ITERATOR_SYMBOL];
					if (typeof maybeIterator === "function") return maybeIterator;
					return null;
				}
				var ReactSharedInternals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
				function error(format) {
					for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) args[_key2 - 1] = arguments[_key2];
					printWarning("error", format, args);
				}
				function printWarning(level, format, args) {
					var stack = ReactSharedInternals.ReactDebugCurrentFrame.getStackAddendum();
					if (stack !== "") {
						format += "%s";
						args = args.concat([stack]);
					}
					var argsWithFormat = args.map(function(item) {
						return String(item);
					});
					argsWithFormat.unshift("Warning: " + format);
					Function.prototype.apply.call(console[level], console, argsWithFormat);
				}
				var enableScopeAPI = false;
				var enableCacheElement = false;
				var enableTransitionTracing = false;
				var enableLegacyHidden = false;
				var enableDebugTracing = false;
				var REACT_MODULE_REFERENCE = Symbol.for("react.module.reference");
				function isValidElementType(type) {
					if (typeof type === "string" || typeof type === "function") return true;
					if (type === REACT_FRAGMENT_TYPE || type === REACT_PROFILER_TYPE || enableDebugTracing || type === REACT_STRICT_MODE_TYPE || type === REACT_SUSPENSE_TYPE || type === REACT_SUSPENSE_LIST_TYPE || enableLegacyHidden || type === REACT_OFFSCREEN_TYPE || enableScopeAPI || enableCacheElement || enableTransitionTracing) return true;
					if (typeof type === "object" && type !== null) {
						if (type.$$typeof === REACT_LAZY_TYPE || type.$$typeof === REACT_MEMO_TYPE || type.$$typeof === REACT_PROVIDER_TYPE || type.$$typeof === REACT_CONTEXT_TYPE || type.$$typeof === REACT_FORWARD_REF_TYPE || type.$$typeof === REACT_MODULE_REFERENCE || type.getModuleId !== void 0) return true;
					}
					return false;
				}
				function getWrappedName(outerType, innerType, wrapperName) {
					var displayName = outerType.displayName;
					if (displayName) return displayName;
					var functionName = innerType.displayName || innerType.name || "";
					return functionName !== "" ? wrapperName + "(" + functionName + ")" : wrapperName;
				}
				function getContextName(type) {
					return type.displayName || "Context";
				}
				function getComponentNameFromType(type) {
					if (type == null) return null;
					if (typeof type.tag === "number") error("Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue.");
					if (typeof type === "function") return type.displayName || type.name || null;
					if (typeof type === "string") return type;
					switch (type) {
						case REACT_FRAGMENT_TYPE: return "Fragment";
						case REACT_PORTAL_TYPE: return "Portal";
						case REACT_PROFILER_TYPE: return "Profiler";
						case REACT_STRICT_MODE_TYPE: return "StrictMode";
						case REACT_SUSPENSE_TYPE: return "Suspense";
						case REACT_SUSPENSE_LIST_TYPE: return "SuspenseList";
					}
					if (typeof type === "object") switch (type.$$typeof) {
						case REACT_CONTEXT_TYPE: return getContextName(type) + ".Consumer";
						case REACT_PROVIDER_TYPE: return getContextName(type._context) + ".Provider";
						case REACT_FORWARD_REF_TYPE: return getWrappedName(type, type.render, "ForwardRef");
						case REACT_MEMO_TYPE:
							var outerName = type.displayName || null;
							if (outerName !== null) return outerName;
							return getComponentNameFromType(type.type) || "Memo";
						case REACT_LAZY_TYPE:
							var lazyComponent = type;
							var payload = lazyComponent._payload;
							var init = lazyComponent._init;
							try {
								return getComponentNameFromType(init(payload));
							} catch (x) {
								return null;
							}
					}
					return null;
				}
				var assign = Object.assign;
				var disabledDepth = 0;
				var prevLog;
				var prevInfo;
				var prevWarn;
				var prevError;
				var prevGroup;
				var prevGroupCollapsed;
				var prevGroupEnd;
				function disabledLog() {}
				disabledLog.__reactDisabledLog = true;
				function disableLogs() {
					if (disabledDepth === 0) {
						prevLog = console.log;
						prevInfo = console.info;
						prevWarn = console.warn;
						prevError = console.error;
						prevGroup = console.group;
						prevGroupCollapsed = console.groupCollapsed;
						prevGroupEnd = console.groupEnd;
						var props = {
							configurable: true,
							enumerable: true,
							value: disabledLog,
							writable: true
						};
						Object.defineProperties(console, {
							info: props,
							log: props,
							warn: props,
							error: props,
							group: props,
							groupCollapsed: props,
							groupEnd: props
						});
					}
					disabledDepth++;
				}
				function reenableLogs() {
					disabledDepth--;
					if (disabledDepth === 0) {
						var props = {
							configurable: true,
							enumerable: true,
							writable: true
						};
						Object.defineProperties(console, {
							log: assign({}, props, { value: prevLog }),
							info: assign({}, props, { value: prevInfo }),
							warn: assign({}, props, { value: prevWarn }),
							error: assign({}, props, { value: prevError }),
							group: assign({}, props, { value: prevGroup }),
							groupCollapsed: assign({}, props, { value: prevGroupCollapsed }),
							groupEnd: assign({}, props, { value: prevGroupEnd })
						});
					}
					if (disabledDepth < 0) error("disabledDepth fell below zero. This is a bug in React. Please file an issue.");
				}
				var ReactCurrentDispatcher = ReactSharedInternals.ReactCurrentDispatcher;
				var prefix;
				function describeBuiltInComponentFrame(name, source, ownerFn) {
					if (prefix === void 0) try {
						throw Error();
					} catch (x) {
						var match = x.stack.trim().match(/\n( *(at )?)/);
						prefix = match && match[1] || "";
					}
					return "\n" + prefix + name;
				}
				var reentry = false;
				var componentFrameCache = new (typeof WeakMap === "function" ? WeakMap : Map)();
				function describeNativeComponentFrame(fn, construct) {
					if (!fn || reentry) return "";
					var frame = componentFrameCache.get(fn);
					if (frame !== void 0) return frame;
					var control;
					reentry = true;
					var previousPrepareStackTrace = Error.prepareStackTrace;
					Error.prepareStackTrace = void 0;
					var previousDispatcher = ReactCurrentDispatcher.current;
					ReactCurrentDispatcher.current = null;
					disableLogs();
					try {
						if (construct) {
							var Fake = function() {
								throw Error();
							};
							Object.defineProperty(Fake.prototype, "props", { set: function() {
								throw Error();
							} });
							if (typeof Reflect === "object" && Reflect.construct) {
								try {
									Reflect.construct(Fake, []);
								} catch (x) {
									control = x;
								}
								Reflect.construct(fn, [], Fake);
							} else {
								try {
									Fake.call();
								} catch (x) {
									control = x;
								}
								fn.call(Fake.prototype);
							}
						} else {
							try {
								throw Error();
							} catch (x) {
								control = x;
							}
							fn();
						}
					} catch (sample) {
						if (sample && control && typeof sample.stack === "string") {
							var sampleLines = sample.stack.split("\n");
							var controlLines = control.stack.split("\n");
							var s = sampleLines.length - 1;
							var c = controlLines.length - 1;
							while (s >= 1 && c >= 0 && sampleLines[s] !== controlLines[c]) c--;
							for (; s >= 1 && c >= 0; s--, c--) if (sampleLines[s] !== controlLines[c]) {
								if (s !== 1 || c !== 1) do {
									s--;
									c--;
									if (c < 0 || sampleLines[s] !== controlLines[c]) {
										var _frame = "\n" + sampleLines[s].replace(" at new ", " at ");
										if (fn.displayName && _frame.includes("<anonymous>")) _frame = _frame.replace("<anonymous>", fn.displayName);
										if (typeof fn === "function") componentFrameCache.set(fn, _frame);
										return _frame;
									}
								} while (s >= 1 && c >= 0);
								break;
							}
						}
					} finally {
						reentry = false;
						ReactCurrentDispatcher.current = previousDispatcher;
						reenableLogs();
						Error.prepareStackTrace = previousPrepareStackTrace;
					}
					var name = fn ? fn.displayName || fn.name : "";
					var syntheticFrame = name ? describeBuiltInComponentFrame(name) : "";
					if (typeof fn === "function") componentFrameCache.set(fn, syntheticFrame);
					return syntheticFrame;
				}
				function describeFunctionComponentFrame(fn, source, ownerFn) {
					return describeNativeComponentFrame(fn, false);
				}
				function shouldConstruct(Component) {
					var prototype = Component.prototype;
					return !!(prototype && prototype.isReactComponent);
				}
				function describeUnknownElementTypeFrameInDEV(type, source, ownerFn) {
					if (type == null) return "";
					if (typeof type === "function") return describeNativeComponentFrame(type, shouldConstruct(type));
					if (typeof type === "string") return describeBuiltInComponentFrame(type);
					switch (type) {
						case REACT_SUSPENSE_TYPE: return describeBuiltInComponentFrame("Suspense");
						case REACT_SUSPENSE_LIST_TYPE: return describeBuiltInComponentFrame("SuspenseList");
					}
					if (typeof type === "object") switch (type.$$typeof) {
						case REACT_FORWARD_REF_TYPE: return describeFunctionComponentFrame(type.render);
						case REACT_MEMO_TYPE: return describeUnknownElementTypeFrameInDEV(type.type, source, ownerFn);
						case REACT_LAZY_TYPE:
							var lazyComponent = type;
							var payload = lazyComponent._payload;
							var init = lazyComponent._init;
							try {
								return describeUnknownElementTypeFrameInDEV(init(payload), source, ownerFn);
							} catch (x) {}
					}
					return "";
				}
				var hasOwnProperty = Object.prototype.hasOwnProperty;
				var loggedTypeFailures = {};
				var ReactDebugCurrentFrame = ReactSharedInternals.ReactDebugCurrentFrame;
				function setCurrentlyValidatingElement(element) {
					if (element) {
						var owner = element._owner;
						var stack = describeUnknownElementTypeFrameInDEV(element.type, element._source, owner ? owner.type : null);
						ReactDebugCurrentFrame.setExtraStackFrame(stack);
					} else ReactDebugCurrentFrame.setExtraStackFrame(null);
				}
				function checkPropTypes(typeSpecs, values, location, componentName, element) {
					var has = Function.call.bind(hasOwnProperty);
					for (var typeSpecName in typeSpecs) if (has(typeSpecs, typeSpecName)) {
						var error$1 = void 0;
						try {
							if (typeof typeSpecs[typeSpecName] !== "function") {
								var err = Error((componentName || "React class") + ": " + location + " type `" + typeSpecName + "` is invalid; it must be a function, usually from the `prop-types` package, but received `" + typeof typeSpecs[typeSpecName] + "`.This often happens because of typos such as `PropTypes.function` instead of `PropTypes.func`.");
								err.name = "Invariant Violation";
								throw err;
							}
							error$1 = typeSpecs[typeSpecName](values, typeSpecName, componentName, location, null, "SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED");
						} catch (ex) {
							error$1 = ex;
						}
						if (error$1 && !(error$1 instanceof Error)) {
							setCurrentlyValidatingElement(element);
							error("%s: type specification of %s `%s` is invalid; the type checker function must return `null` or an `Error` but returned a %s. You may have forgotten to pass an argument to the type checker creator (arrayOf, instanceOf, objectOf, oneOf, oneOfType, and shape all require an argument).", componentName || "React class", location, typeSpecName, typeof error$1);
							setCurrentlyValidatingElement(null);
						}
						if (error$1 instanceof Error && !(error$1.message in loggedTypeFailures)) {
							loggedTypeFailures[error$1.message] = true;
							setCurrentlyValidatingElement(element);
							error("Failed %s type: %s", location, error$1.message);
							setCurrentlyValidatingElement(null);
						}
					}
				}
				var isArrayImpl = Array.isArray;
				function isArray(a) {
					return isArrayImpl(a);
				}
				function typeName(value) {
					return typeof Symbol === "function" && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
				}
				function willCoercionThrow(value) {
					try {
						testStringCoercion(value);
						return false;
					} catch (e) {
						return true;
					}
				}
				function testStringCoercion(value) {
					return "" + value;
				}
				function checkKeyStringCoercion(value) {
					if (willCoercionThrow(value)) {
						error("The provided key is an unsupported type %s. This value must be coerced to a string before before using it here.", typeName(value));
						return testStringCoercion(value);
					}
				}
				var ReactCurrentOwner = ReactSharedInternals.ReactCurrentOwner;
				var RESERVED_PROPS = {
					key: true,
					ref: true,
					__self: true,
					__source: true
				};
				var specialPropKeyWarningShown;
				var specialPropRefWarningShown;
				var didWarnAboutStringRefs = {};
				function hasValidRef(config) {
					if (hasOwnProperty.call(config, "ref")) {
						var getter = Object.getOwnPropertyDescriptor(config, "ref").get;
						if (getter && getter.isReactWarning) return false;
					}
					return config.ref !== void 0;
				}
				function hasValidKey(config) {
					if (hasOwnProperty.call(config, "key")) {
						var getter = Object.getOwnPropertyDescriptor(config, "key").get;
						if (getter && getter.isReactWarning) return false;
					}
					return config.key !== void 0;
				}
				function warnIfStringRefCannotBeAutoConverted(config, self) {
					if (typeof config.ref === "string" && ReactCurrentOwner.current && self && ReactCurrentOwner.current.stateNode !== self) {
						var componentName = getComponentNameFromType(ReactCurrentOwner.current.type);
						if (!didWarnAboutStringRefs[componentName]) {
							error("Component \"%s\" contains the string ref \"%s\". Support for string refs will be removed in a future major release. This case cannot be automatically converted to an arrow function. We ask you to manually fix this case by using useRef() or createRef() instead. Learn more about using refs safely here: https://reactjs.org/link/strict-mode-string-ref", getComponentNameFromType(ReactCurrentOwner.current.type), config.ref);
							didWarnAboutStringRefs[componentName] = true;
						}
					}
				}
				function defineKeyPropWarningGetter(props, displayName) {
					var warnAboutAccessingKey = function() {
						if (!specialPropKeyWarningShown) {
							specialPropKeyWarningShown = true;
							error("%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://reactjs.org/link/special-props)", displayName);
						}
					};
					warnAboutAccessingKey.isReactWarning = true;
					Object.defineProperty(props, "key", {
						get: warnAboutAccessingKey,
						configurable: true
					});
				}
				function defineRefPropWarningGetter(props, displayName) {
					var warnAboutAccessingRef = function() {
						if (!specialPropRefWarningShown) {
							specialPropRefWarningShown = true;
							error("%s: `ref` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://reactjs.org/link/special-props)", displayName);
						}
					};
					warnAboutAccessingRef.isReactWarning = true;
					Object.defineProperty(props, "ref", {
						get: warnAboutAccessingRef,
						configurable: true
					});
				}
				/**
				* Factory method to create a new React element. This no longer adheres to
				* the class pattern, so do not use new to call it. Also, instanceof check
				* will not work. Instead test $$typeof field against Symbol.for('react.element') to check
				* if something is a React Element.
				*
				* @param {*} type
				* @param {*} props
				* @param {*} key
				* @param {string|object} ref
				* @param {*} owner
				* @param {*} self A *temporary* helper to detect places where `this` is
				* different from the `owner` when React.createElement is called, so that we
				* can warn. We want to get rid of owner and replace string `ref`s with arrow
				* functions, and as long as `this` and owner are the same, there will be no
				* change in behavior.
				* @param {*} source An annotation object (added by a transpiler or otherwise)
				* indicating filename, line number, and/or other information.
				* @internal
				*/
				var ReactElement = function(type, key, ref, self, source, owner, props) {
					var element = {
						$$typeof: REACT_ELEMENT_TYPE,
						type,
						key,
						ref,
						props,
						_owner: owner
					};
					element._store = {};
					Object.defineProperty(element._store, "validated", {
						configurable: false,
						enumerable: false,
						writable: true,
						value: false
					});
					Object.defineProperty(element, "_self", {
						configurable: false,
						enumerable: false,
						writable: false,
						value: self
					});
					Object.defineProperty(element, "_source", {
						configurable: false,
						enumerable: false,
						writable: false,
						value: source
					});
					if (Object.freeze) {
						Object.freeze(element.props);
						Object.freeze(element);
					}
					return element;
				};
				/**
				* https://github.com/reactjs/rfcs/pull/107
				* @param {*} type
				* @param {object} props
				* @param {string} key
				*/
				function jsxDEV(type, config, maybeKey, source, self) {
					var propName;
					var props = {};
					var key = null;
					var ref = null;
					if (maybeKey !== void 0) {
						checkKeyStringCoercion(maybeKey);
						key = "" + maybeKey;
					}
					if (hasValidKey(config)) {
						checkKeyStringCoercion(config.key);
						key = "" + config.key;
					}
					if (hasValidRef(config)) {
						ref = config.ref;
						warnIfStringRefCannotBeAutoConverted(config, self);
					}
					for (propName in config) if (hasOwnProperty.call(config, propName) && !RESERVED_PROPS.hasOwnProperty(propName)) props[propName] = config[propName];
					if (type && type.defaultProps) {
						var defaultProps = type.defaultProps;
						for (propName in defaultProps) if (props[propName] === void 0) props[propName] = defaultProps[propName];
					}
					if (key || ref) {
						var displayName = typeof type === "function" ? type.displayName || type.name || "Unknown" : type;
						if (key) defineKeyPropWarningGetter(props, displayName);
						if (ref) defineRefPropWarningGetter(props, displayName);
					}
					return ReactElement(type, key, ref, self, source, ReactCurrentOwner.current, props);
				}
				var ReactCurrentOwner$1 = ReactSharedInternals.ReactCurrentOwner;
				var ReactDebugCurrentFrame$1 = ReactSharedInternals.ReactDebugCurrentFrame;
				function setCurrentlyValidatingElement$1(element) {
					if (element) {
						var owner = element._owner;
						var stack = describeUnknownElementTypeFrameInDEV(element.type, element._source, owner ? owner.type : null);
						ReactDebugCurrentFrame$1.setExtraStackFrame(stack);
					} else ReactDebugCurrentFrame$1.setExtraStackFrame(null);
				}
				var propTypesMisspellWarningShown = false;
				/**
				* Verifies the object is a ReactElement.
				* See https://reactjs.org/docs/react-api.html#isvalidelement
				* @param {?object} object
				* @return {boolean} True if `object` is a ReactElement.
				* @final
				*/
				function isValidElement(object) {
					return typeof object === "object" && object !== null && object.$$typeof === REACT_ELEMENT_TYPE;
				}
				function getDeclarationErrorAddendum() {
					if (ReactCurrentOwner$1.current) {
						var name = getComponentNameFromType(ReactCurrentOwner$1.current.type);
						if (name) return "\n\nCheck the render method of `" + name + "`.";
					}
					return "";
				}
				function getSourceInfoErrorAddendum(source) {
					if (source !== void 0) {
						var fileName = source.fileName.replace(/^.*[\\\/]/, "");
						var lineNumber = source.lineNumber;
						return "\n\nCheck your code at " + fileName + ":" + lineNumber + ".";
					}
					return "";
				}
				/**
				* Warn if there's no key explicitly set on dynamic arrays of children or
				* object keys are not valid. This allows us to keep track of children between
				* updates.
				*/
				var ownerHasKeyUseWarning = {};
				function getCurrentComponentErrorInfo(parentType) {
					var info = getDeclarationErrorAddendum();
					if (!info) {
						var parentName = typeof parentType === "string" ? parentType : parentType.displayName || parentType.name;
						if (parentName) info = "\n\nCheck the top-level render call using <" + parentName + ">.";
					}
					return info;
				}
				/**
				* Warn if the element doesn't have an explicit key assigned to it.
				* This element is in an array. The array could grow and shrink or be
				* reordered. All children that haven't already been validated are required to
				* have a "key" property assigned to it. Error statuses are cached so a warning
				* will only be shown once.
				*
				* @internal
				* @param {ReactElement} element Element that requires a key.
				* @param {*} parentType element's parent's type.
				*/
				function validateExplicitKey(element, parentType) {
					if (!element._store || element._store.validated || element.key != null) return;
					element._store.validated = true;
					var currentComponentErrorInfo = getCurrentComponentErrorInfo(parentType);
					if (ownerHasKeyUseWarning[currentComponentErrorInfo]) return;
					ownerHasKeyUseWarning[currentComponentErrorInfo] = true;
					var childOwner = "";
					if (element && element._owner && element._owner !== ReactCurrentOwner$1.current) childOwner = " It was passed a child from " + getComponentNameFromType(element._owner.type) + ".";
					setCurrentlyValidatingElement$1(element);
					error("Each child in a list should have a unique \"key\" prop.%s%s See https://reactjs.org/link/warning-keys for more information.", currentComponentErrorInfo, childOwner);
					setCurrentlyValidatingElement$1(null);
				}
				/**
				* Ensure that every element either is passed in a static location, in an
				* array with an explicit keys property defined, or in an object literal
				* with valid key property.
				*
				* @internal
				* @param {ReactNode} node Statically passed child of any type.
				* @param {*} parentType node's parent's type.
				*/
				function validateChildKeys(node, parentType) {
					if (typeof node !== "object") return;
					if (isArray(node)) for (var i = 0; i < node.length; i++) {
						var child = node[i];
						if (isValidElement(child)) validateExplicitKey(child, parentType);
					}
					else if (isValidElement(node)) {
						if (node._store) node._store.validated = true;
					} else if (node) {
						var iteratorFn = getIteratorFn(node);
						if (typeof iteratorFn === "function") {
							if (iteratorFn !== node.entries) {
								var iterator = iteratorFn.call(node);
								var step;
								while (!(step = iterator.next()).done) if (isValidElement(step.value)) validateExplicitKey(step.value, parentType);
							}
						}
					}
				}
				/**
				* Given an element, validate that its props follow the propTypes definition,
				* provided by the type.
				*
				* @param {ReactElement} element
				*/
				function validatePropTypes(element) {
					var type = element.type;
					if (type === null || type === void 0 || typeof type === "string") return;
					var propTypes;
					if (typeof type === "function") propTypes = type.propTypes;
					else if (typeof type === "object" && (type.$$typeof === REACT_FORWARD_REF_TYPE || type.$$typeof === REACT_MEMO_TYPE)) propTypes = type.propTypes;
					else return;
					if (propTypes) {
						var name = getComponentNameFromType(type);
						checkPropTypes(propTypes, element.props, "prop", name, element);
					} else if (type.PropTypes !== void 0 && !propTypesMisspellWarningShown) {
						propTypesMisspellWarningShown = true;
						error("Component %s declared `PropTypes` instead of `propTypes`. Did you misspell the property assignment?", getComponentNameFromType(type) || "Unknown");
					}
					if (typeof type.getDefaultProps === "function" && !type.getDefaultProps.isReactClassApproved) error("getDefaultProps is only used on classic React.createClass definitions. Use a static property named `defaultProps` instead.");
				}
				/**
				* Given a fragment, validate that it can only be provided with fragment props
				* @param {ReactElement} fragment
				*/
				function validateFragmentProps(fragment) {
					var keys = Object.keys(fragment.props);
					for (var i = 0; i < keys.length; i++) {
						var key = keys[i];
						if (key !== "children" && key !== "key") {
							setCurrentlyValidatingElement$1(fragment);
							error("Invalid prop `%s` supplied to `React.Fragment`. React.Fragment can only have `key` and `children` props.", key);
							setCurrentlyValidatingElement$1(null);
							break;
						}
					}
					if (fragment.ref !== null) {
						setCurrentlyValidatingElement$1(fragment);
						error("Invalid attribute `ref` supplied to `React.Fragment`.");
						setCurrentlyValidatingElement$1(null);
					}
				}
				var didWarnAboutKeySpread = {};
				function jsxWithValidation(type, props, key, isStaticChildren, source, self) {
					var validType = isValidElementType(type);
					if (!validType) {
						var info = "";
						if (type === void 0 || typeof type === "object" && type !== null && Object.keys(type).length === 0) info += " You likely forgot to export your component from the file it's defined in, or you might have mixed up default and named imports.";
						var sourceInfo = getSourceInfoErrorAddendum(source);
						if (sourceInfo) info += sourceInfo;
						else info += getDeclarationErrorAddendum();
						var typeString;
						if (type === null) typeString = "null";
						else if (isArray(type)) typeString = "array";
						else if (type !== void 0 && type.$$typeof === REACT_ELEMENT_TYPE) {
							typeString = "<" + (getComponentNameFromType(type.type) || "Unknown") + " />";
							info = " Did you accidentally export a JSX literal instead of a component?";
						} else typeString = typeof type;
						error("React.jsx: type is invalid -- expected a string (for built-in components) or a class/function (for composite components) but got: %s.%s", typeString, info);
					}
					var element = jsxDEV(type, props, key, source, self);
					if (element == null) return element;
					if (validType) {
						var children = props.children;
						if (children !== void 0) {
							if (isStaticChildren) {
								if (isArray(children)) {
									for (var i = 0; i < children.length; i++) validateChildKeys(children[i], type);
									if (Object.freeze) Object.freeze(children);
								} else error("React.jsx: Static children should always be an array. You are likely explicitly calling React.jsxs or React.jsxDEV. Use the Babel transform instead.");
							} else validateChildKeys(children, type);
						}
					}
					if (hasOwnProperty.call(props, "key")) {
						var componentName = getComponentNameFromType(type);
						var keys = Object.keys(props).filter(function(k) {
							return k !== "key";
						});
						var beforeExample = keys.length > 0 ? "{key: someKey, " + keys.join(": ..., ") + ": ...}" : "{key: someKey}";
						if (!didWarnAboutKeySpread[componentName + beforeExample]) {
							error("A props object containing a \"key\" prop is being spread into JSX:\n  let props = %s;\n  <%s {...props} />\nReact keys must be passed directly to JSX without using spread:\n  let props = %s;\n  <%s key={someKey} {...props} />", beforeExample, componentName, keys.length > 0 ? "{" + keys.join(": ..., ") + ": ...}" : "{}", componentName);
							didWarnAboutKeySpread[componentName + beforeExample] = true;
						}
					}
					if (type === REACT_FRAGMENT_TYPE) validateFragmentProps(element);
					else validatePropTypes(element);
					return element;
				}
				function jsxWithValidationStatic(type, props, key) {
					return jsxWithValidation(type, props, key, true);
				}
				function jsxWithValidationDynamic(type, props, key) {
					return jsxWithValidation(type, props, key, false);
				}
				var jsx = jsxWithValidationDynamic;
				var jsxs = jsxWithValidationStatic;
				exports.Fragment = REACT_FRAGMENT_TYPE;
				exports.jsx = jsx;
				exports.jsxs = jsxs;
			})();
		}));
		//#endregion
		//#region src/client/ui.tsx
		var import_jsx_runtime = (/* @__PURE__ */ __commonJSMin(((exports, module) => {
			if (process.env.NODE_ENV === "production") module.exports = require_react_jsx_runtime_production_min();
			else module.exports = require_react_jsx_runtime_development();
		})))();
		const T = {
			bg: "#f7f7f8",
			card: "#ffffff",
			cardMuted: "#fafafb",
			border: "#e7e8ec",
			borderStrong: "#d9dbe0",
			text: "#171719",
			muted: "#8b8d97",
			mutedStrong: "#5b5d68",
			accent: "#ff5b30",
			accentSoft: "#fff1ec",
			dark: "#17181c",
			ok: "#16a34a",
			okSoft: "#eafbf0",
			warn: "#d97706",
			warnSoft: "#fef6e7",
			danger: "#e0392f",
			dangerSoft: "#fdedec",
			radius: 14,
			radiusSm: 10,
			shadow: "0 1px 2px rgba(23,24,28,0.04), 0 8px 24px rgba(23,24,28,0.05)",
			shadowSm: "0 1px 2px rgba(23,24,28,0.05)"
		};
		const fontStack = "ui-sans-serif, -apple-system, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif";
		const styles = {
			root: {
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minHeight: 0,
				background: T.bg,
				backgroundImage: "linear-gradient(90deg, rgba(0,0,0,0.025) 1px, transparent 1px), linear-gradient(rgba(0,0,0,0.025) 1px, transparent 1px)",
				backgroundSize: "28px 28px",
				color: T.text,
				font: `13px/1.55 ${fontStack}`
			},
			body: {
				display: "flex",
				flex: "1 1 auto",
				minHeight: 0,
				gap: 16,
				padding: 16
			},
			rail: {
				width: 208,
				flex: "0 0 auto",
				background: T.card,
				border: `1px solid ${T.border}`,
				borderRadius: T.radius,
				boxShadow: T.shadow,
				padding: 14,
				display: "flex",
				flexDirection: "column",
				gap: 4
			},
			main: {
				flex: "1 1 auto",
				minWidth: 0,
				overflowY: "auto",
				display: "flex",
				flexDirection: "column"
			},
			card: {
				background: T.card,
				border: `1px solid ${T.border}`,
				borderRadius: T.radius,
				boxShadow: T.shadowSm,
				padding: 18
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			input: {
				width: "100%",
				boxSizing: "border-box",
				background: T.cardMuted,
				color: T.text,
				border: `1px solid ${T.border}`,
				borderRadius: T.radiusSm,
				padding: "8px 10px",
				font: `13px ${fontStack}`,
				outline: "none"
			},
			mono: {
				font: "12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				margin: 0,
				color: T.mutedStrong
			}
		};
		function Button(props) {
			const { variant = "default", disabled, active, full } = props;
			if (variant === "nav") return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				title: props.title,
				disabled,
				onClick: props.onClick,
				style: {
					display: "flex",
					alignItems: "center",
					gap: 10,
					width: "100%",
					textAlign: "left",
					background: active ? T.accentSoft : "transparent",
					color: active ? T.accent : T.mutedStrong,
					border: "none",
					borderRadius: T.radiusSm,
					padding: "9px 10px",
					font: `13px ${fontStack}`,
					fontWeight: active ? 600 : 500,
					cursor: disabled ? "not-allowed" : "pointer",
					opacity: disabled ? .45 : 1,
					...props.style
				},
				children: props.children
			});
			const background = variant === "dark" ? T.dark : variant === "danger" ? T.dangerSoft : variant === "ghost" ? "transparent" : T.card;
			const color = variant === "dark" ? "#fff" : variant === "danger" ? T.danger : T.text;
			const border = variant === "dark" ? T.dark : variant === "danger" ? "#f3c9c6" : variant === "ghost" ? "transparent" : T.border;
			return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				title: props.title,
				disabled,
				onClick: props.onClick,
				style: {
					background,
					color,
					border: `1px solid ${border}`,
					borderRadius: 999,
					padding: "8px 16px",
					font: `13px ${fontStack}`,
					fontWeight: 600,
					cursor: disabled ? "not-allowed" : "pointer",
					opacity: disabled ? .5 : 1,
					whiteSpace: "nowrap",
					width: full ? "100%" : void 0,
					transition: "opacity .15s, background .15s",
					...props.style
				},
				children: props.children
			});
		}
		function Field(props) {
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
				style: {
					display: "block",
					marginBottom: 14,
					...props.style
				},
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						style: {
							display: "block",
							color: T.mutedStrong,
							marginBottom: 6,
							fontSize: 12,
							fontWeight: 600
						},
						children: props.label
					}),
					props.children,
					props.hint ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						style: {
							display: "block",
							color: T.muted,
							fontSize: 11,
							marginTop: 5,
							lineHeight: 1.5
						},
						children: props.hint
					}) : null
				]
			});
		}
		function Badge(props) {
			const tone = props.tone ?? "muted";
			const map = {
				ok: {
					color: T.ok,
					bg: T.okSoft
				},
				warn: {
					color: T.warn,
					bg: T.warnSoft
				},
				danger: {
					color: T.danger,
					bg: T.dangerSoft
				},
				accent: {
					color: T.accent,
					bg: T.accentSoft
				},
				muted: {
					color: T.mutedStrong,
					bg: T.cardMuted
				}
			}[tone];
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 5,
					padding: "2px 9px",
					borderRadius: 999,
					fontSize: 11,
					fontWeight: 600,
					color: map.color,
					background: map.bg,
					whiteSpace: "nowrap"
				},
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: {
					width: 5,
					height: 5,
					borderRadius: 999,
					background: map.color,
					flex: "0 0 auto"
				} }), props.children]
			});
		}
		function statusTone(status) {
			if (status === "SUCCESS") return "ok";
			if (status === "GENERATING") return "warn";
			if (status === "FAILED") return "danger";
			return "muted";
		}
		function statusLabel(status) {
			return {
				SUCCESS: "已完成",
				GENERATING: "生成中",
				FAILED: "失败",
				IDLE: "未开始"
			}[status] ?? status;
		}
		function Notice(props) {
			const map = {
				info: {
					color: "#2563eb",
					bg: "#eff6ff",
					border: "#bfdbfe"
				},
				error: {
					color: T.danger,
					bg: T.dangerSoft,
					border: "#f3c9c6"
				},
				success: {
					color: T.ok,
					bg: T.okSoft,
					border: "#bbe8cb"
				}
			}[props.kind];
			return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				style: {
					border: `1px solid ${map.border}`,
					background: map.bg,
					color: map.color,
					borderRadius: T.radiusSm,
					padding: "10px 12px",
					marginBottom: 14,
					fontSize: 12.5,
					lineHeight: 1.6
				},
				children: props.children
			});
		}
		function SectionHeading(props) {
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: { marginBottom: 18 },
				children: [
					props.eyebrow ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 12,
							color: T.muted,
							marginBottom: 4,
							fontWeight: 600
						},
						children: props.eyebrow
					}) : null,
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 24,
							fontWeight: 800,
							letterSpacing: "-0.01em"
						},
						children: props.title
					}),
					props.description ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							color: T.muted,
							fontSize: 13,
							marginTop: 6
						},
						children: props.description
					}) : null
				]
			});
		}
		/** A configuration chip like upstream's "内容语言：简体中文" strip. */
		function ConfigChip(props) {
			const tone = props.tone ?? "ok";
			const dot = {
				ok: T.ok,
				warn: T.warn,
				accent: T.accent
			}[tone];
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 6,
					fontSize: 12.5,
					color: T.mutedStrong
				},
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: {
						width: 6,
						height: 6,
						borderRadius: 999,
						background: dot
					} }),
					props.label,
					"：",
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", {
						style: {
							color: T.text,
							fontWeight: 600
						},
						children: props.value
					})
				]
			});
		}
		//#endregion
		//#region src/client/views/channels.tsx
		/**
		* Channels screen — provider diagnostics.
		*
		* Upstream had a 30 KB `provider-settings.tsx` for CRUD over provider rows plus
		* `/models` discovery and per-role default assignment. In DSH the channel list
		* lives in the plugin Config (Schemastery), so this screen is read-only
		* *diagnostics* plus a pointer to where to edit — which is the part that
		* actually helps when generation fails.
		*/
		function ChannelsView(props) {
			const { api } = props;
			const [data, setData] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const load = () => {
				setLoading(true);
				setError(null);
				api.channels().then(setData).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false));
			};
			(0, react.useEffect)(load, [api]);
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: {
					padding: 24,
					maxWidth: 760,
					display: "grid",
					gap: 16
				},
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(SectionHeading, {
						eyebrow: "系统设置",
						title: "AI 配置",
						description: "渠道用于连接图像/文本模型服务，在设置中配置后即可在此诊断。"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.card,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								...styles.row,
								justifyContent: "space-between",
								marginBottom: 8
							},
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "渠道" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
								onClick: load,
								disabled: loading,
								children: loading ? "检测中…" : "重新检测"
							})]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								color: T.muted,
								fontSize: 12
							},
							children: [
								"渠道在 ",
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "设置 → 插件 → MxPage" }),
								" 里配置：baseUrl + 密钥（建议用",
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", {
									style: styles.mono,
									children: " apiKeyEnv "
								}),
								"指向环境变量）+ 模型目录。"
							]
						})]
					}),
					error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
						kind: "error",
						children: error
					}) : null,
					data ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: styles.card,
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										...styles.row,
										marginBottom: 8
									},
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "当前生效渠道" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
										tone: "ok",
										children: data.channel.label ?? data.channel.id ?? "unnamed"
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									style: {
										...styles.mono,
										color: T.muted
									},
									children: data.channel.baseUrl
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										...styles.row,
										marginTop: 10,
										flexWrap: "wrap",
										gap: 6
									},
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, {
											tone: data.modelCount ? "ok" : "danger",
											children: [
												"共 ",
												data.modelCount,
												" 个模型"
											]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, {
											tone: data.imageModels.length ? "ok" : "warn",
											children: ["图像 ", data.imageModels.length]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, {
											tone: data.visionModels.length ? "ok" : "warn",
											children: ["视觉 ", data.visionModels.length]
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, {
											tone: data.textModels.length ? "ok" : "warn",
											children: ["文本 ", data.textModels.length]
										})
									]
								}),
								data.imageModels.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Notice, {
									kind: "error",
									children: [
										"没有识别出任何图像模型。模型能力是",
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "按名字推断" }),
										"的 —— 上游为避免消耗图像额度 跳过了真实端点探测，所以「名字像图像模型」不等于网关真支持生图。请在渠道里显式列出",
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", {
											style: styles.mono,
											children: " models "
										}),
										"。"
									]
								}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										marginTop: 10,
										...styles.mono,
										color: T.muted
									},
									children: ["图像模型：", data.imageModels.join(", ")]
								})
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: styles.card,
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("strong", { children: [
								"已配置渠道（",
								data.channels.length,
								"）"
							] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									display: "grid",
									gap: 8,
									marginTop: 10
								},
								children: [data.channels.map((channel) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										border: `1px solid ${T.border}`,
										borderRadius: 6,
										padding: 10,
										opacity: channel.disabled ? .5 : 1
									},
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
										style: {
											...styles.row,
											marginBottom: 4
										},
										children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: channel.label }),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: channel.id }),
											channel.disabled ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
												tone: "warn",
												children: "已禁用"
											}) : null,
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
												tone: channel.hasKey ? "ok" : "danger",
												children: channel.hasKey ? "密钥已配置" : "缺少密钥"
											}),
											channel.models.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, {
												tone: "ok",
												children: [channel.models.length, " 个显式模型"]
											}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
												tone: "warn",
												children: "靠 GET /models 发现"
											})
										]
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										style: {
											...styles.mono,
											color: T.muted
										},
										children: channel.baseUrl
									})]
								}, channel.id)), data.channels.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
									kind: "error",
									children: "还没有配置任何渠道。所有 mxpage_* 工具都会返回 MXPAGE_HTTP_401 直到配置完成。"
								}) : null]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: styles.card,
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "配额行为" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									color: T.muted,
									fontSize: 12,
									marginTop: 6
								},
								children: [
									"上游对 ",
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", {
										style: styles.mono,
										children: "429 / 额度 / 403 / 401"
									}),
									" ",
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "不轮换模型" }),
									"， 所以一个渠道额度用尽会直接失败而不是试下一个。本插件把这条做成了配置项",
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", {
										style: styles.mono,
										children: " rotateChannelOnQuotaExhausted "
									}),
									"，默认开启。"
								]
							})]
						})
					] }) : null
				]
			});
		}
		//#endregion
		//#region src/client/views/editor.tsx
		/**
		* Editor screen — per-section detailed editing and version control.
		*
		* Rebuilt in the same light theme as the planner: a section list, a preview
		* card, generate/edit actions, an editable-fields card, and a version strip.
		* Every generation creates a NEW version and never overwrites, so the version
		* list is the undo history.
		*/
		const LANGUAGES$1 = [
			["en-US", "English"],
			["zh-CN", "简体中文"],
			["ja-JP", "日本語"],
			["ko-KR", "한국어"],
			["es-ES", "Español"],
			["fr-FR", "Français"],
			["de-DE", "Deutsch"]
		];
		function EditorView(props) {
			const { api, detail, busy, run, reload, selectedSectionId, onSelectSection } = props;
			const selected = (0, react.useMemo)(() => detail.sections.find((section) => section.id === selectedSectionId) ?? detail.sections[0] ?? null, [detail.sections, selectedSectionId]);
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: {
					padding: 24,
					display: "flex",
					flexDirection: "column",
					height: "100%",
					minHeight: 0
				},
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(SectionHeading, {
					eyebrow: "详细编辑",
					title: "分区编辑器",
					description: "修改文案与视觉提示词、发起生成或重绘，并管理版本历史。"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: {
						flex: "1 1 auto",
						minHeight: 0,
						display: "flex",
						gap: 16
					},
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: {
							width: 240,
							flex: "0 0 auto",
							display: "flex",
							flexDirection: "column",
							minHeight: 0
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								color: T.muted,
								fontSize: 11.5,
								fontWeight: 700,
								padding: "0 4px 8px"
							},
							children: [
								"分区（",
								detail.sections.length,
								"）"
							]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								overflowY: "auto",
								display: "grid",
								gap: 6,
								flex: "1 1 auto"
							},
							children: [detail.sections.map((section) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: () => onSelectSection(section.id),
								style: {
									textAlign: "left",
									background: section.id === selected?.id ? T.accentSoft : T.card,
									border: `1.5px solid ${section.id === selected?.id ? T.dark : T.border}`,
									borderRadius: 10,
									boxShadow: T.shadowSm,
									color: T.text,
									padding: "8px 10px",
									font: "inherit",
									cursor: "pointer",
									display: "flex",
									gap: 6,
									alignItems: "center"
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
									style: {
										flex: "1 1 auto",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										fontSize: 12.5
									},
									children: section.title
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
									tone: statusTone(section.status),
									children: section.imageUrl ? "有图" : statusLabel(section.status)
								})]
							}, section.id)), detail.sections.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									color: T.muted,
									fontSize: 12,
									padding: 8
								},
								children: "先在「规划」页生成分区。"
							}) : null]
						})]
					}), selected ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SectionEditor, {
						api,
						detail,
						section: selected,
						busy,
						run,
						reload
					}, selected.id) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							...styles.card,
							flex: "1 1 auto",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							color: T.muted
						},
						children: "选择左侧分区开始编辑"
					})]
				})]
			});
		}
		function SectionEditor(props) {
			const { api, detail, section, busy, run, reload } = props;
			const projectId = detail.project.id;
			const [title, setTitle] = (0, react.useState)(section.title);
			const [goal, setGoal] = (0, react.useState)(section.goal);
			const [copy, setCopy] = (0, react.useState)(section.copy);
			const [visualPrompt, setVisualPrompt] = (0, react.useState)(section.visualPrompt);
			const [translateTo, setTranslateTo] = (0, react.useState)("en-US");
			const [note, setNote] = (0, react.useState)(null);
			const [versions, setVersions] = (0, react.useState)(section.versions);
			const [preview, setPreview] = (0, react.useState)(section.imageUrl);
			(0, react.useEffect)(() => {
				setTitle(section.title);
				setGoal(section.goal);
				setCopy(section.copy);
				setVisualPrompt(section.visualPrompt);
				setVersions(section.versions);
				setPreview(section.imageUrl);
			}, [section]);
			const dirty = title !== section.title || goal !== section.goal || copy !== section.copy || visualPrompt !== section.visualPrompt;
			const save = () => run(`save-${section.id}`, async () => {
				await api.updateSection(section.id, {
					title,
					goal,
					copy,
					visualPrompt
				});
				setNote("已保存");
				await reload();
			});
			const generate = (regenerate) => run(`gen-${section.id}`, async () => {
				const result = await api.generateSection(projectId, section.id, { regenerate });
				setPreview(result.imageUrl);
				setNote(`${regenerate ? "重绘" : "生成"}完成 · ${result.modelUsed}`);
				await reload();
				const fresh = await api.listVersions(section.id);
				setVersions(fresh.versions);
			});
			const edit = (editMode) => run(`edit-${section.id}-${editMode}`, async () => {
				const result = await api.editSection(projectId, section.id, editMode, { targetLanguage: editMode === "translate" ? translateTo : void 0 });
				setPreview(result.imageUrl);
				setNote(`${editMode} 完成`);
				await reload();
				const fresh = await api.listVersions(section.id);
				setVersions(fresh.versions);
			});
			const activate = (versionId) => run(`activate-${versionId}`, async () => {
				const result = await api.activateVersion(section.id, versionId);
				setPreview(result.imageUrl);
				setNote("已切换版本");
				await reload();
			});
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: {
					flex: "1 1 auto",
					minWidth: 0,
					overflowY: "auto",
					display: "grid",
					gap: 16
				},
				children: [
					note ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
						kind: "success",
						children: note
					}) : null,
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: {
							...styles.card,
							display: "flex",
							gap: 18,
							alignItems: "flex-start"
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								width: 220,
								flex: "0 0 auto",
								borderRadius: 12,
								border: `1px solid ${T.border}`,
								background: T.cardMuted,
								overflow: "hidden",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								color: T.muted,
								minHeight: 160
							},
							children: preview ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
								src: preview,
								alt: section.title,
								style: {
									width: "100%",
									display: "block"
								}
							}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									padding: 20,
									textAlign: "center"
								},
								children: "还没有成品图"
							})
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								flex: "1 1 auto",
								minWidth: 0
							},
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										...styles.row,
										marginBottom: 12,
										flexWrap: "wrap"
									},
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: section.type }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
											tone: statusTone(section.status),
											children: statusLabel(section.status)
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											style: {
												color: T.muted,
												fontSize: 11
											},
											children: section.sectionKey
										})
									]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										...styles.row,
										flexWrap: "wrap"
									},
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
											variant: "dark",
											disabled: busy !== null,
											onClick: () => generate(false),
											children: busy === `gen-${section.id}` ? "生成中…" : preview ? "重新生成" : "生成"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
											disabled: !preview || busy !== null,
											onClick: () => generate(true),
											children: "重绘（保留身份）"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
											disabled: !preview || busy !== null,
											onClick: () => edit("repaint"),
											children: "Repaint"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
											disabled: !preview || busy !== null,
											onClick: () => edit("enhance"),
											children: "Enhance"
										})
									]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										...styles.row,
										marginTop: 10,
										flexWrap: "wrap"
									},
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", {
										value: translateTo,
										onChange: (e) => setTranslateTo(e.target.value),
										style: {
											...styles.input,
											width: 140
										},
										children: LANGUAGES$1.map(([value, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value,
											children: label
										}, value))
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
										disabled: !preview || busy !== null,
										onClick: () => edit("translate"),
										children: busy === `edit-${section.id}-translate` ? "翻译中…" : "图内文字翻译"
									})]
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.card,
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									...styles.row,
									justifyContent: "space-between",
									marginBottom: 12
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", {
									style: { fontSize: 13.5 },
									children: "分区内容"
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									disabled: !dirty || busy !== null,
									onClick: save,
									children: busy === `save-${section.id}` ? "保存中…" : dirty ? "保存修改" : "已保存"
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "标题",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
									value: title,
									onChange: (e) => setTitle(e.target.value),
									style: styles.input
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "目标",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
									value: goal,
									onChange: (e) => setGoal(e.target.value),
									style: styles.input
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "图内文案",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
									rows: 3,
									value: copy,
									onChange: (e) => setCopy(e.target.value),
									style: {
										...styles.input,
										resize: "vertical"
									}
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "视觉提示词",
								hint: "两段式：Primary Prompt / English Prompt。留空则由 Visual Prompt Agent 生成。",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
									rows: 6,
									value: visualPrompt,
									onChange: (e) => setVisualPrompt(e.target.value),
									style: {
										...styles.input,
										resize: "vertical",
										...styles.mono
									}
								})
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.card,
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("strong", {
								style: { fontSize: 13.5 },
								children: [
									"版本历史（",
									versions.length,
									"）"
								]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									color: T.muted,
									fontSize: 12,
									margin: "4px 0 12px"
								},
								children: "每次生成或改图都是新版本，从不覆盖旧文件。"
							}),
							versions.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									color: T.muted,
									fontSize: 12
								},
								children: "还没有版本"
							}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									gap: 10,
									flexWrap: "wrap"
								},
								children: versions.slice().sort((a, b) => b.versionNumber - a.versionNumber).map((version) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
									type: "button",
									onClick: () => activate(version.id),
									disabled: busy !== null || version.isActive,
									style: {
										width: 96,
										padding: 5,
										background: version.isActive ? T.accentSoft : T.cardMuted,
										border: `1.5px solid ${version.isActive ? T.accent : T.border}`,
										borderRadius: 10,
										color: T.text,
										font: "inherit",
										cursor: version.isActive ? "default" : "pointer"
									},
									children: [version.imageUrl ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
										src: version.imageUrl,
										alt: `v${version.versionNumber}`,
										style: {
											width: "100%",
											height: 72,
											objectFit: "cover",
											borderRadius: 6,
											display: "block"
										}
									}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { height: 72 } }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
										style: {
											fontSize: 11,
											marginTop: 5
										},
										children: [
											"v",
											version.versionNumber,
											version.isActive ? " · 当前" : ""
										]
									})]
								}, version.id))
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/views/planner.tsx
		/**
		* Planner screen — the section planning workbench.
		*
		* Rebuilt to match the actual upstream MxPage layout: a header with the
		* project title and a one-click export action, a config strip (language /
		* hero+detail counts / aspect ratio), and a three-column body — module tree,
		* phone-frame preview, and a module edit panel — mirroring
		* `components/planner/planner-workspace.tsx` + `components/editor/editor-workspace.tsx`.
		*/
		const SECTION_TYPE_LABELS = {
			HERO: "头图主视觉",
			SELLING_POINTS: "卖点模块",
			SCENARIO: "场景展示",
			DETAIL_CLOSEUP: "细节特写",
			SPECS: "规格参数",
			MATERIAL: "材质工艺",
			COMPARISON: "对比说明",
			GIFT_SCENE: "送礼场景",
			BRAND_TRUST: "品牌信任",
			SUMMARY: "总结收口",
			CUSTOM: "自定义模块"
		};
		const LANGUAGES = [
			["zh-CN", "简体中文"],
			["en-US", "English"],
			["ja-JP", "日本語"],
			["ko-KR", "한국어"]
		];
		function PlannerView(props) {
			const { api, detail, busy, run, reload, onOpenEditor } = props;
			const snapshot = detail.project.modelSnapshot ?? {};
			const preview = snapshot.previewConfig ?? {};
			const styleGuide = snapshot.visualStyleGuide ?? null;
			const [heroCount, setHeroCount] = (0, react.useState)(Number(preview.heroImageCount) || 3);
			const [detailCount, setDetailCount] = (0, react.useState)(Number(preview.detailSectionCount) || 6);
			const [aspect, setAspect] = (0, react.useState)(preview.imageAspectRatio ?? "3:4");
			const [language, setLanguage] = (0, react.useState)(preview.contentLanguage ?? "zh-CN");
			const [autoDecide, setAutoDecide] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)(null);
			const [confirmReplan, setConfirmReplan] = (0, react.useState)(false);
			const [showConfig, setShowConfig] = (0, react.useState)(false);
			const [showStyleGuide, setShowStyleGuide] = (0, react.useState)(false);
			const [selectedId, setSelectedId] = (0, react.useState)(null);
			const analyzed = Boolean(detail.analysis);
			const hasSections = detail.sections.length > 0;
			const selected = (0, react.useMemo)(() => detail.sections.find((section) => section.id === selectedId) ?? detail.sections[0] ?? null, [detail.sections, selectedId]);
			const doAnalyze = () => run("analyze", async () => {
				await api.analyze(detail.project.id);
				setNotice("分析完成");
				await reload();
			});
			const doPlan = () => run("plan", async () => {
				const result = await api.plan(detail.project.id, {
					heroImageCount: heroCount,
					detailSectionCount: detailCount,
					imageAspectRatio: aspect,
					contentLanguage: language
				}, { autoDecideCounts: autoDecide });
				setNotice(result.fallbackMode === "template_plan" ? "AI 返回结构不完整，已自动切换为模板规划。" : "规划完成");
				setConfirmReplan(false);
				setShowConfig(false);
				await reload();
			});
			const doGenerateAll = (mode) => run(`page-${mode}`, async () => {
				const { jobId, total } = await api.generatePage(detail.project.id, mode);
				setNotice(`后台任务已启动，共 ${total} 张，完成后自动刷新。`);
				for (let i = 0; i < 600; i += 1) {
					await new Promise((resolve) => setTimeout(resolve, 2e3));
					const status = await api.jobStatus(jobId).catch(() => null);
					if (!status || status.state !== "running" && status.state !== "stopping") {
						setNotice(`生成结束：${status?.state === "completed" ? "已完成" : status?.state ?? "未知"}`);
						break;
					}
				}
				await reload();
			});
			const doGenerateOne = (section) => run(`gen-${section.id}`, async () => {
				await api.generateSection(detail.project.id, section.id);
				await reload();
			});
			const doExport = () => run("export", async () => {
				const result = await api.exportProject(detail.project.id, "zip");
				setNotice(`已导出：${result.fileName ?? result.zipPath ?? "ok"}`);
			});
			if (!analyzed) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				style: {
					flex: "1 1 auto",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					padding: 40
				},
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: {
						...styles.card,
						width: "min(480px,92%)",
						textAlign: "center",
						padding: 32
					},
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 20,
								fontWeight: 800,
								marginBottom: 8
							},
							children: "开始商品分析"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								color: T.muted,
								fontSize: 13,
								marginBottom: 20,
								lineHeight: 1.6
							},
							children: "AI 将基于主图识别商品类别、材质与核心卖点，作为后续规划与生成的依据。"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
							variant: "dark",
							onClick: doAnalyze,
							disabled: busy !== null,
							style: { padding: "10px 28px" },
							children: busy === "analyze" ? "分析中…" : "开始分析"
						})
					]
				})
			});
			if (!hasSections) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				style: {
					flex: "1 1 auto",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					padding: 40
				},
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: {
						...styles.card,
						width: "min(520px,92%)",
						padding: 32
					},
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 20,
								fontWeight: 800,
								marginBottom: 8,
								textAlign: "center"
							},
							children: "规划详情页结构"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								color: T.muted,
								fontSize: 13,
								marginBottom: 20,
								textAlign: "center",
								lineHeight: 1.6
							},
							children: "设置头图与详情分区数量，AI 将生成统一的视觉风格与每个模块的文案、提示词。"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlanConfigForm, {
							heroCount,
							setHeroCount,
							detailCount,
							setDetailCount,
							aspect,
							setAspect,
							language,
							setLanguage,
							autoDecide,
							setAutoDecide
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
							variant: "dark",
							full: true,
							onClick: doPlan,
							disabled: busy !== null,
							style: {
								marginTop: 18,
								padding: "10px"
							},
							children: busy === "plan" ? "规划中…" : "生成规划"
						})
					]
				})
			});
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					height: "100%"
				},
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: { padding: "18px 24px 0" },
					children: [
						notice ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
							kind: "info",
							children: notice
						}) : null,
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "flex-start",
								justifyContent: "space-between",
								gap: 16
							},
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(SectionHeading, {
								eyebrow: "预览与编辑",
								title: `${detail.project.name} 的商品页工作台`,
								description: "左侧查看模块顺序与生成状态，中间查看手机商品页预览，右侧编辑标题、文案和视觉 Prompt。"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 8,
									flex: "0 0 auto"
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									onClick: () => setShowConfig((v) => !v),
									children: "配置"
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "dark",
									disabled: busy !== null,
									onClick: () => doGenerateAll("missing"),
									children: busy === "page-missing" ? "生成中…" : "一键生成缺图"
								})]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								...styles.card,
								display: "flex",
								alignItems: "center",
								gap: 18,
								flexWrap: "wrap",
								padding: "10px 16px",
								marginBottom: 16
							},
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ConfigChip, {
									label: "内容语言",
									value: LANGUAGES.find(([v]) => v === language)?.[1] ?? language,
									tone: "ok"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ConfigChip, {
									label: "头图",
									value: `${heroCount} 张`,
									tone: "accent"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ConfigChip, {
									label: "详情页",
									value: `${detailCount} 张`,
									tone: "warn"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ConfigChip, {
									label: "详情图比例",
									value: aspect
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										marginLeft: "auto",
										display: "flex",
										gap: 8
									},
									children: [
										hasSections ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
											variant: "ghost",
											onClick: () => setConfirmReplan(true),
											disabled: busy !== null,
											children: "重新规划"
										}) : null,
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
											onClick: doExport,
											disabled: busy !== null,
											children: busy === "export" ? "导出中…" : "导出 ZIP"
										}),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
											variant: "dark",
											onClick: () => doGenerateAll("all"),
											disabled: busy !== null,
											children: busy === "page-all" ? "生成中…" : "一键导出详情页图像"
										})
									]
								})
							]
						}),
						showConfig ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								...styles.card,
								marginBottom: 16
							},
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlanConfigForm, {
								heroCount,
								setHeroCount,
								detailCount,
								setDetailCount,
								aspect,
								setAspect,
								language,
								setLanguage,
								autoDecide,
								setAutoDecide,
								compact: true
							})
						}) : null,
						confirmReplan ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Notice, {
							kind: "error",
							children: ["重新规划会删除该项目全部分区、版本与已生成的图。", /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 8,
									display: "flex",
									gap: 8
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "danger",
									onClick: doPlan,
									disabled: busy !== null,
									children: "确认重新规划"
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									onClick: () => setConfirmReplan(false),
									children: "取消"
								})]
							})]
						}) : null,
						styleGuide ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: { marginBottom: 4 },
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: () => setShowStyleGuide((v) => !v),
								style: {
									background: "none",
									border: "none",
									color: T.mutedStrong,
									fontSize: 12,
									cursor: "pointer",
									padding: 0,
									marginBottom: showStyleGuide ? 8 : 16
								},
								children: [
									showStyleGuide ? "▾" : "▸",
									" 视觉风格契约 · ",
									styleGuide.styleName ?? "未命名"
								]
							}), showStyleGuide ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									...styles.card,
									marginBottom: 16,
									display: "grid",
									gap: 6
								},
								children: Object.entries(styleGuide).filter(([, v]) => v).map(([key, value]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: { fontSize: 12 },
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										style: { color: T.muted },
										children: key
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										style: {
											whiteSpace: "pre-wrap",
											marginTop: 2
										},
										children: value
									})]
								}, key))
							}) : null]
						}) : null
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: {
						flex: "1 1 auto",
						minHeight: 0,
						display: "flex",
						gap: 16,
						padding: "0 24px 24px"
					},
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ModuleTree, {
							sections: detail.sections,
							selectedId: selected?.id ?? null,
							onSelect: setSelectedId
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PhonePreview, {
							sections: detail.sections,
							selectedId: selected?.id ?? null,
							onSelect: setSelectedId
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ModuleEditPanel, {
							api,
							projectId: detail.project.id,
							section: selected,
							busy,
							run,
							reload,
							onGenerate: doGenerateOne,
							onOpenEditor
						})
					]
				})]
			});
		}
		function PlanConfigForm(props) {
			const { heroCount, setHeroCount, detailCount, setDetailCount, aspect, setAspect, language, setLanguage, autoDecide, setAutoDecide } = props;
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 14,
					flexWrap: "wrap"
				},
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "头图数量 (1–5)",
						style: { width: 130 },
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							type: "number",
							min: 1,
							max: 5,
							value: heroCount,
							onChange: (e) => setHeroCount(Number(e.target.value)),
							style: styles.input
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "详情分区 (1–10)",
						style: { width: 130 },
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							type: "number",
							min: 1,
							max: 10,
							value: detailCount,
							onChange: (e) => setDetailCount(Number(e.target.value)),
							style: styles.input
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "画幅",
						style: { width: 110 },
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
							value: aspect,
							onChange: (e) => setAspect(e.target.value),
							style: styles.input,
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
								value: "3:4",
								children: "3:4"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
								value: "9:16",
								children: "9:16"
							})]
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "图内文案语言",
						style: { width: 150 },
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", {
							value: language,
							onChange: (e) => setLanguage(e.target.value),
							style: styles.input,
							children: LANGUAGES.map(([value, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
								value,
								children: label
							}, value))
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
						label: "数量决策",
						style: { width: 130 },
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 6,
								fontSize: 12,
								color: T.mutedStrong,
								height: 36
							},
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: autoDecide,
								onChange: (e) => setAutoDecide(e.target.checked)
							}), "让 AI 决定"]
						})
					})
				]
			});
		}
		function ModuleTree(props) {
			const { sections, selectedId, onSelect } = props;
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: {
					width: 260,
					flex: "0 0 auto",
					display: "flex",
					flexDirection: "column",
					minHeight: 0
				},
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: { marginBottom: 10 },
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							fontWeight: 800,
							fontSize: 14
						},
						children: "模块结构树"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							color: T.muted,
							fontSize: 11.5,
							marginTop: 2,
							lineHeight: 1.5
						},
						children: "查看模块顺序、生成状态和当前选中的编辑对象。"
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					style: {
						overflowY: "auto",
						display: "grid",
						gap: 8,
						flex: "1 1 auto"
					},
					children: sections.map((section, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						type: "button",
						onClick: () => onSelect(section.id),
						style: {
							textAlign: "left",
							background: T.card,
							border: `1.5px solid ${section.id === selectedId ? T.dark : T.border}`,
							borderRadius: 12,
							boxShadow: T.shadowSm,
							padding: 12,
							cursor: "pointer",
							font: "inherit",
							color: T.text
						},
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									justifyContent: "space-between",
									alignItems: "flex-start",
									marginBottom: 4
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
									style: {
										color: T.muted,
										fontSize: 11
									},
									children: ["#", index + 1]
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
									tone: section.status === "SUCCESS" ? "ok" : section.status === "FAILED" ? "danger" : "muted",
									children: statusLabel(section.status) === "未开始" ? "未开始" : statusLabel(section.status)
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									fontWeight: 700,
									fontSize: 13,
									marginBottom: 4,
									lineHeight: 1.4
								},
								children: section.title
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									color: T.muted,
									fontSize: 11,
									marginBottom: 6
								},
								children: SECTION_TYPE_LABELS[section.type] ?? section.type
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 5
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: SECTION_TYPE_LABELS[section.type] ?? section.type }), section.imageUrl ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
									tone: "accent",
									children: "AI 真图"
								}) : null]
							})
						]
					}, section.id))
				})]
			});
		}
		function PhonePreview(props) {
			const { sections, selectedId, onSelect } = props;
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: {
					flex: "1 1 auto",
					minWidth: 0,
					display: "flex",
					flexDirection: "column",
					minHeight: 0
				},
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: { marginBottom: 10 },
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							fontWeight: 800,
							fontSize: 14
						},
						children: "手机商品页预览"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							color: T.muted,
							fontSize: 11.5,
							marginTop: 2,
							lineHeight: 1.5
						},
						children: "头图支持点击切换，详情图无缝衔接。"
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					style: {
						flex: "1 1 auto",
						display: "flex",
						justifyContent: "center",
						overflowY: "auto",
						paddingTop: 4
					},
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							width: 300,
							flex: "0 0 auto",
							background: "#0d0e12",
							borderRadius: 34,
							padding: 10,
							boxShadow: "0 20px 45px rgba(23,24,28,0.18)",
							height: "fit-content"
						},
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								background: T.card,
								borderRadius: 24,
								overflow: "hidden"
							},
							children: [sections.filter((section) => section.imageUrl).map((section) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
								src: section.imageUrl ?? void 0,
								alt: section.title,
								onClick: () => onSelect(section.id),
								style: {
									width: "100%",
									display: "block",
									cursor: "pointer",
									outline: section.id === selectedId ? `2px solid ${T.accent}` : "none",
									outlineOffset: -2
								}
							}, section.id)), sections.every((section) => !section.imageUrl) ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									padding: "60px 20px",
									textAlign: "center",
									color: T.muted,
									fontSize: 12
								},
								children: [
									"还没有生成任何图片",
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
									"在右侧或模块卡片上点「生成」"
								]
							}) : null]
						})
					})
				})]
			});
		}
		function ModuleEditPanel(props) {
			const { api, projectId, section, busy, run, reload, onGenerate, onOpenEditor } = props;
			if (!section) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				style: {
					width: 320,
					flex: "0 0 auto",
					...styles.card,
					height: "fit-content"
				},
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					style: {
						color: T.muted,
						fontSize: 12.5
					},
					children: "选择左侧模块查看详情"
				})
			});
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: {
					width: 320,
					flex: "0 0 auto",
					display: "flex",
					flexDirection: "column",
					minHeight: 0
				},
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: { marginBottom: 10 },
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							fontWeight: 800,
							fontSize: 14
						},
						children: "模块编辑面板"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							color: T.muted,
							fontSize: 11.5,
							marginTop: 2,
							lineHeight: 1.5
						},
						children: "编辑模块内容、发起生成与重绘，并管理版本历史。"
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: {
						...styles.card,
						overflowY: "auto",
						flex: "1 1 auto"
					},
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								marginBottom: 12
							},
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								style: {
									fontWeight: 700,
									fontSize: 12.5
								},
								children: "当前出图结果"
							}), section.imageUrl ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
								tone: "accent",
								children: "AI 真图"
							}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: "未生成" })]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								color: T.muted,
								fontSize: 11.5,
								marginBottom: 16,
								lineHeight: 1.6
							},
							children: "生成完成后会自动保存到项目资源、版本历史以及当前生效版本。"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
							label: "类型",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									...styles.input,
									background: T.cardMuted
								},
								children: SECTION_TYPE_LABELS[section.type] ?? section.type
							})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
							label: "标题",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									...styles.input,
									background: T.cardMuted
								},
								children: section.title
							})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
							label: "模块目标",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									...styles.input,
									background: T.cardMuted,
									minHeight: 40
								},
								children: section.goal
							})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
							label: "模块文案",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									...styles.input,
									background: T.cardMuted,
									minHeight: 60,
									whiteSpace: "pre-wrap"
								},
								children: section.copy || "—"
							})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
							label: "视觉 Prompt",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									...styles.mono,
									...styles.input,
									background: T.cardMuted,
									maxHeight: 140,
									overflowY: "auto"
								},
								children: section.visualPrompt || "—"
							})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 8,
								marginTop: 4
							},
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
								variant: "dark",
								full: true,
								disabled: busy !== null,
								onClick: () => onGenerate(section),
								children: busy === `gen-${section.id}` ? "生成中…" : section.imageUrl ? "重新生成" : "生成"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
								onClick: () => onOpenEditor(section.id),
								children: "详细编辑"
							})]
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/views/xiaohongshu.tsx
		/**
		* Xiaohongshu screen — the four-step carousel flow.
		*
		* Ported surface from upstream `components/xiaohongshu/xiaohongshu-flow.tsx`
		* (39 KB / 961 lines) + `xiaohongshu-flow-state.ts`.
		*
		* Upstream kept the draft in `localStorage` + IndexedDB because no server state
		* existed for XHS output. Here the draft lives in React state for the session
		* and the generated images are surfaced as data URLs, matching the service,
		* which never persists XHS output either.
		*/
		const ASPECTS = [
			"3:4",
			"1:1",
			"9:16"
		];
		function XiaohongshuView(props) {
			const { api, busy, run } = props;
			const [step, setStep] = (0, react.useState)(1);
			const [topic, setTopic] = (0, react.useState)("");
			const [imageCount, setImageCount] = (0, react.useState)(5);
			const [aspect, setAspect] = (0, react.useState)("3:4");
			const [plan, setPlan] = (0, react.useState)(null);
			const [pages, setPages] = (0, react.useState)([]);
			const [note, setNote] = (0, react.useState)(null);
			const [editTarget, setEditTarget] = (0, react.useState)(null);
			const [editPrompt, setEditPrompt] = (0, react.useState)("");
			const doPlan = () => run("xhs-plan", async () => {
				const result = await api.xhsPlan(topic, imageCount, aspect);
				setPlan(result.plan);
				setNote(`已规划 ${result.plan.pages?.length ?? 0} 页，请逐页确认 imagePrompt。`);
				setStep(2);
			});
			const doGenerate = () => run("xhs-generate", async () => {
				if (!plan) return;
				const result = await api.xhsGenerate(plan, aspect);
				setPages(result.pages);
				setNote(`已生成 ${result.pages.length} 页。`);
				setStep(4);
			});
			const doEdit = () => run("xhs-edit", async () => {
				if (!editTarget || !editPrompt.trim()) return;
				const result = await api.xhsEdit(editTarget.imageUrl, editPrompt, aspect);
				setPages((current) => current.map((page) => page.pageNumber === editTarget.pageNumber ? {
					...page,
					imageUrl: result.edited.imageUrl
				} : page));
				setEditTarget(null);
				setEditPrompt("");
				setNote(`第 ${editTarget.pageNumber} 页已修改。`);
			});
			const setPagePrompt = (pageNumber, value) => {
				setPlan((current) => {
					if (!current) return current;
					return {
						...current,
						pages: current.pages.map((page) => page.pageNumber === pageNumber ? {
							...page,
							imagePrompt: value
						} : page)
					};
				});
			};
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: {
					padding: 24,
					maxWidth: 880
				},
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(SectionHeading, {
						eyebrow: "内容创作",
						title: "小红书图文",
						description: "规划 → 审阅 → 生成 → 改图，四步走完成一组种草笔记配图。链路不落盘、不建项目，图只以引用形式返回。"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							...styles.row,
							marginBottom: 18
						},
						children: [
							1,
							2,
							3,
							4
						].map((value) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
							active: step === value,
							onClick: () => setStep(value),
							children: value === 1 ? "① 规划" : value === 2 ? "② 审阅" : value === 3 ? "③ 生成" : "④ 改图"
						}, value))
					}),
					note ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
						kind: "info",
						children: note
					}) : null,
					step === 1 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.card,
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "选题 / 商品角度",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
									value: topic,
									onChange: (event) => setTopic(event.target.value),
									placeholder: "例如：秋冬通勤保温杯怎么选",
									style: styles.input
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 10
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
									label: "页数 (3–8)",
									style: { width: 120 },
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										type: "number",
										min: 3,
										max: 8,
										value: imageCount,
										onChange: (event) => setImageCount(Number(event.target.value)),
										style: styles.input
									})
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
									label: "画幅",
									style: { width: 120 },
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", {
										value: aspect,
										onChange: (event) => setAspect(event.target.value),
										style: styles.input,
										children: ASPECTS.map((value) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value,
											children: value
										}, value))
									})
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
								variant: "dark",
								full: true,
								disabled: !topic.trim() || busy !== null,
								onClick: doPlan,
								style: { marginTop: 6 },
								children: busy === "xhs-plan" ? "规划中…" : "开始规划"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									color: T.muted,
									fontSize: 12,
									marginTop: 8
								},
								children: "模型不可用时会自动回退到完全本地的中文模板方案，仍然可用。"
							})
						]
					}) : null,
					step === 2 && plan ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.card,
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "审阅每页的 imagePrompt" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									color: T.muted,
									fontSize: 12,
									margin: "4px 0 12px"
								},
								children: "改完再生成。这一步不消耗额度。"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									display: "grid",
									gap: 12
								},
								children: plan.pages.map((page) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										border: `1px solid ${T.border}`,
										borderRadius: 6,
										padding: 10
									},
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
											style: {
												...styles.row,
												marginBottom: 6
											},
											children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, { children: [
												"第 ",
												page.pageNumber,
												" 页"
											] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: String(page.title ?? "") })]
										}),
										page.body ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
											style: {
												color: T.muted,
												fontSize: 12,
												marginBottom: 8,
												whiteSpace: "pre-wrap"
											},
											children: String(page.body)
										}) : null,
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
											rows: 4,
											value: String(page.imagePrompt ?? ""),
											onChange: (event) => setPagePrompt(page.pageNumber, event.target.value),
											style: {
												...styles.input,
												resize: "vertical",
												...styles.mono
											}
										})
									]
								}, page.pageNumber))
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									...styles.row,
									marginTop: 12
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "dark",
									disabled: busy !== null,
									onClick: () => setStep(3),
									children: "确认，进入生成"
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									onClick: () => setStep(1),
									children: "返回重来"
								})]
							})
						]
					}) : null,
					step === 3 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.card,
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "生成整组图" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
								kind: "info",
								children: "每页都会先跑 Visual Prompt Agent。**消耗付费图像额度** —— 确认后再开始。"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: { ...styles.row },
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "dark",
									disabled: !plan || busy !== null,
									onClick: doGenerate,
									children: busy === "xhs-generate" ? "生成中…" : `生成 ${plan?.pages.length ?? 0} 页`
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									onClick: () => setStep(2),
									children: "返回审阅"
								})]
							})
						]
					}) : null,
					step === 4 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.card,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("strong", { children: [
							"成品与改图（",
							pages.length,
							" 页）"
						] }), pages.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								color: T.muted,
								fontSize: 12,
								marginTop: 8
							},
							children: "还没有成品，先走第 ③ 步。"
						}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								display: "grid",
								gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
								gap: 12,
								marginTop: 12
							},
							children: pages.map((page) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									border: `1px solid ${T.border}`,
									borderRadius: 6,
									padding: 6
								},
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
										src: page.imageUrl,
										alt: page.title,
										style: {
											width: "100%",
											borderRadius: 4,
											display: "block",
											background: T.bg
										}
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
										style: {
											fontSize: 11,
											marginTop: 6,
											color: T.muted
										},
										children: [
											"第 ",
											page.pageNumber,
											" 页 · ",
											page.model
										]
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
										style: {
											...styles.row,
											marginTop: 6
										},
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
											onClick: () => {
												setEditTarget(page);
												setEditPrompt("");
											},
											children: "改图"
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
											href: page.imageUrl,
											download: `xiaohongshu-${page.pageNumber}.png`,
											style: {
												color: T.accent,
												fontSize: 12
											},
											children: "下载"
										})]
									})
								]
							}, page.pageNumber))
						})]
					}) : null,
					editTarget ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: {
							...styles.card,
							marginTop: 14
						},
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("strong", { children: [
								"改第 ",
								editTarget.pageNumber,
								" 页"
							] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "要改什么",
								hint: "例如：把标题改成「一杯顶三杯」，配色换成暖橙",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
									rows: 3,
									value: editPrompt,
									onChange: (event) => setEditPrompt(event.target.value),
									style: {
										...styles.input,
										resize: "vertical"
									}
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: styles.row,
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "dark",
									disabled: !editPrompt.trim() || busy !== null,
									onClick: doEdit,
									children: busy === "xhs-edit" ? "修改中…" : "提交修改"
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									onClick: () => setEditTarget(null),
									children: "取消"
								})]
							})
						]
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/panel.tsx
		/**
		* MxPage panel — the workbench shell.
		*
		* Rebuilt to match the actual upstream MxPage product layout: a left rail
		* with brand header + nav items + attribution footer, and a main canvas that
		* shows either the "upload to start" welcome state or the phone-preview
		* workbench once a project exists.
		*/
		const NAV = [
			[
				"planner",
				"规划",
				"📐"
			],
			[
				"editor",
				"编辑",
				"✏️"
			],
			[
				"xiaohongshu",
				"小红书图文",
				"📕"
			],
			[
				"channels",
				"AI 配置",
				"🔌"
			]
		];
		function LogoMark() {
			return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				style: {
					width: 32,
					height: 32,
					borderRadius: 9,
					background: T.dark,
					color: "#fff",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					fontSize: 13,
					fontWeight: 800,
					flex: "0 0 auto"
				},
				children: "M"
			});
		}
		function MxpagePanel(props) {
			const { api, onClose } = props;
			const [projects, setProjects] = (0, react.useState)([]);
			const [projectId, setProjectId] = (0, react.useState)(null);
			const [detail, setDetail] = (0, react.useState)(null);
			const [tab, setTab] = (0, react.useState)("planner");
			const [sectionId, setSectionId] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [dragOver, setDragOver] = (0, react.useState)(false);
			const fileInput = (0, react.useRef)(null);
			const reloadProjects = (0, react.useCallback)(async () => {
				try {
					const result = await api.listProjects();
					setProjects(result.projects);
					return result.projects;
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
					return [];
				}
			}, [api]);
			const reloadDetail = (0, react.useCallback)(async (id = projectId) => {
				if (!id) return;
				try {
					const result = await api.getProject(id);
					setDetail(result);
					setError(null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}, [api, projectId]);
			(0, react.useEffect)(() => {
				reloadProjects();
			}, [reloadProjects]);
			(0, react.useEffect)(() => {
				if (projectId) reloadDetail(projectId);
				else setDetail(null);
			}, [projectId, reloadDetail]);
			/** Serializes one async action behind the shared `busy` label. */
			const run = (0, react.useCallback)(async (label, action) => {
				setBusy(label);
				setError(null);
				try {
					await action();
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(null);
				}
			}, []);
			const createProject = (files) => run("create", async () => {
				if (files.length === 0) throw new Error("至少选择一张商品图");
				const first = files[0];
				const created = await api.createProjectWithUpload(first.name.replace(/\.[^.]+$/, ""), files);
				await reloadProjects();
				setProjectId(created.projectId);
			});
			return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				style: styles.root,
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: styles.body,
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.rail,
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 10,
									padding: "4px 6px 14px"
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LogoMark, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									style: {
										fontWeight: 800,
										fontSize: 15,
										lineHeight: 1.2
									},
									children: "MxPage"
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 10.5,
										color: T.muted
									},
									children: "AI 商品图文工作台"
								})] })]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									display: "grid",
									gap: 2,
									marginBottom: 10
								},
								children: NAV.map(([value, label, icon]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
									variant: "nav",
									active: tab === value,
									onClick: () => setTab(value),
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										style: { fontSize: 14 },
										children: icon
									}), label]
								}, value))
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 11,
									color: T.muted,
									fontWeight: 700,
									padding: "10px 10px 6px"
								},
								children: [
									"项目（",
									projects.length,
									"）"
								]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									display: "grid",
									gap: 2,
									overflowY: "auto",
									flex: "1 1 auto",
									minHeight: 60
								},
								children: projects.map((project) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
									type: "button",
									onClick: () => {
										setProjectId(project.id);
										setSectionId(null);
									},
									style: {
										display: "flex",
										gap: 8,
										alignItems: "center",
										textAlign: "left",
										background: project.id === projectId ? T.accentSoft : "transparent",
										border: "none",
										borderRadius: 8,
										padding: "6px 8px",
										color: T.text,
										font: "inherit",
										cursor: "pointer"
									},
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										style: {
											width: 26,
											height: 26,
											flex: "0 0 auto",
											borderRadius: 6,
											border: `1px solid ${T.border}`,
											background: T.cardMuted,
											overflow: "hidden"
										},
										children: project.coverImageUrl ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
											src: project.coverImageUrl,
											alt: "",
											style: {
												width: "100%",
												height: "100%",
												objectFit: "cover"
											}
										}) : null
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										style: {
											minWidth: 0,
											flex: "1 1 auto",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											fontSize: 12.5
										},
										children: project.name
									})]
								}, project.id))
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									borderTop: `1px solid ${T.border}`,
									marginTop: 10,
									paddingTop: 12
								},
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 10.5,
											color: T.muted
										},
										children: "出品方"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12.5,
											fontWeight: 700,
											margin: "2px 0 6px"
										},
										children: "灵矩绘境 · MxPage"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
										variant: "ghost",
										onClick: onClose,
										style: {
											padding: "6px 0",
											color: T.muted
										},
										children: "关闭面板"
									})
								]
							})
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.main,
						children: [error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
							kind: "error",
							children: error
						}) : null, tab === "channels" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChannelsView, { api }) : tab === "xiaohongshu" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(XiaohongshuView, {
							api,
							busy,
							run
						}) : !detail ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(WelcomeUpload, {
							busy,
							dragOver,
							setDragOver,
							fileInput,
							onFiles: createProject
						}) : tab === "planner" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlannerView, {
							api,
							detail,
							busy,
							run,
							reload: () => reloadDetail(),
							onOpenEditor: (id) => {
								setSectionId(id);
								setTab("editor");
							}
						}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EditorView, {
							api,
							detail,
							busy,
							run,
							reload: () => reloadDetail(),
							selectedSectionId: sectionId,
							onSelectSection: setSectionId
						})]
					})]
				})
			});
		}
		/** The upstream "上传产品图片" welcome / drop-zone state. */
		function WelcomeUpload(props) {
			const { busy, dragOver, setDragOver, fileInput, onFiles } = props;
			const [staged, setStaged] = (0, react.useState)([]);
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: {
					flex: "1 1 auto",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					textAlign: "center",
					padding: 40
				},
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 28,
							fontWeight: 800,
							letterSpacing: "-0.01em"
						},
						children: "上传产品图片"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							color: T.muted,
							fontSize: 13.5,
							marginTop: 8,
							marginBottom: 28
						},
						children: "上传一张产品白底图，AI 将自动分析产品信息"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						onDragOver: (event) => {
							event.preventDefault();
							setDragOver(true);
						},
						onDragLeave: () => setDragOver(false),
						onDrop: (event) => {
							event.preventDefault();
							setDragOver(false);
							const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
							if (files.length) setStaged(files);
						},
						onClick: () => fileInput.current?.click(),
						style: {
							width: "min(560px, 90%)",
							minHeight: 260,
							background: T.card,
							border: `1.5px dashed ${dragOver ? T.accent : T.borderStrong}`,
							borderRadius: 18,
							boxShadow: T.shadow,
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							justifyContent: "center",
							gap: 14,
							cursor: "pointer",
							padding: 24
						},
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
								ref: fileInput,
								type: "file",
								accept: "image/*",
								multiple: true,
								hidden: true,
								onChange: (event) => setStaged(Array.from(event.target.files ?? []))
							}),
							staged.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									gap: 8,
									flexWrap: "wrap",
									justifyContent: "center"
								},
								children: staged.slice(0, 5).map((file, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
									src: URL.createObjectURL(file),
									alt: "",
									style: {
										width: 64,
										height: 64,
										objectFit: "cover",
										borderRadius: 10,
										border: `1px solid ${T.border}`
									}
								}, index))
							}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								style: {
									width: 52,
									height: 52,
									borderRadius: 999,
									background: T.cardMuted,
									border: `1px solid ${T.border}`,
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									fontSize: 20
								},
								children: "⬆"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									fontWeight: 700,
									fontSize: 14.5
								},
								children: "点击上传产品图片"
							})] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									color: T.muted,
									fontSize: 11.5
								},
								children: "支持 JPG、PNG、WEBP，建议使用清晰的白底主图"
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						variant: "dark",
						disabled: staged.length === 0 || busy !== null,
						onClick: () => onFiles(staged),
						style: {
							marginTop: 22,
							padding: "11px 32px",
							fontSize: 13.5
						},
						children: busy === "create" ? "创建中…" : "⬆ 开始分析"
					})
				]
			});
		}
		//#endregion
		//#region src/client/mount.tsx
		/**
		* Panel view mounting.
		*
		* The `conversation` slot is single-occupant and external plugins cannot declare
		* slots, so the panel takes over the centre column at the DOM level: a container
		* is appended inside the conversation grid item (an extra trailing child React
		* never manages). Toggling is the container's own `display`, driven by a data
		* attribute on `<html>` so cross-panel exclusivity and the sidebar toggle stay
		* in sync — but nothing else in the DOM is touched.
		*
		* INCIDENT (fixed here): an earlier version additionally forced every sibling
		* in the centre column to `display:none!important` while the panel was active,
		* on the theory that the panel's own `position:absolute` cover was not enough.
		* That rule fires from the CSS alone, independent of whether the panel's host
		* element actually mounted. When `conversationColumn()` failed to resolve
		* (selector mismatch against a shell version, or called before the frame
		* finished rendering), `ensure()` bailed out with no host created, but `sync()`
		* ran anyway and still set the active attribute — blanking the entire
		* conversation column with nothing to show in its place. Reported in production
		* as "the whole main area goes black, only the sidebar still works". Fixed by
		* removing the sibling-hiding rule entirely: the panel's own opaque, absolutely
		* positioned, z-indexed host is sufficient to cover the conversation when it is
		* actually mounted, and a mount failure now degrades to "the panel doesn't
		* appear" rather than "the app goes black".
		*/
		const PANEL_SELECTOR = "[data-dsh-mxpage-view]";
		const TOGGLE_SELECTOR = "[data-dsh-mxpage-toggle]";
		const CONVERSATION_COLUMN_SELECTOR = "[data-pane=\"conversation\"], [class*=\"centerCol\"]";
		const ACTIVE_ATTR = "data-dsh-mxpage-active";
		const PANEL_NAME = "mxpage";
		const ACTIVATE_EVENT = "dsh-panel-activate";
		/** Sibling panels' activation attributes, removed when this panel opens. */
		const OTHER_ACTIVE_ATTRS = [
			"data-dsh-imagegen-active",
			"data-dsh-taskboard-active",
			"data-dsh-ssh-active"
		];
		const STYLE_ID = "dsh-mxpage-panel-style";
		/**
		* Only the panel's OWN visibility is CSS-driven. There is deliberately no rule
		* that reaches outside `PANEL_SELECTOR` — see the incident note above.
		*/
		const STYLESHEET = `
		${PANEL_SELECTOR} {
		  position: absolute;
		  inset: 0;
		  display: none;
		  z-index: 5;
		  background: #0f1115;
		}
		html[${ACTIVE_ATTR}] ${PANEL_SELECTOR} { display: block; }
		${CONVERSATION_COLUMN_SELECTOR} { position: relative; }
		`;
		function conversationColumn() {
			return document.querySelector(CONVERSATION_COLUMN_SELECTOR) ?? void 0;
		}
		function ensureStylesheet() {
			if (document.getElementById(STYLE_ID) !== null) return () => {};
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = STYLESHEET;
			document.head.append(style);
			return () => style.remove();
		}
		/**
		* Mounts the panel container into the centre column and returns a handle. The
		* container stays in the DOM (hidden) once mounted, so panel state survives
		* opening and closing.
		*/
		function mountPanel() {
			const api = new MxpageApi();
			const removeStyles = ensureStylesheet();
			let host;
			let root;
			let open = false;
			/**
			* Reflects `open` onto the DOM. Guarded: the active attribute is only ever
			* set when a real host element exists, so a failed mount cannot blank
			* anything — worst case the toggle silently does nothing.
			*/
			const sync = () => {
				const html = document.documentElement;
				const canShow = open && host !== void 0;
				if (canShow) {
					for (const attr of OTHER_ACTIVE_ATTRS) html.removeAttribute(attr);
					html.setAttribute(ACTIVE_ATTR, "");
					window.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
				} else html.removeAttribute(ACTIVE_ATTR);
				const toggle = document.querySelector(TOGGLE_SELECTOR);
				if (toggle !== null) {
					if (canShow) toggle.dataset.active = "";
					else delete toggle.dataset.active;
				}
			};
			const ensure = () => {
				if (host !== void 0 && !host.isConnected) {
					host = void 0;
					root = void 0;
				}
				if (host !== void 0) return;
				const column = conversationColumn();
				if (column === void 0) return;
				host = document.createElement("div");
				host.dataset.dshMxpageView = "";
				column.append(host);
				root = (0, import_client.createRoot)(host);
			};
			/** Renders (or re-renders) the panel tree. Never lets a render error escape. */
			const render = () => {
				if (root === void 0) return;
				try {
					root.render(/* @__PURE__ */ (0, import_jsx_runtime.jsx)(MxpagePanel, {
						api,
						onClose: () => handle.close()
					}));
				} catch (error) {
					console.warn("[dsh-mxpage] panel render failed, closing:", error);
					open = false;
					sync();
				}
			};
			const handle = {
				open() {
					open = true;
					ensure();
					if (host === void 0) {
						console.warn("[dsh-mxpage] could not locate the conversation column; panel not shown.");
						open = false;
						return;
					}
					sync();
					render();
				},
				close() {
					open = false;
					sync();
				},
				toggle() {
					if (open) handle.close();
					else handle.open();
				},
				isOpen: () => open,
				dispose() {
					open = false;
					sync();
					root?.unmount();
					host?.remove();
					removeStyles();
				}
			};
			const observer = new MutationObserver(() => {
				if (!open) return;
				const hadHost = host !== void 0;
				ensure();
				if (host === void 0) {
					if (hadHost) {
						open = false;
						sync();
					}
					return;
				}
				if (!hadHost) render();
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
			const onActivate = (event) => {
				if (event.detail !== PANEL_NAME && open) handle.close();
			};
			window.addEventListener(ACTIVATE_EVENT, onActivate);
			const originalDispose = handle.dispose;
			handle.dispose = () => {
				observer.disconnect();
				window.removeEventListener(ACTIVATE_EVENT, onActivate);
				originalDispose();
			};
			return handle;
		}
		/**
		* Adds a sidebar button that toggles the panel. Placed in the sidebar header
		* row when found, and next to the shell's own "设置" utility button otherwise
		* — either way it degrades to a self-contained, high-contrast pill rather than
		* inheriting ambient text color, which previously rendered as invisible plain
		* text against a dark sidebar (no icon, no background, effectively no button)
		* when the host's own text/icon colors did not resolve the way `color:
		* inherit` assumed.
		*/
		function mountSidebarToggle(onToggle, label, tooltip) {
			let button;
			/** Pins the button right above the session-list region (`regionArea`), i.e.
			* directly under the 新会话/生图 row. Returns false while the shell has not
			* rendered that region yet. Anchoring on `newSession` itself is unreliable:
			* in some shells it IS the row button whose parent is the whole sidebar
			* root, so inserting after its parent drops the toggle below all content. */
			const pin = (column) => {
				if (button === void 0) return false;
				const region = column.querySelector("[class*=\"regionArea\"]");
				if (region?.parentElement) {
					if (button.nextSibling !== region) region.parentElement.insertBefore(button, region);
					return true;
				}
				return false;
			};
			/**
			* Theme-aware foreground/background for the toggle. The colors were once
			* hardcoded light-on-dark (#f3f4f6 text, white-alpha fill) — invisible when
			* the shell sidebar renders in a LIGHT theme (white text on a white
			* sidebar). Instead of trusting `prefers-color-scheme` (the shell theme may
			* not follow the OS setting), walk up from the sidebar column to the first
			* non-transparent computed background and pick contrast colors from its
			* luminance. Recomputed on every ensure(), so a live theme switch corrects
			* the button on the next DOM mutation.
			*/
			const themeFor = (column) => {
				let el = column;
				let bg = "rgba(0, 0, 0, 0)";
				while (el) {
					const c = getComputedStyle(el).backgroundColor;
					const m = c.match(/rgba?\(([^)]+)\)/);
					if (m) {
						const parts = m[1].split(",").map((s) => Number.parseFloat(s));
						if ((parts.length > 3 ? parts[3] : 1) > .01) {
							bg = c;
							break;
						}
					}
					el = el.parentElement;
				}
				const m = bg.match(/rgba?\(([^)]+)\)/);
				const parts = m ? m[1].split(",").map((s) => Number.parseFloat(s)) : [
					255,
					255,
					255
				];
				return (.2126 * lin(parts[0]) + .7152 * lin(parts[1]) + .0722 * lin(parts[2])) / 255 < .5 ? {
					fg: "#f3f4f6",
					bg: "rgba(255,255,255,0.06)",
					bgHover: "rgba(255,255,255,0.12)",
					border: "rgba(255,255,255,0.1)"
				} : {
					fg: "#1f2329",
					bg: "rgba(0,0,0,0.05)",
					bgHover: "rgba(0,0,0,0.09)",
					border: "rgba(0,0,0,0.1)"
				};
			};
			const lin = (v) => {
				const s = v / 255;
				return (s <= .03928 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4) * 255;
			};
			const applyTheme = (column) => {
				if (button === void 0) return;
				const t = themeFor(column);
				button.dataset.mxBg = t.bg;
				button.dataset.mxBgHover = t.bgHover;
				button.style.color = t.fg;
				button.style.background = t.bg;
				button.style.border = `1px solid ${t.border}`;
			};
			const ensure = () => {
				const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
				if (column === null) return;
				if (button !== void 0 && button.isConnected) {
					applyTheme(column);
					pin(column);
					return;
				}
				const target = column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
				if (target === void 0) return;
				button = document.createElement("button");
				button.type = "button";
				button.dataset.dshMxpageToggle = "";
				button.setAttribute("aria-label", label);
				button.title = tooltip;
				button.innerHTML = `<span style="display:inline-flex;align-items:center;gap:7px;font:inherit;color:inherit"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:0 0 auto"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6.5h12M5.5 9.5h5"/></svg><span style="color:inherit">${label}</span></span>`;
				button.style.cssText = "display:flex;align-items:center;width:100%;margin:6px 0 0;padding:7px 10px;border-radius:8px;cursor:pointer;font-size:13px;line-height:1.3;transition:background .15s";
				applyTheme(column);
				button.addEventListener("mouseenter", () => {
					if (button) button.style.background = button.dataset.mxBgHover ?? button.style.background;
				});
				button.addEventListener("mouseleave", () => {
					if (button) button.style.background = button.dataset.mxBg ?? button.style.background;
				});
				button.addEventListener("click", onToggle);
				if (!pin(column)) target.append(button);
			};
			const observer = new MutationObserver(ensure);
			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
			ensure();
			return () => {
				observer.disconnect();
				button?.remove();
			};
		}
		//#endregion
		//#region src/client/settings-card.tsx
		/**
		* The `mxpage` settings card: registered into the real `settings.plugin.item`
		* slot (设置 → 插件 → MxPage), the same mechanism `@dickpy/dsh-imagegen` uses
		* for its own card.
		*
		* BACKGROUND: an earlier version of this plugin mounted its panel and sidebar
		* toggle with hand-rolled DOM queries (`document.querySelector` +
		* `MutationObserver`) and registered no settings card at all. The host
		* `ctx.settings.installSection` call in `src/index.ts` makes the `mxpage`
		* namespace exist, but nothing rendered a form for it: 设置 → 插件 → MxPage
		* had no card because no plugin ever contributed one to
		* `settings.plugin.item`. That slot is keyed by settings namespace and
		* dispatched by `@deepseek-ai/dsh-client-ui-settings-plugins`'s configurable
		* tab; a plugin distributed outside the host repo earns its card by
		* registering here, in its OWN client bundle — the tab never learns what a
		* namespace means, it only pairs a served namespace with whichever card
		* claimed that key.
		*
		* The channel list is staged as one JSON blob (`set` on the `channels` path)
		* rather than field-by-field, because upstream MxPage's channel shape is
		* itself a list of objects — there is no single scalar path per channel field
		* the generic `CardForm` text/number controls model.
		*/
		const CARD_STYLE = {
			display: "grid",
			gap: 10
		};
		const ROW_STYLE = {
			border: "1px solid var(--dsw-alias-border-l4, #33343a)",
			borderRadius: 8,
			padding: 10,
			display: "grid",
			gap: 8
		};
		const LABEL_STYLE = {
			fontSize: 12,
			color: "var(--dsw-alias-label-secondary, #9a9ba3)",
			display: "block",
			marginBottom: 4
		};
		const INPUT_STYLE = {
			width: "100%",
			boxSizing: "border-box",
			border: "1px solid var(--dsw-alias-border-l4, #33343a)",
			background: "var(--dsw-alias-bg-layer-3, #1c1d21)",
			color: "var(--dsw-alias-label-primary, #f3f4f6)",
			borderRadius: 8,
			padding: "6px 10px",
			fontSize: 13,
			lineHeight: 1.5,
			font: "inherit"
		};
		const BUTTON_STYLE = {
			border: "1px solid var(--dsw-alias-border-l4, #33343a)",
			background: "transparent",
			color: "inherit",
			borderRadius: 8,
			padding: "5px 10px",
			fontSize: 12,
			cursor: "pointer"
		};
		const PRIMARY_BUTTON_STYLE = {
			...BUTTON_STYLE,
			background: "var(--dsw-alias-brand-primary, #ff5b30)",
			borderColor: "transparent",
			color: "#fff",
			fontWeight: 600
		};
		let channelSeq = 0;
		function freshChannelId() {
			channelSeq += 1;
			return `channel-${Date.now().toString(36)}-${channelSeq}`;
		}
		function emptyChannel() {
			return {
				id: freshChannelId(),
				label: "",
				baseUrl: "",
				apiKey: "",
				models: []
			};
		}
		/** Comma/newline separated model list <-> array. */
		function modelsToText(models) {
			return (models ?? []).join(", ");
		}
		function textToModels(text) {
			return text.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
		}
		function ChannelRow(props) {
			const { channel, disabled, onChange, onRemove } = props;
			const [showKey, setShowKey] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: ROW_STYLE,
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center"
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", {
							style: { fontSize: 13 },
							children: channel.label?.trim() || channel.id
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: BUTTON_STYLE,
							disabled,
							onClick: onRemove,
							children: "删除"
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
						style: LABEL_STYLE,
						children: "渠道标识（id）"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						style: INPUT_STYLE,
						value: channel.id,
						disabled,
						onChange: (event) => onChange({
							...channel,
							id: event.target.value
						})
					})] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
						style: LABEL_STYLE,
						children: "显示名（可选）"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						style: INPUT_STYLE,
						value: channel.label ?? "",
						disabled,
						placeholder: "例如：xAI（Grok）",
						onChange: (event) => onChange({
							...channel,
							label: event.target.value
						})
					})] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
						style: LABEL_STYLE,
						children: "Base URL（OpenAI 兼容）"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						style: INPUT_STYLE,
						value: channel.baseUrl,
						disabled,
						placeholder: "https://api.example.com/v1",
						onChange: (event) => onChange({
							...channel,
							baseUrl: event.target.value
						})
					})] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
						style: LABEL_STYLE,
						children: "API Key"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 6
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							style: {
								...INPUT_STYLE,
								flex: 1
							},
							type: showKey ? "text" : "password",
							value: channel.apiKey ?? "",
							disabled,
							placeholder: "sk-...",
							onChange: (event) => onChange({
								...channel,
								apiKey: event.target.value
							})
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: BUTTON_STYLE,
							disabled,
							onClick: () => setShowKey((v) => !v),
							children: showKey ? "隐藏" : "显示"
						})]
					})] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
						style: LABEL_STYLE,
						children: "图像模型（逗号分隔；留空则用 GET /models 自动发现）"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						style: INPUT_STYLE,
						value: modelsToText(channel.models),
						disabled,
						placeholder: "grok-imagine-image-2.0, gpt-image-2",
						onChange: (event) => onChange({
							...channel,
							models: textToModels(event.target.value)
						})
					})] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
						style: {
							...LABEL_STYLE,
							display: "flex",
							alignItems: "center",
							gap: 6
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: channel.disabled === true,
							disabled,
							onChange: (event) => onChange({
								...channel,
								disabled: event.target.checked
							})
						}), "禁用此渠道"]
					})
				]
			});
		}
		/**
		* Self-contained channel editor. Stages edits locally (React state) and
		* writes the whole `channels` array in one `mutate([{ op: 'set', path:
		* ['channels'], value }])` call on Save — mirroring the staged-then-committed
		* discipline every other settings card in the host uses, without pulling in
		* the generic per-scalar-field `CardForm` (channels are a list of objects,
		* not a flat field set).
		*/
		function MxpageSettingsCard(props) {
			const { scope } = props;
			const snapshot = (0, react.useSyncExternalStore)((listener) => scope.subscribe(listener), () => scope.getSnapshot());
			const [draft, setDraft] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const stored = snapshot.value?.channels ?? [];
			if (snapshot.status === "unavailable") return null;
			const channels = draft ?? stored;
			const dirty = draft !== null;
			const disabled = snapshot.writable === false || saving;
			const setChannels = (next) => {
				setDraft(next);
				setError(null);
			};
			const handleSave = async () => {
				if (draft === null) return;
				setSaving(true);
				setError(null);
				try {
					await scope.mutate([{
						op: "set",
						path: ["channels"],
						value: draft
					}], snapshot.revision);
					setDraft(null);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setSaving(false);
				}
			};
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: CARD_STYLE,
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
						style: {
							margin: 0,
							fontSize: 12,
							color: "var(--dsw-alias-label-tertiary, #6b6c74)"
						},
						children: [
							"渠道用于连接 OpenAI 兼容的图像/文本模型网关。配置至少一个渠道后，",
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "mxpage_*" }),
							" 工具才能分析商品、规划页面并生成图片。"
						]
					}),
					channels.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						style: {
							margin: 0,
							fontSize: 13,
							color: "var(--dsw-alias-label-secondary, #9a9ba3)"
						},
						children: "还没有配置任何渠道。"
					}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							display: "grid",
							gap: 8
						},
						children: channels.map((channel, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChannelRow, {
							channel,
							disabled,
							onChange: (next) => {
								const nextList = channels.slice();
								nextList[index] = next;
								setChannels(nextList);
							},
							onRemove: () => {
								const nextList = channels.slice();
								nextList.splice(index, 1);
								setChannels(nextList);
							}
						}, channel.id || index))
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: BUTTON_STYLE,
							disabled,
							onClick: () => setChannels([...channels, emptyChannel()]),
							children: "+ 添加渠道"
						}), dirty ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: PRIMARY_BUTTON_STYLE,
							disabled,
							onClick: handleSave,
							children: saving ? "保存中…" : "保存"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							style: BUTTON_STYLE,
							disabled: saving,
							onClick: () => setDraft(null),
							children: "放弃修改"
						})] }) : null]
					}),
					error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						style: {
							margin: 0,
							fontSize: 12,
							color: "var(--dsw-alias-label-error, #f87171)"
						},
						children: error
					}) : null,
					snapshot.writable === false ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						style: {
							margin: 0,
							fontSize: 12,
							color: "var(--dsw-alias-label-tertiary, #6b6c74)"
						},
						children: "当前设置文档为只读，无法保存修改。"
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** The settings namespace this plugin's host half registers (src/index.ts). */
		const SETTINGS_NAMESPACE = "mxpage";
		/**
		* `settingsScope` and `slots` come from optional child fibers: a shell
		* version without either simply never mounts the settings card, degrading to
		* "no card" rather than a failed boot. `connection` is read opportunistically
		* (see below), never injected, for the same reason.
		*/
		const inject = [];
		function apply(ctx) {
			const disposers = [];
			try {
				const panel = mountPanel();
				disposers.push(() => panel.dispose());
				disposers.push(mountSidebarToggle(() => panel.toggle(), "MxPage", "打开 MxPage 电商图文工作台"));
				try {
					const connection = ctx.get("connection");
					if (connection && connection.isLoopback === false) console.warn("[dsh-mxpage] opened from a non-loopback origin: the panel bridge is loopback-only, so requests will be refused.");
				} catch {}
			} catch (error) {
				console.warn("[dsh-mxpage] panel mount failed:", error);
			}
			ctx.inject(["settingsScope", "slots"], (sctx) => {
				sctx.effect(() => {
					const scope = sctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
					return sctx.slots.inject("settings.plugin.item", () => sctx.slots.register({
						name: "settings.plugin.item",
						key: SETTINGS_NAMESPACE,
						inject: () => ({ scope })
					}, MxpageSettingsCard));
				});
			});
			ctx.effect(() => () => {
				for (const dispose of disposers) try {
					dispose();
				} catch {}
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;

		return module.exports;
	}
});
