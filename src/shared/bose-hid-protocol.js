/**
 * HID Protocol Constants & Parser
 * 
 * Handles USB HID Telephony Usage Page (0x0B) for professional headsets.
 * Supports Bose, Jabra, Poly/Plantronics, and Yealink UC headsets and USB dongles.
 */

// ── Vendor IDs ──
export const BOSE_VENDOR_ID = 0x05A7;
export const JABRA_VENDOR_ID = 0x0B0E;        // GN Audio / Jabra
export const POLY_VENDOR_ID = 0x047F;         // Plantronics / Poly
export const YEALINK_VENDOR_ID = 0x3F0E;      // Yealink

export const SUPPORTED_VENDOR_IDS = new Set([
  BOSE_VENDOR_ID,
  JABRA_VENDOR_ID,
  POLY_VENDOR_ID,
  YEALINK_VENDOR_ID,
]);

/** Check if a vendorId belongs to a supported headset brand. */
export function isSupportedVendor(vendorId) {
  return SUPPORTED_VENDOR_IDS.has(vendorId);
}

// ── Known product IDs by vendor ──
export const BOSE_PRODUCT_IDS = {
  BOSE_700_UC:       0x40FE,
  BOSE_700_UC_ALT:   0x40FF,
  BOSE_USB_LINK:     0x40FC,
  BOSE_QC45_UC:      0x4103,
  BOSE_QC_ULTRA_UC:  0x4109,
  BOSE_QC_ULTRA_ALT: 0x410A,
  BOSE_USB_LINK_2:   0x4108,
};

export const JABRA_PRODUCT_IDS = {
  JABRA_EVOLVE2_85:  0x0A45,
  JABRA_EVOLVE2_75:  0x0A72,
  JABRA_EVOLVE2_65:  0x0A52,
  JABRA_EVOLVE2_55:  0x0B14,
  JABRA_EVOLVE2_40:  0x0A4D,
  JABRA_EVOLVE2_30:  0x0A88,
  JABRA_ENGAGE_50:   0x0A46,
  JABRA_ENGAGE_50_II:0x0B0F,
  JABRA_LINK_380:    0x0A51,
  JABRA_LINK_400:    0x0B01,
  JABRA_BIZ_2400_II: 0x0444,
};

export const POLY_PRODUCT_IDS = {
  POLY_VOYAGER_FOCUS2: 0xC056,
  POLY_VOYAGER_4320:   0xC053,
  POLY_VOYAGER_4310:   0xC054,
  POLY_BLACKWIRE_5220: 0xC033,
  POLY_BLACKWIRE_3320: 0xC03A,
  POLY_SAVI_8200:      0xC04A,
  POLY_BT700:          0xC058,
  POLY_BT600:          0xC039,
  POLY_CALISTO_5300:   0xC052,
  POLY_ENCORE_PRO_HW:  0x0126,
};

export const YEALINK_PRODUCT_IDS = {
  YEALINK_BH72:      0x0010,
  YEALINK_BH76:      0x0012,
  YEALINK_BH71:      0x000E,
  YEALINK_UH34:      0x0008,
  YEALINK_UH36:      0x0006,
  YEALINK_UH37:      0x000A,
  YEALINK_WH62:      0x0004,
  YEALINK_WH66:      0x0002,
  YEALINK_BHT60:     0x0014,  // BT dongle
};

// HID Usage Pages
export const USAGE_PAGE = {
  TELEPHONY: 0x000B,
  CONSUMER:  0x000C,
  LED:       0x0008,
};

// Telephony Usage Page (0x0B) — Input usages
export const TELEPHONY_USAGE = {
  PHONE:      0x01,
  HEADSET:    0x05,
  HOOK_SWITCH:0x20,
  FLASH:      0x21,
  REDIAL:     0x24,
  DROP:       0x26,
  PHONE_MUTE: 0x2F,
};

// LED Usage Page (0x08) — Output usages (host → headset)
export const LED_USAGE = {
  MUTE:     0x09,
  OFF_HOOK: 0x17,
  RING:     0x18,
  HOLD:     0x21,
};

// Consumer Usage Page (0x0C)
export const CONSUMER_USAGE = {
  VOLUME_UP:   0xE9,
  VOLUME_DOWN: 0xEA,
  MUTE:        0xE2,
};

/**
 * Standard telephony input report bit positions.
 * Bose UC headsets typically use this layout (may vary by model/firmware).
 * The parser auto-detects from HID report descriptors when possible.
 */
const DEFAULT_INPUT_BITS = {
  hookSwitch: 0, // Bit 0
  phoneMute:  1, // Bit 1
  flash:      2, // Bit 2
  drop:       3, // Bit 3
  redial:     4, // Bit 4
};

const DEFAULT_OUTPUT_BITS = {
  offHook: 0, // Bit 0
  ring:    1, // Bit 1
  mute:    2, // Bit 2
  hold:    3, // Bit 3
};

