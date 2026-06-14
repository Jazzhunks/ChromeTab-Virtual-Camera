/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Chrome Tab Virtual Camera - Background Service Worker
 */

let activeCaptureState = {
  isCapturing: false,
  capturedTabId: null,
  config: {
    width: 1280,
    height: 720,
    fps: 30,
    mirror: false,
    audio: false
  }
};

// Load state from local storage on startup
chrome.storage.local.get(["activeCaptureState"], (result) => {
  if (result && result.activeCaptureState) {
    activeCaptureState = result.activeCaptureState;
  }
});

// Listen for messages from standard extension parts (popup, offscreen, content script)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, payload } = message;

  switch (action) {
    case "GET_CAPTURE_STATE":
      chrome.storage.local.get(["activeCaptureState"], (result) => {
        if (result && result.activeCaptureState) {
          activeCaptureState = result.activeCaptureState;
        }
        sendResponse({ status: "success", state: activeCaptureState });
      });
      return true; // Keep message channel open for async response

    case "START_VIRTUAL_CAM":
      startVirtualCamera(payload, sender, sendResponse);
      return true; // Keep message channel open for async response

    case "STOP_VIRTUAL_CAM":
      stopVirtualCamera(sendResponse);
      return true;

    case "SIGNAL_TO_OFFSCREEN":
      // Relay signaling messages (WebRTC Offer/Answer/ICE) from the web pages (via content script) to the offscreen document
      chrome.runtime.sendMessage({
        action: "SIGNAL_FROM_PAGE",
        payload: {
          ...payload,
          pageTabId: sender.tab?.id,
          pageFrameId: sender.frameId
        }
      }).catch(err => {
        // Offscreen document might not be ready yet or closed
        console.warn("[Background] Failed to relay signal to offscreen document:", err);
      });
      sendResponse({ status: "success" });
      break;

    case "SIGNAL_TO_PAGE":
      // Relay signaling messages from offscreen script back to the webpage
      if (payload && payload.pageTabId) {
        const enrichedPayload = { ...payload };
        if (payload.type === "OFFER") {
          enrichedPayload.config = {
            mirror: activeCaptureState.config ? !!activeCaptureState.config.mirror : false
          };
        }
        chrome.tabs.sendMessage(payload.pageTabId, {
          action: "SIGNAL_FROM_EXTENSION",
          payload: enrichedPayload
        }, { frameId: payload.pageFrameId }).catch(err => {
          console.warn("[Background] Failed to relay signal to tab " + payload.pageTabId, err);
        });
      }
      sendResponse({ status: "success" });
      break;

    case "OFFSCREEN_CONNECTED":
      console.log("[Background] Offscreen document reported connected state.");
      sendResponse({ status: "success" });
      break;

    default:
      break;
  }
});

/**
 * Start the virtual camera process
 */
async function startVirtualCamera(config, sender, sendResponse) {
  try {
    // 1. Get the tab to capture. We prioritize a designated tabId, or fallback to the active tab in current window.
    let tabId = config.tabId;
    if (!tabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0) {
        tabId = tabs[0].id;
      }
    }

    if (!tabId) {
      sendResponse({ status: "error", message: "No active tab found to capture." });
      return;
    }

    // Update active capture configuration
    activeCaptureState.isCapturing = true;
    activeCaptureState.capturedTabId = tabId;
    activeCaptureState.config = {
      width: config.width || 1280,
      height: config.height || 720,
      fps: config.fps || 30,
      mirror: !!config.mirror,
      audio: !!config.audio
    };

    // 2. Get the tab capture stream ID
    // In MV3, chrome.tabCapture.getMediaStreamId must be called on behalf of a user gesture
    // passing the target tab explicitly.
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, async (streamId) => {
      if (chrome.runtime.lastError) {
        activeCaptureState.isCapturing = false;
        activeCaptureState.capturedTabId = null;
        sendResponse({ status: "error", message: chrome.runtime.lastError.message });
        return;
      }

      if (!streamId) {
        activeCaptureState.isCapturing = false;
        activeCaptureState.capturedTabId = null;
        sendResponse({ status: "error", message: "Failed to generate media stream ID for tab capture." });
        return;
      }

      try {
        // 3. Create or establish the offscreen document
        await setupOffscreenDocument();

        // 4. Send the streamId and configuration parameters to the offscreen document
        await sleep(300); // Give the offscreen document a brief moment to finish mounting
        chrome.runtime.sendMessage({
          action: "START_STREAM_CAPTURE",
          payload: {
            streamId: streamId,
            config: activeCaptureState.config,
            capturedTabId: tabId
          }
        });

        // 5. Save the configuration state into chrome.storage so popup and content scripts can read persistent state
        await chrome.storage.local.set({ activeCaptureState });

        // Update the extension badge to show capturing status
        chrome.action.setBadgeText({ text: "LIVE" });
        chrome.action.setBadgeBackgroundColor({ color: "#22c55e" }); // Emerald green

        sendResponse({ status: "success", state: activeCaptureState });
      } catch (err) {
        activeCaptureState.isCapturing = false;
        activeCaptureState.capturedTabId = null;
        sendResponse({ status: "error", message: "Offscreen initialization failed: " + err.message });
      }
    });

  } catch (error) {
    console.error("[Background] Error starting virtual camera:", error);
    activeCaptureState.isCapturing = false;
    activeCaptureState.capturedTabId = null;
    sendResponse({ status: "error", message: error.message });
  }
}

/**
 * Stop the virtual camera process
 */
async function stopVirtualCamera(sendResponse) {
  try {
    activeCaptureState.isCapturing = false;
    activeCaptureState.capturedTabId = null;

    // Send success response to the Popup synchronously to prevent any "message port closed" issues
    sendResponse({ status: "success", state: activeCaptureState });

    // Send stop signal to offscreen document
    chrome.runtime.sendMessage({ action: "STOP_STREAM_CAPTURE" }, () => {
      if (chrome.runtime.lastError) {
        // Safe to ignore
      }
    });

    // Clean up extension badge
    chrome.action.setBadgeText({ text: "" });

    // Update local storage
    chrome.storage.local.set({ activeCaptureState });

    // Close offscreen document
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {
      // Ignored if already closed
    }
  } catch (err) {
    console.error("[Background] Error stopping virtual camera:", err);
    try {
      sendResponse({ status: "error", message: err.message });
    } catch (e) {}
  }
}

/**
 * Creates an offscreen document if it doesn't already exist.
 */
async function setupOffscreenDocument() {
  const hasOffscreen = await hasExistingOffscreenDocument();
  if (hasOffscreen) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "To handle the tab capture MediaStream and stream it natively to conference tabs via WebRTC local pipes."
  });
}

/**
 * Helper to check if offscreen document is already opened
 */
async function hasExistingOffscreenDocument() {
  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });
    return contexts.length > 0;
  } else {
    // Fallback if older Chrome version
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
