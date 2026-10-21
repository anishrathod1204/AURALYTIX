import { useEffect, useRef, useState } from "react";
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
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("Microphone is off");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [serverFallbackAvailable, setServerFallbackAvailable] = useState(false);
  const recorderRef = useRef(null);
  const recognitionRef = useRef(null);
  const streamRef = useRef(null);
  const timeoutRef = useRef(null);
  const mountedRef = useRef(true);

  const browserSpeechAvailable =
    typeof window !== "undefined" &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timeoutRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      recognitionRef.current?.abort?.();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

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
    if (!SpeechRecognition) return false;

    setError("");
    setTranscript("");
    setServerFallbackAvailable(false);
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
        void submitTranscript(recognized);
      };
      recognition.onerror = (event) => {
        failed = true;
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        if (!mountedRef.current) return;
        setRecording(false);
        setStatus("Browser speech recognition stopped");
        const denied = event.error === "not-allowed" || event.error === "service-not-allowed";
        setServerFallbackAvailable(!denied && event.error !== "audio-capture");
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setError("Microphone or browser speech access was denied. Check the browser permissions.");
        } else if (event.error === "no-speech") {
          setError("No speech was detected. Try again and speak after the microphone starts.");
        } else {
          setError("Browser speech recognition failed. Try again or use server transcription.");
        }
      };
      recognition.onend = () => {
        window.clearTimeout(timeoutRef.current);
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        if (!receivedResult && !failed && mountedRef.current) {
          setRecording(false);
          setStatus("Listening ended without a transcript");
          setServerFallbackAvailable(true);
          setError("No speech was recognized. Try again or use server transcription.");
        }
      };
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
    } catch {
      recognitionRef.current = null;
      setRecording(false);
      setStatus("Browser speech recognition did not start");
      setServerFallbackAvailable(true);
      setError("Browser speech recognition could not start. Try server transcription.");
      return false;
    }
  };

  const stopRecording = () => {
    window.clearTimeout(timeoutRef.current);
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        recognitionRef.current = null;
        setRecording(false);
      }
      return;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  };

  const startServerRecording = async () => {
    setError("");
    setTranscript("");
    setServerFallbackAvailable(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice recording is not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
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
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        if (!mountedRef.current) return;
        setRecording(false);
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (!blob.size) {
          setProcessing(false);
          setStatus("No audio was recorded");
          setError("No audio was captured. Try again and speak after recording starts.");
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
            setError(requestError.message || "Check the backend connection and try again.");
          }
        }
      };
      recorder.start(250);
      setRecording(true);
      setStatus("Recording, up to 30 seconds");
      timeoutRef.current = window.setTimeout(stopRecording, 30000);
    } catch (recordingError) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setRecording(false);
      setStatus("Microphone not started");
      setError(
        recordingError.name === "NotAllowedError"
          ? "Microphone access was not granted. Check the browser permissions."
          : "Unable to start microphone recording.",
      );
    }
  };

  const startRecording = async () => {
    if (browserSpeechAvailable && startBrowserRecognition()) return;
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
      {recording ? (
        <button className="secondary-button" type="button" onClick={stopRecording}>
          <Square aria-hidden="true" size={15} /> Stop listening
        </button>
      ) : (
        <button className="secondary-button" type="button" onClick={startRecording} disabled={processing}>
          {processing ? (
            <LoaderCircle className="spinning-icon" aria-hidden="true" size={16} />
          ) : (
            <Mic2 aria-hidden="true" size={16} />
          )}
          {processing ? "Processing" : "Start recording"}
        </button>
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
