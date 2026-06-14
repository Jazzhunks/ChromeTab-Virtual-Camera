/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Chrome Tab Virtual Camera - Popup Controllers
 */

document.addEventListener("DOMContentLoaded", async () => {
  const statusDot = document.getElementById("statusDot");
  const statusLabel = document.getElementById("statusLabel");
  const tabTitleDisplay = document.getElementById("tabTitle");
  const resolutionSelect = document.getElementById("resolutionSelect");
  const fpsSelect = document.getElementById("fpsSelect");
  const audioToggle = document.getElementById("audioToggle");
  const mirrorToggle = document.getElementById("mirrorToggle");
  const actionBtn = document.getElementById("actionBtn");

  let currentCapturedTab = null;
  let isAlreadyCapturing = false;

  // 1. Fetch current active tab info for display
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab) {
    currentCapturedTab = activeTab;
    tabTitleDisplay.textContent = activeTab.title || `Tab #${activeTab.id}`;
  } else {
    tabTitleDisplay.textContent = "No active tab selected";
  }

  // 2. Load the initial state directly from local storage for maximum reliability
  chrome.storage.local.get(["activeCaptureState"], (result) => {
    if (result && result.activeCaptureState) {
      console.log("[Popup] Loaded state from local storage:", result.activeCaptureState);
      restoreUIState(result.activeCaptureState);
    }
  });

  // 3. Keep the UI updated if state changes dynamically
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.activeCaptureState) {
      const newState = changes.activeCaptureState.newValue;
      if (newState) {
        console.log("[Popup] Real-time state updated:", newState);
        restoreUIState(newState);
      }
    }
  });

  // 4. Fallback: Query background service worker for active capture state
  chrome.runtime.sendMessage({ action: "GET_CAPTURE_STATE" }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn("[Popup] Background unavailable:", chrome.runtime.lastError.message);
      return;
    }

    if (response && response.state) {
      restoreUIState(response.state);
    }
  });

  /**
   * Restores popup inputs to match running background pipeline settings
   */
  function restoreUIState(state) {
    isAlreadyCapturing = state.isCapturing;

    if (isAlreadyCapturing) {
      // Set indicator to active
      statusDot.className = "indicator-dot active";
      statusLabel.textContent = "LIVE";
      statusLabel.style.color = "var(--accent-green)";

      // Overwrite tab display to reflect tab being captured rather than currently selected popup tab
      if (state.capturedTabId) {
        chrome.tabs.get(state.capturedTabId, (tab) => {
          if (!chrome.runtime.lastError && tab) {
            tabTitleDisplay.textContent = `Capturing: ${tab.title}`;
          } else {
            tabTitleDisplay.textContent = "Capturing Background Tab";
          }
        });
      }

      // Update button visual
      actionBtn.textContent = "Stop Virtual Camera";
      actionBtn.classList.add("stop");

      // Set input states to match the running capture settings
      const cfg = state.config;
      if (cfg) {
        resolutionSelect.value = cfg.height === 1080 ? "1080" : "720";
        fpsSelect.value = String(cfg.fps);
        audioToggle.checked = !!cfg.audio;
        mirrorToggle.checked = !!cfg.mirror;
      }
    } else {
      // Standby defaults
      statusDot.className = "indicator-dot inactive";
      statusLabel.textContent = "Standby";
      statusLabel.style.color = "var(--text-muted)";

      actionBtn.textContent = "Start Virtual Camera";
      actionBtn.classList.remove("stop");
    }
  }

  /**
   * Action trigger handler (Start / Stop pipeline)
   */
  actionBtn.addEventListener("click", async () => {
    if (isAlreadyCapturing) {
      // STOP PIPELINE
      actionBtn.disabled = true;
      statusLabel.textContent = "Stopping...";

      chrome.runtime.sendMessage({ action: "STOP_VIRTUAL_CAM" }, (response) => {
        actionBtn.disabled = false;
        if (chrome.runtime.lastError) {
          console.warn("[Popup] STOP_VIRTUAL_CAM error, relying on storage updates:", chrome.runtime.lastError.message);
          return;
        }

        if (response && response.status === "success") {
          restoreUIState(response.state);
        } else {
          console.warn("[Popup] Failed to stop virtual camera response content:", response);
        }
      });
    } else {
      // START PIPELINE
      if (!currentCapturedTab) {
        alert("Could not identify an active tab to stream.");
        return;
      }

      actionBtn.disabled = true;
      statusLabel.textContent = "Starting...";

      const width = resolutionSelect.value === "1080" ? 1920 : 1280;
      const height = resolutionSelect.value === "1080" ? 1080 : 720;
      const fps = parseInt(fpsSelect.value, 10);
      const audio = audioToggle.checked;
      const mirror = mirrorToggle.checked;

      const payload = {
        tabId: currentCapturedTab.id,
        width,
        height,
        fps,
        audio,
        mirror
      };

      chrome.runtime.sendMessage({
        action: "START_VIRTUAL_CAM",
        payload: payload
      }, (response) => {
        actionBtn.disabled = false;

        if (chrome.runtime.lastError) {
          alert("Error: " + chrome.runtime.lastError.message + "\n\nPlease ensure this page is a regular HTTP/HTTPS tab. chrome:// pages cannot be captured.");
          restoreUIState({ isCapturing: false });
          return;
        }

        if (response && response.status === "success") {
          restoreUIState(response.state);
        } else {
          alert("Streaming Error: " + (response?.message || "Verify tab constraints & browser permissions."));
          restoreUIState({ isCapturing: false });
        }
      });
    }
  });
});
