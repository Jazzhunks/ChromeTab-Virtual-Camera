/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Chrome Tab Virtual Camera - Webpage Inject Hook Script
 */

(function () {
  console.log("[TabCam Inject] Overriding mediaDevices API to inject Virtual Webcam source...");

  const VIRTUAL_VIDEO_DEVICE_ID = "chrome-tab-camera-virtual";
  const VIRTUAL_LABEL = "OBS Virtual Camera";
  const VIRTUAL_GROUP_ID = "chrome-tab-camera-group";

  // Keep track of any real deviceIds that correspond to OBS Virtual Camera
  const obsDeviceIds = new Set();

  // Cache existing media device APIs
  const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  const activeConnections = new Map(); // Key: connectionId, Value: { pc, stream, messageHandler }

  /**
   * Helper to mirror a video track in real-time using a hidden video element and a canvas
   */
  function mirrorVideoTrack(rawTrack) {
    const hiddenVideo = document.createElement("video");
    hiddenVideo.autoplay = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.muted = true;
    hiddenVideo.srcObject = new MediaStream([rawTrack]);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    let width = 640;
    let height = 480;

    const settings = rawTrack.getSettings();
    if (settings.width) width = settings.width;
    if (settings.height) height = settings.height;

    canvas.width = width;
    canvas.height = height;

    hiddenVideo.onloadedmetadata = () => {
      if (hiddenVideo.videoWidth) {
        canvas.width = hiddenVideo.videoWidth;
        canvas.height = hiddenVideo.videoHeight;
      }
    };

    let animationFrameId = null;
    let isStopped = false;

    function drawFrame() {
      if (isStopped) return;
      if (hiddenVideo.readyState >= hiddenVideo.HAVE_CURRENT_DATA) {
        const w = hiddenVideo.videoWidth || canvas.width;
        const h = hiddenVideo.videoHeight || canvas.height;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        ctx.save();
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      animationFrameId = requestAnimationFrame(drawFrame);
    }

    hiddenVideo.onplay = () => {
      drawFrame();
    };

    // Safe fallback if play event doesn't trigger
    hiddenVideo.play().then(() => {
      drawFrame();
    }).catch(e => {
      console.warn("[TabCam Inject] Error playing video for mirroring:", e);
    });

    const fps = settings.frameRate || 30;
    const canvasStream = canvas.captureStream(fps);
    const mirroredTrack = canvasStream.getVideoTracks()[0];

    if (!mirroredTrack) {
      console.error("[TabCam Inject] Failed to capture video track from mirror canvas.");
      return rawTrack;
    }

    const originalStop = mirroredTrack.stop.bind(mirroredTrack);
    mirroredTrack.stop = () => {
      isStopped = true;
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      try {
        rawTrack.stop();
      } catch (e) {}
      try {
        hiddenVideo.srcObject = null;
      } catch (e) {}
      originalStop();
    };

    rawTrack.onended = () => {
      isStopped = true;
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      try {
        mirroredTrack.stop();
      } catch (e) {}
    };

    return mirroredTrack;
  }

  /**
   * INTERCEPT 1: enumerateDevices
   * Append our Chrome Tab Virtual Camera into the returned devices array so platforms display it as a choice.
   */
  navigator.mediaDevices.enumerateDevices = async function () {
    const devices = await originalEnumerateDevices();

    // Check if there are any devices containing "obs" inside their labels
    devices.forEach(device => {
      if (device.kind === "videoinput" && device.label) {
        const lowerLabel = device.label.toLowerCase();
        if (lowerLabel.includes("obs virtual camera") || lowerLabel.includes("obs-camera") || lowerLabel.includes("obs virtual")) {
          if (device.deviceId && device.deviceId !== VIRTUAL_VIDEO_DEVICE_ID) {
            obsDeviceIds.add(device.deviceId);
          }
        }
      }
    });

    // Avoid duplicates
    const alreadyExists = devices.some(d => d.deviceId === VIRTUAL_VIDEO_DEVICE_ID);
    if (!alreadyExists) {
      // Modern browsers require mock MediaDeviceInfo structure. Let's build a compatible object.
      devices.unshift({
        deviceId: VIRTUAL_VIDEO_DEVICE_ID,
        kind: "videoinput",
        label: VIRTUAL_LABEL,
        groupId: VIRTUAL_GROUP_ID,
        toJSON: function() { return this; }
      });
    } else {
      // Ensure the virtual camera sits at position 0 to claim default priority
      const index = devices.findIndex(d => d.deviceId === VIRTUAL_VIDEO_DEVICE_ID);
      if (index > 0) {
        const [vItem] = devices.splice(index, 1);
        devices.unshift(vItem);
      }
    }

    return devices;
  };

  /**
   * Helper to inspect constraints and check if our Tab Virtual Camera is requested
   */
  async function isVirtualCameraConstraints(constraints) {
    if (!constraints || !constraints.video) return false;
    const videoConstraints = constraints.video;
    
    // Proactively query devices to populate/validate our OBS and virtual device IDs
    let latestObsIds = new Set();
    try {
      const devices = await originalEnumerateDevices();
      devices.forEach(device => {
        if (device.kind === "videoinput" && device.label) {
          const lowerLabel = device.label.toLowerCase();
          if (
            lowerLabel.includes("obs") || 
            lowerLabel.includes("virtual") || 
            lowerLabel.includes("loopback") ||
            lowerLabel.includes("splitcam") ||
            lowerLabel.includes("manycam") ||
            lowerLabel.includes("droidcam") ||
            lowerLabel.includes("vcam") ||
            lowerLabel.includes("skycam")
          ) {
            latestObsIds.add(device.deviceId);
            obsDeviceIds.add(device.deviceId);
          }
        }
      });
    } catch (e) {
      console.warn("[TabCam Inject] Error scanning devices for virtual signature:", e);
    }

    if (typeof videoConstraints === "object") {
      const dId = videoConstraints.deviceId;
      if (dId) {
        let exactId = "";
        if (typeof dId === "string") {
          exactId = dId;
        } else if (typeof dId === "object" && dId !== null) {
          if (dId.exact) exactId = dId.exact;
          else if (dId.ideal) exactId = dId.ideal;
          else if (Array.isArray(dId)) {
            if (dId.includes(VIRTUAL_VIDEO_DEVICE_ID)) return true;
            for (const id of dId) {
              if (obsDeviceIds.has(id) || latestObsIds.has(id)) return true;
            }
            return false;
          }
        }
        // If a specific, valid physical device ID (not our virtual ID, not a known OBS device ID, and not "default") was requested, don't hijack
        if (
          exactId && 
          exactId !== VIRTUAL_VIDEO_DEVICE_ID && 
          exactId !== "default" && 
          !obsDeviceIds.has(exactId) && 
          !latestObsIds.has(exactId)
        ) {
          return false;
        }
      }
    }
    
    // Otherwise, since TabCam is the system DEFAULT, route all video captures to the virtual stream
    return true;
  }

  /**
   * INTERCEPT 2: getUserMedia
   * Hijacks standard webcam acquisition requests and wires up a virtual WebRTC connection to streaming source.
   */
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const shouldHijack = await isVirtualCameraConstraints(constraints);
    if (shouldHijack) {
      console.log("[TabCam Inject] Intercepted getUserMedia! Pairing WebRTC loopback stream...", constraints);
      return await getVirtualCameraStream(constraints);
    }
    return originalGetUserMedia(constraints);
  };

  // Support old-school callback-based getUserMedia overrides, used by legacy apps
  if (navigator.getUserMedia) {
    const originalLegacyGetUserMedia = navigator.getUserMedia.bind(navigator);
    navigator.getUserMedia = function (constraints, successCb, errorCb) {
      isVirtualCameraConstraints(constraints).then(shouldHijack => {
        if (shouldHijack) {
          getVirtualCameraStream(constraints)
            .then(successCb)
            .catch(errorCb);
        } else {
          originalLegacyGetUserMedia(constraints, successCb, errorCb);
        }
      }).catch(() => {
        originalLegacyGetUserMedia(constraints, successCb, errorCb);
      });
    };
  }

  // Support deprecated webkit/mozGetUserMedia overrides if present
  if (navigator.webkitGetUserMedia) {
    const originalWebkitGetUserMedia = navigator.webkitGetUserMedia.bind(navigator);
    navigator.webkitGetUserMedia = function (constraints, successCb, errorCb) {
      isVirtualCameraConstraints(constraints).then(shouldHijack => {
        if (shouldHijack) {
          getVirtualCameraStream(constraints)
            .then(successCb)
            .catch(errorCb);
        } else {
          originalWebkitGetUserMedia(constraints, successCb, errorCb);
        }
      }).catch(() => {
        originalWebkitGetUserMedia(constraints, successCb, errorCb);
      });
    };
  }

  /**
   * NEGOTIATION PIPELINE
   * Establish WebRTC local transport with extension and capture the tab tracks.
   */
  function getVirtualCameraStream(constraints) {
    const connectionId = Math.random().toString(36).substring(2, 11);
    return new Promise((resolve, reject) => {
      try {
        console.log(`[TabCam Inject] Creating RTCPeerConnection for Virtual Cam loop (connectionId=${connectionId})...`);

        // Setup local WebRTC endpoint
        const pc = new RTCPeerConnection({
          iceServers: [],
          iceCandidatePoolSize: 0
        });
        pc._mirrorSetting = false;

        // Express interest in receiving video and audio tracks
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        const outStream = new MediaStream();
        activeConnections.set(connectionId, { pc, stream: outStream });

        let hasWebRTCAudio = false;

        // Collect tracks as they arrive over WebRTC local cable
        pc.ontrack = (event) => {
          console.log(`[TabCam Inject] Received track over loopback WebRTC (connectionId=${connectionId}):`, event.track.kind);
          let track = event.track;
          if (track.kind === "video") {
            if (pc._mirrorSetting) {
              console.log("[TabCam Inject] Applying live mirror horizontal flip on track input.");
              try {
                track = mirrorVideoTrack(track);
              } catch (err) {
                console.error("[TabCam Inject] Track mirroring failed:", err);
              }
            }
            outStream.addTrack(track);
          } else if (track.kind === "audio") {
            hasWebRTCAudio = true;
            outStream.addTrack(track);
          }

          // If track stops externally, make sure we clean up WebRTC
          track.onended = () => {
            console.log(`[TabCam Inject] WebRTC MediaTrack ended for connectionId=${connectionId}.`);
            cleanupConnection(connectionId);
          };
        };

        // Track state changes
        pc.onconnectionstatechange = () => {
          console.log(`[TabCam Inject] WebRTC connectionState for connectionId=${connectionId}:`, pc.connectionState);
          if (pc.connectionState === "failed" || pc.connectionState === "closed") {
            cleanupConnection(connectionId);
          }
        };

        // Bridge signaling replies from webpage context to content script
        function messageRelayHandler(event) {
          if (event.source !== window || !event.data || event.data.source !== "TABCAM_CONTENT") {
            return;
          }

          const { type, payload } = event.data;

          // Guard: make sure this message is designated for this specific connectionId
          if (payload.connectionId !== connectionId) {
            return;
          }

          if (type === "OFFER") {
            console.log(`[TabCam Inject] Received WebRTC SDP Offer from extension for connectionId=${connectionId}. Config:`, payload.config);
            if (payload.config && payload.config.mirror) {
              pc._mirrorSetting = true;
            }
            pc.setRemoteDescription(new RTCSessionDescription({
              type: "offer",
              sdp: payload.sdp
            })).then(() => {
              return pc.createAnswer();
            }).then(answer => {
              return pc.setLocalDescription(answer).then(() => {
                console.log(`[TabCam Inject] Sending WebRTC SDP Answer back for connectionId=${connectionId}...`);
                window.postMessage({
                  source: "TABCAM_INJECT",
                  type: "ANSWER",
                  payload: { connectionId, sdp: answer.sdp }
                }, "*");
              });
            }).catch(err => {
              console.error(`[TabCam Inject] WebRTC signaling handshake error for connectionId=${connectionId}:`, err);
              reject(err);
            });
          } else if (type === "ICE_CANDIDATE") {
            if (payload.candidate) {
              pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
                .catch(err => console.warn(`[TabCam Inject] Candidate pairing ignored for connectionId=${connectionId}:`, err));
            }
          }
        }

        // Handle signaling event listeners
        window.addEventListener("message", messageRelayHandler);

        // Store reference to clean up later
        const connObj = activeConnections.get(connectionId);
        if (connObj) {
          connObj.messageHandler = messageRelayHandler;
        }

        // Initialize handshake process by pinging content script
        console.log(`[TabCam Inject] Pinging Content Bridge for connection initiation (connectionId=${connectionId})...`);
        window.postMessage({
          source: "TABCAM_INJECT",
          type: "INIT_CONNECTION",
          payload: { connectionId }
        }, "*");

        // Return stream once tracks are mapped
        // Give a short grace period for WebRTC routing to complete
        setTimeout(() => {
          if (constraints.audio && !hasWebRTCAudio) {
            console.log(`[TabCam Inject] App requested audio but WebRTC has none. Injecting physical microphone fallback (connectionId=${connectionId})...`);
            originalGetUserMedia({ audio: constraints.audio })
              .then(micStream => {
                const micTrack = micStream.getAudioTracks()[0];
                if (micTrack) {
                  outStream.addTrack(micTrack);
                  console.log("[TabCam Inject] Successfully bound real microphone audio track to virtual camera stream.");
                }
                resolve(outStream);
              })
              .catch(err => {
                console.warn("[TabCam Inject] Failed to obtain real microphone track, generating silent fallback track:", err);
                try {
                  const ctx = new (window.AudioContext || window.webkitAudioContext)();
                  const dest = ctx.createMediaStreamDestination();
                  const silentTrack = dest.stream.getAudioTracks()[0];
                  if (silentTrack) {
                    outStream.addTrack(silentTrack);
                  }
                } catch (e) {
                  console.error("[TabCam Inject] Critical error generating fallback silent audio:", e);
                }
                resolve(outStream);
              });
          } else {
            if (outStream.getTracks().length > 0) {
              console.log("[TabCam Inject] Returning live Virtual Camera stream to client page.");
            } else {
              // If tracks haven't finished binding yet, we resolve the stream anyway; tracks are dynamically added and will play.
              console.log("[TabCam Inject] Stream resolved. Tracks are binding asynchronously...");
            }
            resolve(outStream);
          }
        }, 150);

      } catch (err) {
        console.error(`[TabCam Inject] Failed to instantiate virtual webcam source (connectionId=${connectionId}):`, err);
        reject(err);
      }
    });
  }

  /**
   * Close active WebRTC links and reset states
   */
  function cleanupConnection(connectionId) {
    if (!connectionId) {
      for (const id of activeConnections.keys()) {
        cleanupConnection(id);
      }
      return;
    }

    const conn = activeConnections.get(connectionId);
    if (conn) {
      console.log(`[TabCam Inject] Cleaning up active peer connection for connectionId=${connectionId}...`);
      try {
        if (conn.messageHandler) {
          window.removeEventListener("message", conn.messageHandler);
        }

        // Notify extension that this page is disconnecting
        window.postMessage({
          source: "TABCAM_INJECT",
          type: "DISCONNECT",
          payload: { connectionId }
        }, "*");

        conn.pc.close();
      } catch (e) {}

      try {
        conn.stream.getTracks().forEach(track => track.stop());
      } catch (e) {}

      activeConnections.delete(connectionId);
    }
  }

})();
