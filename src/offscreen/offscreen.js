/**
 * Offscreen Document — Headset Communication
 * 
 * Two modes:
 * 1. WebHID (USB): Direct HID input/output reports for USB-connected headsets
 *    (Bose, Jabra, Poly/Plantronics, Yealink)
 * 2. Media Session (Bluetooth): Captures media key presses from BT headsets
 *    (Bose, Jabra, Poly, Yealink, AirPods, etc.) by playing silent audio and
 *    registering Media Session action handlers.
 *    When a D365 call is active/ringing, Chrome routes AVRCP button
 *    presses (translated to media keys by Windows) to our handlers.
 */

import {
  isSupportedVendor,
  HID_FILTERS,
  parseTelephonyInput,
  parseConsumerInput,
  buildOutputReport,
  analyzeDeviceCollections,
  identifyDeviceModel,
  getVendorQuirks,
  getFriendlyName,
  USAGE_PAGE,
} from '../shared/bose-hid-protocol.js';

import { MSG, SOURCE } from '../shared/messages.js';

// ── State ──
let device = null;
let deviceInfo = null;    // { telephony, consumer } from analyzeDeviceCollections
let vendorQuirks = null;  // { hookSwitch, phoneMute } from getVendorQuirks
let previousInput = null; // Track state changes vs. raw reports

// ── Debounce for hook switch (some headsets send multiple reports) ──
let hookDebounceTimer = null;
const HOOK_DEBOUNCE_MS = 150;

/**
 * Connect to a headset via WebHID.
 * Called when user clicks "Connect" in the popup (which triggers a user gesture
 * in the popup, but the actual requestDevice must happen in a user-gesture context).
 * For offscreen, we rely on previously-granted permissions via getDevices().
 */
async function connectDevice() {
  try {
    // Try to get already-paired devices first
    const devices = await navigator.hid.getDevices();
    // Find any supported headset device (Bose, Jabra, Poly/Plantronics)
    const headsetDevice = devices.find(d => isSupportedVendor(d.vendorId));

    if (!headsetDevice) {
      // No previously-paired device found — need user gesture from popup
      sendMessage(MSG.HID_DEVICE_DISCONNECTED, {
        reason: 'no_paired_device',
        message: 'No USB HID device found. Bluetooth headsets connect via native host.'
      });
      return;
    }

    await openDevice(headsetDevice);
  } catch (err) {
    console.error('[Offscreen] Connect error:', err);
    sendMessage(MSG.HID_DEVICE_DISCONNECTED, { reason: 'error', message: err.message });
  }
}

/**
 * Open and configure an HID device.
 * If another application has exclusive access, retry a few times.
 */