/**
 * Parses a telephony input report from a Bose headset.
 * @param {DataView} data - HID input report data (excludes report ID byte)
 * @param {object} [bitMap] - Custom bit mapping override
 * @returns {object} Parsed button states
 */
export function parseTelephonyInput(data, bitMap = DEFAULT_INPUT_BITS) {
  if (!data || data.byteLength === 0) return null;
  const byte0 = data.getUint8(0);
  return {
    hookSwitch: !!(byte0 & (1 << bitMap.hookSwitch)),
    phoneMute:  !!(byte0 & (1 << bitMap.phoneMute)),
    flash:      !!(byte0 & (1 << bitMap.flash)),
    drop:       !!(byte0 & (1 << bitMap.drop)),
    redial:     !!(byte0 & (1 << bitMap.redial)),
    raw: byte0,
  };
}

/**
 * Parses a consumer control input report.
 * @param {DataView} data - HID input report data
 * @returns {object} Parsed consumer controls
 */
export function parseConsumerInput(data) {
  if (!data || data.byteLength === 0) return null;
  const byte0 = data.getUint8(0);
  return {
    volumeUp:   !!(byte0 & 0x01),
    volumeDown: !!(byte0 & 0x02),
    mute:       !!(byte0 & 0x04),
    raw: byte0,
  };
}

/**
 * Builds an output report buffer to send LED states to the headset.
 * @param {object} state - LED states to set
 * @param {boolean} [state.offHook=false] - Call-active LED
 * @param {boolean} [state.ring=false]    - Incoming-call ring indicator
 * @param {boolean} [state.mute=false]    - Mute LED
 * @param {boolean} [state.hold=false]    - Hold LED
 * @param {object} [bitMap] - Custom bit mapping override
 * @returns {Uint8Array} Output report buffer
 */
export function buildOutputReport(state, bitMap = DEFAULT_OUTPUT_BITS) {
  let byte0 = 0;
  if (state.offHook) byte0 |= (1 << bitMap.offHook);
  if (state.ring)    byte0 |= (1 << bitMap.ring);
  if (state.mute)    byte0 |= (1 << bitMap.mute);
  if (state.hold)    byte0 |= (1 << bitMap.hold);
  return new Uint8Array([byte0]);
}

/**
 * Determines the telephony collection and report IDs from an HIDDevice's collections.
 * @param {HIDDevice} device - WebHID device object
 * @returns {object|null} { telephonyCollection, telephonyReportId, consumerCollection, consumerReportId }
 */
export function analyzeDeviceCollections(device) {
  let telephony = null;
  let consumer = null;

  for (const col of device.collections) {
    if (col.usagePage === USAGE_PAGE.TELEPHONY &&
        (col.usage === TELEPHONY_USAGE.HEADSET || col.usage === TELEPHONY_USAGE.PHONE)) {
      telephony = col;
    }
    if (col.usagePage === USAGE_PAGE.CONSUMER) {
      consumer = col;
    }
  }

  const result = { telephony: null, consumer: null };

  if (telephony) {
    result.telephony = {
      collection: telephony,
      inputReportId:  telephony.inputReports?.[0]?.reportId ?? 0,
      outputReportId: telephony.outputReports?.[0]?.reportId ?? 0,
    };
  }
  if (consumer) {
    result.consumer = {
      collection: consumer,
      inputReportId: consumer.inputReports?.[0]?.reportId ?? 0,
    };
  }

  return result;
}

/**
 * WebHID device filters for supported telephony headsets.
 * Includes Bose, Jabra, and Poly/Plantronics.
 */
function vendorFilters(vendorId) {
  return [
    { vendorId, usagePage: USAGE_PAGE.TELEPHONY, usage: TELEPHONY_USAGE.HEADSET },
    { vendorId, usagePage: USAGE_PAGE.TELEPHONY, usage: TELEPHONY_USAGE.PHONE },
    { vendorId }, // Broad fallback for firmware variants
  ];
}

export const HID_FILTERS = [
  ...vendorFilters(BOSE_VENDOR_ID),
  ...vendorFilters(JABRA_VENDOR_ID),
  ...vendorFilters(POLY_VENDOR_ID),
  ...vendorFilters(YEALINK_VENDOR_ID),
];

// Backward-compat alias
export const BOSE_HID_FILTERS = HID_FILTERS;

const VENDOR_NAMES = {
  [BOSE_VENDOR_ID]: 'Bose',
  [JABRA_VENDOR_ID]: 'Jabra',
  [POLY_VENDOR_ID]: 'Poly',
  [YEALINK_VENDOR_ID]: 'Yealink',
};

const VENDOR_PRODUCT_MAPS = {
  [BOSE_VENDOR_ID]: BOSE_PRODUCT_IDS,
  [JABRA_VENDOR_ID]: JABRA_PRODUCT_IDS,
  [POLY_VENDOR_ID]: POLY_PRODUCT_IDS,
  [YEALINK_VENDOR_ID]: YEALINK_PRODUCT_IDS,
};

