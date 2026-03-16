/**
 * Popup UI Controller
 * Manages the extension popup interface — device status, call state, connect/disconnect.
 */

import { MSG, SOURCE } from '../shared/messages.js';

// ── DOM refs ──
const deviceDot     = document.getElementById('device-dot');
const deviceLabel   = document.getElementById('device-label');
const deviceInfo    = document.getElementById('device-info');
const btnConnect    = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const d365Dot       = document.getElementById('d365-dot');
const d365Info      = document.getElementById('d365-info');
const callDot       = document.getElementById('call-dot');
const callState     = document.getElementById('call-state');
const muteState     = document.getElementById('mute-state');
const btnTest       = document.getElementById('btn-test');

const btHint          = document.getElementById('bt-hint');
const connectingStatus = document.getElementById('connecting-status');
const connectingStep   = document.getElementById('connecting-step');
const connectingTip    = document.getElementById('connecting-tip');
const progressFill     = document.getElementById('progress-fill');

let isConnecting = false; // Track connecting state so updateUI doesn't reset it
let connectStartTime = 0;
let connectStepInterval = null;

// ── Connection progress phases ──
const CONNECT_PHASES = [
  { at: 0,  pct: 10,  text: 'Starting native host...' },
  { at: 2,  pct: 25,  text: 'Searching for headset...' },
  { at: 5,  pct: 45,  text: 'Waiting for Bluetooth pairing...',
    tip: '💡 Make sure your headset is powered on and in range.' },
  { at: 8,  pct: 60,  text: 'Still connecting — hang tight...',
    tip: '💡 Some headsets take up to 15 seconds on first connection.' },
  { at: 12, pct: 80,  text: 'Almost there...',
    tip: '💡 If it doesn\'t connect, try turning the headset off and on.' },
];

function startConnectProgress() {
  connectStartTime = Date.now();
  connectingStatus.classList.remove('hidden');
  connectingTip.classList.add('hidden');
  progressFill.style.width = '5%';
  connectingStep.textContent = 'Starting connection...';

  connectStepInterval = setInterval(() => {
    const elapsed = (Date.now() - connectStartTime) / 1000;
    // Find the latest applicable phase
    let phase = CONNECT_PHASES[0];
    for (const p of CONNECT_PHASES) {
      if (elapsed >= p.at) phase = p;
    }
    progressFill.style.width = phase.pct + '%';
    const secs = Math.floor(elapsed);
    connectingStep.textContent = `${phase.text} (${secs}s)`;
    if (phase.tip) {
      connectingTip.textContent = phase.tip;
      connectingTip.classList.remove('hidden');
    }
  }, 500);
}

function stopConnectProgress() {
  if (connectStepInterval) {
    clearInterval(connectStepInterval);
    connectStepInterval = null;
  }
  connectingStatus.classList.add('hidden');
  connectingTip.classList.add('hidden');
  progressFill.style.width = '0%';
}

// ── Connect button handler ──

btnConnect.addEventListener('click', async () => {
  try {
    // Show connecting state immediately
    isConnecting = true;
    btnConnect.textContent = 'Connecting...';
    btnConnect.disabled = true;
    deviceDot.className = 'dot connecting';
    deviceInfo.textContent = 'Connecting to headset...';
    startConnectProgress();
    btHint.classList.add('hidden');

    // Trigger native host connection for Bluetooth
    chrome.runtime.sendMessage({
      source: SOURCE.POPUP,
      type: MSG.NATIVE_HOST_CONNECT,
    });

    // Also tell offscreen to try USB auto-connect (no picker dialog)
    chrome.runtime.sendMessage({
      source: SOURCE.POPUP,
      type: MSG.HID_REQUEST_CONNECT,
    });

    // Poll status until connected or timeout (15s)
    let attempts = 0;
    const pollInterval = setInterval(() => {
      attempts++;
      refreshStatus();
      if (attempts >= 30) {
        clearInterval(pollInterval);
        isConnecting = false;
        stopConnectProgress();
        refreshStatus(); // Final refresh to show real state
      }
    }, 500);

  } catch (err) {
    console.error('Connect error:', err);
    isConnecting = false;
    stopConnectProgress();
    deviceInfo.textContent = `Error: ${err.message}`;
    btnConnect.textContent = 'Connect Headset';
    btnConnect.disabled = false;
    deviceDot.className = 'dot';
  }
});

btnDisconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({
    source: SOURCE.POPUP,
    type: MSG.HID_REQUEST_DISCONNECT,
  });
  setTimeout(refreshStatus, 500);
});

btnTest.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('src/test/test-page.html') });
});

// ── Status updates ──

function updateUI(status) {
  // Device — show connected status for USB or Bluetooth
  if (status.device) {
    // Connected! Clear connecting state
    isConnecting = false;
    stopConnectProgress();
    deviceDot.className = 'dot connected';
    deviceLabel.textContent = 'Headset';
    const mode = status.connectionMode === 'media-session' ? ' [BT Media]' :
                 status.connectionMode === 'bluetooth' ? ' [BT]' :
                 status.connectionMode === 'usb' ? ' [USB]' : '';
    deviceInfo.textContent = `${status.device.friendlyName || status.device.productName || status.device.model}${mode}`;
    btnConnect.classList.add('hidden');
    btnDisconnect.classList.remove('hidden');
    btHint.classList.add('hidden');
  } else if (isConnecting) {
    // Still waiting for connection — keep the connecting animation
    deviceDot.className = 'dot connecting';
    deviceInfo.textContent = 'Connecting to headset...';
    btnConnect.textContent = 'Connecting...';
    btnConnect.disabled = true;
    btHint.classList.add('hidden');
  } else {
    deviceDot.className = 'dot';
    deviceLabel.textContent = 'Headset';
    if (status.lastDeviceError) {
      deviceInfo.textContent = status.lastDeviceError;
    } else if (status.nativeHostConnected) {
      deviceInfo.textContent = 'Native host connected — waiting for BT headset';
    } else {
      deviceInfo.textContent = 'Not connected';
    }
    btnConnect.classList.remove('hidden');
    btnConnect.textContent = 'Connect Headset';
    btnConnect.disabled = false;
    btnDisconnect.classList.add('hidden');
    btHint.classList.remove('hidden');
  }

  // D365 — show more helpful info
  if (status.d365Connected) {
    d365Dot.className = 'dot connected';
    d365Info.textContent = 'Connected to D365 tab';
  } else {
    d365Dot.className = 'dot';
    d365Info.textContent = 'No D365 tab detected — open Dynamics 365 in a tab';
  }

  // Call state
  callState.textContent = status.callState || 'Idle';
  callState.className = `call-state ${status.callState || ''}`;

  switch (status.callState) {
    case 'ringing':
      callDot.className = 'dot ringing';
      break;
    case 'active':
      callDot.className = 'dot active';
      break;
    case 'hold':
      callDot.className = 'dot hold';
      break;
    default:
      callDot.className = 'dot';
  }

  // Mute
  if (status.muted) {
    muteState.classList.remove('hidden');
  } else {
    muteState.classList.add('hidden');
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage(
    { source: SOURCE.POPUP, type: MSG.GET_STATUS },
    (response) => {
      if (response) updateUI(response);
    }
  );
}

// Listen for live status broadcasts
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === MSG.STATUS_UPDATE) {
    updateUI(message.payload);
  }
});

// Initial load
refreshStatus();
document.getElementById('version-text').textContent = 'v' + chrome.runtime.getManifest().version;
