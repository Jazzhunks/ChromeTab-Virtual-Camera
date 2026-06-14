========================================================================
             CHROME TAB VIRTUAL CAMERA - EXTENSION INSTRUCTIONS
========================================================================

A plug-and-play Chrome Extension that allows you to capture any Chrome Tab 
and expose it directly as a webcam-selectable video/audio stream in video 
conferencing platforms like Zoom, Google Meet, Microsoft Teams, Discord, 
and more—without requiring OBS, system drivers, or external installers.

------------------------------------------------------------------------
HOW IT WORKS (THE WEBRTC LOOPBACK ARCHITECTURE)
------------------------------------------------------------------------
Chrome Extensions cannot install system-level kernel drivers to register 
actual hardware cameras. To bypass this, TabCam uses a brilliant 3-layer 
signaling bridge:

1. Tab Capture context: When started, the background service worker obtains 
   a streamId token and hands it off to an 'Offscreen Document' context. 
   The offscreen document initiates chrome.tabCapture to grab the tab's 
   audio and video tracks in Full-HD.
2. API Injection (Monkeypatch): The extension's content script injects a 
   hook ("inject.js") directly into newly loaded webpages. It intercepts 
   "navigator.mediaDevices.enumerateDevices" to register a virtual camera 
   input named "OBS Virtual Camera". It overrides "getUserMedia" 
   to redirect camera requests to our virtual source.
3. WebRTC Loopback Cable: When a platform (like Google Meet) requests the 
   Virtual Camera, "inject.js" opens a local loopback WebRTC channel. 
   The offscreen capturing document serves as the WebRTC sender, and the 
   meeting page is the receiver. Tracks are piped across this local web-cable 
   instantly, operating offline and with sub-millisecond, zero-lag latency.

------------------------------------------------------------------------
INSTALLATION GUIDE (CHROME / CHROMIUM-BASED BROWSERS)
------------------------------------------------------------------------
To install and run this extension locally:

1. Download the ZIP file containing this extension.
2. Unpack/unzip the file into a dedicated folder on your computer.
3. Open Google Chrome and navigate to the Extensions page:
   --> Type `chrome://extensions` in your address bar and press Enter.
4. Enable "Developer mode" in the top-right corner of the Extensions page.
5. Click on the "Load unpacked" button in the top-left corner.
6. Select the folder where you unzipped the extension files (the folder 
   containing "manifest.json").
7. The "Chrome Tab Virtual Camera" extension will appear in your list!

------------------------------------------------------------------------
HOW TO USE
------------------------------------------------------------------------
1. Open the web page/tab you want to share (e.g., a presentation, slideshow, 
   a game canvas, or visualizer).
2. Click the Extension puzzle icon in your Chrome toolbar and select 
   "Chrome Tab Virtual Camera" to open the popup.
3. Adjust your desired options (720p/1080p, 30/60 FPS, Audio capture, Mirroring).
4. Click the "Start Virtual Camera" button.
5. Open any online video meeting platform (such as Google Meet or Zoom Web).
6. Go into the platform's Settings --> Video / Camera dropdown.
7. Select "OBS Virtual Camera".
8. Viola! Your selected tab stream is now broadcasting as your video camera.
9. To turn off, open the extension popup again and click "Stop Virtual Camera".

------------------------------------------------------------------------
BROWSER LIMITATIONS & NOTES
------------------------------------------------------------------------
- Extension Security: Chrome forbids extensions from capturing special system 
  pages, Chrome settings, or "chrome://" dashboards. Ensure the source tab 
  is a standard website (HTTP/HTTPS).
- Sandbox Safety: All WebRTC traffic runs completely locally on your computer 
  without sending data to external target servers. Your data and streams remain 
  100% private.
========================================================================
