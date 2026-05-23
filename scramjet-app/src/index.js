import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const licensePath = join(repoRoot, "LICENSE");

function escapeHtml(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function buildLicenseHtml(title, licenseText) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} — License</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 1.25rem 1.5rem 2rem;
    font-family: system-ui, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
    background: #f5f5f5;
    color: #111;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e8e8e8; }
  }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; }
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 0.8125rem;
    line-height: 1.45;
  }
</style>
</head>
<body>
<h1>${escapeHtml(title)} — GNU Affero General Public License</h1>
<pre>${escapeHtml(licenseText)}</pre>
</body>
</html>`;
}

let licenseHtmlCache = null;
async function getLicenseHtml() {
	if (!licenseHtmlCache) {
		const text = await readFile(licensePath, "utf8");
		licenseHtmlCache = buildLicenseHtml("Scramjet", text);
	}
	return licenseHtmlCache;
}

// Wisp Configuration: Refer to the documentation at https://www.npmjs.com/package/@mercuryworkshop/wisp-js

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	hostname_blacklist: [/example\.com/],
	dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
				res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
				else socket.end();
			});
	},
});

// Register before static so /LICENSE is not treated as a missing public file.
fastify.get("/LICENSE", async (req, reply) => {
	reply.type("text/html; charset=utf-8");
	return reply.send(await getLicenseHtml());
});

fastify.register(fastifyStatic, {
	root: publicPath,
	decorateReply: true,
});

fastify.register(fastifyStatic, {
	root: scramjetPath,
	prefix: "/scram/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: libcurlPath,
	prefix: "/libcurl/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: baremuxPath,
	prefix: "/baremux/",
	decorateReply: false,
});

fastify.setNotFoundHandler((res, reply) => {
	return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
	const address = fastify.server.address();

	// by default we are listening on 0.0.0.0 (every interface)
	// we just need to list a few
	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(
		`\thttp://${
			address.family === "IPv6" ? `[${address.address}]` : address.address
		}:${address.port}`
	);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
	console.log("SIGTERM signal received: closing HTTP server");
	fastify.close();
	process.exit(0);
}

let port = parseInt(process.env.PORT || "");

if (isNaN(port)) port = 8080;

fastify
	.listen({
		port: port,
		host: "0.0.0.0",
	})
	.catch((err) => {
		if (err && err.code === "EADDRINUSE") {
			console.error(
				`Scramjet: port ${port} is already in use. Close the other program or pick another port in Bavarium Settings.`
			);
			process.exit(1);
			return;
		}
		console.error(err);
		process.exit(1);
	});
