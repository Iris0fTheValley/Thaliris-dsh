window.__ModuleLoader__.load({
	id: "@thaliris/dsh-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let zod = require("zod");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/remote.mjs
		const method = (name, parameters, cancellable = false) => ({
			id: `@thaliris/dsh-plugin#thaliris/${name}`,
			service: "thalirisController",
			namespace: "thaliris",
			method: name,
			invocation: { kind: "direct" },
			parameters: parameters.map((name) => ({
				name,
				wire: name,
				source: "json",
				codec: {
					mode: "strict",
					typeSymbol: "@thaliris/dsh-plugin#NativeIdentity",
					create: () => zod.z.string().trim().min(1).max(128)
				}
			})),
			...cancellable ? { cancellation: { parameter: "signal" } } : {},
			result: {
				mode: "strict",
				typeSymbol: "@thaliris/dsh-plugin#JsonValue",
				create: () => zod.z.json(),
				decode: (value) => zod.z.json().parse(value)
			}
		});
		const remoteContribution = {
			package: "@thaliris/dsh-plugin",
			descriptors: [
				method("templates", []),
				method("providers", []),
				method("toolCatalog", []),
				method("diagnostics", ["sessionId", "taskId"], true),
				method("approveMemory", [
					"sessionId",
					"taskId",
					"proposalId"
				], true),
				method("setupStatus", []),
				method("prepareRuntime", [], true),
				method("recheckRuntime", [], true)
			]
		};
		//#endregion
		//#region src/client/policy-controller.ts
		/** Revision-fenced drafts over the native Thaliris ConfigForm. */
		/** Optional runtime path overrides, in the order the page renders them. */
		const RUNTIME_FIELDS = [
			"pythonExecutable",
			"corePath",
			"authorityDirectory"
		];
		function copyRole(value) {
			return {
				id: value.id ?? "",
				name: value.name ?? "",
				description: value.description ?? "",
				prompt: value.prompt ?? "",
				enabled: value.enabled ?? true,
				tools: [...value.tools ?? []],
				modelPolicy: {
					mode: value.modelPolicy?.mode ?? "inherit",
					routes: structuredClone(value.modelPolicy?.routes ?? [])
				},
				memory: {
					read: [...value.memory?.read ?? []],
					write: [...value.memory?.write ?? []]
				},
				context: {
					handoff: value.context?.handoff ?? true,
					memory: value.context?.memory ?? false
				}
			};
		}
		/** Fill schema-resolved defaults while keeping the native form authoritative. */
		function copyPolicy(value) {
			if (value === void 0) return void 0;
			return {
				controllerPrompt: value.controllerPrompt ?? "",
				workspaces: structuredClone(value.workspaces ?? []),
				roles: (value.roles ?? []).map((role) => copyRole(role)),
				memory: {
					mode: value.memory?.mode ?? "disabled",
					autoAuthorized: value.memory?.autoAuthorized ?? false,
					providers: [...value.memory?.providers ?? []],
					controllerRead: [...value.memory?.controllerRead ?? []],
					controllerWrite: [...value.memory?.controllerWrite ?? []]
				}
			};
		}
		/** Draft the optional runtime overrides as strings, blank meaning "no override". */
		function copyRuntime(value) {
			return {
				pythonExecutable: value?.pythonExecutable ?? "",
				corePath: value?.corePath ?? "",
				authorityDirectory: value?.authorityDirectory ?? ""
			};
		}
		/** Absolute Windows, Windows UNC or POSIX path; the host rejects relative overrides at use. */
		function absolutePath(value) {
			return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
		}
		function invalidRuntimeFields(runtime, fields) {
			if (runtime === void 0) return [];
			return fields.filter((field) => {
				const value = runtime[field].trim();
				return value !== "" && !absolutePath(value);
			});
		}
		function validationError(policy) {
			if (policy === void 0) return void 0;
			const ids = policy.roles.map((role) => role.id.trim());
			if (ids.some((id) => id.length === 0)) return "Role IDs cannot be empty.";
			if (new Set(ids).size !== ids.length) return "Each role needs a unique ID.";
			if (policy.roles.some((role) => role.modelPolicy.mode === "fixed" && role.modelPolicy.routes.length !== 1)) return "A fixed model policy needs exactly one allowed route.";
		}
		/**
		* Enabled roles whose native tool grants are empty, each paired with the shipped
		* role template that recommends tools for its id. Nothing here writes anything.
		*/
		function roleRecommendations(roles, templates) {
			return roles.flatMap((role, index) => {
				if (!role.enabled || role.tools.length > 0) return [];
				const template = templates.find((candidate) => candidate.id === role.id);
				return [{
					index,
					role,
					template,
					tools: template?.tools ?? []
				}];
			});
		}
		/** Replace only the recommended roles' empty grants; undefined means nothing to apply. */
		function withRecommendedTools(roles, recommendations) {
			const applicable = new Map(recommendations.filter((recommendation) => recommendation.tools.length > 0).map((recommendation) => [recommendation.index, recommendation.tools]));
			if (applicable.size === 0) return void 0;
			return roles.map((role, index) => {
				const tools = applicable.get(index);
				return tools === void 0 ? role : {
					...role,
					tools: [...tools]
				};
			});
		}
		/** Owns only transient drafts; every accepted value and write remains in native Settings. */
		var PolicyEditorController = class {
			form;
			store;
			dirtyFields = /* @__PURE__ */ new Set();
			dirtyRuntimeFields = /* @__PURE__ */ new Set();
			draft;
			runtime;
			expectedRevision;
			saving = false;
			conflict = false;
			error;
			native;
			unsubscribe;
			constructor(form) {
				this.form = form;
				this.native = form.getSnapshot();
				this.draft = copyPolicy(this.native.value?.policy);
				this.runtime = copyRuntime(this.native.value);
				this.store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(this.project());
				this.unsubscribe = form.subscribe(() => this.onNativeChange());
			}
			getSnapshot = () => this.store.getSnapshot();
			subscribe = (listener) => this.store.subscribe(listener);
			edit(field, value) {
				if (!this.canEdit()) return;
				if (this.expectedRevision === void 0) this.expectedRevision = this.native.revision;
				const draft = copyPolicy(this.draft);
				if (draft === void 0) return;
				draft[field] = structuredClone(value);
				this.draft = draft;
				this.dirtyFields.add(field);
				this.error = void 0;
				this.conflict = this.native.revision !== this.expectedRevision;
				this.publish();
			}
			/** Stage one optional runtime path override; blank clears it on save. */
			editRuntime(field, value) {
				if (!this.canEdit()) return;
				if (this.expectedRevision === void 0) this.expectedRevision = this.native.revision;
				this.runtime = {
					...this.runtime ?? copyRuntime(void 0),
					[field]: value
				};
				this.dirtyRuntimeFields.add(field);
				this.error = void 0;
				this.conflict = this.native.revision !== this.expectedRevision;
				this.publish();
			}
			/** Stage and write the shipped native tool grants for empty, enabled roles. */
			async applyRecommended(templates) {
				const current = this.project();
				if (!current.draft || !current.writable || current.conflict || current.saving) return false;
				const next = withRecommendedTools(current.draft.roles, roleRecommendations(current.draft.roles, templates));
				if (next === void 0) return false;
				this.edit("roles", next);
				return await this.save();
			}
			async save() {
				const current = this.project();
				if (!current.dirty || !current.writable || current.conflict || current.validationError || current.runtimeInvalid.length > 0 || this.saving || this.expectedRevision === void 0 || this.draft === void 0) return false;
				const revision = this.expectedRevision;
				const operations = [...[...this.dirtyFields].map((field) => ({
					op: "set",
					path: ["policy", field],
					value: zod.z.json().parse(this.draft[field])
				})), ...[...this.dirtyRuntimeFields].map((field) => {
					const value = (this.runtime ?? copyRuntime(void 0))[field].trim();
					return value === "" ? {
						op: "unset",
						path: [field]
					} : {
						op: "set",
						path: [field],
						value: zod.z.json().parse(value)
					};
				})];
				this.saving = true;
				this.error = void 0;
				this.publish();
				try {
					if (!await this.form.mutate(operations, revision)) {
						this.conflict = true;
						this.error = "The native Settings revision changed. Reload its latest values before editing again.";
						return false;
					}
					this.dirtyFields.clear();
					this.dirtyRuntimeFields.clear();
					this.expectedRevision = void 0;
					this.conflict = false;
					this.draft = copyPolicy(this.form.getSnapshot().value?.policy);
					this.runtime = copyRuntime(this.form.getSnapshot().value);
					return true;
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
					return false;
				} finally {
					this.saving = false;
					this.native = this.form.getSnapshot();
					this.publish();
				}
			}
			/** Drop this page's drafts and re-read the latest native snapshot. */
			discard() {
				this.native = this.form.getSnapshot();
				this.draft = copyPolicy(this.native.value?.policy);
				this.runtime = copyRuntime(this.native.value);
				this.expectedRevision = void 0;
				this.dirtyFields.clear();
				this.dirtyRuntimeFields.clear();
				this.saving = false;
				this.conflict = false;
				this.error = void 0;
				this.publish();
			}
			async dispose() {
				this.unsubscribe();
			}
			canEdit() {
				return this.native.status === "ready" && this.native.writable && this.native.mode === "host" && !this.saving && !this.conflict && this.draft !== void 0 && this.native.revision !== void 0;
			}
			onNativeChange() {
				this.native = this.form.getSnapshot();
				if (this.saving) {
					this.publish();
					return;
				}
				if (this.dirtyFields.size === 0) this.draft = copyPolicy(this.native.value?.policy);
				if (this.dirtyRuntimeFields.size === 0) this.runtime = copyRuntime(this.native.value);
				if (this.dirtyFields.size > 0 || this.dirtyRuntimeFields.size > 0) {
					if (this.native.revision !== this.expectedRevision) this.conflict = true;
				}
				this.publish();
			}
			project() {
				const writable = this.native.status === "ready" && this.native.writable && this.native.mode === "host";
				const dirtyFields = [...this.dirtyFields];
				const dirtyRuntimeFields = [...this.dirtyRuntimeFields];
				return {
					native: this.native,
					draft: this.draft,
					runtime: this.runtime,
					dirtyFields,
					dirtyRuntimeFields,
					runtimeInvalid: invalidRuntimeFields(this.runtime, dirtyRuntimeFields),
					saving: this.saving,
					conflict: this.conflict,
					error: this.error,
					validationError: validationError(this.draft),
					dirty: dirtyFields.length > 0 || dirtyRuntimeFields.length > 0,
					writable,
					available: this.native.status === "ready" && this.draft !== void 0
				};
			}
			publish() {
				this.store.set(this.project());
			}
		};
		//#endregion
		//#region src/client/native-controller.ts
		/** Native DSH projections and the optional Thaliris Gateway contribution. */
		function describeError(value) {
			if (typeof value === "string") return value;
			if (typeof value === "object" && value !== null) {
				const record = value;
				const detail = [record.code, record.message].filter((part) => typeof part === "string").join(": ");
				if (detail) return detail;
			}
			return value instanceof Error ? value.message : String(value);
		}
		function remoteError(response) {
			return describeError(response.error);
		}
		/** Browser-side cache of Host projections; it stores no policy or task state. */
		var NativeProjectionController = class {
			ctx;
			store;
			stops;
			constructor(ctx) {
				this.ctx = ctx;
				const sessions = ctx.sessions;
				const workspaces = ctx.workspaces;
				this.store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
					modelCatalog: void 0,
					modelStatus: "idle",
					providers: [],
					providerStatus: "idle",
					tools: [],
					toolStatus: "idle",
					templates: [],
					templateStatus: "idle",
					sessions: sessions.list.getSnapshot(),
					workspaces: workspaces.list.getSnapshot(),
					diagnosticSessionId: void 0,
					diagnostics: void 0,
					diagnosticStatus: "idle",
					diagnosticError: void 0,
					approvalStatus: "idle",
					approvalReceipt: void 0,
					approvalError: void 0
				});
				const refreshModels = () => {
					this.loadModels();
				};
				const refreshAll = () => {
					this.refresh();
				};
				this.stops = [
					sessions.list.subscribe(() => {
						this.store.update((state) => {
							state.sessions = sessions.list.getSnapshot();
						});
					}),
					workspaces.list.subscribe(() => {
						this.store.update((state) => {
							state.workspaces = workspaces.list.getSnapshot();
						});
					}),
					ctx.remote.$on("llm/adapters-updated", refreshModels),
					ctx.remote.$on("settings/document-updated", refreshModels),
					ctx.on("connection/reset", refreshAll)
				];
			}
			getSnapshot = () => this.store.getSnapshot();
			subscribe = (listener) => this.store.subscribe(listener);
			async refresh() {
				await Promise.all([
					this.loadModels(),
					this.loadProviders(),
					this.loadTools(),
					this.loadTemplates()
				]);
			}
			async loadModels() {
				this.store.update((state) => {
					state.modelStatus = "loading";
				});
				try {
					const response = await this.ctx.remote.session.modelCatalog();
					if (!response.ok) throw new Error(remoteError(response));
					this.store.update((state) => {
						state.modelCatalog = response.value;
						state.modelStatus = "ready";
					});
				} catch {
					this.store.update((state) => {
						state.modelStatus = "error";
					});
				}
			}
			async loadProviders() {
				this.store.update((state) => {
					state.providerStatus = "loading";
				});
				try {
					const response = await this.ctx.remote.thaliris.providers();
					if (!response.ok) throw new Error(remoteError(response));
					this.store.update((state) => {
						state.providers = response.value;
						state.providerStatus = "ready";
					});
				} catch {
					this.store.update((state) => {
						state.providerStatus = "error";
					});
				}
			}
			async loadTools() {
				this.store.update((state) => {
					state.toolStatus = "loading";
				});
				try {
					const response = await this.ctx.remote.thaliris.toolCatalog();
					if (!response.ok) throw new Error(remoteError(response));
					this.store.update((state) => {
						state.tools = response.value;
						state.toolStatus = "ready";
					});
				} catch {
					this.store.update((state) => {
						state.toolStatus = "error";
					});
				}
			}
			async loadTemplates() {
				this.store.update((state) => {
					state.templateStatus = "loading";
				});
				try {
					const response = await this.ctx.remote.thaliris.templates();
					if (!response.ok) throw new Error(remoteError(response));
					this.store.update((state) => {
						state.templates = response.value;
						state.templateStatus = "ready";
					});
				} catch {
					this.store.update((state) => {
						state.templateStatus = "error";
					});
				}
			}
			async loadDiagnostics(sessionId, taskId) {
				this.store.update((state) => {
					state.diagnosticSessionId = sessionId;
					state.diagnosticStatus = "loading";
					state.diagnosticError = void 0;
					state.diagnostics = void 0;
				});
				try {
					const response = await this.ctx.sessions.using(sessionId, { source: "gateway" }, async () => {
						return await this.ctx.remote.thaliris.diagnostics(sessionId, taskId);
					});
					if (!response.ok) throw new Error(remoteError(response));
					this.store.update((state) => {
						state.diagnostics = response.value;
						state.diagnosticStatus = "ready";
					});
					return true;
				} catch (error) {
					this.store.update((state) => {
						state.diagnosticError = describeError(error);
						state.diagnosticStatus = "error";
					});
					return false;
				}
			}
			async approveMemory(sessionId, taskId, proposalId) {
				if (this.store.getSnapshot().approvalStatus === "saving") return false;
				this.store.update((state) => {
					state.approvalStatus = "saving";
					state.approvalReceipt = void 0;
					state.approvalError = void 0;
				});
				try {
					const response = await this.ctx.sessions.using(sessionId, { source: "gateway" }, async () => {
						return await this.ctx.remote.thaliris.approveMemory(sessionId, taskId, proposalId);
					});
					if (!response.ok) throw new Error(remoteError(response));
					this.store.update((state) => {
						state.approvalReceipt = response.value;
						state.approvalStatus = "ready";
					});
					await this.loadDiagnostics(sessionId, taskId);
					return true;
				} catch (error) {
					this.store.update((state) => {
						state.approvalError = describeError(error);
						state.approvalStatus = "error";
					});
					return false;
				}
			}
			async dispose() {
				for (const stop of this.stops) stop();
			}
		};
		//#endregion
		//#region src/client/setup-controller.ts
		const INITIAL$1 = {
			status: "idle",
			setup: void 0,
			error: void 0,
			action: "idle",
			actionError: void 0
		};
		/** Poll cadence while a provisioning action runs; the action itself owns the outcome. */
		const PROGRESS_POLL_MS = 800;
		function record$2(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
		}
		function stringOrNull(value) {
			return typeof value === "string" ? value : null;
		}
		function runtimeInfo(value) {
			const row = record$2(value);
			if (!row) return null;
			return {
				pythonExecutable: stringOrNull(row.pythonExecutable),
				corePath: stringOrNull(row.corePath),
				version: stringOrNull(row.version),
				commit: stringOrNull(row.commit),
				state_schema_version: typeof row.state_schema_version === "number" ? row.state_schema_version : null,
				python: stringOrNull(row.python),
				verified_at: stringOrNull(row.verified_at),
				source: stringOrNull(row.source),
				version_matches_pin: typeof row.version_matches_pin === "boolean" ? row.version_matches_pin : null
			};
		}
		function pinInfo(value) {
			const row = record$2(value);
			if (!row) return {};
			return {
				...typeof row.version === "string" ? { version: row.version } : {},
				...typeof row.commit === "string" ? { commit: row.commit } : {},
				...typeof row.stateSchemaVersion === "number" ? { stateSchemaVersion: row.stateSchemaVersion } : {},
				...typeof row.error === "string" ? { error: row.error } : {}
			};
		}
		function autoBindInfo(value) {
			const row = record$2(value);
			if (!row || typeof row.workspaceId !== "string" || typeof row.root !== "string") return null;
			return {
				workspaceId: row.workspaceId,
				root: row.root,
				enabled: row.enabled !== false,
				at: typeof row.at === "string" ? row.at : ""
			};
		}
		/** Normalize one Gateway JSON answer into the status the page renders. */
		function asSetupStatus(value) {
			const row = record$2(value);
			if (!row || typeof row.state !== "string") return void 0;
			const progress = record$2(row.progress);
			const status = {
				state: row.state,
				verified: row.verified === true,
				code: stringOrNull(row.code),
				recovery: stringOrNull(row.recovery),
				detail: stringOrNull(row.detail),
				step: stringOrNull(row.step),
				attempt: typeof row.attempt === "number" ? row.attempt : 0,
				elapsed_ms: typeof row.elapsed_ms === "number" ? row.elapsed_ms : null,
				progress: progress ? {
					step: stringOrNull(progress.step),
					started_at: stringOrNull(progress.started_at),
					elapsed_ms: typeof progress.elapsed_ms === "number" ? progress.elapsed_ms : null
				} : null,
				configured: row.configured === true,
				manual_override: row.manual_override === true,
				authorityDirectory: stringOrNull(row.authorityDirectory),
				runtime: runtimeInfo(row.runtime),
				pin: pinInfo(row.pin),
				workspaceAutoBind: autoBindInfo(row.workspaceAutoBind)
			};
			if (typeof row.ok === "boolean") status.ok = row.ok;
			if (typeof row.already === "boolean") status.already = row.already;
			if (typeof row.provisioned === "boolean") status.provisioned = row.provisioned;
			return status;
		}
		/**
		* Reads the host's tolerant setup status and runs the two explicit human actions.
		* A provisioning action polls the sync status read for progress while it runs, so
		* the page can show the active step; it never provisions on its own.
		*/
		var SetupController = class {
			ctx;
			store;
			timer;
			constructor(ctx) {
				this.ctx = ctx;
				this.store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(INITIAL$1);
			}
			getSnapshot = () => this.store.getSnapshot();
			subscribe = (listener) => this.store.subscribe(listener);
			/** Read the current setup status without changing host state. */
			async load() {
				const gateway = this.gateway();
				if (!gateway) {
					this.set({
						status: "error",
						error: void 0
					});
					return;
				}
				this.set({ status: "loading" });
				try {
					const response = await gateway.setupStatus();
					if (!response.ok) throw new Error(describeError(response.error));
					const setup = asSetupStatus(response.value);
					if (!setup) throw new Error("the host returned an unreadable setup status");
					this.set({
						status: "ready",
						setup,
						error: void 0
					});
				} catch (error) {
					this.set({
						status: "error",
						error: describeError(error)
					});
				}
			}
			/** Explicit human action: provision the pinned runtime if needed and verify it. */
			async prepare() {
				return await this.run("preparing", (gateway) => gateway.prepareRuntime());
			}
			/** Explicit human action: re-read the configured or recorded runtime and verify it. */
			async recheck() {
				return await this.run("rechecking", (gateway) => gateway.recheckRuntime());
			}
			dispose() {
				this.stopProgress();
			}
			gateway() {
				return this.ctx.get("remote.thaliris");
			}
			async run(action, invoke) {
				if (this.store.getSnapshot().action !== "idle") return false;
				this.set({
					action,
					actionError: void 0
				});
				this.startProgress();
				try {
					const gateway = this.gateway();
					if (!gateway) throw new Error("the host does not serve the Thaliris setup Gateway");
					const response = await invoke(gateway);
					if (!response.ok) throw new Error(describeError(response.error));
					const setup = asSetupStatus(response.value);
					if (!setup) throw new Error("the host returned an unreadable setup status");
					this.set({
						status: "ready",
						setup,
						error: void 0
					});
					return setup.state === "ready";
				} catch (error) {
					this.set({ actionError: describeError(error) });
					return false;
				} finally {
					this.stopProgress();
					this.set({ action: "idle" });
				}
			}
			startProgress() {
				if (this.timer !== void 0) return;
				this.timer = setInterval(() => {
					this.poll();
				}, PROGRESS_POLL_MS);
			}
			stopProgress() {
				if (this.timer === void 0) return;
				clearInterval(this.timer);
				this.timer = void 0;
			}
			async poll() {
				const gateway = this.gateway();
				if (!gateway) return;
				try {
					const response = await gateway.setupStatus();
					if (!response.ok) return;
					const setup = asSetupStatus(response.value);
					if (setup) this.set({ setup });
				} catch {}
			}
			set(patch) {
				this.store.set({
					...this.store.getSnapshot(),
					...patch
				});
			}
		};
		//#endregion
		//#region src/client/mode-controller.ts
		/** Settings namespace the native Agent Preset registry owns. */
		const AGENT_PRESET_SETTINGS_NS = "agent-preset-registry";
		/** Preset id of the optional Thaliris mode. */
		const THALIRIS_PRESET_ID = "thaliris";
		const INITIAL = {
			status: "idle",
			error: void 0,
			presets: [],
			registryAvailable: false,
			writable: false,
			nativeDefault: void 0,
			selectedDefault: void 0,
			saving: false,
			saveError: void 0
		};
		function record$1(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
		}
		function presetRow(value) {
			const row = record$1(value);
			if (!row || typeof row.id !== "string" || row.id.trim() === "") return void 0;
			return {
				id: row.id,
				isDefault: row.isDefault === true,
				...typeof row.name === "string" ? { name: row.name } : {},
				...typeof row.description === "string" ? { description: row.description } : {},
				...typeof row.broken === "string" ? { broken: row.broken } : {}
			};
		}
		function rosterRows(value) {
			const row = record$1(value);
			return (row && Array.isArray(row.presets) ? row.presets : []).flatMap((item) => {
				const parsed = presetRow(item);
				return parsed ? [parsed] : [];
			});
		}
		/** The roster row for the Thaliris preset, when the host registered it. */
		function thalirisRow(state) {
			return state.presets.find((row) => row.id === THALIRIS_PRESET_ID);
		}
		/** Whether the Thaliris preset is registered and its composition mounted. */
		function thalirisHealthy(state) {
			const row = thalirisRow(state);
			return row !== void 0 && row.broken === void 0;
		}
		/** The preset the host resolves for sessions that name no preset. */
		function effectiveDefaultId(state) {
			const resolved = state.presets.find((row) => row.isDefault);
			if (resolved) return resolved.id;
			return state.selectedDefault ?? state.nativeDefault;
		}
		/** The saved default points at no registered preset, so unnamed sessions cannot compose. */
		function danglingDefault(state) {
			if (!state.registryAvailable || state.status !== "ready") return false;
			if (state.presets.some((row) => row.isDefault)) return false;
			return effectiveDefaultId(state) !== void 0;
		}
		/** Whether Thaliris currently composes new unnamed sessions. */
		function isThalirisDefault(state) {
			return effectiveDefaultId(state) === THALIRIS_PRESET_ID;
		}
		/** The explicit set action is offered only for a healthy, registered, non-default preset. */
		function canSetThalirisDefault(state) {
			return state.status === "ready" && state.registryAvailable && state.writable && !state.saving && thalirisHealthy(state) && !isThalirisDefault(state);
		}
		/** A saved override differs from the native default, or the saved default is dangling. */
		function restoreNeeded(state) {
			return state.selectedDefault !== void 0 && state.selectedDefault !== state.nativeDefault || danglingDefault(state);
		}
		/** The restore action is offered when a saved override or a dangling default needs repair. */
		function canRestoreNativeDefault(state) {
			return state.status === "ready" && state.registryAvailable && state.writable && !state.saving && state.nativeDefault !== void 0 && state.nativeDefault !== "thaliris" && restoreNeeded(state);
		}
		/** Reads the native roster and writes the one volatile default field on an explicit click. */
		var ModeController = class {
			ctx;
			store;
			stops = [];
			constructor(ctx) {
				this.ctx = ctx;
				this.store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(INITIAL);
				const form = this.form();
				if (form) this.stops.push(form.subscribe(() => {
					this.publishForm();
				}));
				const events = this.ctx.get("remote");
				if (events?.$on) this.stops.push(events.$on("settings/document-updated", () => {
					this.load();
				}));
				this.stops.push(this.ctx.on("connection/reset", () => {
					this.load();
				}));
			}
			getSnapshot = () => this.store.getSnapshot();
			subscribe = (listener) => this.store.subscribe(listener);
			/** Read the native roster and default fields without writing anything. */
			async load() {
				const snapshot = this.form()?.getSnapshot();
				this.set({
					status: "loading",
					registryAvailable: snapshot?.status === "ready",
					writable: snapshot?.status === "ready" && snapshot.writable === true,
					nativeDefault: snapshot?.value?.default,
					selectedDefault: snapshot?.value?.selectedDefault
				});
				const roster = await this.readRoster();
				this.set({
					status: roster.status === "ok" ? "ready" : roster.status,
					error: roster.error,
					presets: roster.presets
				});
			}
			/** Explicit human action: make Thaliris the native new-Session default. */
			async setThalirisDefault() {
				return await this.writeDefault(THALIRIS_PRESET_ID);
			}
			/** Explicit human action: restore the native default preset recorded by the host. */
			async restoreNativeDefault() {
				const target = this.store.getSnapshot().nativeDefault;
				if (target === void 0) return false;
				return await this.writeDefault(target);
			}
			dispose() {
				for (const stop of this.stops) stop();
				this.stops.length = 0;
			}
			async writeDefault(id) {
				const current = this.store.getSnapshot();
				if (current.saving) return false;
				if (current.status !== "ready" || !current.registryAvailable || !current.writable) return false;
				const settings = this.settings();
				if (!settings?.update) return false;
				const revision = this.form()?.getSnapshot().revision;
				this.set({
					saving: true,
					saveError: void 0
				});
				try {
					const response = await settings.update(AGENT_PRESET_SETTINGS_NS, { selectedDefault: id }, revision);
					if (!response.ok) throw new Error(describeError(response.error));
					await this.load();
					return true;
				} catch (error) {
					this.set({ saveError: describeError(error) });
					await this.load();
					return false;
				} finally {
					this.set({ saving: false });
				}
			}
			async readRoster() {
				const roster = this.ctx.get("remote.agentPresets");
				if (!roster?.list) return {
					status: "unavailable",
					presets: []
				};
				try {
					const response = await roster.list();
					if (!response.ok) {
						if (record$1(response.error)?.code === "gateway/invocation-unavailable") return {
							status: "unavailable",
							presets: []
						};
						return {
							status: "error",
							presets: [],
							error: describeError(response.error)
						};
					}
					return {
						status: "ok",
						presets: rosterRows(response.value)
					};
				} catch (error) {
					return {
						status: "error",
						presets: [],
						error: describeError(error)
					};
				}
			}
			settings() {
				return this.ctx.get("remote.settings");
			}
			form() {
				try {
					return this.ctx.configForms.get(AGENT_PRESET_SETTINGS_NS);
				} catch {
					return;
				}
			}
			publishForm() {
				const snapshot = this.form()?.getSnapshot();
				this.set({
					registryAvailable: snapshot?.status === "ready",
					writable: snapshot?.status === "ready" && snapshot.writable === true,
					nativeDefault: snapshot?.value?.default,
					selectedDefault: snapshot?.value?.selectedDefault
				});
			}
			set(patch) {
				this.store.set({
					...this.store.getSnapshot(),
					...patch
				});
			}
		};
		//#endregion
		//#region \0dsh-css:ThalirisPage.module.css.mjs
		const css = "._vlGrG_page{width:100%;color:var(--dsw-alias-text-primary);flex-direction:column;gap:18px;display:flex}._vlGrG_header,._vlGrG_sectionHead,._vlGrG_cardHead,._vlGrG_inline,._vlGrG_inlineActions,._vlGrG_permissionRow{align-items:center;gap:12px;display:flex}._vlGrG_header,._vlGrG_sectionHead,._vlGrG_cardHead{justify-content:space-between}._vlGrG_header{align-items:flex-start}._vlGrG_title{margin:0;font-size:20px;font-weight:600}._vlGrG_summary,._vlGrG_section p,._vlGrG_section small{color:var(--dsw-alias-text-secondary)}._vlGrG_summary{margin:5px 0 0}._vlGrG_section{flex-direction:column;gap:14px;min-width:0;display:flex}._vlGrG_fieldset{border:0;flex-direction:column;gap:14px;min-width:0;margin:0;padding:0;display:flex}._vlGrG_visuallyHidden{clip:rect(0, 0, 0, 0);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}._vlGrG_section h3,._vlGrG_section h4{margin:0;font-weight:600}._vlGrG_section h3{font-size:16px}._vlGrG_section h4{font-size:14px}._vlGrG_section p{margin:0;line-height:1.5}._vlGrG_field{flex-direction:column;gap:6px;min-width:0;display:flex}._vlGrG_field>span{font-size:13px;font-weight:500}._vlGrG_field textarea{resize:vertical;box-sizing:border-box;width:100%;min-height:118px;color:var(--dsw-alias-text-primary);background:var(--dsw-alias-surface-primary);border:1px solid var(--dsw-alias-border-primary);font:inherit;border-radius:8px;padding:10px 12px;line-height:1.5}._vlGrG_field select,._vlGrG_inline select,._vlGrG_section>select{max-width:100%;color:var(--dsw-alias-text-primary);background:var(--dsw-alias-surface-primary);border:1px solid var(--dsw-alias-border-primary);font:inherit;border-radius:8px;padding:8px 10px}._vlGrG_inline{flex-wrap:wrap}._vlGrG_inline select{flex:1;min-width:220px}._vlGrG_inlineActions{flex-wrap:wrap;justify-content:flex-end}._vlGrG_grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:14px;display:grid}._vlGrG_wide{grid-column:1/-1}._vlGrG_stack{flex-direction:column;gap:10px;display:flex}._vlGrG_card{border:1px solid var(--dsw-alias-border-primary);background:var(--dsw-alias-surface-secondary);border-radius:10px;flex-direction:column;gap:12px;min-width:0;padding:14px;display:flex}._vlGrG_cardHead{align-items:flex-start}._vlGrG_cardHead code,._vlGrG_cardHead p{color:var(--dsw-alias-text-secondary);overflow-wrap:anywhere;margin-top:5px;display:block}._vlGrG_subsection{flex-direction:column;gap:10px;padding-top:4px;display:flex}._vlGrG_checkGrid{grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:8px 12px;display:grid}._vlGrG_permissionRow{flex-wrap:wrap;justify-content:flex-start;padding:7px 0}._vlGrG_permissionRow strong{min-width:140px}._vlGrG_notice{background:var(--dsw-alias-surface-tertiary);overflow-wrap:anywhere;border-radius:8px;padding:9px 11px}._vlGrG_error{color:var(--dsw-alias-text-danger);background:var(--dsw-alias-surface-danger);border-radius:8px;padding:9px 11px}._vlGrG_keyValues{grid-template-columns:minmax(140px,max-content) 1fr;gap:6px 16px;margin:0;display:grid}._vlGrG_keyValues dt{color:var(--dsw-alias-text-secondary);font-size:13px}._vlGrG_keyValues dd{overflow-wrap:anywhere;margin:0}._vlGrG_section code{overflow-wrap:anywhere;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}._vlGrG_card pre{max-width:100%;max-height:260px;color:var(--dsw-alias-text-primary);background:var(--dsw-alias-surface-primary);white-space:pre-wrap;overflow-wrap:anywhere;border-radius:7px;margin:0;padding:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow:auto}@media (width<=680px){._vlGrG_header,._vlGrG_sectionHead{flex-direction:column;align-items:flex-start}._vlGrG_inline{flex-direction:column;align-items:stretch}._vlGrG_inline select{box-sizing:border-box;width:100%}}";
		const tagId = "@thaliris/dsh-plugin/ThalirisPage.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@thaliris/dsh-plugin";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ThalirisPage_module_css_default = {
			"card": "_vlGrG_card",
			"cardHead": "_vlGrG_cardHead",
			"checkGrid": "_vlGrG_checkGrid",
			"error": "_vlGrG_error",
			"field": "_vlGrG_field",
			"fieldset": "_vlGrG_fieldset",
			"grid": "_vlGrG_grid",
			"header": "_vlGrG_header",
			"inline": "_vlGrG_inline",
			"inlineActions": "_vlGrG_inlineActions",
			"keyValues": "_vlGrG_keyValues",
			"notice": "_vlGrG_notice",
			"page": "_vlGrG_page",
			"permissionRow": "_vlGrG_permissionRow",
			"section": "_vlGrG_section",
			"sectionHead": "_vlGrG_sectionHead",
			"stack": "_vlGrG_stack",
			"subsection": "_vlGrG_subsection",
			"summary": "_vlGrG_summary",
			"title": "_vlGrG_title",
			"visuallyHidden": "_vlGrG_visuallyHidden",
			"wide": "_vlGrG_wide"
		};
		//#endregion
		//#region src/client/ThalirisPage.tsx
		const TABS = [
			{
				id: "general",
				key: "tabGeneral"
			},
			{
				id: "roles",
				key: "tabRoles"
			},
			{
				id: "memory",
				key: "tabMemory"
			},
			{
				id: "context",
				key: "tabContext"
			},
			{
				id: "diagnostics",
				key: "tabDiagnostics"
			}
		];
		function json(value) {
			try {
				return JSON.stringify(value, null, 2);
			} catch {
				return String(value);
			}
		}
		function record(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
		}
		function routeKey(provider, model) {
			return JSON.stringify([provider, model]);
		}
		function exactRouteKey(route) {
			return JSON.stringify([
				route.provider,
				route.model,
				route.reasoningEffort ?? null
			]);
		}
		function routesOf(state) {
			return state.modelCatalog?.groups.flatMap((group) => group.models.map((model) => ({
				provider: group.id,
				providerName: group.name,
				model: model.id,
				modelName: model.name,
				efforts: model.reasoning?.efforts ?? []
			}))) ?? [];
		}
		function roleWith(role, patch) {
			return {
				...role,
				...patch
			};
		}
		function duplicateRole(role, roles) {
			const base = role.id.trim() || "role";
			let id = `${base}-copy`;
			for (let suffix = 2; roles.some((value) => value.id === id); suffix++) id = `${base}-copy-${suffix}`;
			return {
				...structuredClone(role),
				id
			};
		}
		const SETUP_STATE_KEYS = {
			unconfigured: "stateUnconfigured",
			detecting: "stateDetecting",
			provisioning: "stateProvisioning",
			verifying: "stateVerifying",
			ready: "stateReady",
			failed: "stateFailed"
		};
		function setupStateLabel(state, t) {
			const key = SETUP_STATE_KEYS[state];
			return key === void 0 ? t("stateUnknown") : t(key);
		}
		function setupStateTone(state) {
			if (state === "ready") return "success";
			if (state === "failed") return "danger";
			if (state === "detecting" || state === "provisioning" || state === "verifying") return "warning";
			return "outline";
		}
		const SETUP_STEP_KEYS = {
			"detect-python": "setupStepDetectPython",
			"fetch-source": "setupStepFetchSource",
			"create-runtime": "setupStepCreateRuntime",
			"install-core": "setupStepInstallCore",
			"verify-core": "setupStepVerifyCore",
			"write-manifest": "setupStepWriteManifest",
			"verify-recorded": "setupStepVerifyRecorded",
			"verify-configured": "setupStepVerifyConfigured",
			ready: "setupStepReady"
		};
		function setupStepLabel(step, t) {
			if (!step) return void 0;
			const key = SETUP_STEP_KEYS[step];
			return key === void 0 ? step : t(key);
		}
		const SETUP_SOURCE_KEYS = {
			provisioned: "sourceProvisioned",
			recorded: "sourceRecorded",
			configuration: "sourceConfiguration",
			detected: "sourceDetected"
		};
		function setupSourceLabel(source, t) {
			if (!source) return void 0;
			const key = SETUP_SOURCE_KEYS[source];
			return key === void 0 ? source : t(key);
		}
		function runtimeFieldLabel(field, t) {
			return field === "pythonExecutable" ? t("setupPythonOverride") : field === "corePath" ? t("setupCoreOverride") : t("setupAuthorityOverride");
		}
		/**
		* The Settings page is root-scoped and owns no Session selection, so the explicit
		* "most recent Workspace" action uses the same native rule DSH applies when a flow
		* opens a Workspace without naming one: latest Session activity, then creation time.
		*/
		function recentWorkspaceId(workspaces, sessions) {
			let selected;
			let selectedTime = Number.NEGATIVE_INFINITY;
			for (const workspace of workspaces) {
				let latest = Number.NEGATIVE_INFINITY;
				for (const sessionId of workspace.sessionIds) {
					const updatedAt = sessions[sessionId]?.updatedAt;
					if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) latest = Math.max(latest, updatedAt);
				}
				if (latest === Number.NEGATIVE_INFINITY) {
					const created = Date.parse(workspace.createdAt);
					if (Number.isFinite(created)) latest = created;
				}
				if (selected === void 0 || latest > selectedTime) {
					selected = workspace.workspaceId;
					selectedTime = latest;
				}
			}
			return selected;
		}
		function ThalirisPage(props) {
			const { t } = props;
			const policy = props.usePolicy((state) => state);
			const native = props.useNative((state) => state);
			const setup = props.useSetup((state) => state);
			const mode = props.useMode((state) => state);
			const [tab, setTab] = (0, react.useState)("general");
			const [templateId, setTemplateId] = (0, react.useState)("");
			const [workspaceId, setWorkspaceId] = (0, react.useState)("");
			const [sessionId, setSessionId] = (0, react.useState)("");
			const [taskId, setTaskId] = (0, react.useState)("");
			const [copied, setCopied] = (0, react.useState)(false);
			const headingId = (0, react.useId)();
			const draft = policy.draft;
			const shell = {
				available: policy.available,
				writable: policy.writable,
				dirty: policy.dirty && policy.writable,
				invalid: Boolean(policy.validationError) || policy.conflict || policy.runtimeInvalid.length > 0,
				saving: policy.saving,
				failed: Boolean(policy.error)
			};
			const tfn = t;
			const templates = native.templates;
			const routeChoices = (0, react.useMemo)(() => routesOf(native), [native.modelCatalog]);
			const edit = (field, value) => props.edit(field, value);
			const editRole = (index, patch) => {
				if (!draft) return;
				edit("roles", draft.roles.map((role, i) => i === index ? roleWith(role, patch) : role));
			};
			const editMemory = (patch) => {
				if (draft) edit("memory", {
					...draft.memory,
					...patch
				});
			};
			const autoBind = setup.setup?.workspaceAutoBind ?? void 0;
			const recentId = recentWorkspaceId(native.workspaces.items, native.sessions.byId);
			const recentWorkspace = native.workspaces.items.find((row) => row.workspaceId === recentId);
			if (props.view === "summary") return t("summary");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ThalirisPage_module_css_default.page,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: ThalirisPage_module_css_default.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: ThalirisPage_module_css_default.title,
							id: headingId,
							children: "Thaliris"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ThalirisPage_module_css_default.summary,
							children: t("summary")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: props.refresh,
							children: t("projectionRefresh")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SegmentedTabs, {
						label: t("settingsLabel"),
						value: tab,
						onChange: (value) => setTab(value),
						items: TABS.map((item) => ({
							value: item.id,
							label: t(item.key),
							id: `${headingId}-tab-${item.id}`,
							panelId: `${headingId}-panel`
						}))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
						labels: {
							unavailable: t("formUnavailable"),
							readOnly: t("readOnly"),
							saveFailed: t("saveFailed"),
							save: t("save"),
							saving: t("saving")
						},
						state: shell,
						onSave: props.save,
						onDiscard: props.discard,
						children: [
							policy.conflict ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: ThalirisPage_module_css_default.error,
								role: "alert",
								children: t("conflict")
							}) : null,
							policy.validationError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: ThalirisPage_module_css_default.error,
								role: "alert",
								children: policy.validationError
							}) : null,
							policy.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: ThalirisPage_module_css_default.error,
								role: "alert",
								children: policy.error
							}) : null,
							policy.available && (!policy.writable || policy.conflict) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								onClick: props.discard,
								children: t("discard")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
								className: ThalirisPage_module_css_default.fieldset,
								disabled: !policy.writable,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", {
										className: ThalirisPage_module_css_default.visuallyHidden,
										children: t("settingsLabel")
									}),
									tab === "general" && draft ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SetupSection, {
											setup,
											runtime: policy.runtime,
											runtimeInvalid: policy.runtimeInvalid,
											writable: policy.writable,
											editRuntime: props.editRuntime,
											t: tfn,
											onPrepare: props.prepareRuntime,
											onRecheck: props.recheckRuntime,
											onRefresh: props.loadSetup
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModeSection, {
											mode,
											t: tfn,
											onSet: props.setThalirisDefault,
											onRestore: props.restoreNativeDefault
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RecommendedPermissions, {
											draft,
											native,
											t: tfn,
											disabled: !policy.writable || policy.saving,
											onApply: props.applyRecommended,
											onLoadTemplates: props.refresh
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
											className: ThalirisPage_module_css_default.section,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("generalTitle") }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("generalHelp") }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
													className: ThalirisPage_module_css_default.field,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("controllerPrompt") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
														value: draft.controllerPrompt,
														onChange: (event) => edit("controllerPrompt", event.currentTarget.value)
													})]
												})
											]
										})
									] }) : null,
									tab === "roles" && draft ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: ThalirisPage_module_css_default.section,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: ThalirisPage_module_css_default.sectionHead,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("rolesTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("rolesHelp") })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "primary",
													onClick: () => edit("roles", [...draft.roles, {
														id: "",
														name: "",
														description: "",
														prompt: "",
														enabled: true,
														tools: [],
														modelPolicy: {
															mode: "inherit",
															routes: []
														},
														memory: {
															read: [],
															write: []
														},
														context: {
															handoff: true,
															memory: false
														}
													}]),
													children: t("addRole")
												})]
											}),
											native.templateStatus === "idle" || native.templateStatus === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
												onClick: () => props.refresh(),
												children: t("loadTemplates")
											}) : null,
											native.templateStatus === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("templateUnavailable") }) : null,
											templates.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: ThalirisPage_module_css_default.inline,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: templateId,
													onChange: (event) => setTemplateId(event.currentTarget.value),
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "",
														children: t("chooseTemplate")
													}), templates.map((template) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: template.id,
														children: template.name
													}, template.id))]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													disabled: !templateId || draft.roles.some((role) => role.id === templateId),
													onClick: () => {
														const template = templates.find((role) => role.id === templateId);
														if (template) edit("roles", [...draft.roles, structuredClone(template)]);
													},
													children: t("addTemplate")
												})]
											}) : null,
											draft.roles.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("noRoles") }) : null,
											draft.roles.map((role, index) => {
												const chosenRoutes = role.modelPolicy.routes;
												const route = chosenRoutes[0];
												const selectedKey = route ? routeKey(route.provider, route.model) : "";
												const selectedChoice = routeChoices.find((candidate) => routeKey(candidate.provider, candidate.model) === selectedKey);
												const routeUnavailable = role.modelPolicy.mode === "fixed" && Boolean(route && !selectedChoice);
												const availableExactRoutes = routeChoices.flatMap((choice) => [{
													...choice,
													reasoningEffort: void 0,
													effortName: t("defaultEffort"),
													available: true
												}, ...choice.efforts.map((effort) => ({
													...choice,
													reasoningEffort: effort.id,
													effortName: effort.name ?? effort.id,
													available: true
												}))]);
												const allowedChoices = [...availableExactRoutes, ...chosenRoutes.filter((value) => !availableExactRoutes.some((choice) => exactRouteKey(choice) === exactRouteKey(value))).map((value) => ({
													...value,
													providerName: value.provider,
													modelName: value.model,
													effortName: value.reasoningEffort ?? t("defaultEffort"),
													available: false
												}))];
												const updateRoute = (key) => {
													const candidate = routeChoices.find((item) => routeKey(item.provider, item.model) === key);
													if (!candidate) return;
													const next = {
														provider: candidate.provider,
														model: candidate.model
													};
													editRole(index, { modelPolicy: {
														...role.modelPolicy,
														routes: role.modelPolicy.mode === "allowed" ? [...role.modelPolicy.routes.filter((item) => routeKey(item.provider, item.model) !== key), next] : [next]
													} });
												};
												return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
													className: ThalirisPage_module_css_default.card,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: ThalirisPage_module_css_default.cardHead,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: role.name || role.id || t("addRole") }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
																checked: role.enabled,
																label: `${t("enabled")}: ${role.name || role.id || index + 1}`,
																onChange: (enabled) => editRole(index, { enabled })
															})]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: ThalirisPage_module_css_default.grid,
															children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
																	className: ThalirisPage_module_css_default.field,
																	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("roleId") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
																		value: role.id,
																		onChange: (event) => editRole(index, { id: event.currentTarget.value })
																	})]
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
																	className: ThalirisPage_module_css_default.field,
																	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("roleName") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
																		value: role.name,
																		onChange: (event) => editRole(index, { name: event.currentTarget.value })
																	})]
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
																	className: `${ThalirisPage_module_css_default.field} ${ThalirisPage_module_css_default.wide}`,
																	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("roleDescription") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
																		value: role.description,
																		onChange: (event) => editRole(index, { description: event.currentTarget.value })
																	})]
																})
															]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
															className: ThalirisPage_module_css_default.field,
															children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("rolePrompt") }),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
																	"aria-label": t("rolePrompt"),
																	value: role.prompt,
																	onChange: (event) => editRole(index, { prompt: event.currentTarget.value })
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("rolePromptHelp") })
															]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: ThalirisPage_module_css_default.subsection,
															children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("modelPolicy") }),
																/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
																	className: ThalirisPage_module_css_default.field,
																	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelPolicy") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
																		value: role.modelPolicy.mode,
																		onChange: (event) => editRole(index, { modelPolicy: {
																			...role.modelPolicy,
																			mode: event.currentTarget.value,
																			routes: event.currentTarget.value === "inherit" ? [] : role.modelPolicy.routes
																		} }),
																		children: [
																			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																				value: "inherit",
																				children: t("inherit")
																			}),
																			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																				value: "fixed",
																				children: t("fixed")
																			}),
																			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																				value: "allowed",
																				children: t("allowed")
																			})
																		]
																	})]
																}),
																role.modelPolicy.mode !== "inherit" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
																	native.modelStatus === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("modelCatalogLoading") }) : null,
																	native.modelStatus !== "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("modelCatalogUnavailable") }) : null,
																	routeUnavailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
																		className: ThalirisPage_module_css_default.notice,
																		children: [
																			t("unavailableRoute"),
																			": ",
																			route?.provider,
																			"/",
																			route?.model
																		]
																	}) : null,
																	role.modelPolicy.mode === "fixed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
																		className: ThalirisPage_module_css_default.field,
																		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("selectedModel") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
																			value: selectedKey,
																			onChange: (event) => updateRoute(event.currentTarget.value),
																			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																				value: "",
																				children: t("noModels")
																			}), routeChoices.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
																				value: routeKey(item.provider, item.model),
																				children: [
																					item.providerName,
																					" / ",
																					item.modelName
																				]
																			}, routeKey(item.provider, item.model)))]
																		})]
																	}) : null,
																	role.modelPolicy.mode === "allowed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
																		className: ThalirisPage_module_css_default.checkGrid,
																		children: allowedChoices.map((item) => {
																			const key = exactRouteKey(item);
																			const checked = role.modelPolicy.routes.some((value) => exactRouteKey(value) === key);
																			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
																				className: ThalirisPage_module_css_default.stack,
																				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
																					checked,
																					label: item.available ? `${item.providerName} / ${item.modelName} (${item.effortName})` : `${item.provider}/${item.model} (${item.effortName}) — ${t("unavailableRoute")}`,
																					onChange: (next) => {
																						const selected = role.modelPolicy.routes.filter((value) => exactRouteKey(value) !== key);
																						if (next && item.available) selected.push({
																							provider: item.provider,
																							model: item.model,
																							...item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}
																						});
																						editRole(index, { modelPolicy: {
																							...role.modelPolicy,
																							routes: selected
																						} });
																					}
																				})
																			}, key);
																		})
																	}) : null,
																	role.modelPolicy.mode === "fixed" && selectedChoice?.efforts.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
																		className: ThalirisPage_module_css_default.field,
																		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("reasoningEffort") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
																			value: route?.reasoningEffort ?? "",
																			onChange: (event) => {
																				if (!route) return;
																				const next = {
																					provider: route.provider,
																					model: route.model,
																					...event.currentTarget.value ? { reasoningEffort: event.currentTarget.value } : {}
																				};
																				editRole(index, { modelPolicy: {
																					...role.modelPolicy,
																					routes: [next]
																				} });
																			},
																			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																				value: "",
																				children: t("defaultEffort")
																			}), selectedChoice.efforts.map((effort) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
																				value: effort.id,
																				children: effort.name ?? effort.id
																			}, effort.id))]
																		})]
																	}) : null
																] }) : null
															]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: ThalirisPage_module_css_default.subsection,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("tools") }), native.toolStatus !== "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("toolsUnavailable") }), role.tools.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
																checked: true,
																label: `${name} — ${t("toolUnavailable")}`,
																onChange: (checked) => {
																	if (!checked) editRole(index, { tools: role.tools.filter((value) => value !== name) });
																}
															}, name))] }) : native.tools.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("noTools") }), role.tools.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
																checked: true,
																label: `${name} — ${t("toolUnavailable")}`,
																onChange: (checked) => {
																	if (!checked) editRole(index, { tools: role.tools.filter((value) => value !== name) });
																}
															}, name))] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
																className: ThalirisPage_module_css_default.checkGrid,
																children: [...new Set([...native.tools.filter((tool) => !tool.name.startsWith("thaliris_task_") && tool.name !== "thaliris_reconcile" && tool.name !== "thaliris_workstream" && tool.name !== "thaliris_observe").map((tool) => tool.name), ...role.tools])].map((name) => {
																	const tool = native.tools.find((item) => item.name === name);
																	const reserved = name.startsWith("thaliris_task_") || name === "thaliris_reconcile" || name === "thaliris_workstream" || name === "thaliris_observe";
																	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
																		checked: role.tools.includes(name),
																		disabled: reserved && !role.tools.includes(name),
																		label: `${name}${tool?.description ? ` — ${tool.description}` : ` — ${t("toolUnavailable")}`}`,
																		onChange: (checked) => {
																			const tools = role.tools.filter((value) => value !== name);
																			if (checked) tools.push(name);
																			editRole(index, { tools });
																		}
																	}, name);
																})
															})]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: ThalirisPage_module_css_default.inlineActions,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																onClick: () => {
																	const duplicate = duplicateRole(role, draft.roles);
																	edit("roles", [
																		...draft.roles.slice(0, index + 1),
																		duplicate,
																		...draft.roles.slice(index + 1)
																	]);
																},
																children: t("duplicateRole")
															}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																onClick: () => edit("roles", draft.roles.filter((_, i) => i !== index)),
																children: t("deleteRole")
															})]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RoleGrantControls, {
															role,
															index,
															providers: native.providers,
															t: tfn,
															onRole: editRole
														})
													]
												}, `${role.id || "draft"}-${index}`);
											})
										]
									}) : null,
									tab === "memory" && draft ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryFields, {
										draft,
										native,
										t: tfn,
										editMemory,
										openPlugin: props.openPlugin,
										editRole
									}) : null,
									tab === "context" && draft ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										className: ThalirisPage_module_css_default.section,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("contextTitle") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("contextHelp") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: ThalirisPage_module_css_default.inline,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: workspaceId,
													onChange: (event) => setWorkspaceId(event.currentTarget.value),
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "",
														children: native.workspaces.phase === "pending" ? t("workspaceLoading") : t("chooseWorkspace")
													}), native.workspaces.items.map((workspace) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
														value: workspace.workspaceId,
														children: [
															workspace.title,
															" — ",
															workspace.path
														]
													}, workspace.workspaceId))]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													disabled: !workspaceId || draft.workspaces.some((row) => row.workspaceId === workspaceId),
													onClick: () => {
														const workspace = native.workspaces.items.find((row) => row.workspaceId === workspaceId);
														if (workspace) edit("workspaces", [...draft.workspaces, {
															workspaceId: workspace.workspaceId,
															root: workspace.path,
															enabled: true
														}]);
													},
													children: t("bindWorkspace")
												})]
											}),
											!native.workspaces.items.length && native.workspaces.phase === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("noWorkspaces") }) : null,
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: ThalirisPage_module_css_default.stack,
												children: draft.workspaces.map((binding, index) => {
													const workspace = native.workspaces.items.find((row) => row.workspaceId === binding.workspaceId);
													const autoBoundHere = autoBind?.workspaceId === binding.workspaceId;
													return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: ThalirisPage_module_css_default.card,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															className: ThalirisPage_module_css_default.cardHead,
															children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: workspace?.title ?? binding.workspaceId }),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: binding.root }),
																autoBoundHere ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
																	className: ThalirisPage_module_css_default.notice,
																	children: [t("workspaceAutoBound"), autoBind?.at ? ` — ${t("workspaceAutoBindAt")}: ${autoBind.at}` : ""]
																}) : null,
																!workspace ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
																	className: ThalirisPage_module_css_default.notice,
																	children: t("workspaceMissing")
																}) : null
															] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
																checked: binding.enabled,
																label: `${t("workspaceEnabled")}: ${binding.workspaceId}`,
																onChange: (enabled) => {
																	const workspaces = [...draft.workspaces];
																	workspaces[index] = {
																		...binding,
																		enabled
																	};
																	edit("workspaces", workspaces);
																}
															})]
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
															onClick: () => edit("workspaces", draft.workspaces.filter((_, i) => i !== index)),
															children: t("removeWorkspace")
														})]
													}, binding.workspaceId);
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("workspaceExplicitOnly") }) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: ThalirisPage_module_css_default.inline,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													disabled: !recentWorkspace || draft.workspaces.some((row) => row.workspaceId === recentWorkspace.workspaceId),
													onClick: () => {
														if (recentWorkspace) edit("workspaces", [...draft.workspaces, {
															workspaceId: recentWorkspace.workspaceId,
															root: recentWorkspace.path,
															enabled: true
														}]);
													},
													children: t("workspaceBindRecent")
												}), recentWorkspace ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
													recentWorkspace.title,
													" — ",
													recentWorkspace.path
												] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("workspaceRecentMissing") })]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("workspaceBindRecentHint") }) }),
											autoBind ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: ThalirisPage_module_css_default.card,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: ThalirisPage_module_css_default.cardHead,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("workspaceAutoBoundTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: autoBind.root })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
															tone: "info",
															children: t("workspaceAutoBound")
														})]
													}),
													autoBind.at ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
														t("workspaceAutoBindAt"),
														": ",
														autoBind.at
													] }) : null,
													draft.workspaces.some((row) => row.workspaceId === autoBind.workspaceId) ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
														className: ThalirisPage_module_css_default.notice,
														children: t("workspaceAutoBindStale")
													})
												]
											}) : null,
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("workspaceAutoBindHelp") }) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("roleHandoff") }),
											draft.roles.map((role, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: ThalirisPage_module_css_default.permissionRow,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: role.name || role.id || `Role ${index + 1}` }),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
														checked: role.context.handoff,
														label: t("roleHandoff"),
														onChange: (checked) => editRole(index, { context: {
															...role.context,
															handoff: checked
														} })
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
														checked: role.context.memory,
														label: t("roleMemoryContext"),
														onChange: (checked) => editRole(index, { context: {
															...role.context,
															memory: checked
														} })
													})
												]
											}, role.id || index))
										]
									}) : null
								]
							}),
							tab === "diagnostics" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Diagnostics, {
								native,
								selectedSession: sessionId,
								setSelectedSession: (value) => {
									setSessionId(value);
									setTaskId("");
								},
								selectedTask: taskId,
								setSelectedTask: setTaskId,
								copied,
								setCopied,
								t: tfn,
								loadDiagnostics: () => sessionId && taskId && props.loadDiagnostics(sessionId, taskId),
								openSession: props.openSession,
								approveMemory: props.approveMemory
							}) : null
						]
					})
				]
			});
		}
		function RoleGrantControls({ role, index, providers, t, onRole }) {
			const providerIds = [...new Set([
				...providers.map((provider) => provider.id),
				...role.memory.read,
				...role.memory.write
			])];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: ThalirisPage_module_css_default.subsection,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", { children: [
					t("roleMemory"),
					": ",
					role.name || role.id,
					" (",
					role.id,
					")"
				] }), providerIds.map((id) => {
					const provider = providers.find((value) => value.id === id);
					const name = provider?.name ?? id;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ThalirisPage_module_css_default.permissionRow,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
								name,
								" (",
								id,
								")"
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
								checked: role.memory.read.includes(id),
								label: `${t("roleRead")}: ${name}`,
								onChange: (checked) => {
									const read = role.memory.read.filter((value) => value !== id);
									if (checked) read.push(id);
									onRole(index, { memory: {
										...role.memory,
										read
									} });
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
								checked: role.memory.write.includes(id),
								label: `${t("roleWrite")}: ${name}`,
								onChange: (checked) => {
									const write = role.memory.write.filter((value) => value !== id);
									if (checked) write.push(id);
									onRole(index, { memory: {
										...role.memory,
										write
									} });
								}
							}),
							provider ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: ThalirisPage_module_css_default.notice,
								children: [
									t("providerMissing"),
									": ",
									id
								]
							})
						]
					}, id);
				})]
			});
		}
		function MemoryFields({ draft, native, t, editMemory, openPlugin, editRole }) {
			const memory = draft.memory;
			const toggle = (field, id, checked) => {
				const values = memory[field].filter((value) => value !== id);
				if (checked) values.push(id);
				editMemory({ [field]: values });
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: ThalirisPage_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("memoryTitle") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("memoryHelp") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: ThalirisPage_module_css_default.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("memoryMode") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							value: memory.mode,
							onChange: (event) => editMemory({ mode: event.currentTarget.value }),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "disabled",
									children: t("modeDisabled")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "manual",
									children: t("modeManual")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "suggest-review",
									children: t("modeSuggest")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "auto",
									children: t("modeAuto")
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ThalirisPage_module_css_default.permissionRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
							checked: memory.autoAuthorized,
							label: t("autoAuthorized"),
							onChange: (autoAuthorized) => editMemory({ autoAuthorized })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("autoAuthorizedHelp") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("providers") }),
					native.providers.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("noProviders") }) : null,
					[...new Set([
						...native.providers.map((provider) => provider.id),
						...memory.providers,
						...memory.controllerRead,
						...memory.controllerWrite
					])].map((id) => {
						const provider = native.providers.find((value) => value.id === id);
						const name = provider?.name ?? id;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ThalirisPage_module_css_default.permissionRow,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
									checked: memory.providers.includes(id),
									label: `${name} (${id}) — ${t("providerEnabled")}`,
									onChange: (checked) => toggle("providers", id, checked)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
									checked: memory.controllerRead.includes(id),
									label: `${t("controllerRead")}: ${name}`,
									onChange: (checked) => toggle("controllerRead", id, checked)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
									checked: memory.controllerWrite.includes(id),
									label: `${t("controllerWrite")}: ${name}`,
									onChange: (checked) => toggle("controllerWrite", id, checked)
								}),
								provider ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: ThalirisPage_module_css_default.notice,
									children: [
										t("providerMissing"),
										": ",
										id
									]
								})
							]
						}, id);
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ThalirisPage_module_css_default.inlineActions,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: () => openPlugin("@thaliris/dsh-memory"),
							children: t("openMemoryPlugin")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: () => openPlugin("@thaliris/dsh-memory-local"),
							children: t("openLocalPlugin")
						})]
					}),
					draft.roles.map((role, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RoleGrantControls, {
						role,
						index,
						providers: native.providers,
						t,
						onRole: editRole
					}, `${role.id || "draft"}-${index}`))
				]
			});
		}
		function Diagnostics({ native, selectedSession, setSelectedSession, selectedTask, setSelectedTask, copied, setCopied, t, loadDiagnostics, openSession, approveMemory }) {
			const roots = native.sessions.ids.map((id) => native.sessions.byId[id]).filter((row) => row && row.parentId === void 0 && row.origin !== "subagent");
			const data = record(native.diagnostics);
			const task = record(data?.task);
			const taskState = record(task?.state);
			const taskMatches = taskState?.task_id === selectedTask;
			const pendingResults = (taskState?.pending_results ?? []).flatMap((item) => {
				try {
					return [typeof item === "string" ? JSON.parse(item) : item];
				} catch {
					return [];
				}
			}).map(record).filter((item) => item);
			const proposals = pendingResults.filter((item) => typeof item.proposal_id === "string" && typeof item.approval_id !== "string" && typeof item.provider === "string" && typeof item.key === "string" && typeof item.text === "string" && item.provenance !== void 0);
			const recordedReceipts = (Array.isArray(taskState?.records) ? taskState.records : []).map(record).filter((item) => item?.kind === "dsh-memory-approval" && item.producer === "dsh:adapter" && typeof item.text === "string").flatMap((item) => {
				try {
					return [record(JSON.parse(item.text))?.receipt];
				} catch {
					return [];
				}
			}).map(record).filter((item) => item);
			const approvalReceipts = [...pendingResults, ...recordedReceipts].filter((item) => typeof item.approval_id === "string" && typeof item.proposal_id === "string");
			const reservations = Array.isArray(data?.reservations) ? data.reservations : [];
			const approved = new Set(approvalReceipts.map((value) => value.proposal_id));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: ThalirisPage_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("diagnosticsTitle") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("diagnosticsHelp") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ThalirisPage_module_css_default.inline,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								value: selectedSession,
								onChange: (event) => setSelectedSession(event.currentTarget.value),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("selectSession")
								}), roots.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: row.id,
									children: [
										row.displayTitle,
										" — ",
										row.id
									]
								}, row.id))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								"aria-label": t("selectTaskId"),
								placeholder: t("selectTaskId"),
								value: selectedTask,
								onChange: (event) => setSelectedTask(event.currentTarget.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								disabled: !selectedSession || !selectedTask.trim() || native.diagnosticStatus === "loading",
								onClick: loadDiagnostics,
								children: native.diagnosticStatus === "loading" ? t("diagnosticsLoading") : native.diagnosticStatus === "ready" ? t("refreshDiagnostics") : t("loadDiagnostics")
							})
						]
					}),
					roots.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("noRootSessions") }) : null,
					native.diagnosticStatus === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: ThalirisPage_module_css_default.error,
						children: native.diagnosticError ?? t("diagnosticsUnavailable")
					}) : null,
					data && !taskMatches ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: ThalirisPage_module_css_default.notice,
						children: [
							t("diagnosticsTaskChanged"),
							": ",
							String(taskState?.task_id ?? "")
						]
					}) : null,
					data && taskMatches ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ThalirisPage_module_css_default.grid,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoCard, {
									title: t("taskEvidence"),
									value: task
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoCard, {
									title: t("workspaceEvidence"),
									value: data.workspace
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoCard, {
									title: t("permissionsEvidence"),
									value: {
										permissions: data.permissions,
										providers: data.providers
									}
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("reservationEvidence") }),
						reservations.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("noReservations") }) : reservations.map((item, index) => {
							const row = record(item) ?? {};
							const reservation = record(row.reservation) ?? {};
							const observation = record(row.native) ?? {};
							const outcome = observation.outcome;
							const terminal = [
								"completed",
								"aborted",
								"error",
								"max-tokens",
								"blocked",
								"interrupted"
							].includes(String(outcome));
							const resident = typeof observation.reason === "string" && observation.reason.includes("resident");
							const action = terminal ? "reconcile" : resident ? "cancel-reconcile" : "check";
							const args = {
								task_id: taskState?.task_id,
								base_revision: taskState?.revision,
								action
							};
							const copy = async () => {
								try {
									await navigator.clipboard.writeText(json(args));
									setCopied(true);
								} catch {
									setCopied(false);
								}
							};
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
								className: ThalirisPage_module_css_default.card,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: reservation.workstream ?? reservation.correlation ?? t("reservationEvidence") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
										t("outcome"),
										": ",
										String(outcome ?? "UNKNOWN")
									] }),
									!terminal ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: ThalirisPage_module_css_default.notice,
										children: t("unknownOutcome")
									}) : null,
									observation.child_id ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: ThalirisPage_module_css_default.inline,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: String(observation.child_id) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											onClick: () => openSession(String(observation.child_id)),
											children: t("openChildSession")
										})]
									}) : null,
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("reconcileGuide") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("reconcileCommand") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", { children: json(args) })] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										onClick: () => {
											copy();
										},
										children: copied ? t("commandCopied") : t("copyCommand")
									})
								]
							}, `${reservation.workstream ?? "reservation"}-${index}`);
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("proposals") }),
						proposals.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("noProposals") }) : proposals.map((proposal) => {
							const memory = record(data.permissions)?.memory;
							const canApprove = memory && memory.mode !== "disabled" && memory.providers?.includes(proposal.provider) && memory.controllerWrite?.includes(proposal.provider);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
								className: ThalirisPage_module_css_default.card,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: proposal.proposal_id }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
										t("proposalProvider"),
										": ",
										proposal.provider
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
										t("proposalKey"),
										": ",
										proposal.key
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("proposalText") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", { children: String(proposal.text ?? "") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
										t("proposalProvenance"),
										": ",
										json(proposal.provenance)
									] }),
									approved.has(proposal.proposal_id) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("alreadyApproved") }) : canApprove ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										disabled: !taskMatches || native.approvalStatus === "saving",
										onClick: () => approveMemory(selectedSession, selectedTask, proposal.proposal_id),
										children: t("approveProposal")
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: ThalirisPage_module_css_default.notice,
										children: t("noApprovalGrant")
									})
								]
							}, proposal.proposal_id);
						}),
						approvalReceipts.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoCard, {
							title: t("approvalReceipts"),
							value: approvalReceipts
						}) : null,
						native.approvalStatus === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoCard, {
							title: t("proposalApproved"),
							value: native.approvalReceipt
						}) : null,
						native.approvalStatus === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ThalirisPage_module_css_default.error,
							children: native.approvalError ?? t("approvalUncertain")
						}), native.approvalError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ThalirisPage_module_css_default.notice,
							children: t("approvalUncertain")
						}) : null] }) : null
					] }) : null
				]
			});
		}
		function InfoCard({ title, value }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: ThalirisPage_module_css_default.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", { children: json(value) })]
			});
		}
		function SetupSection({ setup, runtime, runtimeInvalid, writable, editRuntime, t, onPrepare, onRecheck, onRefresh }) {
			const data = setup.setup;
			const runtimeInfo = data?.runtime;
			const pin = data?.pin;
			const busy = setup.action !== "idle";
			const progress = data?.progress;
			const progressStep = setupStepLabel(progress?.step, t);
			const prepareLabel = data?.state === "failed" ? t("setupRetry") : data?.state === "ready" ? t("setupPrepareAgain") : t("setupPrepare");
			const source = setupSourceLabel(runtimeInfo?.source, t);
			const pinLabel = pin?.version ? `${pin.version}${pin.commit ? ` @ ${pin.commit.slice(0, 12)}` : ""}` : pin?.error ? t("setupPinError") : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: ThalirisPage_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ThalirisPage_module_css_default.sectionHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("setupTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("setupHelp") })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ThalirisPage_module_css_default.inlineActions,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									disabled: busy,
									onClick: onPrepare,
									children: busy && setup.action === "preparing" ? t("setupPreparing") : prepareLabel
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									disabled: busy,
									onClick: onRecheck,
									children: busy && setup.action === "rechecking" ? t("setupRechecking") : t("setupRecheck")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									disabled: busy,
									onClick: onRefresh,
									children: t("setupRefresh")
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("setupFirstUse") }),
					data ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ThalirisPage_module_css_default.inline,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
								tone: setupStateTone(data.state),
								children: setupStateLabel(data.state, t)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
								tone: data.verified ? "success" : "neutral",
								children: data.verified ? t("setupVerified") : t("setupUnverified")
							}),
							data.manual_override ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
								tone: "info",
								children: t("setupManualOverride")
							}) : null
						]
					}) : null,
					busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: ThalirisPage_module_css_default.notice,
						role: "status",
						children: [
							setup.action === "preparing" ? t("setupPreparing") : t("setupRechecking"),
							progressStep ? ` — ${progressStep}` : "",
							typeof progress?.elapsed_ms === "number" ? ` (${Math.round(progress.elapsed_ms / 1e3)}s)` : ""
						]
					}) : null,
					setup.actionError ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: ThalirisPage_module_css_default.error,
						role: "alert",
						children: [
							t("setupActionFailed"),
							": ",
							setup.actionError
						]
					}) : null,
					setup.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: ThalirisPage_module_css_default.error,
						role: "alert",
						children: setup.error ? `${t("setupUnavailable")} ${setup.error}` : t("setupUnavailable")
					}) : null,
					setup.status === "loading" && !data ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("setupStatusLoading") }) : null,
					data ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
						className: ThalirisPage_module_css_default.keyValues,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("setupAuthority") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: data.authorityDirectory ?? t("setupNotConfigured") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("setupPython") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: runtimeInfo?.pythonExecutable ?? t("setupNotConfigured") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("setupPythonVersion") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: runtimeInfo?.python ?? "—" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("setupCoreVersion") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: runtimeInfo?.version ?? "—" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("setupCorePath") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: runtimeInfo?.corePath ?? "—" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("setupSource") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: source ?? "—" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("setupVerifiedAt") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: runtimeInfo?.verified_at ?? "—" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("setupPin") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: pinLabel ?? "—" })
						]
					}) : null,
					data && data.state === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ThalirisPage_module_css_default.card,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("setupErrorLabel") }),
							data.code ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
								t("setupCodeLabel"),
								": ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: data.code })
							] }) : null,
							data.recovery ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
								t("setupRecoveryLabel"),
								": ",
								data.recovery
							] }) : null,
							data.detail ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
								t("setupDetailLabel"),
								": ",
								data.detail
							] }) : null
						]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("setupOverridesTitle") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("setupOverridesHelp") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: ThalirisPage_module_css_default.grid,
						children: RUNTIME_FIELDS.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: ThalirisPage_module_css_default.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: runtimeFieldLabel(field, t) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									"aria-label": runtimeFieldLabel(field, t),
									value: runtime?.[field] ?? "",
									disabled: !writable,
									"aria-invalid": runtimeInvalid.includes(field) ? true : void 0,
									onChange: (event) => editRuntime(field, event.currentTarget.value)
								}),
								runtimeInvalid.includes(field) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
									className: ThalirisPage_module_css_default.error,
									children: t("setupInvalidLocation")
								}) : null
							]
						}, field))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("setupOverridesSaveHint") }) })
				]
			});
		}
		function ModeSection({ mode, t, onSet, onRestore }) {
			const row = thalirisRow(mode);
			const healthy = thalirisHealthy(mode);
			const isDefault = isThalirisDefault(mode);
			const dangling = danglingDefault(mode);
			const effective = effectiveDefaultId(mode);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: ThalirisPage_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("modeTitle") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("modeHelp") }),
					mode.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("modeRosterLoading") }) : null,
					mode.status === "unavailable" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: ThalirisPage_module_css_default.notice,
						children: t("modeRegistryUnavailable")
					}) : null,
					mode.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: ThalirisPage_module_css_default.error,
						role: "alert",
						children: [t("modeRegistryError"), mode.error ? `: ${mode.error}` : ""]
					}) : null,
					mode.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ThalirisPage_module_css_default.inline,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t("modePresetHealth"), ":"] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
									tone: row ? healthy ? "success" : "danger" : "outline",
									children: row ? healthy ? t("modeHealthy") : t("modeBroken") : t("modeMissing")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t("modeDefaultLabel"), ":"] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
									tone: dangling ? "danger" : isDefault ? "warning" : "neutral",
									children: dangling ? t("modeNoDefault") : isDefault ? t("modeIsDefault") : t("modeIsOtherDefault")
								})
							]
						}),
						row?.broken ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: ThalirisPage_module_css_default.error,
							children: [
								t("modeBrokenDetail"),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: row.broken })
							]
						}) : null,
						mode.registryAvailable ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ThalirisPage_module_css_default.notice,
							children: t("modeSettingsUnavailable")
						}),
						mode.presets.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("modeRosterEmpty") }) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
							className: ThalirisPage_module_css_default.keyValues,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("modeNativeDefault") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: mode.nativeDefault ?? "—" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("modeSelectedDefault") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: mode.selectedDefault ?? "—" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("modeDefaultLabel") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: effective ?? "—" })
							]
						}),
						dangling ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ThalirisPage_module_css_default.error,
							role: "alert",
							children: t("modeDanglingResolve")
						}) : null,
						isDefault ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ThalirisPage_module_css_default.notice,
							children: t("modeDanglingWarning")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: ThalirisPage_module_css_default.inlineActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								disabled: !canSetThalirisDefault(mode),
								onClick: onSet,
								children: t("modeSetDefault")
							}), restoreNeeded(mode) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								disabled: !canRestoreNativeDefault(mode),
								onClick: onRestore,
								children: t("modeRestoreDefault")
							}) : null]
						}),
						mode.saving ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: ThalirisPage_module_css_default.notice,
							role: "status",
							children: t("modeSavingDefault")
						}) : null,
						mode.saveError ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: ThalirisPage_module_css_default.error,
							role: "alert",
							children: [
								t("modeWriteFailed"),
								": ",
								mode.saveError
							]
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("modeNoAutoWrite") }) })
					] }) : null
				]
			});
		}
		function RecommendedPermissions({ draft, native, t, disabled, onApply, onLoadTemplates }) {
			const templates = native.templates;
			const recommendations = roleRecommendations(draft.roles, templates);
			const catalog = new Set(native.tools.map((tool) => tool.name));
			const applicable = recommendations.some((recommendation) => recommendation.tools.length > 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: ThalirisPage_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("recommendedTitle") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("recommendedHelp") }),
					native.templateStatus !== "ready" && recommendations.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ThalirisPage_module_css_default.inline,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("templateUnavailable") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: onLoadTemplates,
							children: t("loadTemplates")
						})]
					}) : null,
					recommendations.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("recommendedNone") }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ThalirisPage_module_css_default.stack,
						children: [
							recommendations.map((recommendation) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
								className: ThalirisPage_module_css_default.card,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: ThalirisPage_module_css_default.cardHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: recommendation.role.name || recommendation.role.id }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: recommendation.role.id })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
										tone: recommendation.tools.length > 0 ? "warning" : "outline",
										children: [
											t("recommendedCurrent"),
											": ",
											recommendation.role.tools.length
										]
									})]
								}), recommendation.template ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: ThalirisPage_module_css_default.subsection,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("recommendedTools") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: ThalirisPage_module_css_default.checkGrid,
										children: recommendation.tools.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: ThalirisPage_module_css_default.stack,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: name }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: native.toolStatus === "ready" ? catalog.has(name) ? t("recommendedInCatalog") : t("recommendedNotInCatalog") : t("recommendedCatalogMissing") })]
										}, name))
									})]
								}) : native.templateStatus === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: ThalirisPage_module_css_default.notice,
									children: t("recommendedNoTemplate")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: ThalirisPage_module_css_default.notice,
									children: t("recommendedTemplatesPending")
								})]
							}, recommendation.role.id || recommendation.index)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: ThalirisPage_module_css_default.inlineActions,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									disabled: disabled || !applicable,
									onClick: () => onApply(templates),
									children: t("recommendedApply")
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("recommendedHint") }) })
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Web/Desktop settings strings for the shared Thaliris client. */
		const NS = "settings.thaliris";
		const en = {
			pluginTitle: "Thaliris",
			summary: "Set up the Thaliris runtime, its Agent Preset default, role permissions, Workspace access, memory grants, and native diagnostics.",
			settingsLabel: "Thaliris settings",
			tabGeneral: "General",
			tabRoles: "Roles",
			tabMemory: "Memory",
			tabContext: "Context",
			tabDiagnostics: "Diagnostics",
			formUnavailable: "Thaliris settings are not available from this connection.",
			readOnly: "This connection cannot persist Settings. Changes stay unavailable until the Host serves writable Settings.",
			save: "Save changes",
			saving: "Saving…",
			saveFailed: "The Host did not accept these Settings.",
			discard: "Reload native values",
			conflict: "Settings changed after these edits began. Reload native values before editing again.",
			generalTitle: "Controller guidance",
			generalHelp: "This visible prompt is sent to the native root Controller in a configured Workspace. Thaliris records its decisions but does not make them.",
			controllerPrompt: "Controller guidance",
			rolesTitle: "Editable roles",
			rolesHelp: "Role records are user policy. The Controller chooses which enabled role, if any, fits each bounded Workstream.",
			addRole: "New role",
			noRoles: "No roles are stored. Use New role or add an explicit template.",
			addTemplate: "Add selected template",
			chooseTemplate: "Choose a template",
			loadTemplates: "Load templates",
			templateUnavailable: "Templates are unavailable while the runtime API is not mounted.",
			duplicateRole: "Duplicate",
			deleteRole: "Delete",
			enabled: "Enabled",
			roleId: "Stable role ID",
			roleName: "Name",
			roleDescription: "Description",
			rolePrompt: "Full role prompt",
			rolePromptHelp: "This complete prompt is sent to the selected native child. No hidden role suffix is added.",
			tools: "Allowed native tools",
			toolsUnavailable: "The native tool list is unavailable. Retry after enabling the runtime API.",
			refresh: "Refresh",
			noTools: "No native tools were returned.",
			toolUnavailable: "not in the current native tool catalog",
			modelPolicy: "Model policy",
			inherit: "Inherit the native parent model",
			fixed: "Use one fixed route",
			allowed: "Allow these exact routes",
			modelCatalogUnavailable: "The native model catalog is unavailable.",
			modelCatalogLoading: "Loading the native model catalog…",
			noModels: "The native catalog has no available routes.",
			selectedModel: "Selected route",
			reasoningEffort: "Reasoning effort",
			defaultEffort: "Native default",
			unavailableRoute: "Stored route is no longer in the native catalog",
			memoryTitle: "Memory policy",
			memoryHelp: "Memory stays disabled until providers and explicit grants are selected. Auto writes also need a separate persisted user opt-in.",
			memoryMode: "Write policy",
			modeDisabled: "Disabled",
			modeManual: "Manual",
			modeSuggest: "Suggest and review",
			modeAuto: "Automatic writes",
			autoAuthorized: "I explicitly authorize automatic memory writes",
			autoAuthorizedHelp: "This consent is independent from the selected write policy.",
			providers: "Available providers",
			providerEnabled: "Enabled for Thaliris",
			providerMissing: "Selected provider is not installed or currently unavailable",
			noProviders: "No memory provider is active. Install an optional provider through the native Plugins page.",
			memoryCapabilityMissing: "The memory capability is not active. Install it from the native Plugins page.",
			openMemoryPlugin: "Open memory capability in Plugins",
			openLocalPlugin: "Open local provider in Plugins",
			controllerRead: "Controller may read",
			controllerWrite: "Controller may write or approve proposals",
			roleMemory: "Role memory grants",
			roleRead: "May read",
			roleWrite: "May write or propose",
			contextTitle: "Workspace and role context",
			contextHelp: "Workspace IDs and roots come from the native Workspace list. A matching path alone does not establish a Controller.",
			workspaceBindings: "Bound native Workspaces",
			workspaceLoading: "Loading native Workspaces…",
			noWorkspaces: "No native Workspaces are available.",
			chooseWorkspace: "Choose a native Workspace",
			bindWorkspace: "Bind Workspace",
			removeWorkspace: "Remove binding",
			workspaceEnabled: "Enabled for Thaliris",
			workspaceMissing: "This stored Workspace is not in the current native Workspace list.",
			roleHandoff: "May receive a bounded Controller handoff",
			roleMemoryContext: "May receive explicitly selected memory context",
			diagnosticsTitle: "Native diagnostics",
			diagnosticsHelp: "Select a native root Session and the Task ID returned by thaliris_task_start. A root Session may own multiple independent tasks; diagnostics never chooses by Workspace.",
			selectSession: "Native root Session",
			selectTaskId: "Explicit Core Task ID",
			diagnosticsTaskChanged: "Loaded diagnostics belong to this different task. Load the selected Task ID to continue",
			noRootSessions: "No native root Sessions are listed.",
			loadDiagnostics: "Load diagnostics",
			refreshDiagnostics: "Refresh diagnostics",
			diagnosticsLoading: "Reading current Core and native Session evidence…",
			diagnosticsUnavailable: "Diagnostics are unavailable. Enable the runtime and its native API plugin, then retry.",
			taskEvidence: "Core task evidence",
			workspaceEvidence: "Verified Workspace",
			permissionsEvidence: "Current grants",
			reservationEvidence: "Native reservation evidence",
			noReservations: "No active reservations are listed.",
			outcome: "Native outcome",
			unknownOutcome: "UNKNOWN — the reservation remains reserved.",
			reconcileGuide: "Only a proven native terminal outcome can be reconciled. The native tool records that observation; semantic acceptance remains the Controller’s decision.",
			reconcileCommand: "Native reconcile command arguments",
			copyCommand: "Copy arguments",
			commandCopied: "Arguments copied.",
			childSession: "Observed native child Session",
			openChildSession: "Open child Session",
			proposals: "Memory proposals for review",
			noProposals: "No pending memory proposals were returned.",
			proposalProvider: "Provider",
			proposalKey: "Key",
			proposalText: "Proposed text",
			proposalProvenance: "Provenance",
			approveProposal: "Approve this proposal",
			proposalApproved: "Native provider result and Core approval receipt",
			approvalReceipts: "Recorded Core approval receipts",
			approvalUncertain: "Approval did not return a complete receipt. The provider write may have succeeded; refresh diagnostics and provider state before retrying.",
			alreadyApproved: "An approval receipt is recorded for this proposal.",
			noApprovalGrant: "Approval is unavailable under the current provider, write grant, or memory policy.",
			installForProvider: "Install or enable this provider in the native Plugins page.",
			projectionRefresh: "Refresh native projections",
			runtimeRequiresSetup: "The runtime and API are installed as separate native entries. Configure Python, Core, authority directory, and Workspace access in the native plugin configuration, then enable both entries in Plugins.",
			setupTitle: "First-run setup",
			setupHelp: "Thaliris provisions its pinned Core runtime on first use. Nothing is provisioned automatically from this page: Prepare and Re-check are explicit human actions, and Standard or unselected sessions never provision anything.",
			setupFirstUse: "First use provisions automatically: the first Thaliris tool call prepares a pinned Core runtime, typically within a second or two. A failure leaves the plugin loaded and reports a code with recovery text below.",
			setupStatusLoading: "Reading the setup status…",
			setupUnavailable: "Setup status is unavailable from this connection.",
			setupStateLabel: "Runtime state",
			stateUnconfigured: "Not provisioned yet",
			stateDetecting: "Detecting Python",
			stateProvisioning: "Provisioning",
			stateVerifying: "Verifying",
			stateReady: "Ready",
			stateFailed: "Failed",
			stateUnknown: "Unknown state",
			setupVerified: "Verified in this process",
			setupUnverified: "Not verified in this process yet",
			setupProgress: "Current step",
			setupElapsed: "Elapsed",
			setupAttempt: "Attempt",
			setupNotConfigured: "No runtime is configured or recorded yet.",
			setupPin: "Pinned Core",
			setupPinError: "The Core pin is unreadable",
			setupPython: "Python interpreter",
			setupPythonVersion: "Python version",
			setupCoreVersion: "Core version",
			setupCorePath: "Core package path",
			setupAuthority: "Authority directory",
			setupSource: "Runtime source",
			sourceProvisioned: "Provisioned for this install",
			sourceRecorded: "Recorded runtime manifest",
			sourceConfiguration: "Manual paths",
			sourceDetected: "Host-detected",
			setupVerifiedAt: "Verified at",
			setupConfigured: "Manual paths configured",
			setupManualOverride: "Manual override active",
			setupErrorLabel: "Setup failure",
			setupCodeLabel: "Code",
			setupRecoveryLabel: "Recovery",
			setupDetailLabel: "Detail",
			setupPrepare: "Prepare Thaliris runtime",
			setupPrepareAgain: "Prepare again",
			setupRetry: "Retry preparing runtime",
			setupRecheck: "Re-check runtime",
			setupPreparing: "Preparing the Thaliris runtime…",
			setupRechecking: "Re-checking the configured runtime…",
			setupActionFailed: "The setup action did not complete",
			setupRefresh: "Refresh setup status",
			setupStepDetectPython: "Detect Python",
			setupStepFetchSource: "Fetch the pinned Core source",
			setupStepCreateRuntime: "Create the isolated runtime",
			setupStepInstallCore: "Install the pinned Core",
			setupStepVerifyCore: "Verify Core imports",
			setupStepWriteManifest: "Write the runtime manifest",
			setupStepVerifyRecorded: "Verify the recorded runtime",
			setupStepVerifyConfigured: "Verify the configured paths",
			setupStepReady: "Ready",
			setupOverridesTitle: "Manual runtime paths (optional)",
			setupOverridesHelp: "Leave a field blank to use the provisioned or host-detected default. These are optional volatile settings; the host validates them on its next use, and clearing a field removes your override.",
			setupPythonOverride: "Python executable",
			setupCoreOverride: "Core package path",
			setupAuthorityOverride: "Authority directory",
			setupOverridesSaveHint: "Save changes writes these overrides; use Re-check afterward to verify them.",
			setupInvalidLocation: "Enter an absolute path, or leave the field blank.",
			workspaceAutoBoundTitle: "Auto-bound Workspace",
			workspaceAutoBindHelp: "On the first Thaliris session in a Workspace, when no binding exists yet, the host binds that Workspace once. Standard or unselected sessions never create a binding.",
			workspaceAutoBound: "Auto-bound on first Thaliris use",
			workspaceAutoBindAt: "Bound at",
			workspaceAutoBindStale: "This process reported an auto-bound Workspace that is not in the current draft. Reload native values to see the stored binding.",
			workspaceBindRecent: "Bind most recent Workspace",
			workspaceBindRecentHint: "The settings page has no Session selection, so this binds the native Workspace whose Sessions changed most recently.",
			workspaceRecentMissing: "No native Workspace with Session activity is available to bind.",
			workspaceExplicitOnly: "A binding is written only by an explicit action here, or once by the first-use auto-bind of a Thaliris-selected Session.",
			modeTitle: "Agent Preset and new-Session default",
			modeHelp: "Thaliris is an optional native Agent Preset; Sessions keep the preset they started with, and the default applies only to new Sessions. The plugin never changes the default automatically.",
			modePresetHealth: "Thaliris preset health",
			modeHealthy: "Healthy",
			modeBroken: "Registered but unavailable",
			modeMissing: "Not registered on this host",
			modeRegistryUnavailable: "This host does not serve the native Agent Preset registry.",
			modeSettingsUnavailable: "The native Agent Preset settings section is not served, so the default cannot be changed from this page.",
			modeRegistryError: "Reading the native preset roster failed",
			modeRosterLoading: "Reading the native preset roster…",
			modeRosterEmpty: "The native registry lists no presets.",
			modeDefaultLabel: "New-Session default",
			modeIsDefault: "Thaliris is the native new-Session default",
			modeIsOtherDefault: "Another preset is the native new-Session default",
			modeNoDefault: "The saved new-Session default does not resolve to a registered preset",
			modeNativeDefault: "Native default preset",
			modeSelectedDefault: "Saved default override",
			modeSetDefault: "Set Thaliris as new-Session default",
			modeRestoreDefault: "Restore native default",
			modeSavingDefault: "Writing the native default…",
			modeWriteFailed: "The host did not accept the default change",
			modeBrokenDetail: "The Thaliris preset is registered but its composition failed to mount. Sessions that select it may fail; Sessions using another default are unaffected.",
			modeDanglingWarning: "Disabling or removing the Thaliris bundle while it is the new-Session default leaves a dangling default: new unnamed Sessions fail until another default is chosen. Restore the native default before disabling or removing the bundle.",
			modeDanglingResolve: "Restore the native default to repair new-Session creation.",
			modeNoAutoWrite: "No default is written until you click one of these actions.",
			recommendedTitle: "Recommended native permissions",
			recommendedHelp: "Shipped role templates grant curated native DSH tools. The plugin never rewrites stored roles: this lists enabled roles whose tool grants are empty and applies the recommendation only when you click Apply.",
			recommendedNone: "Every enabled role already has native tool grants.",
			recommendedNoTemplate: "No shipped template matches this role ID; no recommendation is available.",
			recommendedTools: "Recommended native tools",
			recommendedCurrent: "Current grants",
			recommendedApply: "Apply recommended permissions",
			recommendedHint: "Apply writes policy.roles through the native Settings revision fence. It is the only write this section performs, and it runs only on your click.",
			recommendedApplied: "Recommended permissions were written.",
			recommendedApplyFailed: "The host did not accept the recommended permissions",
			recommendedCatalogMissing: "The host tool catalog is unavailable; the shipped recommendation is shown from the role templates.",
			recommendedTemplatesPending: "Waiting for the shipped role templates.",
			recommendedInCatalog: "present in the current host catalog",
			recommendedNotInCatalog: "not in the current host catalog (filtered at dispatch)"
		};
		const zh = {
			pluginTitle: "Thaliris",
			summary: "设置 Thaliris 运行时、Agent 预设默认值、角色权限、工作区访问、记忆授权和原生诊断。",
			settingsLabel: "Thaliris 设置",
			tabGeneral: "常规",
			tabRoles: "角色",
			tabMemory: "记忆",
			tabContext: "上下文",
			tabDiagnostics: "诊断",
			formUnavailable: "此连接无法访问 Thaliris 设置。",
			readOnly: "此连接无法保存设置。只有主机提供可写设置后才能保存。",
			save: "保存更改",
			saving: "正在保存…",
			saveFailed: "主机未接受这些设置。",
			discard: "重新载入原生值",
			conflict: "开始编辑后设置已有变化。请重新载入原生值再编辑。",
			generalTitle: "控制器指引",
			generalHelp: "此处可见的提示会发送给已配置工作区中的原生根控制器。Thaliris 记录决定，但不会代替控制器做决定。",
			controllerPrompt: "控制器指引",
			rolesTitle: "可编辑角色",
			rolesHelp: "角色记录属于用户策略。控制器为每个有界工作流选择合适的已启用角色，也可以不委派。",
			addRole: "新建角色",
			noRoles: "尚未保存角色。可新建角色或显式添加模板。",
			addTemplate: "添加所选模板",
			chooseTemplate: "选择模板",
			loadTemplates: "载入模板",
			templateUnavailable: "运行时 API 未挂载时无法取得模板。",
			duplicateRole: "复制",
			deleteRole: "删除",
			enabled: "已启用",
			roleId: "稳定角色 ID",
			roleName: "名称",
			roleDescription: "说明",
			rolePrompt: "完整角色提示",
			rolePromptHelp: "选择此角色后，完整提示会发送给原生子会话；运行时不会追加隐藏后缀。",
			tools: "允许的原生工具",
			toolsUnavailable: "无法取得原生工具列表。启用运行时 API 后重试。",
			refresh: "刷新",
			noTools: "原生注册表未返回工具。",
			toolUnavailable: "不在当前原生工具目录中",
			modelPolicy: "模型策略",
			inherit: "继承原生父会话模型",
			fixed: "使用一个固定路由",
			allowed: "允许这些精确路由",
			modelCatalogUnavailable: "无法取得原生模型目录。",
			modelCatalogLoading: "正在载入原生模型目录…",
			noModels: "原生目录没有可用路由。",
			selectedModel: "所选路由",
			reasoningEffort: "推理力度",
			defaultEffort: "原生默认值",
			unavailableRoute: "已保存路由已不在原生模型目录中",
			memoryTitle: "记忆策略",
			memoryHelp: "只有选择提供方并设置明确授权后，才能启用记忆。自动写入还需要单独保存的用户授权。",
			memoryMode: "写入策略",
			modeDisabled: "关闭",
			modeManual: "手动",
			modeSuggest: "建议并审核",
			modeAuto: "自动写入",
			autoAuthorized: "我明确授权自动写入记忆",
			autoAuthorizedHelp: "此授权与所选写入策略相互独立。",
			providers: "可用提供方",
			providerEnabled: "为 Thaliris 启用",
			providerMissing: "所选提供方未安装或当前不可用",
			noProviders: "当前没有启用记忆提供方。请从原生插件页面安装可选提供方。",
			memoryCapabilityMissing: "记忆能力未启用。请从原生插件页面安装。",
			openMemoryPlugin: "在插件页打开记忆能力",
			openLocalPlugin: "在插件页打开本地提供方",
			controllerRead: "控制器可读取",
			controllerWrite: "控制器可写入或批准建议",
			roleMemory: "角色记忆授权",
			roleRead: "可读取",
			roleWrite: "可写入或建议",
			contextTitle: "工作区和角色上下文",
			contextHelp: "工作区 ID 和根目录来自原生工作区列表。路径匹配本身不能证明控制器身份。",
			workspaceBindings: "绑定的原生工作区",
			workspaceLoading: "正在载入原生工作区…",
			noWorkspaces: "没有可用的原生工作区。",
			chooseWorkspace: "选择原生工作区",
			bindWorkspace: "绑定工作区",
			removeWorkspace: "移除绑定",
			workspaceEnabled: "为 Thaliris 启用",
			workspaceMissing: "此保存的工作区不在当前原生工作区列表中。",
			roleHandoff: "可接收控制器的有界委派",
			roleMemoryContext: "可接收明确选择的记忆上下文",
			diagnosticsTitle: "原生诊断",
			diagnosticsHelp: "选择原生根会话和 thaliris_task_start 返回的任务 ID。一个根会话可以关联多个独立任务；诊断不会按工作区自动选择任务。",
			selectSession: "原生根会话",
			selectTaskId: "明确的 Core 任务 ID",
			diagnosticsTaskChanged: "当前诊断属于另一个任务。请载入所选任务 ID 后继续",
			noRootSessions: "原生列表中没有根会话。",
			loadDiagnostics: "载入诊断",
			refreshDiagnostics: "刷新诊断",
			diagnosticsLoading: "正在读取当前 Core 和原生会话证据…",
			diagnosticsUnavailable: "无法取得诊断。请启用运行时及原生 API 插件后重试。",
			taskEvidence: "Core 任务证据",
			workspaceEvidence: "已核实工作区",
			permissionsEvidence: "当前授权",
			reservationEvidence: "原生保留记录证据",
			noReservations: "没有活动保留记录。",
			outcome: "原生结果",
			unknownOutcome: "UNKNOWN — 保留记录仍保持保留状态。",
			reconcileGuide: "只有已证明的原生终止结果才能协调。原生工具记录该观测；语义验收仍由控制器决定。",
			reconcileCommand: "原生协调工具参数",
			copyCommand: "复制参数",
			commandCopied: "参数已复制。",
			childSession: "观测到的原生子会话",
			openChildSession: "打开子会话",
			proposals: "待审核记忆建议",
			noProposals: "没有待审核的记忆建议。",
			proposalProvider: "提供方",
			proposalKey: "键",
			proposalText: "建议文本",
			proposalProvenance: "来源",
			approveProposal: "批准此建议",
			proposalApproved: "原生提供方结果和 Core 批准回执",
			approvalReceipts: "已记录的 Core 批准回执",
			approvalUncertain: "批准操作未返回完整回执。提供方写入可能已成功；重试前请刷新诊断和提供方状态。",
			alreadyApproved: "此建议已有批准回执。",
			noApprovalGrant: "当前提供方、写入授权或记忆策略不允许批准。",
			installForProvider: "请在原生插件页安装或启用此提供方。",
			projectionRefresh: "刷新原生投影",
			runtimeRequiresSetup: "运行时和 API 是独立的原生条目。请在原生插件配置中设置 Python、Core、授权目录和工作区访问，然后在插件页启用两个条目。",
			setupTitle: "首次运行设置",
			setupHelp: "Thaliris 会在首次使用时准备固定版本的 Core 运行时。本页不会自动执行任何准备：Prepare 与 Re-check 都是显式的人工操作，Standard 或未选择 Thaliris 的会话不会准备任何内容。",
			setupFirstUse: "首次使用会自动准备：第一次 Thaliris 工具调用会准备固定版本的 Core 运行时，通常只需一两秒。失败时插件仍保持加载，并在下方显示错误代码和恢复说明。",
			setupStatusLoading: "正在读取设置状态…",
			setupUnavailable: "此连接无法获取设置状态。",
			setupStateLabel: "运行时状态",
			stateUnconfigured: "尚未准备",
			stateDetecting: "正在检测 Python",
			stateProvisioning: "正在准备",
			stateVerifying: "正在验证",
			stateReady: "就绪",
			stateFailed: "失败",
			stateUnknown: "未知状态",
			setupVerified: "已在当前进程中验证",
			setupUnverified: "当前进程尚未验证",
			setupProgress: "当前步骤",
			setupElapsed: "耗时",
			setupAttempt: "尝试次数",
			setupNotConfigured: "尚未配置或记录运行时。",
			setupPin: "固定的 Core",
			setupPinError: "Core 固定版本信息无法读取",
			setupPython: "Python 解释器",
			setupPythonVersion: "Python 版本",
			setupCoreVersion: "Core 版本",
			setupCorePath: "Core 包路径",
			setupAuthority: "授权目录",
			setupSource: "运行时来源",
			sourceProvisioned: "本次安装已准备",
			sourceRecorded: "已记录的运行时清单",
			sourceConfiguration: "手动路径",
			sourceDetected: "主机检测",
			setupVerifiedAt: "验证时间",
			setupConfigured: "已配置手动路径",
			setupManualOverride: "手动覆盖生效",
			setupErrorLabel: "设置失败",
			setupCodeLabel: "代码",
			setupRecoveryLabel: "恢复方式",
			setupDetailLabel: "详情",
			setupPrepare: "准备 Thaliris 运行时",
			setupPrepareAgain: "再次准备",
			setupRetry: "重试准备运行时",
			setupRecheck: "重新检查运行时",
			setupPreparing: "正在准备 Thaliris 运行时…",
			setupRechecking: "正在重新检查已配置的运行时…",
			setupActionFailed: "设置操作未完成",
			setupRefresh: "刷新设置状态",
			setupStepDetectPython: "检测 Python",
			setupStepFetchSource: "获取固定的 Core 源码",
			setupStepCreateRuntime: "创建隔离运行时",
			setupStepInstallCore: "安装固定的 Core",
			setupStepVerifyCore: "验证 Core 导入",
			setupStepWriteManifest: "写入运行时清单",
			setupStepVerifyRecorded: "验证已记录的运行时",
			setupStepVerifyConfigured: "验证已配置的路径",
			setupStepReady: "就绪",
			setupOverridesTitle: "手动运行时路径（可选）",
			setupOverridesHelp: "留空即使用已准备或主机检测的默认值。这些是可选的易变设置；主机会在下次使用时校验，清空字段会移除你的覆盖。",
			setupPythonOverride: "Python 可执行文件",
			setupCoreOverride: "Core 包路径",
			setupAuthorityOverride: "授权目录",
			setupOverridesSaveHint: "“保存更改”会写入这些覆盖；随后请使用 Re-check 验证。",
			setupInvalidLocation: "请输入绝对路径，或留空。",
			workspaceAutoBoundTitle: "自动绑定的工作区",
			workspaceAutoBindHelp: "在某个工作区中首次运行 Thaliris 会话、且尚无任何绑定时，主机会绑定该工作区一次。Standard 或未选择 Thaliris 的会话不会创建绑定。",
			workspaceAutoBound: "首次使用 Thaliris 时自动绑定",
			workspaceAutoBindAt: "绑定时间",
			workspaceAutoBindStale: "本进程报告了一个自动绑定的工作区，但当前草稿中没有它。请重新载入原生值以查看已保存的绑定。",
			workspaceBindRecent: "绑定最近使用的工作区",
			workspaceBindRecentHint: "设置页没有会话选择，因此这里绑定会话活动最新的原生工作区。",
			workspaceRecentMissing: "没有可用于绑定的、有会话活动的原生工作区。",
			workspaceExplicitOnly: "绑定只会由此处的显式操作写入，或由 Thaliris 选中会话的首次使用自动绑定写入一次。",
			modeTitle: "Agent 预设和新会话默认值",
			modeHelp: "Thaliris 是可选的原生 Agent 预设；会话保持启动时使用的预设，默认值只影响新会话。插件绝不会自动更改默认值。",
			modePresetHealth: "Thaliris 预设状态",
			modeHealthy: "正常",
			modeBroken: "已注册但不可用",
			modeMissing: "未在当前主机注册",
			modeRegistryUnavailable: "当前主机未提供原生 Agent 预设注册表。",
			modeSettingsUnavailable: "当前主机未提供原生 Agent 预设设置区域，因此无法在本页更改默认值。",
			modeRegistryError: "读取原生预设列表失败",
			modeRosterLoading: "正在读取原生预设列表…",
			modeRosterEmpty: "原生注册表没有列出任何预设。",
			modeDefaultLabel: "新会话默认值",
			modeIsDefault: "Thaliris 是原生新会话默认预设",
			modeIsOtherDefault: "其他预设是原生新会话默认预设",
			modeNoDefault: "已保存的新会话默认值无法解析到任何已注册预设",
			modeNativeDefault: "原生默认预设",
			modeSelectedDefault: "已保存的默认覆盖",
			modeSetDefault: "将 Thaliris 设为新会话默认预设",
			modeRestoreDefault: "恢复原生默认值",
			modeSavingDefault: "正在写入原生默认值…",
			modeWriteFailed: "主机未接受默认值更改",
			modeBrokenDetail: "Thaliris 预设已注册，但其组合挂载失败。选择它的会话可能失败；使用其他默认值的会话不受影响。",
			modeDanglingWarning: "在 Thaliris 作为新会话默认值时禁用或移除该 bundle 会留下悬空默认值：在重新选择默认值之前，新的未命名会话都会失败。请在禁用或移除 bundle 之前恢复原生默认值。",
			modeDanglingResolve: "恢复原生默认值以修复新会话创建。",
			modeNoAutoWrite: "只有在你点击这些操作后才会写入默认值。",
			recommendedTitle: "推荐的原生权限",
			recommendedHelp: "随附的角色模板会授予精选的原生 DSH 工具。插件绝不改写已保存角色：这里只列出已启用但工具授权为空的角色，并且仅在你点击“应用”时写入推荐值。",
			recommendedNone: "所有已启用角色都已有原生工具授权。",
			recommendedNoTemplate: "没有与此角色 ID 匹配的随附模板，因此没有推荐值。",
			recommendedTools: "推荐的原生工具",
			recommendedCurrent: "当前授权",
			recommendedApply: "应用推荐权限",
			recommendedHint: "“应用”会通过原生设置的修订栅栏写入 policy.roles。这是本区域唯一的写入操作，且只在你点击时执行。",
			recommendedApplied: "推荐权限已写入。",
			recommendedApplyFailed: "主机未接受推荐权限",
			recommendedCatalogMissing: "无法获取主机工具目录；此处显示角色模板中的随附推荐。",
			recommendedTemplatesPending: "正在等待随附的角色模板。",
			recommendedInCatalog: "当前主机目录中存在",
			recommendedNotInCatalog: "当前主机目录中不存在（派发时会被过滤）"
		};
		//#endregion
		//#region src/client/index.tsx
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session",
			"sessions",
			"workspaces",
			"uiWorkspace",
			"pluginNavigation",
			"configForms"
		];
		/** Mount the same product page in the shared Web client used by Desktop. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "thaliris-client: dictionaries");
			ctx.effect(() => ctx.remote.$mount(remoteContribution), "thaliris-client: native Gateway contribution");
			ctx.inject(["remote.thaliris"], mountPage);
		}
		function mountPage(ctx) {
			const policy = new PolicyEditorController(ctx.configForms.get("thaliris"));
			const native = new NativeProjectionController(ctx);
			const setup = new SetupController(ctx);
			const mode = new ModeController(ctx);
			const face = {
				hooks: {
					policy: policy.store,
					native: native.store,
					setup: setup.store,
					mode: mode.store
				},
				edit: policy.edit.bind(policy),
				editRuntime: policy.editRuntime.bind(policy),
				save: () => {
					policy.save();
				},
				discard: () => policy.discard(),
				refresh: () => {
					native.refresh();
					setup.load();
					mode.load();
				},
				loadDiagnostics: (sessionId, taskId) => {
					native.loadDiagnostics(sessionId, taskId);
				},
				approveMemory: (sessionId, taskId, proposalId) => {
					native.approveMemory(sessionId, taskId, proposalId);
				},
				loadSetup: () => {
					setup.load();
				},
				prepareRuntime: () => {
					setup.prepare();
				},
				recheckRuntime: () => {
					setup.recheck();
				},
				setThalirisDefault: () => {
					mode.setThalirisDefault();
				},
				restoreNativeDefault: () => {
					mode.restoreNativeDefault();
				},
				applyRecommended: (templates) => {
					policy.applyRecommended(templates);
				},
				openPlugin: (packageName) => ctx.pluginNavigation.openBundle(packageName),
				openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId)
			};
			ctx.effect(() => async () => {
				await Promise.all([
					policy.dispose(),
					native.dispose(),
					mode.dispose()
				]);
				setup.dispose();
			}, "thaliris-client: native projection subscriptions");
			native.refresh();
			setup.load();
			mode.load();
			ctx.inject(["remote.agentPresets"], () => {
				mode.load();
			});
			ctx.effect(() => ctx.configForms.whileServed(["thaliris"], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
				name: "plugins.item",
				id: "thaliris",
				order: 40,
				label: () => ctx.locale.bind(NS)("pluginTitle"),
				locale: NS,
				inject: () => face
			}, ThalirisPage))), "thaliris-client: shared settings page");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map