// ── Friendly display names ──
const FRIENDLY_NAMES = {
  // Bose
  BOSE_700_UC:       'Bose 700 UC',
  BOSE_700_UC_ALT:   'Bose 700 UC',
  BOSE_USB_LINK:     'Bose USB Link',
  BOSE_QC45_UC:      'Bose QC45 UC',
  BOSE_QC_ULTRA_UC:  'Bose QC Ultra UC',
  BOSE_QC_ULTRA_ALT: 'Bose QC Ultra UC',
  BOSE_USB_LINK_2:   'Bose USB Link 2',
  // Jabra
  JABRA_EVOLVE2_85:  'Jabra Evolve2 85',
  JABRA_EVOLVE2_75:  'Jabra Evolve2 75',
  JABRA_EVOLVE2_65:  'Jabra Evolve2 65',
  JABRA_EVOLVE2_55:  'Jabra Evolve2 55',
  JABRA_EVOLVE2_40:  'Jabra Evolve2 40',
  JABRA_EVOLVE2_30:  'Jabra Evolve2 30',
  JABRA_ENGAGE_50:   'Jabra Engage 50',
  JABRA_ENGAGE_50_II:'Jabra Engage 50 II',
  JABRA_LINK_380:    'Jabra Link 380',
  JABRA_LINK_400:    'Jabra Link 400',
  JABRA_BIZ_2400_II: 'Jabra BIZ 2400 II',
  // Poly
  POLY_VOYAGER_FOCUS2: 'Poly Voyager Focus 2',
  POLY_VOYAGER_4320:   'Poly Voyager 4320',
  POLY_VOYAGER_4310:   'Poly Voyager 4310',
  POLY_BLACKWIRE_5220: 'Poly Blackwire 5220',
  POLY_BLACKWIRE_3320: 'Poly Blackwire 3320',
  POLY_SAVI_8200:      'Poly Savi 8200',
  POLY_BT700:          'Poly BT700 Dongle',
  POLY_BT600:          'Poly BT600 Dongle',
  POLY_CALISTO_5300:   'Poly Calisto 5300',
  POLY_ENCORE_PRO_HW:  'Poly EncorePro HW',
  // Yealink
  YEALINK_BH72:      'Yealink BH72',
  YEALINK_BH76:      'Yealink BH76',
  YEALINK_BH71:      'Yealink BH71',
  YEALINK_UH34:      'Yealink UH34',
  YEALINK_UH36:      'Yealink UH36',
  YEALINK_UH37:      'Yealink UH37',
  YEALINK_WH62:      'Yealink WH62',
  YEALINK_WH66:      'Yealink WH66',
  YEALINK_BHT60:     'Yealink BHT60 Dongle',
};

/**
 * Returns a user-friendly display name for a model identifier.
 * @param {string} modelId - Internal model ID (e.g. 'JABRA_EVOLVE2_65')
 * @returns {string} Friendly name or the modelId as fallback
 */
export function getFriendlyName(modelId) {
  return FRIENDLY_NAMES[modelId] || modelId;
}

// ── Vendor quirks ──
// Bose headsets use stateful HID: bit stays on/off to reflect actual state.
// Jabra & Poly use momentary HID: bit pulses true→false for each button press.
const VENDOR_QUIRKS = {
  [BOSE_VENDOR_ID]: {
    hookSwitch: 'stateful',   // Bit reflects off-hook/on-hook state
    phoneMute:  'stateful',   // Bit reflects current mute on/off
  },
  [JABRA_VENDOR_ID]: {
    hookSwitch: 'momentary',  // Pulse per press — rising edge = toggle
    phoneMute:  'momentary',  // Pulse per press — rising edge = toggle
  },
  [POLY_VENDOR_ID]: {
    hookSwitch: 'momentary',
    phoneMute:  'momentary',
  },
  [YEALINK_VENDOR_ID]: {
    hookSwitch: 'momentary',
    phoneMute:  'momentary',
  },
};

/**
 * Returns vendor-specific button behavior quirks.
 * @param {number} vendorId
 * @returns {{ hookSwitch: 'stateful'|'momentary', phoneMute: 'stateful'|'momentary' }}
 */
export function getVendorQuirks(vendorId) {
  return VENDOR_QUIRKS[vendorId] || VENDOR_QUIRKS[BOSE_VENDOR_ID];
}

/**
 * Identifies the model name of a supported HID device.
 * Works for Bose, Jabra, and Poly/Plantronics.
 * @param {HIDDevice} device
 * @returns {string|null} Model name or null
 */
export function identifyDeviceModel(device) {
  const vid = device.vendorId;
  const pid = device.productId;
  const productMap = VENDOR_PRODUCT_MAPS[vid];
  if (productMap) {
    for (const [model, id] of Object.entries(productMap)) {
      if (id === pid) return model;
    }
    const brand = VENDOR_NAMES[vid] || 'Unknown';
    return `${brand}_0x${pid.toString(16).toUpperCase()}`;
  }
  return null;
}

// Backward-compat alias
export function identifyBoseModel(device) {
  return identifyDeviceModel(device);
}
