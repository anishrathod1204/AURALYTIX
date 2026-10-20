const API_ORIGIN = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const endpoint = (path) => API_ORIGIN ? API_ORIGIN + path : "/api" + path;

async function readResponse(response, fallback) {
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const detail = typeof payload.detail === "string" ? payload.detail : fallback;
    throw new Error(detail || fallback);
  }
  return payload;
}

export function getSessionId() {
  const storageKey = "auralytix-session-id";
  try {
    let sessionId = window.sessionStorage.getItem(storageKey);
    if (!sessionId) {
      sessionId = window.crypto?.randomUUID?.() || "session-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      window.sessionStorage.setItem(storageKey, sessionId);
    }
    return sessionId;
  } catch {
    return "session-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }
}

export async function getAnswerUpdate(taskId) {
  const response = await fetch(endpoint("/query/answer/" + encodeURIComponent(taskId)));
  return readResponse(response, "The answer update could not be retrieved.");
}

export async function postQuery(query, sessionId = "default", modality = "text") {
  const response = await fetch(endpoint("/query"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, session_id: sessionId, modality }),
  });
  return readResponse(response, "The analysis request failed.");
}

export async function postTranscribe(file) {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(endpoint("/transcribe"), { method: "POST", body: form });
  return readResponse(response, "Audio transcription failed.");
}

export async function postVoiceQuery(file, sessionId = "default") {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(endpoint("/voice-query") + "?session_id=" + encodeURIComponent(sessionId), {
    method: "POST",
    body: form,
  });
  return readResponse(response, "Voice analysis failed.");
}

export async function getHealth() {
  const response = await fetch(endpoint("/health"));
  return readResponse(response, "Health check failed.");
}

export async function deleteSession(sessionId = getSessionId()) {
  const response = await fetch(endpoint("/session/" + encodeURIComponent(sessionId)), { method: "DELETE" });
  return readResponse(response, "Could not clear this session.");
}
