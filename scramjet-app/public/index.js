"use strict";

/**
 * @type {HTMLFormElement}
 */
const form = document.getElementById("sj-form");
/**
 * @type {HTMLInputElement}
 */
const address = document.getElementById("sj-address");
/**
 * @type {HTMLInputElement}
 */
const searchEngine = document.getElementById("sj-search-engine");
/**
 * @type {HTMLParagraphElement}
 */
const error = document.getElementById("sj-error");
/**
 * @type {HTMLPreElement}
 */
const errorCode = document.getElementById("sj-error-code");

let controller = null;
/** @type {Promise<any> | null} */
let transportPromise = null;
/** @type {string | null} */
let lastProxiedTarget = null;
/** @type {HTMLIFrameElement | null} */
let proxyFrame = null;
/** @type {ReturnType<typeof $scramjetController.Controller.prototype.createFrame> | null} */
let proxyFrameHandle = null;

/** Serialize overlapping navigations (Bavarium may trigger many in quick succession). */
let proxyNavChain = Promise.resolve();

function getWispUrl() {
	return (
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/"
	);
}

/**
 * Scramjet expects response headers as [key, value][].
 * Normalize common transport header formats into that tuple array.
 * @param {any} headers
 * @returns {[string, string][]}
 */
function normalizeRawHeaders(headers) {
	if (!headers) return [];
	if (Array.isArray(headers)) {
		return headers
			.filter((h) => Array.isArray(h) && h.length >= 2)
			.map((h) => [String(h[0]), String(h[1])]);
	}

	/** @type {[string, string][]} */
	const rawHeaders = [];
	if (typeof headers.forEach === "function") {
		headers.forEach((value, key) => {
			rawHeaders.push([String(key), String(value)]);
		});
		return rawHeaders;
	}
	if (typeof headers.entries === "function") {
		for (const [key, value] of headers.entries()) {
			rawHeaders.push([String(key), String(value)]);
		}
		return rawHeaders;
	}
	if (typeof headers === "object") {
		for (const [key, value] of Object.entries(headers)) {
			if (Array.isArray(value)) {
				for (const v of value) rawHeaders.push([String(key), String(v)]);
			} else if (value != null) {
				rawHeaders.push([String(key), String(value)]);
			}
		}
	}
	return rawHeaders;
}

/**
 * @param {any} libcurl
 */
function wrapLibcurlTransport(libcurl) {
	return {
		get ready() {
			return libcurl.ready;
		},
		init: () => libcurl.init(),
		meta: () => libcurl.meta(),
		connect: (...args) => libcurl.connect(...args),
		request: async (remote, method, body, headers, signal) => {
			if (body instanceof Blob) {
				body = await body.arrayBuffer();
			}
			const res = await libcurl.request(remote, method, body, headers, signal);
			return {
				body: res.body,
				status: res.status,
				statusText: res.statusText,
				headers: normalizeRawHeaders(res.headers),
			};
		},
	};
}

/**
 * Epoxy's default export doesn't expose request() in Scramjet's transport shape.
 * @param {import("@mercuryworkshop/epoxy-transport").default} epoxy
 */
function wrapEpoxyTransport(epoxy) {
	return {
		get ready() {
			return epoxy.ready;
		},
		init: () => epoxy.init(),
		meta: () => epoxy.meta(),
		connect: (...args) => epoxy.connect(...args),
		request: async (remote, method, body, headers, signal) => {
			if (body instanceof Blob) {
				body = await body.arrayBuffer();
			}
			const res = await epoxy.client.fetch(remote.href, {
				method,
				body,
				headers,
				redirect: "manual",
				signal,
			});
			return {
				body: res.body,
				status: res.status,
				statusText: res.statusText,
				headers: normalizeRawHeaders(res.headers),
			};
		},
	};
}

