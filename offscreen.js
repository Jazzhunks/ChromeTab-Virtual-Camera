/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Chrome Tab Virtual Camera - Offscreen Stream Pipeline Engine
 */

let activeStream = null;
const peerConnections = new Map(); // Key: pageId (string), Value: RTCPeerConnection

const statusLog = document.getElementById("statusLog");
const previewVideo = document.getElementById("previewVideo");

function logStatus(text) {
  console.log("[Offscreen] " + text);
  if (statusLog) {
    statusLog.textContent = text;
  }
}

// Report success connection to background-worker
chrome.runtime.sendMessage({ action: "OFFSCREEN_CONNECTED" });

// Listen to command messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, payload } = message;

  switch (action) {
    case "START_STREAM_CAPTURE":
      startTabCaptureStream(payload.streamId, payload.config).then(() => {
        sendResponse({ status: "success" });
      }).catch(err => {
        sendResponse({ status: "error", message: err.message });
      });
      return true; // Keep message channel open for async response

    case "STOP_STREAM_CAPTURE":
      stopAllActiveStreams();
      sendResponse({ status: "success" });
      break;

    case "SIGNAL_FROM_PAGE":
      handlePageSignal(payload).then(() => {
        sendResponse({ status: "success" });
      }).catch(err => {
        sendResponse({ status: "error", message: err.message });
      });
      return true; // Keep message channel open for async response

    default:
      break;
  }
});

/**
 * Capture the tab MediaStream using constraints based on user choices (Resolution/FPS/Audio)
 */
async function startTabCaptureStream(streamId, config) {
  try {
    stopAllActiveStreams();

    logStatus(`Initiating capture: StreamID=${streamId.substring(0, 8)}... Config: ${config.width}x${config.height} @ ${config.fps}fps`);

    // Define constraints compatible with chrome.tabCapture
    const videoConstraints = {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: config.width || 1280,
        maxHeight: config.height || 720,
        maxFrameRate: config.fps || 30
      }
    };

    const audioConstraints = config.audio ? {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    } : false;

    // Get the actual MediaStream
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: audioConstraints
    });

    activeStream = stream;

    // Output live preview to offscreen video element for debugging/visual confirmation
    if (previewVideo) {
      previewVideo.srcObject = stream;
      previewVideo.muted = true;
      previewVideo.play().catch(e => console.warn("Failed preview playback:", e));
    }

    logStatus("Tab stream successfully captured and piped into Virtual Camera feed.");

    // Notify any pages waiting or active
    for (const [pageId, pc] of peerConnections.entries()) {
      logStatus(`Negotiating stream update with active connection: ${pageId}`);
      updateStreamsForPeerConnection(pc);
    }

  } catch (error) {
    logStatus("Capture Error: " + error.message);
    console.error("[Offscreen] Error capturing stream:", error);
    chrome.runtime.sendMessage({
      action: "VIRTUAL_CAM_ERROR",
      payload: { message: error.message }
    });
  }
}

/**
 * Handle incoming WebRTC signaling message from target video conferencing page context
 */
async function handlePageSignal(signal) {
  const { type, pageTabId, pageFrameId, connectionId } = signal;
  const pageId = `${pageTabId}-${pageFrameId}`;
  const connKey = `${pageId}-${connectionId}`;

  logStatus(`Received signal from webpage [${connKey}]: type=${type}`);

  if (type === "INIT_CONNECTION") {
    // Webpage initiated connection request
    await establishWebRTCConnection(connKey, pageTabId, pageFrameId, connectionId);
  } else if (type === "ANSWER") {
    const pc = peerConnections.get(connKey);
    if (pc) {
      logStatus(`Setting remote SDP description for: ${connKey}`);
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: "answer",
        sdp: signal.sdp
      })).catch(err => console.error("Error setting remote description:", err));
    }
  } else if (type === "ICE_CANDIDATE") {
    const pc = peerConnections.get(connKey);
    if (pc && signal.candidate) {
      logStatus(`Adding Remote ICE candidate to page: ${connKey}`);
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate))
        .catch(err => console.warn("Error adding received ICE candidate:", err));
    }
  } else if (type === "DISCONNECT") {
    closePeerConnection(connKey);
  }
}

/**
 * Establish a local peer-to-peer WebRTC connection with a client page
 */
async function establishWebRTCConnection(connKey, pageTabId, pageFrameId, connectionId) {
  try {
    // Clean up existing page connection if any
    closePeerConnection(connKey);

    logStatus(`Establishing local WebRTC pipe for webpage connection: ${connKey}`);

    // Create RTCPeerConnection with local loopback configuration (no STUN required as peers are in same browser process)
    const pc = new RTCPeerConnection({
      iceServers: [],
      iceCandidatePoolSize: 0
    });

    peerConnections.set(connKey, pc);

    // Relay local ICE candidates discovered by this peer to the page
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        chrome.runtime.sendMessage({
          action: "SIGNAL_TO_PAGE",
          payload: {
            type: "ICE_CANDIDATE",
            candidate: event.candidate,
            pageTabId,
            pageFrameId,
            connectionId
          }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      logStatus(`WebRTC [${connKey}] Connection state changed to: ${pc.connectionState}`);
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
        closePeerConnection(connKey);
      }
    };

    // Bind current active stream tracks to peer connection
    updateStreamsForPeerConnection(pc);

    // Create SDP Offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Send SDP Offer to page via the messaging pipeline
    chrome.runtime.sendMessage({
      action: "SIGNAL_TO_PAGE",
      payload: {
        type: "OFFER",
        sdp: offer.sdp,
        pageTabId,
        pageFrameId,
        connectionId
      }
    });

  } catch (error) {
    console.error("[Offscreen] Failed to establish WebRTC connection:", error);
    logStatus(`WebRTC [${connKey}] setup failure: ` + error.message);
  }
}

/**
 * Inject the active media tracks into a peer connection, or fallback if none is ready yet
 */
function updateStreamsForPeerConnection(pc) {
  // Clear any existing senders
  pc.getSenders().forEach(sender => pc.removeTrack(sender));

  if (activeStream) {
    activeStream.getTracks().forEach(track => {
      pc.addTrack(track, activeStream);
    });
    logStatus("Muted sound/video tracks bound to PeerConnection.");
  } else {
    logStatus("WARNING: WebRTC connection established without active tab capture stream. Waiting for stream start...");
  }
}

/**
 * Close a specific webpage connection
 */
function closePeerConnection(pageId) {
  const pc = peerConnections.get(pageId);
  if (pc) {
    try {
      pc.close();
    } catch (e) {}
    peerConnections.delete(pageId);
    logStatus(`Closed PeerConnection for [${pageId}]`);
  }
}

/**
 * Stop all streaming pipeline operations and close active links
 */
function stopAllActiveStreams() {
  logStatus("Shutting down active Virtual Webcam channels...");

  if (activeStream) {
    activeStream.getTracks().forEach(track => {
      try {
        track.stop();
      } catch (e) {}
    });
    activeStream = null;
  }

  if (previewVideo) {
    previewVideo.srcObject = null;
  }

  // Terminate all WebRTC connections
  for (const pageId of peerConnections.keys()) {
    closePeerConnection(pageId);
  }
}
