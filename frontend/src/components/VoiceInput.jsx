import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic2, MicOff, Square, CircleAlert } from "lucide-react";
import { getSessionId, postQuery, postVoiceQuery } from "../services/api";

export default function VoiceInput({ onResult, compact = false }) {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("Microphone is off");
  const [error, setError] = useState("");
  const recorderRef = useRef(null);
  const recognitionRef = useRef(null);
  const streamRef = useRef(null);
  const timeoutRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timeoutRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      recognitionRef.current?.abort?.();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const stopRecording = () => {
    window.clearTimeout(timeoutRef.current);
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
  };

  const startBrowserRecognition = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("This browser does not provide speech recognition.");
      return;
    }
    setError("");
    setStatus("Requesting browser microphone access");
    let receivedResult = false;
    let failed = false;
    try {
      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.lang = navigator.language || "en-US";
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = async (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript?.trim() || "";
        receivedResult = true;
        window.clearTimeout(timeoutRef.current);
        setRecording(false);
        recognitionRef.current = null;
        if (!transcript) {
          setStatus("No speech was recognized");
          setError("No speech was recognized. Try again or use the backend transcription option.");
          return;
        }
        setProcessing(true);
        setStatus("Searching the spoken question");
        try {
          const result = await postQuery(transcript, getSessionId(), "voice");
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
      recognition.onerror = (event) => {
        failed = true;
        recognitionRef.current = null;
        if (mountedRef.current) {
          setRecording(false);
          setStatus("Browser speech recognition stopped");
          setError(event.error === "not-allowed" ? "Microphone access was not granted." : "Browser speech recognition failed. Try again or use the backend transcription option.");
        }
      };
      recognition.onend = () => {
        window.clearTimeout(timeoutRef.current);
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        if (!receivedResult && !failed && mountedRef.current) {
          setRecording(false);
          setStatus("Listening ended");
          setError("No speech was recognized. Try again.");
        }
      };
      recognition.start();
      setRecording(true);
      setStatus("Listening, maximum 10 seconds");
      timeoutRef.current = window.setTimeout(() => recognition.stop(), 10000);
    } catch {
      recognitionRef.current = null;
      setRecording(false);
      setStatus("Browser speech recognition did not start");
      setError("This browser could not start speech recognition.");
    }
  };

  const startRecording = async () => {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice recording is not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = preferredType ? new MediaRecorder(stream, { mimeType: preferredType }) : new MediaRecorder(stream);
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
        setProcessing(true);
        setStatus("Transcribing and analyzing");
        const mimeType = recorder.mimeType || "audio/webm";
        const extension = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
        const audio = new File([new Blob(chunks, { type: mimeType })], "voice-query." + extension, { type: mimeType });
        try {
          const result = await postVoiceQuery(audio, getSessionId());
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
      recorder.start();
      setRecording(true);
      setStatus("Recording, maximum 10 seconds");
      timeoutRef.current = window.setTimeout(stopRecording, 10000);
    } catch (recordingError) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setRecording(false);
      setStatus("Microphone not started");
      setError(recordingError.name === "NotAllowedError" ? "Microphone access was not granted." : "Unable to start microphone recording.");
    }
  };

  return (
    <div className={"voice-control" + (compact ? " is-compact" : "")}>
      <div className="voice-state">
        {recording ? <span className="recording-indicator" aria-hidden="true" /> : <MicOff aria-hidden="true" size={16} />}
        <span role="status">{status}</span>
      </div>
      {recording ? (
        <button className="secondary-button" type="button" onClick={stopRecording}>
          <Square aria-hidden="true" size={15} /> Stop listening
        </button>
      ) : (
        <button className="secondary-button" type="button" onClick={startRecording} disabled={processing}>
          {processing ? <LoaderCircle className="spinning-icon" aria-hidden="true" size={16} /> : <Mic2 aria-hidden="true" size={16} />}
          {processing ? "Processing" : "Start recording"}
        </button>
      )}
      {!compact && <p className="voice-note">Recording ends automatically after 10 seconds. Audio is sent to the configured backend for transcription.</p>}
      {error && (window.SpeechRecognition || window.webkitSpeechRecognition) && !recording && !processing && (
        <div className="browser-speech-fallback">
          <p>Your browser can provide an alternative speech service. The browser vendor may process the microphone audio.</p>
          <button className="secondary-button" type="button" onClick={startBrowserRecognition}>Use browser speech recognition</button>
        </div>
      )}
      {error && <div className="inline-error voice-error" role="alert"><CircleAlert aria-hidden="true" size={16} /><span>{error}</span></div>}
    </div>
  );
}
