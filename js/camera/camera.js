// Camera access. Rear camera only; resolution is negotiated automatically and
// staff never configure anything.

export class CameraError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const WANT = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };

export class Camera {
  constructor(video) { this.video = video; this.stream = null; this.info = null; }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('UNSUPPORTED', 'This browser cannot open the camera. Use Chrome or Safari over HTTPS.');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, ...WANT } });
    } catch (e) {
      if (e.name === 'NotAllowedError') throw new CameraError('DENIED', 'Camera permission was refused. Allow camera access in the browser settings, then reopen the scanner.');
      if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') throw new CameraError('NOT_FOUND', 'No camera was found on this device.');
      if (e.name === 'NotReadableError') throw new CameraError('BUSY', 'The camera is in use by another app. Close it and try again.');
      throw new CameraError('FAILED', `Camera could not start (${e.name}).`);
    }

    // The front camera is not supported. If the browser handed us one, look
    // for a rear camera by label before giving up.
    let track = stream.getVideoTracks()[0];
    if (track.getSettings().facingMode === 'user') {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const rear = devices.find((d) => /back|rear|environment/i.test(d.label));
      stream.getTracks().forEach((t) => t.stop());
      if (!rear) throw new CameraError('REAR_REQUIRED', 'A rear camera is required. This device only offered the front camera.');
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: rear.deviceId }, ...WANT } });
      track = stream.getVideoTracks()[0];
    }

    // Continuous autofocus where the device lets us ask for it.
    try {
      const caps = track.getCapabilities?.() || {};
      if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch { /* best effort */ }

    this.stream = stream;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    const s = track.getSettings();
    this.info = { width: s.width || this.video.videoWidth, height: s.height || this.video.videoHeight,
      frameRate: s.frameRate || null, facingMode: s.facingMode || null };
    return this.info;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }
}
