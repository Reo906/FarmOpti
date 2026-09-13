/**
 * Framework-independent push-to-talk adapter for the FarmOpti Voice API.
 */
export class FarmOptiVoiceClient {
  constructor({ baseUrl = '', onState = () => {}, onTurn = () => {} } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.onState = onState;
    this.onTurn = onTurn;
    this.sessionId = null;
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error('This browser does not support microphone recording.');
    }
    this.onState('requesting_microphone');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const preferred = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
      .find((type) => MediaRecorder.isTypeSupported(type));
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, preferred ? { mimeType: preferred } : undefined);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    this.recorder.start(250);
    this.onState('listening');
  }

  async stopAndSend({ speak = true } = {}) {
    if (!this.recorder || this.recorder.state !== 'recording') {
      throw new Error('No recording is in progress.');
    }
    const recorder = this.recorder;
    const blob = await new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }));
      recorder.stop();
    });
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.onState('transcribing');

    const form = new FormData();
    const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
    form.append('file', blob, 'farmopti-turn.' + extension);
    const transcriptResponse = await fetch(this.baseUrl + '/api/voice/transcribe', {
      method: 'POST',
      body: form,
    });
    const transcript = await this.#jsonOrError(transcriptResponse);

    return this.sendText(transcript.text, { speak, transcript });
  }

  async sendText(text, { speak = true, transcript = null } = {}) {
    this.onState('evaluating');
    const response = await fetch(this.baseUrl + '/api/voice/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, session_id: this.sessionId }),
    });
    const result = await this.#jsonOrError(response);
    this.sessionId = result.session_id;
    const turn = {
      ...result,
      transcript: transcript || { text, language_code: null, provider_request_id: null },
    };
    this.onTurn(turn);

    if (speak) {
      this.onState('speaking');
      const speechResponse = await fetch(this.baseUrl + '/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: result.reply.answer }),
      });
      if (!speechResponse.ok) await this.#jsonOrError(speechResponse);
      const url = URL.createObjectURL(await speechResponse.blob());
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); this.onState('idle'); };
      audio.onerror = () => { URL.revokeObjectURL(url); this.onState('error'); };
      await audio.play();
    } else {
      this.onState('idle');
    }
    return turn;
  }

  async #jsonOrError(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      this.onState('error');
      throw new Error(payload.detail || 'Voice request failed (' + response.status + ').');
    }
    return payload;
  }

  cancel() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.chunks = [];
    this.onState('idle');
  }
}
