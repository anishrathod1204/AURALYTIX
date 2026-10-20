import { useEffect } from "react";
import { Link } from "react-router-dom";
import Navbar from "../components/Navbar";
import SiteFooter from "../components/SiteFooter";

const updated = new Date("2026-10-20T12:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

export default function PrivacyPolicy() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Privacy Policy | AURALYTIX AI";
    return () => { document.title = previousTitle; };
  }, []);

  return (
    <div className="site-shell">
      <Navbar />
      <main className="policy-main">
        <div className="eyebrow"><span className="eyebrow-line" />AURALYTIX / LEGAL</div>
        <h1>Privacy policy</h1>
        <p className="policy-intro">Last updated {updated}. This draft describes the current application flow. The service operator must confirm it against the final hosting setup and enabled providers before public launch.</p>
        <div className="launch-notice">
          <strong>Launch detail required</strong>
          <p>The service operator and privacy contact are not configured in this build. Add the responsible legal entity, contact address, hosting details, provider list, and retention periods before launch.</p>
        </div>
        <div className="policy-content">
          <section><h2>Information processed</h2><p>When you use AURALYTIX, the service processes the questions you submit, the voice recordings you choose to make, the resulting transcript, and a session identifier used to keep follow-up questions in context. The browser keeps that identifier in session storage for the current tab.</p></section>
          <section><h2>How information is used</h2><p>Questions and transcripts are used to retrieve current material and prepare an answer. With the current local speech setting, recordings are transcribed on the server using faster-whisper when it is installed. If the speech provider is configured to allow OpenAI transcription, recordings may be sent to OpenAI. You may also choose the browser speech recognition fallback after a backend transcription error. When you choose it, your browser may send microphone audio to its speech service. The browser vendor and its processing details depend on the browser you use. The resulting transcript is then used in the same search and reasoning flow as a typed question.</p></section>
          <section><h2>Service providers</h2><p>Depending on the active configuration and your question, text may be sent to OpenRouter, OpenAI, Groq, or a local Ollama model for answer generation. When OpenRouter&apos;s free route is selected, OpenRouter chooses a currently available free model provider, so the downstream provider can vary. Paid search, news, weather, and video services are used only when ENABLE_PAID_APIS is enabled and the matching provider key is configured. Otherwise, search uses DuckDuckGo and Bing, news uses Google News RSS, Bing News RSS, or GDELT, weather uses Open-Meteo, and video lookup uses YouTube&apos;s public search page. When a question contains a public GitHub repository URL, the backend requests that repository&apos;s public metadata, file tree, README, and selected small source files from GitHub. It sends the repository URL to GitHub, does not send the full question to GitHub, and does not execute repository code. The local project currently keeps paid integrations disabled. Local Whisper can process speech on the server; browser speech recognition can also process audio when you choose that fallback. Each third party processes information under its own terms and privacy policy. The operator must verify the deployed configuration and publish links to the providers actually used before launch.</p></section>
          <section><h2>Storage and retention</h2><p>The backend stores text questions and generated answers in a local SQLite database so follow-up questions can use recent session context. This history is automatically removed after 24 hours. Use “Clear session context” to delete the current session sooner. Search results and uploaded audio are not stored in that history. Audio is written to a temporary server file for transcription and removed after the request completes, including when processing fails. Hosting logs, infrastructure backups, database backups, and provider retention are controlled by the operator and must be documented before launch.</p></section>
          <section><h2>Security</h2><p>The operator is responsible for securing the deployed backend, protecting provider credentials, restricting access, and setting appropriate retention controls. Do not submit sensitive personal information unless the operator has confirmed the deployed safeguards and provider terms.</p></section>
          <section><h2>Your choices</h2><p>You can choose whether to use voice input and can clear the current session context from the research desk. Closing a tab removes its session identifier from browser session storage, while the associated server history expires within 24 hours. Requests already sent to the backend or a third-party provider cannot be recalled from this page. The operator must provide a contact method for privacy questions and applicable data requests.</p></section>
          <section><h2>Children</h2><p>The minimum age for using the service is not configured. Before launch, the operator must set and publish an age requirement based on the intended audience and applicable law, and add any controls that requirement calls for.</p></section>
          <section><h2>Contact</h2><p>Privacy contact: not configured. The operator must replace this notice with a monitored contact address and its legal name before public launch.</p></section>
        </div>
        <div className="policy-navigation"><Link to="/terms">Read the terms and conditions</Link><Link to="/">Return to the research desk</Link></div>
      </main>
      <SiteFooter />
    </div>
  );
}
