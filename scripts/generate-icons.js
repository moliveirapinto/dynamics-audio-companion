/**
 * Icon generator — creates PNG icons from SVG for the extension.
 * Run: node scripts/generate-icons.js
 * 
 * If canvas/sharp is not available, this creates placeholder SVG files 
 * that can be used during development. For production, convert to PNG.
 */

const fs = require('fs');
const path = require('path');

const SIZES = [16, 48, 128];
const ICONS_DIR = path.join(__dirname, '..', 'icons');

// Create icons directory
if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

// SVG template — headphone icon with Dynamics purple-teal gradient
function createSvg(size) {
  const strokeW = size <= 16 ? 8 : (size <= 48 ? 6 : 5);
  const extra = size >= 128 ? `
  <!-- Sound wave arcs -->
  <g transform="translate(24,20)" fill="none" stroke="white" stroke-linecap="round">
    <path d="M68 50 C72 54 72 62 68 66" stroke-width="3" opacity="0.6"/>
    <path d="M74 46 C80 52 80 64 74 70" stroke-width="3" opacity="0.4"/>
  </g>
  <text x="64" y="112" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="600" fill="white" opacity="0.7">D365</text>` : '';
  const headTransform = size <= 16 ? 'translate(20,22)' : 'translate(24,24)';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg${size}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6B2FA0"/>
      <stop offset="100%" stop-color="#2D7D9A"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="24" fill="url(#bg${size})"/>
  <g transform="${headTransform}" fill="none" stroke="white" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 56 C14 56 14 26 44 14 C56 8 68 8 80 14 C98 22 98 56 98 56" fill="none"/>
    <rect x="4" y="50" width="20" height="30" rx="8" fill="white" stroke="none"/>
    <rect x="84" y="50" width="20" height="30" rx="8" fill="white" stroke="none"/>
  </g>${extra}
</svg>`;
}

// Write SVG icons (will be displayed correctly in Chrome/Edge)
for (const size of SIZES) {
  const svg = createSvg(size);
  const filePath = path.join(ICONS_DIR, `icon${size}.svg`);
  fs.writeFileSync(filePath, svg);
  console.log(`Created: ${filePath}`);
}

// For Manifest V3, icons must be PNG. Create a simple conversion note.
console.log('\nNote: Manifest V3 requires PNG icons.');
console.log('For development, we use SVG. For production, convert with:');
console.log('  npx svgexport icons/icon128.svg icons/icon128.png 128:128');
console.log('\nGenerating basic PNG placeholders...');

// Create minimal valid PNG files (1x1 red pixel, just for manifest loading)
// These are tiny valid PNGs so the extension loads without errors.
function createMinimalPng() {
  // Minimal valid 1x1 red PNG
  return Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
    0x44, 0xAE, 0x42, 0x60, 0x82,
  ]);
}

for (const size of SIZES) {
  const pngPath = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(pngPath, createMinimalPng());
  console.log(`Created placeholder: ${pngPath}`);
}

console.log('\nDone! Icons created in /icons/');
