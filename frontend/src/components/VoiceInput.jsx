import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, Mic2, MicOff, Square } from "lucide-react";
import { getSessionId, postQuery, postVoiceQuery } from "../services/api";

const LOW_SIGNAL_TRANSCRIPTS = new Set(["you", "uh", "um", "umm", "hmm", "hm"]);

function cleanTranscript(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isLowSignalTranscript(value) {
  const normalized = cleanTranscript(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return !normalized || LOW_SIGNAL_TRANSCRIPTS.has(normalized);
}

export default function VoiceInput({ onResult, compact = false }) {
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("Microphone is off");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [serverFallbackAvailable, setServerFallbackAvailable] = useState(false);
  const [microphones, setMicrophones] = useState([]);
  const [selectedMicrophone, setSelectedMicrophone] = useState("");
  const [inputLevel, setInputLevel] = useState(0);
  const [meterAvailable, setMeterAvailable] = useState(false);
  const recorderRef = useRef(null);
  const recognitionRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const meterFrameRef = useRef(null);
  const timeoutRef = useRef(null);
  const mountedRef = useRef(true);
  const audioSignalRef = useRef(false);

  const browserSpeechAvailable =
    typeof window !== "undefined" &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  const refreshMicrophones = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices?.();
      if (!mountedRef.current || !devices) return;
      setMicrophones(
        devices
          .filter((device) => device.kind === "audioinput" && device.deviceId)
          .map((device, index) => ({
            id: device.deviceId,
            label: device.label || "Microphone " + (index + 1),
          })),
      );
    } catch {
      // Microphone device names are optional; recording can still use the system default.
    }
  }, []);

  const stopMicrophoneMonitor = useCallback(() => {
    if (meterFrameRef.current !== null) {
      window.cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }
    analyserRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => {});
    }
  }, []);

  const releaseMicrophone = useCallback(() => {
    stopMicrophoneMonitor();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (mountedRef.current) setInputLevel(0);
  }, [stopMicrophoneMonitor]);

  const monitorMicrophone = (stream) => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      setMeterAvailable(false);
      return;
    }
    try {
      const context = new AudioContextClass();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      audioContextRef.current = context;
      analyserRef.current = analyser;
      const samples = new Uint8Array(analyser.fftSize);
      let lastUpdate = 0;
      const sampleMicrophone = (timestamp) => {
        const activeAnalyser = analyserRef.current;
        if (!activeAnalyser) return;
        activeAnalyser.getByteTimeDomainData(samples);
        let sumSquares = 0;
        for (const sample of samples) {
          const amplitude = (sample - 128) / 128;
          sumSquares += amplitude * amplitude;
        }
        const rms = Math.sqrt(sumSquares / samples.length);
        const level = Math.min(100, Math.round(rms * 800));
        if (rms > 0.004 && !audioSignalRef.current) {
          audioSignalRef.current = true;
        }
        if (timestamp - lastUpdate > 90 && mountedRef.current) {
          lastUpdate = timestamp;
          setInputLevel(level);
        }
        meterFrameRef.current = window.requestAnimationFrame(sampleMicrophone);
      };
      setMeterAvailable(true);
      if (context.state === "suspended") void context.resume().catch(() => {});
      meterFrameRef.current = window.requestAnimationFrame(sampleMicrophone);
    } catch {
      setMeterAvailable(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void refreshMicrophones();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMicrophones);
    return () => {
      mountedRef.current = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMicrophones);
      window.clearTimeout(timeoutRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      recognitionRef.current?.abort?.();
      releaseMicrophone();
    };
  }, [refreshMicrophones, releaseMicrophone]);

  const submitTranscript = async (rawTranscript) => {
    const value = cleanTranscript(rawTranscript);
    setTranscript(value);
    setRecording(false);
    if (isLowSignalTranscript(value)) {
      setProcessing(false);
      setStatus("No clear question was recognized");
      setServerFallbackAvailable(browserSpeechAvailable);
      setError("Only a short fragment was heard, so nothing was searched. Try again and speak a complete question.");
      return;
    }

    setError("");
    setProcessing(true);
    setStatus("Searching the spoken question");
    try {
      const result = await postQuery(value, getSessionId(), "voice");
      if (mountedRef.current) {
        setProcessing(false);
        setStatus("Analysis complete");
        onResult?.(result);
      }
    } catch (requestError) {
      if (mountedRef.current) {
        setProcessing(false);
        setStatus("Could not complete voice analysis");
        setError(requestError.message || "Check the backend connection and try again.");
      }
    }
  };

  const startBrowserRecognition = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition || !navigator.mediaDevices?.getUserMedia) return false;

    setError("");
    setTranscript("");
    setServerFallbackAvailable(false);
    setMeterAvailable(false);
    audioSignalRef.current = false;
    setInputLevel(0);
    setStatus("Starting browser speech recognition");
    let receivedResult = false;
    let failed = false;
    try {
      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.lang = navigator.language || "en-US";
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => {
        if (mountedRef.current) {
          setRecording(true);
          setStatus("Listening for your question");
        }
      };
      recognition.onresult = (event) => {
        const recognized = Array.from(event.results || [])
          .filter((item) => item.isFinal)
          .map((item) => item[0]?.transcript || "")
          .join(" ");
        if (!recognized.trim()) return;
        receivedResult = true;
        window.clearTimeout(timeoutRef.current);
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        releaseMicrophone();
        void submitTranscript(recognized);
      };
      recognition.onerror = (event) => {
        failed = true;
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        const signalDetected = audioSignalRef.current;
        releaseMicrophone();
        if (!mountedRef.current) return;
        setRecording(false);
        setStatus("Browser speech recognition stopped");
        const denied = event.error === "not-allowed" || event.error === "service-not-allowed";
        setServerFallbackAvailable(!denied && event.error !== "audio-capture");
        if (denied) {
          setError("Microphone or browser speech access was denied. Allow microphone access in the browser's site settings.");
        } else if (signalDetected) {
          setError("The microphone captured sound, but browser speech recognition returned no words. Try server transcription.");
        } else {
          setError("No microphone sound was detected. Allow microphone access and choose the active input below.");
        }
      };
      recognition.onend = () => {
        window.clearTimeout(timeoutRef.current);
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        const signalDetected = audioSignalRef.current;
        releaseMicrophone();
        if (!receivedResult && !failed && mountedRef.current) {
          setRecording(false);
          setStatus("Listening ended without a transcript");
          setServerFallbackAvailable(true);
          setError(
            signalDetected
              ? "The microphone captured sound, but browser speech recognition returned no words. Try server transcription."
              : "No microphone sound was detected. Allow microphone access and choose the active input below.",
          );
        }
      };

      const streamRequest = navigator.mediaDevices.getUserMedia({ audio: true });
      streamRequest.then((stream) => {
        if (recognitionRef.current !== recognition) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        monitorMicrophone(stream);
        void refreshMicrophones();
      }).catch(() => {
        // SpeechRecognition reports permission and device failures through its own events.
      });

      recognition.start();
      setRecording(true);
      setStatus("Listening, up to 30 seconds");
      timeoutRef.current = window.setTimeout(() => {
        try {
          recognition.stop();
        } catch {
          // The recognition service may already have ended.
        }
      }, 30000);
      return true;
    } catch (startError) {
      recognitionRef.current = null;
      releaseMicrophone();
      setRecording(false);
      setStatus("Browser speech recognition could not start");
      const denied = startError?.name === "NotAllowedError" || startError?.name === "SecurityError";
      setServerFallbackAvailable(!denied);
      setError(
        denied
          ? "Microphone access was denied. Allow microphone access in the browser's site settings."
          : "Browser speech recognition could not start. Try server transcription.",
      );
      return true;
    }
  };

  const stopRecording = () => {
    window.clearTimeout(timeoutRef.current);
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        recognitionRef.current = null;
        releaseMicrophone();
        setRecording(false);
      }
      return;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  };

  const startServerRecording = async () => {
    setStarting(true);
    setError("");
    setTranscript("");
    setServerFallbackAvailable(false);
    setMeterAvailable(false);
    audioSignalRef.current = false;
    setInputLevel(0);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setStarting(false);
      setError("Voice recording is not supported in this browser.");
      return;
    }
    try {
      const constraints = selectedMicrophone
        ? { audio: { deviceId: { exact: selectedMicrophone } } }
        : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      monitorMicrophone(stream);
      void refreshMicrophones();
      const preferredType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = preferredType
        ? new MediaRecorder(stream, { mimeType: preferredType })
        : new MediaRecorder(stream);
      const chunks = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        const signalDetected = audioSignalRef.current;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        releaseMicrophone();
        recorderRef.current = null;
        if (!mountedRef.current) return;
        setRecording(false);
        if (!blob.size) {
          setProcessing(false);
          setStatus("No audio was recorded");
          setError("No audio was captured. Check the selected microphone and try again.");
          return;
        }
        setProcessing(true);
        setStatus("Transcribing and analyzing");
        const extension = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
        const audio = new File([blob], "voice-query." + extension, { type: blob.type });
        try {
          const result = await postVoiceQuery(audio, getSessionId());
          if (mountedRef.current) {
            setProcessing(false);
            setStatus("Analysis complete");
            setTranscript(result.transcript || "");
            onResult?.(result);
          }
        } catch (requestError) {
          if (mountedRef.current) {
            setProcessing(false);
            setStatus("Could not complete voice analysis");
            const detail = requestError.message || "";
            if (/no speech|short fragment/i.test(detail)) {
              setError(
                signalDetected
                  ? "The microphone captured sound, but server transcription returned no words. Speak closer to the microphone or check the transcription provider."
                  : "No microphone sound was detected. Allow microphone access and choose the active input below.",
              );
            } else {
              setError(detail || "Check the backend connection and try again.");
            }
          }
        }
      };
      recorder.start(250);
      setRecording(true);
      setStarting(false);
      setStatus("Recording, up to 30 seconds");
      timeoutRef.current = window.setTimeout(stopRecording, 30000);
    } catch (recordingError) {
      releaseMicrophone();
      setStarting(false);
      setRecording(false);
      setStatus("Microphone not started");
      setError(
        recordingError.name === "NotAllowedError"
          ? "Microphone access was not granted. Allow it in the browser's site settings."
          : "Unable to start microphone recording.",
      );
    }
  };

  const startRecording = async () => {
    if (browserSpeechAvailable && !selectedMicrophone) {
      setStarting(true);
      const handled = await startBrowserRecognition();
      setStarting(false);
      if (handled) return;
    }
    await startServerRecording();
  };

  return (
    <div className={"voice-control" + (compact ? " is-compact" : "")}>
      <div className="voice-state">
        {recording ? (
          <span className="recording-indicator" aria-hidden="true" />
        ) : (
          <MicOff aria-hidden="true" size={16} />
        )}
        <span role="status">{status}</span>
      </div>
      {microphones.length > 0 && (
        <label className="voice-device-picker">
          <span>Microphone</span>
          <select
            value={selectedMicrophone}
            onChange={(event) => setSelectedMicrophone(event.target.value)}
            disabled={recording || processing || starting}
          >
            <option value="">System default microphone</option>
            {microphones.map((microphone) => (
              <option key={microphone.id || microphone.label} value={microphone.id}>
                {microphone.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {recording ? (
        <button className="secondary-button" type="button" onClick={stopRecording}>
          <Square aria-hidden="true" size={15} /> Stop listening
        </button>
      ) : (
        <button className="secondary-button" type="button" onClick={startRecording} disabled={processing || starting}>
          {processing || starting ? (
            <LoaderCircle className="spinning-icon" aria-hidden="true" size={16} />
          ) : (
            <Mic2 aria-hidden="true" size={16} />
          )}
          {processing ? "Processing" : starting ? "Starting microphone" : "Start recording"}
        </button>
      )}
      {recording && meterAvailable && (
        <div className="voice-input-meter">
          <span>Mic input</span>
          <div
            className="voice-meter-track"
            role="meter"
            aria-label="Microphone input level"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={inputLevel}
          >
            <span style={{ width: inputLevel + "%" }} />
          </div>
        </div>
      )}
      {transcript && (
        <p className="voice-transcript" aria-live="polite">
          <strong>Heard:</strong> {transcript}
        </p>
      )}
      {error && browserSpeechAvailable && serverFallbackAvailable && !recording && !processing && (
        <button className="secondary-button" type="button" onClick={startServerRecording}>
          Use server transcription
        </button>
      )}
      <p className="voice-note">
        Supported browsers use browser speech recognition first, and the browser vendor may process microphone audio. Server transcription is available when browser speech is unsupported or does not return a transcript.
      </p>
      {error && (
        <div className="inline-error voice-error" role="alert">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
