import { useEffect, useState } from "react";
import { ArrowLeft, AudioLines, CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";
import Navbar from "../components/Navbar";
import SiteFooter from "../components/SiteFooter";
import VoiceInput from "../components/VoiceInput";

export default function Voice() {
  const [result, setResult] = useState(null);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Voice Input | AURALYTIX AI";
    return () => { document.title = previousTitle; };
  }, []);

  return (
    <div className="site-shell">
      <Navbar />
      <main className="policy-main voice-main">
        <Link className="back-link" to="/"><ArrowLeft aria-hidden="true" size={15} /> Research desk</Link>
        <div className="eyebrow"><span className="eyebrow-line" />AURALYTIX / VOICE INPUT</div>
        <h1>Ask by speaking.</h1>
        <p className="policy-intro">On supported browsers, voice input uses browser speech recognition first. The browser vendor may process microphone audio. If browser speech is unavailable, you can use the server transcription option.</p>
        <section className="panel voice-page-panel">
          <div className="section-heading">
            <div><span className="section-kicker">Voice query</span><h2>Microphone input</h2></div>
            <AudioLines aria-hidden="true" size={20} />
          </div>
          <VoiceInput onResult={setResult} />
        </section>
        {result && (
          <section className="panel voice-response" aria-live="polite">
            <div className="section-heading">
              <div><span className="section-kicker">Completed</span><h2>Analysis response</h2></div>
              <CheckCircle2 aria-hidden="true" size={19} />
            </div>
            {result.transcript && <p className="answer-query">{result.transcript}</p>}
            <p className="answer-copy">{result.answer || "The analysis returned without a text response."}</p>
            <Link className="text-link" to="/" state={{ result }}>View full results <ArrowLeft aria-hidden="true" size={14} className="link-arrow-forward" /></Link>
          </section>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