async function importLibcurlTransportInWebMode() {
	const hadOwnProcess = Object.prototype.hasOwnProperty.call(globalThis, "process");
	const originalProcess = globalThis.process;
	try {
		// libcurl's web build asserts when `process.versions.node` is present.
		Object.defineProperty(globalThis, "process", {
			value: undefined,
			writable: true,
			configurable: true,
		});
	} catch (_) {
		try {
			globalThis.process = undefined;
		} catch (_) {}
	}

	try {
		return await import("/libcurl/index.mjs");
	} finally {
		try {
			if (hadOwnProcess) {
				Object.defineProperty(globalThis, "process", {
					value: originalProcess,
					writable: true,
					configurable: true,
				});
			} else {
				delete globalThis.process;
			}
		} catch (_) {}
	}
}

async function getTransport() {
	if (!transportPromise) {
		transportPromise = (async () => {
			try {
				const { default: EpoxyTransport } = await import("/epoxy/index.mjs");
				const epoxy = new EpoxyTransport({ wisp: getWispUrl() });
				await epoxy.init();
				return wrapEpoxyTransport(epoxy);
			} catch (err) {
				console.warn("epoxy transport unavailable, trying libcurl:", err);
			}

			try {
				const libcurlModule = await importLibcurlTransportInWebMode();
				const LibcurlTransport = libcurlModule?.default;
				if (typeof LibcurlTransport !== "function") {
					throw new Error("libcurl transport export not found");
				}
				const libcurl = new LibcurlTransport({ wisp: getWispUrl() });
				await libcurl.init();
				return wrapLibcurlTransport(libcurl);
			} catch (err) {
				console.warn("libcurl transport unavailable:", err);
			}
			throw new Error("No working transport (epoxy/libcurl) available");
		})();
	}
	return transportPromise;
}

function notifyBavariumPageMeta() {
	try {
		require("electron").ipcRenderer.sendToHost("bavarium-page-meta-changed");
	} catch (_) {}
}

function hookProxyFrameNavigation(frameEl) {
	if (!frameEl || frameEl.__bavariumNavHook) return;
	frameEl.__bavariumNavHook = true;
	frameEl.addEventListener("load", notifyBavariumPageMeta);
	try {
		const w = frameEl.contentWindow;
		if (w && w.history && !w.__bavariumHistoryHook) {
			w.__bavariumHistoryHook = true;
			const push = w.history.pushState;
			const replace = w.history.replaceState;
			if (push) {
				w.history.pushState = function () {
					const r = push.apply(this, arguments);
					notifyBavariumPageMeta();
					return r;
				};
			}
			if (replace) {
				w.history.replaceState = function () {
					const r = replace.apply(this, arguments);
					notifyBavariumPageMeta();
					return r;
				};
			}
			w.addEventListener("popstate", notifyBavariumPageMeta);
			w.addEventListener("hashchange", notifyBavariumPageMeta);
		}
	} catch (_) {}
	setInterval(notifyBavariumPageMeta, 600);
}

function deepLinkTargetFromLocation() {
	const fromQuery = new URLSearchParams(location.search).get("url");
	if (fromQuery) return fromQuery;
	const hash = (location.hash || "").replace(/^#/, "");
	if (hash.startsWith("url=")) {
		return decodeURIComponent(hash.slice(4));
	}
	return null;
}

function shellPathForHistory() {
	const path =
		location.pathname && location.pathname !== "/"
			? location.pathname
			: "/";
	const hash = location.hash || "";
	return path + hash;
}

async function waitForServiceWorkerControl(timeoutMs = 15000) {
	if (navigator.serviceWorker.controller) return;

	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			navigator.serviceWorker.removeEventListener(
				"controllerchange",
				onChange,
			);
			reject(new Error("Timed out waiting for service worker control"));
		}, timeoutMs);

		const onChange = () => {
			if (!navigator.serviceWorker.controller) return;
			clearTimeout(timer);
			navigator.serviceWorker.removeEventListener(
				"controllerchange",
				onChange,
			);
			resolve();
		};

		navigator.serviceWorker.addEventListener("controllerchange", onChange);
		if (navigator.serviceWorker.controller) onChange();
	});
}

