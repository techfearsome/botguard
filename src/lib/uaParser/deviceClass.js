/**
 * uaParser/deviceClass.js — Map parsed UA to device classes for page routing.
 *
 * Classes: 'iphone', 'android', 'windows', 'mac', 'linux', 'other'
 *
 * Handles both v1 and v2 output differences:
 *   v1: os.name = "Mac OS"      → v2: os.name = "macOS"
 *   v1: os.name = "Chromium OS" → v2: os.name = "Chrome OS"
 */

'use strict';

function classifyDeviceClass(uaResult) {
  if (!uaResult) return 'other';

  const osName = String(uaResult.os?.name || '').toLowerCase();
  const deviceType = uaResult.device?.type;
  const deviceModel = uaResult.device?.model;

  // iOS family
  if (osName === 'ios') {
    if (deviceModel === 'iPad' || deviceType === 'tablet') return 'other';
    return 'iphone';
  }

  // Android (phone or tablet — both go to 'android')
  if (osName === 'android') return 'android';

  // Desktop OS detection (handles both v1 and v2 naming)
  if (osName.includes('windows')) return 'windows';
  if (osName.includes('mac') || osName === 'macos') return 'mac';

  // Chrome OS / Chromium OS → linux
  if (osName === 'chromium os' || osName === 'chrome os') return 'linux';
  if (osName.includes('linux') || osName.includes('ubuntu') || osName.includes('fedora') ||
      osName.includes('debian') || osName.includes('arch')) return 'linux';

  return 'other';
}

function classifyDevice(uaResult) {
  const deviceType = uaResult?.device?.type;
  if (deviceType === 'mobile' || deviceType === 'tablet') return deviceType;
  return 'desktop';
}

function deviceLabel(uaResult) {
  if (!uaResult) return 'Unknown';
  const osName = (uaResult.os?.name || '').toLowerCase();
  const deviceType = uaResult.device?.type;
  const deviceVendor = uaResult.device?.vendor;
  const deviceModel = uaResult.device?.model;

  if (osName === 'ios') {
    if (deviceModel === 'iPad' || deviceType === 'tablet') return 'iPad';
    return 'iPhone';
  }
  if (osName === 'android') {
    if (deviceType === 'tablet') return 'Android tablet';
    return 'Android phone';
  }
  if (deviceType === 'mobile') return `${deviceVendor || 'Mobile'}`;
  if (deviceType === 'tablet') return `${deviceVendor || 'Tablet'}`;
  if (deviceType === 'smarttv') return 'Smart TV';
  if (deviceType === 'wearable') return 'Wearable';

  if (osName.includes('windows')) return 'Windows';
  if (osName.includes('mac') || osName === 'macos') return 'Mac';
  if (osName === 'chromium os' || osName === 'chrome os') return 'Chromebook';
  if (osName.includes('linux')) return 'Linux';

  return 'desktop';
}

const ALL_DEVICE_CLASSES = ['iphone', 'android', 'windows', 'mac', 'linux', 'other'];

module.exports = { classifyDeviceClass, classifyDevice, deviceLabel, ALL_DEVICE_CLASSES };
