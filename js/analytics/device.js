// Device information for analytics. Only what the spec lists: model, OS,
// browser, camera resolution, screen resolution. No fingerprinting extras.

function parseUA(ua) {
  const out = { device_model: 'Unknown', os: 'Unknown', os_version: '', browser: 'Unknown', browser_version: '' };
  let m;
  if ((m = ua.match(/Android (\d+(?:\.\d+)*)/))) {
    out.os = 'Android'; out.os_version = m[1];
    if ((m = ua.match(/Android [^;]+; ([^;)]+?)(?: Build|\))/))) out.device_model = m[1].trim();
  } else if ((m = ua.match(/(iPhone|iPad|iPod).*? OS (\d+(?:_\d+)*)/))) {
    out.os = 'iOS'; out.os_version = m[2].replace(/_/g, '.'); out.device_model = m[1];
  } else if (/Windows NT/.test(ua)) { out.os = 'Windows'; out.os_version = (ua.match(/Windows NT ([\d.]+)/) || [])[1] || ''; out.device_model = 'Desktop'; }
  else if (/Mac OS X/.test(ua)) { out.os = 'macOS'; out.os_version = ((ua.match(/Mac OS X ([\d_]+)/) || [])[1] || '').replace(/_/g, '.'); out.device_model = 'Desktop'; }
  else if (/Linux/.test(ua)) { out.os = 'Linux'; out.device_model = 'Desktop'; }

  if ((m = ua.match(/Edg\w*\/([\d.]+)/))) { out.browser = 'Edge'; out.browser_version = m[1]; }
  else if ((m = ua.match(/SamsungBrowser\/([\d.]+)/))) { out.browser = 'Samsung Internet'; out.browser_version = m[1]; }
  else if ((m = ua.match(/(?:CriOS|Chrome)\/([\d.]+)/))) { out.browser = 'Chrome'; out.browser_version = m[1]; }
  else if ((m = ua.match(/(?:FxiOS|Firefox)\/([\d.]+)/))) { out.browser = 'Firefox'; out.browser_version = m[1]; }
  else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) { out.browser = 'Safari'; out.browser_version = m[1]; }
  return out;
}

export async function collectDevice(cameraInfo) {
  const info = parseUA(navigator.userAgent);
  // Chrome on Android freezes the model in the UA string; ask for it properly.
  try {
    const hi = await navigator.userAgentData?.getHighEntropyValues?.(['model', 'platformVersion']);
    if (hi?.model) info.device_model = hi.model;
    if (hi?.platformVersion && info.os === 'Android') info.os_version = hi.platformVersion;
  } catch { /* not available */ }
  const dpr = window.devicePixelRatio || 1;
  info.screen_resolution = `${Math.round(screen.width * dpr)}x${Math.round(screen.height * dpr)}`;
  info.camera_resolution = cameraInfo ? `${cameraInfo.width}x${cameraInfo.height}` : null;
  info.performance_class = 'STANDARD';
  return info;
}

/**
 * LIMITED is recorded for analytics only; it never blocks scanning.
 * @param avgOcrMs measured OCR time on this device
 */
export function performanceClass(cameraInfo, avgOcrMs) {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4;
  const lowCam = cameraInfo && Math.max(cameraInfo.width, cameraInfo.height) < 1280;
  return cores <= 4 && mem <= 2 || lowCam || avgOcrMs > 900 ? 'LIMITED' : 'STANDARD';
}