async function openDevice(hidDevice) {
  if (device && device.opened) {
    try { await device.close(); } catch (_) { /* ignore */ }
  }

  device = hidDevice;

  if (!device.opened) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await device.open();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[Offscreen] open() attempt ${attempt + 1} failed:`, err.message);
        // Wait before retry — another app may release the device
        await new Promise(r => setTimeout(r, 500));
      }
    }
    if (lastErr) {
      console.error('[Offscreen] Could not open device after retries:', lastErr.message);
      sendMessage(MSG.HID_DEVICE_DISCONNECTED, {
        reason: 'exclusive_access',
        message: 'Another application may be using the headset. Close other apps (Teams, Zoom, etc.) and try again.',
      });
      device = null;
      return;
    }
  }

  // Analyze collections to find telephony + consumer report IDs
  deviceInfo = analyzeDeviceCollections(device);
  vendorQuirks = getVendorQuirks(device.vendorId);
  const model = identifyDeviceModel(device);

  console.log(`[Offscreen] HID device connected: ${model} (${device.productName})`);
  console.log('[Offscreen] Collections:', JSON.stringify(deviceInfo, null, 2));

  // Listen for input reports
  device.addEventListener('inputreport', handleInputReport);

  // Notify service worker
  sendMessage(MSG.HID_DEVICE_CONNECTED, {
    model,
    friendlyName: getFriendlyName(model),
    productName: device.productName,
    vendorId: device.vendorId,
    productId: device.productId,
  });
}

/**
 * Disconnect the current device.
 */
async function disconnectDevice() {
  if (device) {
    device.removeEventListener('inputreport', handleInputReport);
    if (device.opened) {
      try { await device.close(); } catch (_) { /* ignore */ }
    }
    device = null;
    deviceInfo = null;
    vendorQuirks = null;
    previousInput = null;
  }
  sendMessage(MSG.HID_DEVICE_DISCONNECTED, { reason: 'user_disconnect' });
}

/**
 * Handle HID input reports from the headset.
 */
function handleInputReport(event) {
  const { reportId, data } = event;

  // Determine if this is a telephony or consumer report
  const isTelephony = deviceInfo?.telephony &&
    reportId === deviceInfo.telephony.inputReportId;
  const isConsumer = deviceInfo?.consumer &&
    reportId === deviceInfo.consumer.inputReportId;

  if (isTelephony) {
    const parsed = parseTelephonyInput(data);
    if (!parsed) return;

    // Detect changes from previous state
    if (previousInput) {
      // Hook switch changed (answer/end call)
      if (parsed.hookSwitch !== previousInput.hookSwitch) {
        if (vendorQuirks?.hookSwitch === 'momentary') {
          // Momentary: only fire on rising edge (button press)
          if (parsed.hookSwitch) {
            clearTimeout(hookDebounceTimer);
            hookDebounceTimer = setTimeout(() => {
              sendMessage(MSG.HID_HOOK_SWITCH, { value: true, momentary: true });
            }, HOOK_DEBOUNCE_MS);
          } else {
            clearTimeout(hookDebounceTimer); // Cancel if released quickly
          }
        } else {
          // Stateful: fire on both edges
          clearTimeout(hookDebounceTimer);
          const value = parsed.hookSwitch;
          hookDebounceTimer = setTimeout(() => {
            sendMessage(MSG.HID_HOOK_SWITCH, { value });
          }, HOOK_DEBOUNCE_MS);
        }
      }

      // Mute toggled
      if (parsed.phoneMute !== previousInput.phoneMute) {
        if (vendorQuirks?.phoneMute === 'momentary') {
          // Momentary: only fire on rising edge (button press)
          if (parsed.phoneMute) {
            sendMessage(MSG.HID_PHONE_MUTE, { value: true, momentary: true });
          }
        } else {
          // Stateful: fire on both edges, value = actual mute state
          sendMessage(MSG.HID_PHONE_MUTE, { value: parsed.phoneMute });
        }
      }

      // Flash (momentary — only on press)
      if (parsed.flash && !previousInput.flash) {
        sendMessage(MSG.HID_FLASH, {});
      }

      // Drop (momentary — only on press)
      if (parsed.drop && !previousInput.drop) {
        sendMessage(MSG.HID_DROP, {});
      }

      // Redial (momentary)
      if (parsed.redial && !previousInput.redial) {
        sendMessage(MSG.HID_REDIAL, {});
      }
    } else {
      // First report — just record initial state, don't fire events
    }

    previousInput = parsed;
  } else if (isConsumer) {
    const parsed = parseConsumerInput(data);
    if (!parsed) return;

    if (parsed.volumeUp) sendMessage(MSG.HID_VOLUME_UP, {});
    if (parsed.volumeDown) sendMessage(MSG.HID_VOLUME_DOWN, {});
    if (parsed.mute) sendMessage(MSG.HID_PHONE_MUTE, { value: true });
  } else {
    // Unknown report — might be vendor-specific. Also try telephony parse as fallback.
    // Some models don't separate collections cleanly.
    if (data.byteLength > 0) {
      const parsed = parseTelephonyInput(data);
      if (parsed && previousInput) {
        if (parsed.hookSwitch !== previousInput.hookSwitch) {
          if (vendorQuirks?.hookSwitch === 'momentary') {
            if (parsed.hookSwitch) {
              clearTimeout(hookDebounceTimer);
              hookDebounceTimer = setTimeout(() => {
                sendMessage(MSG.HID_HOOK_SWITCH, { value: true, momentary: true });
              }, HOOK_DEBOUNCE_MS);
            } else {
              clearTimeout(hookDebounceTimer);
            }
          } else {
            clearTimeout(hookDebounceTimer);
            const value = parsed.hookSwitch;
            hookDebounceTimer = setTimeout(() => {
              sendMessage(MSG.HID_HOOK_SWITCH, { value });
            }, HOOK_DEBOUNCE_MS);
          }
        }
        if (parsed.phoneMute !== previousInput.phoneMute) {
          if (vendorQuirks?.phoneMute === 'momentary') {
            if (parsed.phoneMute) {
              sendMessage(MSG.HID_PHONE_MUTE, { value: true, momentary: true });
            }
          } else {
            sendMessage(MSG.HID_PHONE_MUTE, { value: parsed.phoneMute });
          }
        }
        if (parsed.flash && !previousInput.flash) sendMessage(MSG.HID_FLASH, {});
        if (parsed.drop && !previousInput.drop) sendMessage(MSG.HID_DROP, {});
      }
      previousInput = parsed || previousInput;
    }
  }
}

/**
 * Send LED/status output report to the headset.
 */
async function sendLedState(ledState) {
  if (!device || !device.opened || !deviceInfo?.telephony) {
    console.warn('[Offscreen] Cannot send LED: device not connected or no telephony collection');
    return;
  }

  const reportData = buildOutputReport(ledState);
  const reportId = deviceInfo.telephony.outputReportId;

  try {
    await device.sendReport(reportId, reportData);
  } catch (err) {
    console.error('[Offscreen] sendReport error:', err);
  }
}

// ── Message handling ──

function sendMessage(type, payload) {
  chrome.runtime.sendMessage({
    source: SOURCE.OFFSCREEN,
    type,
    payload,
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.source === SOURCE.OFFSCREEN) return; // Ignore own messages

  switch (message.type) {
    case MSG.HID_REQUEST_CONNECT:
      connectDevice().then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true; // async

    case MSG.HID_REQUEST_DISCONNECT:
      disconnectDevice().then(() => sendResponse({ ok: true }));
      return true;

    case MSG.SET_HEADSET_LED:
      sendLedState(message.payload).then(() => sendResponse({ ok: true }));
      return true;

    case MSG.OFFSCREEN_PING:
      sendResponse({ ok: true, hasDevice: !!device && device.opened, mediaCapturing });
      return false;

    case MSG.START_MEDIA_CAPTURE:
      startMediaCapture(message.payload?.callState, message.payload?.muted);
      sendResponse({ ok: true });
      return false;

    case MSG.STOP_MEDIA_CAPTURE:
      stopMediaCapture();
      sendResponse({ ok: true });
      return false;

    case MSG.GET_STATUS:
      sendResponse({
        ok: true,
        device: device ? {
          connected: device.opened,
          model: identifyDeviceModel(device),
          productName: device.productName,
        } : null,
      });
      return false;
  }
});

// ── HID connect/disconnect events ──
navigator.hid.addEventListener('connect', async (event) => {
  const hid = event.device;
  if (isSupportedVendor(hid.vendorId)) {
    console.log('[Offscreen] HID device plugged in:', hid.productName);
    await openDevice(hid);
  }
});

navigator.hid.addEventListener('disconnect', (event) => {
  const hid = event.device;
  if (device && hid === device) {
    console.log('[Offscreen] HID device unplugged');
    device = null;
    deviceInfo = null;
    vendorQuirks = null;
    previousInput = null;
    sendMessage(MSG.HID_DEVICE_DISCONNECTED, { reason: 'unplugged' });
  }
});

// ══════════════════════════════════════════════════════════════
// MEDIA SESSION — Bluetooth headset media key capture
// ══════════════════════════════════════════════════════════════

let mediaCapturing = false;
let mediaCallState = 'idle';
let mediaMuted = false;

/**
 * Generate a tiny silent WAV file (1 second, 8kHz, mono, 8-bit).
 * Used to activate the Media Session so Chrome routes media keys here.
 */
function createSilentWavBlob() {
  const sampleRate = 8000;
  const numSamples = sampleRate; // 1 second
  const headerSize = 44;
  const dataSize = numSamples;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);       // chunk size
  view.setUint16(20, 1, true);        // PCM format
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate
  view.setUint16(32, 1, true);        // block align
  view.setUint16(34, 8, true);        // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  // Silence = 128 for 8-bit unsigned PCM
  const samples = new Uint8Array(buffer, headerSize);
  samples.fill(128);

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Start capturing media keys by playing silent audio and
 * setting up Media Session action handlers.
 */
function startMediaCapture(callState, muted) {
  mediaCallState = callState || 'idle';
  mediaMuted = muted || false;

  // Re-assert media session priority on every state update,
  // not just the first start — this reclaims focus from Spotify/etc.
  // after Chrome may have auto-paused our audio.
  const audio = document.getElementById('silent-audio');
  if (navigator.mediaSession) {
    navigator.mediaSession.playbackState = 'playing';
  }
  if (audio.paused && mediaCapturing) {
    audio.play().catch(() => {});
  }

  if (mediaCapturing) return; // Already active
  mediaCapturing = true;

  if (!audio.src) {
    const blob = createSilentWavBlob();
    audio.src = URL.createObjectURL(blob);
  }
  audio.volume = 0.01; // Near-silent but enough to activate media session

  // Set Media Session metadata so user sees meaningful info in media overlay
  if (navigator.mediaSession) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'D365 Call Control',
      artist: 'Dynamics Audio Companion',
      album: 'Dynamics 365 Contact Center',
    });
  }

  audio.play().then(() => {
    console.log('[Offscreen] Media capture started — media keys now routed here');
    setupMediaSessionHandlers();
  }).catch(err => {
    console.warn('[Offscreen] Silent audio play failed:', err.message);
    mediaCapturing = false;
  });
}

/**
 * Stop capturing media keys — release back to other media apps.
 */
function stopMediaCapture() {
  if (!mediaCapturing) return;
  mediaCapturing = false;

  const audio = document.getElementById('silent-audio');
  audio.pause();

  // Release playback state so other apps reclaim media keys
  if (navigator.mediaSession) {
    navigator.mediaSession.playbackState = 'none';
  }

  // Clear handlers
  const actions = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'];
  for (const action of actions) {
    try { navigator.mediaSession.setActionHandler(action, null); } catch (_) {}
  }

  console.log('[Offscreen] Media capture stopped — media keys released');
}

/**
 * Register Media Session action handlers.
 * Maps headset AVRCP button → Windows media key → Media Session action → D365 call control.
 * Works with Bose, AirPods, AirPods Pro, and other AVRCP-compatible headsets.
 */
function setupMediaSessionHandlers() {
  if (!navigator.mediaSession) return;

  // Play/Pause → headset multi-function button (Bose) or stem press (AirPods)
  // Ringing: accept call. Active: toggle mute.
  navigator.mediaSession.setActionHandler('play', () => {
    console.log('[Offscreen] Media: play');
    if (mediaCallState === 'ringing') {
      sendMessage(MSG.MEDIA_KEY_ACTION, { action: 'acceptCall' });
    } else if (mediaCallState === 'active' || mediaCallState === 'hold') {
      mediaMuted = !mediaMuted;
      sendMessage(MSG.MEDIA_KEY_ACTION, { action: 'toggleMute' });
    }
    // Keep audio "playing" so we stay the active session
    keepAlive();
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    console.log('[Offscreen] Media: pause');
    if (mediaCallState === 'ringing') {
      sendMessage(MSG.MEDIA_KEY_ACTION, { action: 'acceptCall' });
    } else if (mediaCallState === 'active' || mediaCallState === 'hold') {
      mediaMuted = !mediaMuted;
      sendMessage(MSG.MEDIA_KEY_ACTION, { action: 'toggleMute' });
    }
    keepAlive();
  });

  // Stop → reject/end
  navigator.mediaSession.setActionHandler('stop', () => {
    console.log('[Offscreen] Media: stop');
    if (mediaCallState === 'ringing') {
      sendMessage(MSG.MEDIA_KEY_ACTION, { action: 'rejectCall' });
    } else if (mediaCallState === 'active' || mediaCallState === 'hold') {
      sendMessage(MSG.MEDIA_KEY_ACTION, { action: 'endCall' });
    }
    keepAlive();
  });

  // Next track → AirPods double-tap: accept (ringing) or end call (active)
  try {
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      console.log('[Offscreen] Media: nexttrack');
      if (mediaCallState === 'ringing') {
        sendMessage(MSG.MEDIA_KEY_ACTION, { action: 'acceptCall' });
      } else if (mediaCallState === 'active' || mediaCallState === 'hold') {
        sendMessage(MSG.MEDIA_KEY_ACTION, { action: 'endCall' });
      }
    });
  } catch (_) {}

  // Previous track → AirPods triple-tap: hold/resume
  try {
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      console.log('[Offscreen] Media: previoustrack');
      if (mediaCallState === 'active') {
        sendMessage(MSG.MEDIA_KEY_ACTION, { action: 'holdCall' });
      } else if (mediaCallState === 'hold') {
        sendMessage(MSG.MEDIA_KEY_ACTION, { action: 'resumeCall' });
      }
    });
  } catch (_) {}
}

/**
 * After a media session action fires, Chrome may pause our audio.
 * Re-play to stay the active media session.
 */
function keepAlive() {
  if (!mediaCapturing) return;
  const audio = document.getElementById('silent-audio');
  if (audio.paused) {
    audio.play().catch(() => {});
  }
  // Re-assert playing state after each action so we keep priority
  if (navigator.mediaSession) {
    navigator.mediaSession.playbackState = 'playing';
  }
}

// ── Init ──
console.log('[Offscreen] HID offscreen document loaded');
sendMessage(MSG.OFFSCREEN_READY, {});

// Don't auto-connect here — service worker will request it if needed
