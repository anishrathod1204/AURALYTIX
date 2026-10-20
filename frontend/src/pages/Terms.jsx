import { useEffect } from "react";
import { Link } from "react-router-dom";
import Navbar from "../components/Navbar";
import SiteFooter from "../components/SiteFooter";

const updated = new Date("2026-10-20T12:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

export default function Terms() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Terms and Conditions | AURALYTIX AI";
    return () => { document.title = previousTitle; };
  }, []);

  return (
    <div className="site-shell">
      <Navbar />
      <main className="policy-main">
        <div className="eyebrow"><span className="eyebrow-line" />AURALYTIX / LEGAL</div>
        <h1>Terms and conditions</h1>
        <p className="policy-intro">Last updated {updated}. These draft terms describe use of the current AURALYTIX application. They require review and completion by the service operator before public launch.</p>
        <div className="launch-notice">
          <strong>Launch detail required</strong>
          <p>The legal operator, support contact, governing law, and venue are not configured in this build. Add and review these details before making the service public.</p>
        </div>
        <div className="policy-content">
          <section><h2>Using the service</h2><p>AURALYTIX accepts text questions and optional voice recordings, routes requests to configured providers, and presents the returned information. Use the service lawfully and do not interfere with its operation, attempt unauthorized access, or submit content you are not permitted to share.</p></section>
          <section><h2>Responses and sources</h2><p>Responses may be incomplete, outdated, or incorrect. Provider availability and results can change. Review source material directly and use your own judgment before relying on an answer. AURALYTIX does not provide professional, legal, medical, financial, or emergency advice.</p></section>
          <section><h2>Third-party services</h2><p>The service may rely on external LLM, news, weather, search, and video providers. Their services can be unavailable or change independently. Your use of those services may also be subject to their terms and privacy policies.</p></section>
          <section><h2>Availability and changes</h2><p>The operator may update, suspend, or discontinue parts of the service. No uptime commitment, support level, or service feature is promised by this draft. The operator must publish any support and availability commitments that apply to the final service.</p></section>
          <section><h2>Intellectual property</h2><p>The operator or its licensors retain rights in the AURALYTIX software and branding. You retain rights in the content you submit, subject to the limited processing needed to operate the service and the terms of configured providers.</p></section>
          <section><h2>Liability and governing law</h2><p>The final terms must define the operator&apos;s responsibility and any limitations permitted by applicable law. The governing law and dispute venue have not been set in this build and must be supplied by the operator before launch.</p></section>
          <section><h2>Operator and contact</h2><p>Legal operator and support contact: not configured. The operator must publish its legal name and a monitored contact address before public launch.</p></section>
        </div>
        <div className="policy-navigation"><Link to="/privacy">Read the privacy policy</Link><Link to="/">Return to the research desk</Link></div>
      </main>
      <SiteFooter />
    </div>
  );
}