async function ensureController() {
	if (controller) return controller;

	// New controller instance needs a fresh proxy frame registration.
	proxyFrameHandle = null;
	if (proxyFrame) {
		proxyFrame.remove();
		proxyFrame = null;
	}

	await registerSW();
	await waitForServiceWorkerControl();

	const controllingSw = navigator.serviceWorker.controller;
	if (!controllingSw) {
		throw new Error("Service worker is not controlling this page");
	}

	controller = new $scramjetController.Controller({
		serviceworker: controllingSw,
		transport: await getTransport(),
		scramjetConfig: {
			...$scramjet.defaultConfig,
			flags: {
				...$scramjet.defaultConfig.flags,
				allowInvalidJs: true,
				allowFailedIntercepts: true,
			},
			siteFlags: {
				...($scramjet.defaultConfig.siteFlags || {}),
				"youtube.com": {
					allowInvalidJs: true,
					strictRewrites: false,
				},
				"www.youtube.com": {
					allowInvalidJs: true,
					strictRewrites: false,
				},
				"googlevideo.com": {
					allowInvalidJs: true,
					strictRewrites: false,
				},
				"ytimg.com": {
					allowInvalidJs: true,
					strictRewrites: false,
				},
			},
		},
	});
	await controller.wait();
	return controller;
}

async function ensureProxyFrame(ctrl) {
	if (proxyFrameHandle) return proxyFrameHandle;

	proxyFrame = document.createElement("iframe");
	proxyFrame.id = "sj-frame";
	document.body.appendChild(proxyFrame);
	hookProxyFrameNavigation(proxyFrame);
	proxyFrameHandle = ctrl.createFrame(proxyFrame);
	return proxyFrameHandle;
}

function frameShowsTarget(frame, url) {
	if (!frame || !frame.src || frame.src === "about:blank") return false;
	try {
		const enc = encodeURIComponent(url);
		return frame.src.includes(enc) || frame.src.includes(url);
	} catch (_) {
		return false;
	}
}

/**
 * @param {string} rawInput address bar / search text or full URL
 */
async function startProxyNavigation(rawInput) {
	const run = async () => {
		let ctrl;
		try {
			ctrl = await ensureController();
		} catch (err) {
			error.textContent = "Failed to register service worker.";
			errorCode.textContent = err?.stack || String(err);
			throw err;
		}

		const url = search(rawInput, searchEngine.value);

		if (lastProxiedTarget === url && frameShowsTarget(proxyFrame, url)) {
			document.body.classList.add("sj-active");
			return;
		}

		lastProxiedTarget = url;

		const frame = await ensureProxyFrame(ctrl);
		document.body.classList.add("sj-active");
		frame.go(url);
		notifyBavariumPageMeta();
	};

	proxyNavChain = proxyNavChain.then(run, run);
	return proxyNavChain;
}

/** Called from Bavarium renderer without reloading this shell (macOS fix). */
window.bavariumStartProxyNavigation = startProxyNavigation;

async function runDeepLinkNavigation() {
	const deepLink = deepLinkTargetFromLocation();
	if (!deepLink) return false;
	address.value = deepLink;
	await startProxyNavigation(deepLink);
	if (window.history?.replaceState) {
		window.history.replaceState({}, "", shellPathForHistory());
	}
	return true;
}

function installBavariumHashNavigation() {
	if (window.__bavariumSjHashHook) return;
	window.__bavariumSjHashHook = true;
	window.addEventListener("hashchange", () => {
		runDeepLinkNavigation().catch((err) => {
			error.textContent = "Navigation failed.";
			errorCode.textContent = err?.stack || String(err);
		});
	});
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	try {
		await startProxyNavigation(address.value);
	} catch {
		/* surfaced in startProxyNavigation */
	}
});

installBavariumHashNavigation();

runDeepLinkNavigation().catch((err) => {
	error.textContent = "Navigation failed.";
	errorCode.textContent = err?.stack || String(err);
});

window.addEventListener("pageshow", () => {
	runDeepLinkNavigation().catch((err) => {
		error.textContent = "Navigation failed.";
		errorCode.textContent = err?.stack || String(err);
	});
});
