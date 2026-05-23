"use strict";

const { ipcRenderer } = require("electron");

const headlineEl = document.getElementById("headline");
const subtitleEl = document.getElementById("subtitle");
const detailsEl = document.getElementById("releaseDetails");
const btnLater = document.getElementById("btnLater");
const btnDownload = document.getElementById("btnDownload");

function sendChoice(action) {
  btnLater.disabled = true;
  btnDownload.disabled = true;
  ipcRenderer.send("update-prompt-choice", action);
}

btnLater.addEventListener("click", () => sendChoice("later"));
btnDownload.addEventListener("click", () => sendChoice("download"));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    sendChoice("later");
  }
});

ipcRenderer.on("update-prompt-init", (_e, payload) => {
  if (!payload || typeof payload !== "object") return;
  const title = payload.windowTitle || "Update available";
  document.title = title;
  if (headlineEl) headlineEl.textContent = payload.headline || title;
  if (subtitleEl) subtitleEl.textContent = payload.subtitle || "";
  if (detailsEl) {
    detailsEl.textContent = payload.detailsBody || "";
  }
  if (btnDownload) {
    btnDownload.textContent = payload.downloadLabel || "Download update";
    if (payload.trackPreRelease) {
      btnDownload.classList.add("prerelease");
      btnDownload.classList.remove("primary");
    } else {
      btnDownload.classList.add("primary");
      btnDownload.classList.remove("prerelease");
    }
  }
});
