/**
 * Map a parsed UA result (from ua-parser-js) to one of 6 device classes used by
 * per-device page routing.
 *
 * Classes:
 *   - 'iphone'   any iOS phone (or any device with osName='iOS' that isn't an iPad)
 *   - 'android'  any Android phone or tablet
 *   - 'windows'  Windows desktop or laptop
 *   - 'mac'      macOS
 *   - 'linux'    Linux desktop (incl. Chromebook)
 *   - 'other'    everything else (iPad, smart TVs, embedded, BSD, unknown)
 *
 * Note: iPad is intentionally 'other' rather than 'iphone' because mobile-app campaigns
 * usually want to differentiate iOS phone (deep link to App Store iPhone listing) from iPad.
 * Clients can map iPad to iPhone in their campaign config if they prefer.
 */

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

  // Android (phone or tablet - both go to 'android')
  if (osName === 'android') return 'android';

  // Desktop OS detection
  if (osName.includes('windows')) return 'windows';
  if (osName.includes('mac')) return 'mac';

  // Chromebook is Linux-flavored - bucket with linux
  if (osName === 'chromium os' || osName === 'chrome os') return 'linux';
  if (osName.includes('linux') || osName.includes('ubuntu') || osName.includes('fedora') ||
      osName.includes('debian') || osName.includes('arch')) return 'linux';

  return 'other';
}

const ALL_DEVICE_CLASSES = ['iphone', 'android', 'windows', 'mac', 'linux', 'other'];

module.exports = { classifyDeviceClass, ALL_DEVICE_CLASSES };
