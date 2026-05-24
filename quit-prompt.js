"use strict";

const { ipcRenderer } = require("electron");

const downloadHintEl = document.getElementById("downloadHint");
const backgroundOptionEl = document.getElementById("backgroundOption");
const downloadInBackgroundEl = document.getElementById("downloadInBackground");
const btnBack = document.getElementById("btnBack");
const btnLeave = document.getElementById("btnLeave");

let choiceSent = false;

function sendChoice(action) {
  if (choiceSent) return;
  choiceSent = true;
  btnBack.disabled = true;
  btnLeave.disabled = true;
  ipcRenderer.send("quit-prompt-choice", {
    action,
    downloadInBackground:
      action === "leave" &&
      downloadInBackgroundEl &&
      !downloadInBackgroundEl.disabled &&
      downloadInBackgroundEl.checked,
  });
}

btnBack.addEventListener("click", () => sendChoice("back"));
btnLeave.addEventListener("click", () => sendChoice("leave"));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    sendChoice("back");
  }
});

ipcRenderer.on("quit-prompt-init", (_e, payload) => {
  const count =
    payload && typeof payload.activeDownloads === "number"
      ? Math.max(0, Math.floor(payload.activeDownloads))
      : 0;
  const hasDownloads = count > 0;

  if (downloadHintEl) {
    if (hasDownloads) {
      const word = count === 1 ? "download" : "downloads";
      downloadHintEl.textContent = `${count} ${word} will be paused until the next time you open Bavarium`;
      downloadHintEl.hidden = false;
    } else {
      downloadHintEl.hidden = true;
    }
  }

  if (backgroundOptionEl) {
    backgroundOptionEl.hidden = !hasDownloads;
  }
  if (downloadInBackgroundEl) {
    downloadInBackgroundEl.checked = false;
    downloadInBackgroundEl.disabled = !hasDownloads;
  }
});
