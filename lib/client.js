window.__ModuleLoader__.load({
	id: "dsh-mxpage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
			bg: "#0f1115",
			panel: "#161a21",
			raised: "#1d222b",
			border: "#2a3040",
			text: "#e6e9ef",
			muted: "#9aa4b8",
			accent: "#5b8def",
			accentSoft: "rgba(91,141,239,0.14)",
			ok: "#3fb950",
			warn: "#d29922",
			danger: "#f85149",
			radius: 8
		};
		const styles = {
			root: {
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minHeight: 0,
				background: T.bg,
				color: T.text,
				font: "13px/1.5 ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif"
			},
			header: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "10px 14px",
				borderBottom: `1px solid ${T.border}`,
				background: T.panel,
				flex: "0 0 auto"
			},
			body: {
				display: "flex",
				flex: "1 1 auto",
				minHeight: 0
			},
			rail: {
				width: 240,
				flex: "0 0 auto",
				borderRight: `1px solid ${T.border}`,
				background: T.panel,
				overflowY: "auto",
				padding: 8,
				display: "flex",
				flexDirection: "column",
				gap: 6
			},
			main: {
				flex: "1 1 auto",
				minWidth: 0,
				overflowY: "auto",
				padding: 16
			},
			card: {
				background: T.raised,
				border: `1px solid ${T.border}`,
				borderRadius: T.radius,
				padding: 12
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			tabs: {
				display: "flex",
				gap: 4
			},
			input: {
				width: "100%",
				boxSizing: "border-box",
				background: T.bg,
				color: T.text,
				border: `1px solid ${T.border}`,
				borderRadius: 6,
				padding: "6px 8px",
				font: "inherit",
				outline: "none"
			},
			mono: {
				font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				margin: 0
			}
		};
		function Button(props) {
			const { variant = "default", disabled, active } = props;
			const background = variant === "primary" ? T.accent : variant === "danger" ? "rgba(248,81,73,0.14)" : variant === "ghost" ? "transparent" : active ? T.accentSoft : T.raised;
			const color = variant === "primary" ? "#fff" : variant === "danger" ? T.danger : active ? T.accent : T.text;
			return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				title: props.title,
				disabled,
				onClick: props.onClick,
				style: {
					background,
					color,
					border: `1px solid ${active ? T.accent : T.border}`,
					borderRadius: 6,
					padding: "5px 10px",
					font: "inherit",
					cursor: disabled ? "not-allowed" : "pointer",
					opacity: disabled ? .5 : 1,
					whiteSpace: "nowrap",
					...props.style
				},
				children: props.children
			});
		}
		function Field(props) {
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
				style: {
					display: "block",
					marginBottom: 10,
					...props.style
				},
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						style: {
							display: "block",
							color: T.muted,
							marginBottom: 4,
							fontSize: 12
						},
						children: props.label
					}),
					props.children,
					props.hint ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						style: {
							display: "block",
							color: T.muted,
							fontSize: 11,
							marginTop: 4
						},
						children: props.hint
					}) : null
				]
			});
		}
		function Badge(props) {
			const tone = props.tone ?? "muted";
			const color = tone === "ok" ? T.ok : tone === "warn" ? T.warn : tone === "danger" ? T.danger : T.muted;
			return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				style: {
					display: "inline-block",
					padding: "1px 7px",
					borderRadius: 999,
					fontSize: 11,
					color,
					border: `1px solid ${color}44`,
					background: `${color}14`,
					whiteSpace: "nowrap"
				},
				children: props.children
			});
		}
		function statusTone(status) {
			if (status === "SUCCESS") return "ok";
			if (status === "GENERATING") return "warn";
			if (status === "FAILED") return "danger";
			return "muted";
		}
		function Notice(props) {
			const color = props.kind === "error" ? T.danger : props.kind === "success" ? T.ok : T.accent;
			return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				style: {
					border: `1px solid ${color}55`,
					background: `${color}12`,
					color,
					borderRadius: 6,
					padding: "8px 10px",
					marginBottom: 12,
					fontSize: 12
				},
				children: props.children
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
					display: "grid",
					gap: 14
				},
				children: [
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
		* Editor screen — per-section editing and version control.
		*
		* Ported surface from upstream `components/editor/editor-workspace.tsx`
		* (55 KB / 1163 lines). Covers: the section picker, the current image preview,
		* inline editing of title/goal/copy/visualPrompt, generate / regenerate /
		* repaint / enhance / translate, and version list + activate.
		*
		* Upstream rendered a phone-frame page preview; that is presentation, and the
		* behaviour worth keeping is here: every generation creates a NEW version and
		* never overwrites, so the version list is the undo history.
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
					display: "flex",
					gap: 14,
					alignItems: "flex-start"
				},
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: {
						width: 220,
						flex: "0 0 auto",
						display: "grid",
						gap: 4
					},
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								color: T.muted,
								fontSize: 12,
								padding: "0 4px 4px"
							},
							children: [
								"分区 (",
								detail.sections.length,
								")"
							]
						}),
						detail.sections.map((section) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: () => onSelectSection(section.id),
							style: {
								textAlign: "left",
								background: section.id === selected?.id ? T.accentSoft : "transparent",
								border: `1px solid ${section.id === selected?.id ? T.accent : T.border}`,
								borderRadius: 6,
								color: T.text,
								padding: "6px 8px",
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
									whiteSpace: "nowrap"
								},
								children: section.title
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
								tone: statusTone(section.status),
								children: section.imageUrl ? "有图" : section.status
							})]
						}, section.id)),
						detail.sections.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								color: T.muted,
								fontSize: 12,
								padding: 4
							},
							children: "还没有分区"
						}) : null
					]
				}), selected ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SectionEditor, {
					api,
					detail,
					section: selected,
					busy,
					run,
					reload
				}, selected.id) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					style: { color: T.muted },
					children: "先在「规划」页生成分区。"
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
					display: "grid",
					gap: 14
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
							gap: 14,
							alignItems: "flex-start"
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								width: 220,
								flex: "0 0 auto",
								borderRadius: 8,
								border: `1px solid ${T.border}`,
								background: T.bg,
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
									padding: 20
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
										marginBottom: 10,
										flexWrap: "wrap"
									},
									children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: section.type }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
											tone: statusTone(section.status),
											children: section.status
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
											variant: "primary",
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
										marginTop: 8,
										flexWrap: "wrap"
									},
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", {
										value: translateTo,
										onChange: (event) => setTranslateTo(event.target.value),
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
									marginBottom: 8
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "分区内容" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									style: styles.row,
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
										disabled: !dirty || busy !== null,
										onClick: save,
										children: busy === `save-${section.id}` ? "保存中…" : dirty ? "保存修改" : "已保存"
									})
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "标题",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
									value: title,
									onChange: (event) => setTitle(event.target.value),
									style: styles.input
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "目标",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
									value: goal,
									onChange: (event) => setGoal(event.target.value),
									style: styles.input
								})
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
								label: "图内文案",
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
									rows: 3,
									value: copy,
									onChange: (event) => setCopy(event.target.value),
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
									onChange: (event) => setVisualPrompt(event.target.value),
									style: {
										...styles.input,
										resize: "vertical"
									}
								})
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.card,
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("strong", { children: [
								"版本历史（",
								versions.length,
								"）"
							] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: {
									color: T.muted,
									fontSize: 12,
									margin: "4px 0 10px"
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
									gap: 8,
									flexWrap: "wrap"
								},
								children: versions.slice().sort((a, b) => b.versionNumber - a.versionNumber).map((version) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
									type: "button",
									onClick: () => activate(version.id),
									disabled: busy !== null || version.isActive,
									style: {
										width: 90,
										padding: 4,
										background: version.isActive ? T.accentSoft : T.panel,
										border: `1px solid ${version.isActive ? T.accent : T.border}`,
										borderRadius: 6,
										color: T.text,
										font: "inherit",
										cursor: version.isActive ? "default" : "pointer"
									},
									children: [version.imageUrl ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
										src: version.imageUrl,
										alt: `v${version.versionNumber}`,
										style: {
											width: "100%",
											height: 68,
											objectFit: "cover",
											borderRadius: 4,
											display: "block"
										}
									}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { height: 68 } }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
										style: {
											fontSize: 11,
											marginTop: 4
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
		* Planner screen — the section planning cockpit.
		*
		* Ported surface from upstream `components/planner/planner-workspace.tsx`
		* (70 KB / 1624 lines). Covers: analyze → plan, output-config (hero/detail
		* counts, aspect, language), the visual style guide, and the section list with
		* per-section generation.
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
			["ko-KR", "한국어"],
			["es-ES", "Español"],
			["fr-FR", "Français"],
			["de-DE", "Deutsch"],
			["pt-PT", "Português"],
			["ar-SA", "العربية"],
			["ru-RU", "Русский"]
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
			const analyzed = Boolean(detail.analysis);
			const hasSections = detail.sections.length > 0;
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
				await reload();
			});
			const doGenerateAll = (mode) => run(`page-${mode}`, async () => {
				const { jobId, total } = await api.generatePage(detail.project.id, mode);
				setNotice(`后台 job ${jobId} 已启动，共 ${total} 张。完成后会刷新。`);
				for (let i = 0; i < 600; i += 1) {
					await new Promise((resolve) => setTimeout(resolve, 2e3));
					const status = await api.jobStatus(jobId).catch(() => null);
					if (!status || status.state !== "running" && status.state !== "stopping") {
						setNotice(`job ${jobId} 结束：${status?.state ?? "unknown"}`);
						break;
					}
				}
				await reload();
			});
			const doGenerateOne = (section) => run(`gen-${section.id}`, async () => {
				await api.generateSection(detail.project.id, section.id);
				await reload();
			});
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
				notice ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
					kind: "info",
					children: notice
				}) : null,
				!analyzed ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
					kind: "info",
					children: "还没有商品分析。先跑「分析商品」——它只依据图像本身，不会用文件名猜商品。"
				}) : null,
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: {
						...styles.card,
						marginBottom: 14
					},
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								...styles.row,
								marginBottom: 10
							},
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "输出配置" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
								style: {
									color: T.muted,
									fontSize: 12
								},
								children: [
									detail.assets.length,
									" 张商品图 · 主图",
									" ",
									detail.assets.find((asset) => asset.isMain)?.fileName ?? "未设置"
								]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 10,
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
									label: "头图数量 (1–5)",
									style: { width: 120 },
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
										type: "number",
										min: 1,
										max: 5,
										value: heroCount,
										onChange: (event) => setHeroCount(Number(event.target.value)),
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
										onChange: (event) => setDetailCount(Number(event.target.value)),
										style: styles.input
									})
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
									label: "画幅",
									style: { width: 110 },
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", {
										value: aspect,
										onChange: (event) => setAspect(event.target.value),
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
									style: { width: 160 },
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", {
										value: language,
										onChange: (event) => setLanguage(event.target.value),
										style: styles.input,
										children: LANGUAGES.map(([value, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
											value,
											children: label
										}, value))
									})
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
									label: "数量决策",
									style: { width: 140 },
									children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
										style: {
											...styles.row,
											fontSize: 12,
											color: T.muted
										},
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: autoDecide,
											onChange: (event) => setAutoDecide(event.target.checked)
										}), "让模型决定"]
									})
								})
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								...styles.row,
								flexWrap: "wrap",
								marginTop: 4
							},
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: analyzed ? "default" : "primary",
									disabled: busy !== null,
									onClick: doAnalyze,
									children: busy === "analyze" ? "分析中…" : analyzed ? "重新分析" : "分析商品"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "primary",
									disabled: !analyzed || busy !== null,
									onClick: () => hasSections ? setConfirmReplan(true) : doPlan(),
									children: busy === "plan" ? "规划中…" : hasSections ? "重新规划" : "生成规划"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									disabled: !hasSections || busy !== null,
									onClick: () => doGenerateAll("missing"),
									title: "只补没有图的分区",
									children: busy === "page-missing" ? "生成中…" : "生成缺图"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									disabled: !hasSections || busy !== null,
									onClick: () => doGenerateAll("all"),
									title: "全部重做，消耗更多额度",
									children: busy === "page-all" ? "生成中…" : "全部重做"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									disabled: busy !== null,
									onClick: () => run("export", async () => {
										const result = await api.exportProject(detail.project.id, "zip");
										setNotice(`已导出：${result.zipPath ?? result.fileName ?? "ok"}`);
									}),
									children: busy === "export" ? "导出中…" : "导出 ZIP"
								})
							]
						}),
						confirmReplan ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: { marginTop: 10 },
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
								kind: "error",
								children: "重新规划会**删除该项目全部 section、版本与已生成的图**。确认继续？"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: styles.row,
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
						}) : null
					]
				}),
				styleGuide ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", {
					style: {
						...styles.card,
						marginBottom: 14
					},
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("summary", {
						style: { cursor: "pointer" },
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "视觉风格契约" }),
							" ",
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
								style: {
									color: T.muted,
									fontSize: 12
								},
								children: [styleGuide.styleName ?? "未命名", " · 全套图共用，保证一致性"]
							})
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							marginTop: 10,
							display: "grid",
							gap: 6
						},
						children: Object.entries(styleGuide).filter(([, value]) => value).map(([key, value]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: { fontSize: 12 },
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								style: { color: T.muted },
								children: key
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: { whiteSpace: "pre-wrap" },
								children: value
							})]
						}, key))
					})]
				}) : null,
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: { ...styles.card },
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: {
							...styles.row,
							justifyContent: "space-between",
							marginBottom: 8
						},
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("strong", { children: [
							"分区（",
							detail.sections.length,
							"）"
						] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
							style: {
								color: T.muted,
								fontSize: 12
							},
							children: [
								"有图 ",
								detail.sections.filter((section) => section.imageUrl).length,
								" / ",
								detail.sections.length
							]
						})]
					}), detail.sections.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: { color: T.muted },
						children: "还没有分区。先跑「生成规划」。"
					}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						style: {
							display: "grid",
							gap: 8
						},
						children: detail.sections.map((section, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 10,
								alignItems: "center",
								padding: 8,
								border: `1px solid ${T.border}`,
								borderRadius: 6,
								background: T.panel
							},
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									style: {
										width: 56,
										height: 56,
										flex: "0 0 auto",
										borderRadius: 6,
										background: T.bg,
										border: `1px solid ${T.border}`,
										overflow: "hidden",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										color: T.muted,
										fontSize: 11
									},
									children: section.imageUrl ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
										src: section.imageUrl,
										alt: section.title,
										style: {
											width: "100%",
											height: "100%",
											objectFit: "cover"
										}
									}) : "无图"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										flex: "1 1 auto",
										minWidth: 0
									},
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
										style: {
											...styles.row,
											gap: 6
										},
										children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
												style: {
													color: T.muted,
													fontSize: 11
												},
												children: index + 1
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", {
												style: {
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap"
												},
												children: section.title
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: SECTION_TYPE_LABELS[section.type] ?? section.type }),
											/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
												tone: statusTone(section.status),
												children: section.status
											}),
											section.versions.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, { children: ["v", section.versions.length] }) : null
										]
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										style: {
											color: T.muted,
											fontSize: 12,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap"
										},
										children: section.goal || section.copy || "—"
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									style: {
										...styles.row,
										flex: "0 0 auto"
									},
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
										disabled: busy !== null,
										onClick: () => doGenerateOne(section),
										children: busy === `gen-${section.id}` ? "生成中…" : section.imageUrl ? "重绘" : "生成"
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
										variant: "ghost",
										onClick: () => onOpenEditor(section.id),
										children: "编辑"
									})]
								})
							]
						}, section.id))
					})]
				})
			] });
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
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: {
						...styles.row,
						marginBottom: 14
					},
					children: [[
						1,
						2,
						3,
						4
					].map((value) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						active: step === value,
						onClick: () => setStep(value),
						children: value === 1 ? "① 规划" : value === 2 ? "② 审阅" : value === 3 ? "③ 生成" : "④ 改图"
					}, value)), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						style: {
							color: T.muted,
							fontSize: 12,
							marginLeft: "auto"
						},
						children: "小红书链路不落盘、不建项目，图只以引用形式返回"
					})]
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
							variant: "primary",
							disabled: !topic.trim() || busy !== null,
							onClick: doPlan,
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
								variant: "primary",
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
								variant: "primary",
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
								variant: "primary",
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
			] });
		}
		//#endregion
		//#region src/client/panel.tsx
		/**
		* MxPage panel — the workbench shell.
		*
		* Four screens, matching the objective: 规划 (planner), 编辑 (editor),
		* 小红书 (the four-step flow), 渠道 (channel diagnostics), plus the project
		* rail that all of them share.
		*/
		const TABS = [
			["planner", "规划"],
			["editor", "编辑"],
			["xiaohongshu", "小红书"],
			["channels", "渠道"]
		];
		function MxpagePanel(props) {
			const { api, onClose } = props;
			const [projects, setProjects] = (0, react.useState)([]);
			const [projectId, setProjectId] = (0, react.useState)(null);
			const [detail, setDetail] = (0, react.useState)(null);
			const [tab, setTab] = (0, react.useState)("planner");
			const [sectionId, setSectionId] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [creating, setCreating] = (0, react.useState)(false);
			const [newName, setNewName] = (0, react.useState)("");
			const [newFiles, setNewFiles] = (0, react.useState)([]);
			const [railError, setRailError] = (0, react.useState)(null);
			const fileInput = (0, react.useRef)(null);
			const reloadProjects = (0, react.useCallback)(async () => {
				try {
					const result = await api.listProjects();
					setProjects(result.projects);
					return result.projects;
				} catch (cause) {
					setRailError(cause instanceof Error ? cause.message : String(cause));
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
				(async () => {
					const list = await reloadProjects();
					if (list.length > 0) setProjectId((current) => current ?? list[0].id);
				})();
			}, [reloadProjects]);
			(0, react.useEffect)(() => {
				if (projectId) reloadDetail(projectId);
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
			const createProject = () => run("create", async () => {
				const files = newFiles;
				if (files.length === 0) throw new Error("至少选择一张商品图");
				const first = files[0];
				const created = await api.createProjectWithUpload(newName.trim() || first.name.replace(/\.[^.]+$/, ""), files);
				setCreating(false);
				setNewName("");
				setNewFiles([]);
				await reloadProjects();
				setProjectId(created.projectId);
			});
			const tabsDisabled = !detail && tab !== "channels";
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				style: styles.root,
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: styles.header,
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", {
							style: { fontSize: 14 },
							children: "MxPage"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							style: {
								color: T.muted,
								fontSize: 12
							},
							children: "电商图文工作台 · analyze → plan → VPA → generate"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							style: {
								marginLeft: "auto",
								...styles.row
							},
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
								variant: "ghost",
								onClick: onClose,
								title: "关闭面板",
								children: "关闭"
							})
						})
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					style: styles.body,
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.rail,
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									...styles.row,
									justifyContent: "space-between",
									padding: "0 4px"
								},
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
									style: {
										color: T.muted,
										fontSize: 12
									},
									children: [
										"项目 (",
										projects.length,
										")"
									]
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									onClick: () => setCreating((value) => !value),
									children: creating ? "取消" : "+ 新建"
								})]
							}),
							creating ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									...styles.card,
									padding: 8
								},
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
										label: "项目名",
										children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
											value: newName,
											onChange: (event) => setNewName(event.target.value),
											style: styles.input,
											placeholder: "例如：保温杯详情页"
										})
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, {
										label: "商品图",
										hint: newFiles.length ? `已选 ${newFiles.length} 张` : "第一张自动成为主图",
										children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
											ref: fileInput,
											type: "file",
											accept: "image/*",
											multiple: true,
											onChange: (event) => setNewFiles(Array.from(event.target.files ?? [])),
											style: {
												...styles.input,
												padding: 4
											}
										})
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
										variant: "primary",
										disabled: busy !== null || newFiles.length === 0,
										onClick: createProject,
										style: { width: "100%" },
										children: busy === "create" ? "创建中…" : "创建项目"
									})
								]
							}) : null,
							railError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
								kind: "error",
								children: railError
							}) : null,
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									display: "grid",
									gap: 4
								},
								children: [projects.map((project) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
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
										border: `1px solid ${project.id === projectId ? T.accent : "transparent"}`,
										borderRadius: 6,
										padding: 6,
										color: T.text,
										font: "inherit",
										cursor: "pointer"
									},
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
										style: {
											width: 34,
											height: 34,
											flex: "0 0 auto",
											borderRadius: 4,
											border: `1px solid ${T.border}`,
											background: T.bg,
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
									}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
										style: {
											minWidth: 0,
											flex: "1 1 auto"
										},
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											style: {
												display: "block",
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap"
											},
											children: project.name
										}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: project.status })]
									})]
								}, project.id)), projects.length === 0 && !creating ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									style: {
										color: T.muted,
										fontSize: 12,
										padding: 8
									},
									children: "还没有项目。点「+ 新建」上传商品图开始。"
								}) : null]
							})
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						style: styles.main,
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								style: {
									...styles.row,
									marginBottom: 14
								},
								children: [TABS.map(([value, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
									variant: "ghost",
									active: tab === value,
									onClick: () => setTab(value),
									children: label
								}, value)), detail ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
									style: {
										marginLeft: "auto",
										...styles.row,
										gap: 6
									},
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: detail.project.status }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
										style: {
											color: T.muted,
											fontSize: 12
										},
										children: [
											detail.project.name,
											" · ",
											detail.assets.length,
											" 张图 ·",
											" ",
											detail.sections.length,
											" 个分区"
										]
									})]
								}) : null]
							}),
							error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Notice, {
								kind: "error",
								children: error
							}) : null,
							tab === "channels" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChannelsView, { api }) : null,
							tab !== "channels" && tabsDisabled ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								style: { color: T.muted },
								children: "先创建或选择一个项目。"
							}) : null,
							detail && tab === "planner" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlannerView, {
								api,
								detail,
								busy,
								run,
								reload: () => reloadDetail(),
								onOpenEditor: (id) => {
									setSectionId(id);
									setTab("editor");
								}
							}) : null,
							detail && tab === "editor" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EditorView, {
								api,
								detail,
								busy,
								run,
								reload: () => reloadDetail(),
								selectedSectionId: sectionId,
								onSelectSection: setSectionId
							}) : null,
							tab === "xiaohongshu" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(XiaohongshuView, {
								api,
								busy,
								run
							}) : null
						]
					})]
				})]
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
		* never manages), and a stylesheet rule hides the conversation content while the
		* panel is active. Toggling is a data attribute on `<html>`, so the conversation
		* subtree underneath stays mounted and stateful.
		*
		* Same approach as `@dickpy/dsh-imagegen`'s `mount.tsx`; the dual selector covers
		* both the legacy shell (`[data-pane="conversation"]`) and the rc.6+ AppFrame
		* layout (`[class*="centerCol"]`).
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
		const STYLESHEET = `
		${PANEL_SELECTOR} {
		  position: absolute;
		  inset: 0;
		  display: none;
		  z-index: 5;
		  background: #0f1115;
		}
		html[${ACTIVE_ATTR}] ${PANEL_SELECTOR} { display: block; }
		html[${ACTIVE_ATTR}] ${CONVERSATION_COLUMN_SELECTOR} > *:not(${PANEL_SELECTOR}) { display: none !important; }
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
			const sync = () => {
				const html = document.documentElement;
				if (open) {
					for (const attr of OTHER_ACTIVE_ATTRS) html.removeAttribute(attr);
					html.setAttribute(ACTIVE_ATTR, "");
					window.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
				} else html.removeAttribute(ACTIVE_ATTR);
				const toggle = document.querySelector(TOGGLE_SELECTOR);
				if (toggle !== null) {
					if (open) toggle.dataset.active = "";
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
				root.render(/* @__PURE__ */ (0, import_jsx_runtime.jsx)(MxpagePanel, {
					api,
					onClose: () => handle.close()
				}));
			};
			const handle = {
				open() {
					open = true;
					ensure();
					sync();
					root?.render(/* @__PURE__ */ (0, import_jsx_runtime.jsx)(MxpagePanel, {
						api,
						onClose: () => handle.close()
					}));
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
				if (open) ensure();
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
		* row rather than replacing the shell's New Session affordance, so it never
		* hides host UI.
		*/
		function mountSidebarToggle(onToggle, label, tooltip) {
			let button;
			const ensure = () => {
				if (button !== void 0 && button.isConnected) return;
				const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
				if (column === null) return;
				const target = column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
				if (target === void 0) return;
				button = document.createElement("button");
				button.type = "button";
				button.dataset.dshMxpageToggle = "";
				button.setAttribute("aria-label", label);
				button.title = tooltip;
				button.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;font:inherit"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6.5h12M5.5 9.5h5"/></svg>${label}</span>`;
				button.style.cssText = "display:flex;align-items:center;width:100%;margin-top:6px;padding:5px 8px;background:transparent;color:inherit;border:1px solid transparent;border-radius:6px;cursor:pointer;font:inherit;opacity:0.85";
				button.addEventListener("click", onToggle);
				target.append(button);
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
		//#region src/client/index.ts
		/**
		* The panel needs no host services beyond the DOM. `connection` is read
		* opportunistically to warn on a non-loopback browser, because the bridge
		* routes are loopback-fenced and would otherwise fail with a bare 403.
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
