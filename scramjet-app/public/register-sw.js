"use strict";
const stockSW = "/sw.js";

/**
 * List of hostnames that are allowed to run serviceworkers on http://
 */
const swAllowedHostnames = ["localhost", "127.0.0.1"];

/**
 * Global util
 * Used in 404.html and index.html
 */
async function registerSW() {
	if (!navigator.serviceWorker) {
		if (
			location.protocol !== "https:" &&
			!swAllowedHostnames.includes(location.hostname)
		)
			throw new Error("Service workers cannot be registered without https.");

		throw new Error("Your browser doesn't support service workers.");
	}

	await navigator.serviceWorker.register(stockSW, {
		scope: "/",
		updateViaCache: "none",
	});
	const reg = await navigator.serviceWorker.ready;

	// First install: some embedders (Electron webviews) need one reload before fetch is intercepted.
	if (
		!navigator.serviceWorker.controller &&
		reg.active?.state === "activated" &&
		!sessionStorage.getItem("scramjet-sw-reload")
	) {
		sessionStorage.setItem("scramjet-sw-reload", "1");
		location.reload();
		await new Promise(() => {});
	}
}
