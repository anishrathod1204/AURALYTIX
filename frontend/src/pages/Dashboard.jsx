import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Activity, ArrowUpRight, AudioLines, Check, CircleAlert, Globe2, GitBranch, LoaderCircle, Newspaper, Search, Video, CloudSun } from "lucide-react";
import { deleteSession, getAnswerUpdate, getHealth, getSessionId, postQuery } from "../services/api";
import Navbar from "../components/Navbar";
import SiteFooter from "../components/SiteFooter";
import VoiceInput from "../components/VoiceInput";
import NewsCard from "../components/NewsCard";
import VideoEmbed from "../components/VideoEmbed";
import { safeExternalUrl } from "../services/safeUrl";

const MapView = lazy(() => import("../components/MapView"));
const ChartView = lazy(() => import("../components/ChartView"));

const examples = [
  { number: "01", label: "Policy watch", query: "What changed in AI policy this week?" },
  { number: "02", label: "Local conditions", query: "Current weather in Mumbai" },
  { number: "03", label: "Research films", query: "Recent research videos on battery storage" },
  { number: "04", label: "Inspect public code", query: "Inspect the architecture and key files in https://github.com/morluto/rea" },
];

const providers = [
  { key: "llm", label: "Reasoning", icon: Activity },
  { key: "news", label: "News", icon: Newspaper },
  { key: "weather", label: "Weather", icon: CloudSun },
  { key: "youtube", label: "Video", icon: Video },
  { key: "search", label: "Web search", icon: Globe2 },
  { key: "github", label: "GitHub", icon: GitBranch },
];

function ProviderStatus({ provider, integrations }) {
  const Icon = provider.icon;
  const configured = Boolean(integrations[provider.key]);
  const fallbackAvailable = Boolean(integrations[provider.key + "_fallback"]);
  const available = configured || fallbackAvailable;
  const stateLabel = configured ? "Key set" : fallbackAvailable ? "Public API" : "Not set";
  return (
    <div className={"provider-status " + (available ? "is-ready" : "is-offline")} title={configured ? provider.label + " API key or endpoint is configured" : fallbackAvailable ? provider.label + " has a public search fallback" : provider.label + " is not configured"}>
      <Icon aria-hidden="true" size={14} />
      <span>{provider.label}</span>
      <span className="provider-state">{stateLabel}</span>
    </div>
  );
}

function WeatherSummary({ weather, mapCenter }) {
  if (!weather) return null;
  const hasNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const hasTemperature = hasNumber(weather.temperature);
  const hasHumidity = hasNumber(weather.humidity);
  const hasWind = hasNumber(weather.wind_speed);
  return (
    <section className="panel result-section" aria-labelledby="weather-heading">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Retrieved data</span>
          <h2 id="weather-heading">Weather conditions</h2>
        </div>
        <CloudSun aria-hidden="true" size={20} />
      </div>
      <p className="weather-location">{weather.city || "Location returned by provider"}</p>
      <p className="weather-condition">{weather.condition || "Current conditions"}</p>
      <div className="weather-values">
        {hasTemperature && <div><span>Temperature</span><strong>{Math.round(Number(weather.temperature))}°C</strong></div>}
        {hasHumidity && <div><span>Humidity</span><strong>{Math.round(Number(weather.humidity))}%</strong></div>}
        {hasWind && <div><span>Wind</span><strong>{Number(weather.wind_speed).toFixed(1)} m/s</strong></div>}
      </div>
      {mapCenter && <Suspense fallback={<div className="visualization-loading">Loading map</div>}><MapView center={mapCenter} /></Suspense>}
    </section>
  );
}

function SourceList({ sources }) {
  if (!sources.length) return null;
  return (
    <section className="panel result-section" aria-labelledby="sources-heading">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Evidence</span>
          <h2 id="sources-heading">Sources used</h2>
        </div>
        <span className="section-count">{sources.length} returned</span>
      </div>
      <div className="source-list">
        {sources.map((source, index) => (
          <article className="source-row" key={source.url || source.title || index}>
            <div className="source-type"><span>{source.reference || ""}</span>{source.type || source.source || "Web"}</div>
            <div className="source-copy">
              <h3>{source.title || "Untitled source"}</h3>
              {source.description && (source.type === "Repository file" || source.type === "Repository overview"
                ? <pre className="source-excerpt">{source.description}</pre>
                : <p>{source.description}</p>)}
              <div className="source-meta">
                {source.site && <span>{source.site}</span>}
                {source.publishedAt && <time dateTime={source.publishedAt}>{new Date(source.publishedAt).toLocaleDateString()}</time>}
              </div>
            </div>
            {safeExternalUrl(source.url) && (
              <a className="text-link source-link" href={safeExternalUrl(source.url)} target="_blank" rel="noopener noreferrer" aria-label={"Open source: " + (source.title || "web source")}>
                Open <ArrowUpRight aria-hidden="true" size={15} />
              </a>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function RetrievalCoverage({ retrieval }) {
  if (!retrieval) return null;
  const entries = [
    ["Web search", retrieval.web],
    ["News", retrieval.news],
    ["Weather", retrieval.weather],
    ["YouTube", retrieval.videos],
    ["GitHub", retrieval.repository],
    ["Answer", retrieval.reasoning],
  ];
  const describe = (value) => ({
    available: "Results returned",
    "search link available": "Search link ready",
    "not requested": "Not needed for this question",
    "no results": "No results returned",
    unavailable: "Provider unavailable",
    "metadata only": "Metadata returned",
    "repository unavailable": "Repository unavailable",
    "specialist data unavailable": "Provider unavailable",
    "AI synthesis pending": "Writing the brief",
    "AI synthesis": "Source-backed synthesis",
    "source-based response": "Source excerpts shown",
  }[value] || value || "Status unavailable");
  return (
    <section className="panel result-section" aria-labelledby="coverage-heading">
      <div className="section-heading">
        <div><span className="section-kicker">Request diagnostics</span><h2 id="coverage-heading">Search coverage</h2></div>
      </div>
      <div className="coverage-grid">
        {entries.map(([label, value]) => (
          <div key={label}><span>{label}</span><strong>{describe(value)}</strong></div>
        ))}
      </div>
    </section>
  );
}

function RepositorySummary({ repository }) {
  if (!repository) return null;
  return (
    <section className="panel result-section repository-summary" aria-labelledby="repository-heading">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Public source review</span>
          <h2 id="repository-heading">{repository.owner && repository.name ? `${repository.owner}/${repository.name}` : "GitHub repository"}</h2>
        </div>
        <Globe2 aria-hidden="true" size={19} />
      </div>
      {repository.summary && <p>{repository.summary}</p>}
      <div className="repository-facts">
        {repository.branch && <span><strong>Default branch</strong>{repository.branch}</span>}
        {repository.language && <span><strong>Primary language</strong>{repository.language}</span>}
        {Number.isFinite(Number(repository.files_analyzed)) && <span><strong>Files and docs read</strong>{repository.files_analyzed}</span>}
      </div>
      <p className="repository-limit">Read-only review of public documentation and source excerpts. Repository code is never run, so runtime behavior is not verified.</p>
      {repository.error && <p className="repository-error">{repository.error}</p>}
      {safeExternalUrl(repository.url) && <a className="text-link" href={safeExternalUrl(repository.url)} target="_blank" rel="noopener noreferrer">Open repository <ArrowUpRight aria-hidden="true" size={15} /></a>}
    </section>
  );
}

export default function Dashboard() {
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState(null);
  const [clearingSession, setClearingSession] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ status: "offline", integrations: {} }));
  }, []);

  useEffect(() => {
    const sharedResult = location.state?.result;
    if (sharedResult) {
      setResults(sharedResult);
      setQuery(sharedResult.transcript || sharedResult.query || "");
    }
  }, [location.state]);

  useEffect(() => {
    const taskId = results?.task_id;
    if (!taskId || !results?.answer_pending) return undefined;
    let stopped = false;
    let attempts = 0;
    let timer;

    const pollForAnswer = async () => {
      attempts += 1;
      try {
        const update = await getAnswerUpdate(taskId);
        if (stopped) return;
        if (update.status === "complete") {
          setResults((current) => current?.task_id !== taskId ? current : {
            ...current,
            answer: update.answer || current.answer,
            answer_pending: false,
            dashboard_data: {
              ...current.dashboard_data,
              retrieval: {
                ...current.dashboard_data?.retrieval,
                reasoning: update.reasoning || "source-based response",
              },
            },
          });
          return;
        }
      } catch {
        if (stopped) return;
      }
      if (attempts < 20) {
        timer = window.setTimeout(pollForAnswer, 800);
      } else if (!stopped) {
        setResults((current) => current?.task_id !== taskId ? current : {
          ...current,
          answer_pending: false,
          dashboard_data: {
            ...current.dashboard_data,
            retrieval: { ...current.dashboard_data?.retrieval, reasoning: "source-based response" },
          },
        });
      }
    };

    timer = window.setTimeout(pollForAnswer, 700);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [results?.answer_pending, results?.task_id]);

  const runQuery = async (value) => {
    const cleanQuery = value.trim();
    if (!cleanQuery || loading) return;
    setQuery(cleanQuery);
    setLoading(true);
    setError("");
    try {
      const response = await postQuery(cleanQuery, getSessionId(), "text");
      setResults(response);
    } catch (requestError) {
      setError(requestError.message || "The request could not be completed. Check the backend connection and provider settings.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    runQuery(query);
  };

  const handleQueryKeyDown = (event) => {
    const nativeEvent = event.nativeEvent || event;
    if (event.key !== "Enter" || event.shiftKey || nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
    event.preventDefault();
    runQuery(query);
  };

  const handleVoiceResult = (response) => {
    setResults(response);
    setQuery(response.transcript || "");
    setError("");
  };

  const clearSession = async () => {
    setClearingSession(true);
    setError("");
    try {
      await deleteSession(getSessionId());
      setResults(null);
      setQuery("");
      inputRef.current?.focus();
    } catch (clearError) {
      setError(clearError.message || "This session could not be cleared.");
    } finally {
      setClearingSession(false);
    }
  };

  const integrations = health?.integrations || {};
  const dashboard = results?.dashboard_data || {};
  const sources = Array.isArray(results?.sources) ? results.sources : [];
  const articles = Array.isArray(dashboard.articles) ? dashboard.articles : [];
  const videos = Array.isArray(dashboard.videos) ? dashboard.videos : [];
  const weather = dashboard.weather || null;
  const mapCenter = Array.isArray(dashboard.map_center) && dashboard.map_center.length === 2 ? dashboard.map_center : null;
  const videoSearchUrl = dashboard.video_search_url || "https://www.youtube.com/results?search_query=" + encodeURIComponent(results?.query || query);

  return (
    <div className="site-shell">
      <Navbar />
      <main className="dashboard-main">
        <header className="page-heading series-heading">
          <div className="heading-overline">
            <div className="eyebrow"><span className="eyebrow-line" />AURALYTIX ORIGINAL / LIVE RESEARCH</div>
            <span className="edition-mark">RESEARCH DESK&nbsp;&nbsp; · &nbsp;&nbsp;01</span>
          </div>
          <div className="heading-layout">
            <div className="heading-copy">
              <h1>Current research,<br />with the sources attached.</h1>
              <p>Every search brings back related videos and a source-backed answer. Current news and local weather are added when relevant, with follow-up questions kept in the same session.</p>
              <a className="heading-action" href="#research"><span>Start a search</span><ArrowUpRight aria-hidden="true" size={15} /></a>
            </div>
            <ol className="signal-sheet" aria-label="How a research request is processed">
              <li><span>01</span><strong>Question</strong><small>TEXT / VOICE</small></li>
              <li><span>02</span><strong>Retrieval</strong><small>WEB / LIVE DATA</small></li>
              <li><span>03</span><strong>Brief</strong><small>ANSWER / SOURCES</small></li>
            </ol>
          </div>
        </header>

        <section className="provider-strip" aria-label="Provider configuration" id="connections">
          <div className="provider-strip-heading">
            <div><span className="section-kicker">Provider status</span><span className="provider-caption">Live providers and public fallbacks</span></div>
            <span className={"backend-state " + (health?.status === "healthy" ? "is-ready" : health?.status === "offline" ? "is-offline" : "is-degraded")}>
              <span className="state-dot" />
              {!health ? "Checking service" : health.status === "offline" ? "Service unavailable" : health.status === "degraded" ? "Service needs attention" : "Service online"}
            </span>
          </div>
          <div className="provider-grid">
            {providers.map((provider) => (
              <ProviderStatus key={provider.key} provider={provider} integrations={integrations} />
            ))}
          </div>
        </section>

        <div className="workspace-grid" id="research">
          <aside className="query-column">
            <section className="panel query-panel" aria-labelledby="query-heading">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">Research request / {results ? "Follow-up" : "01"}</span>
                  <h2 id="query-heading">{results ? "Continue the thread" : "Ask AURALYTIX"}</h2>
                </div>
                <Search aria-hidden="true" size={19} />
              </div>
              <form onSubmit={handleSubmit}>
                <label className="field-label" htmlFor="research-query">Your question</label>
                <textarea
                  id="research-query"
                  ref={inputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleQueryKeyDown}
                  rows={5}
                  maxLength={2000}
                  placeholder="Ask a question or paste a public GitHub repository URL."
                  className="query-input"
                />
                <div className="input-footnote"><span>{results ? "Follow-ups keep session context" : "Enter to search · Shift+Enter for a new line"}</span><span>{query.length}/2000</span></div>
                <button className="action-button" type="submit" disabled={loading || !query.trim()}>
                  {loading ? <LoaderCircle className="spinning-icon" aria-hidden="true" size={16} /> : <Search aria-hidden="true" size={16} />}
                  {loading ? "Searching sources" : "Search and explain"}
                </button>
              </form>
              <button className="clear-session-button" type="button" onClick={clearSession} disabled={clearingSession || loading}>{clearingSession ? "Clearing session" : "Clear session context"}</button>
              {error && (
                <div className="inline-error" role="alert">
                  <CircleAlert aria-hidden="true" size={17} />
                  <span>{error}</span>
                </div>
              )}
              <div className="example-block">
                <div className="example-heading"><span className="field-label">Start with a field note</span><span className="field-note-index">04 PROMPTS</span></div>
                {examples.map((example) => (
                  <button key={example.query} className="example-button" type="button" onClick={() => { setQuery(example.query); inputRef.current?.focus(); }}>
                    <span className="example-number">{example.number}</span>
                    <span className="example-copy"><strong>{example.label}</strong><small>{example.query}</small></span>
                    <ArrowUpRight aria-hidden="true" size={14} />
                  </button>
                ))}
              </div>
            </section>

            <section className="panel voice-panel" aria-labelledby="voice-heading">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">Chapter 02 / speech</span>
                  <h2 id="voice-heading">Speak your query</h2>
                </div>
                <AudioLines aria-hidden="true" size={19} />
              </div>
              <p className="panel-note">Record up to 30 seconds, review the transcript, then search the same sources as text input.</p>
              <VoiceInput onResult={handleVoiceResult} compact />
            </section>
          </aside>

          <section className="results-column" aria-label="Analysis results" aria-live="polite">
            {loading ? (
              <div className="panel empty-state">
                <LoaderCircle className="spinning-icon" aria-hidden="true" size={26} />
                <h2>Gathering results</h2>
                <p>Checking the providers available for this question.</p>
              </div>
            ) : results ? (
              <div className="result-stack">
                <section className="panel answer-panel" aria-labelledby="answer-heading">
                  <div className="section-heading">
                    <div>
                      <span className="section-kicker">Chapter 03 / research brief</span>
                      <h2 id="answer-heading">{results.modality === "voice" ? "Voice research brief" : "Research brief"}</h2>
                    </div>
                    {dashboard.retrieval?.reasoning === "AI synthesis pending" ? <LoaderCircle className="spinning-icon" aria-hidden="true" size={19} /> : <Check aria-hidden="true" size={19} />}
                  </div>
                  <p className="answer-query">{results.query || query}</p>
                  <div className="answer-copy">{results.answer || "The analysis returned without a text response."}</div>
                  {dashboard.retrieval?.reasoning === "AI synthesis pending" && <p className="answer-status-note">Sources are ready. Finishing the brief from their retrieved excerpts.</p>}
                  {dashboard.retrieval?.reasoning === "source-based response" && <p className="answer-status-note">The reasoning provider did not finish in time. This brief uses the retrieved source excerpts directly.</p>}
                </section>

                <RetrievalCoverage retrieval={dashboard.retrieval} />
                <RepositorySummary repository={dashboard.repository} />
                {weather && <WeatherSummary weather={weather} mapCenter={mapCenter} />}
                {dashboard.chart && <Suspense fallback={<div className="visualization-loading">Loading forecast chart</div>}><ChartView title={dashboard.chart.title || "Returned data"} data={dashboard.chart} /></Suspense>}

                {articles.length > 0 && (
                  <section className="panel result-section" aria-labelledby="news-heading">
                    <div className="section-heading">
                      <div><span className="section-kicker">Retrieved data</span><h2 id="news-heading">News articles</h2></div>
                    </div>
                    <div className="news-grid">{articles.map((article, index) => <NewsCard key={article.url || index} article={article} />)}</div>
                  </section>
                )}

                <section className="panel result-section" aria-labelledby="videos-heading">
                  <div className="section-heading">
                    <div><span className="section-kicker">Video coverage</span><h2 id="videos-heading">Related videos</h2></div>
                    <span className="section-count">{videos.length ? `${videos.length} found` : "Search ready"}</span>
                  </div>
                  {videos.length > 0 ? (
                    <div className="video-grid">{videos.map((video, index) => <VideoEmbed key={video.video_id || index} video={video} />)}</div>
                  ) : (
                    <div className="video-search-fallback">
                      <p>Individual video links were not returned this time. Open YouTube results for the full question.</p>
                      <a className="text-link" href={safeExternalUrl(videoSearchUrl)} target="_blank" rel="noopener noreferrer">
                        Search YouTube for this question <ArrowUpRight aria-hidden="true" size={14} />
                      </a>
                    </div>
                  )}
                </section>

                <SourceList sources={sources} />
                {sources.length === 0 && !weather && articles.length === 0 && (
                  <div className="source-note"><CircleAlert aria-hidden="true" size={16} />No web sources were returned for this request. The search coverage above shows which providers responded.</div>
                )}
              </div>
            ) : (
              <div className="panel empty-state">
                <div className="empty-mark"><Globe2 aria-hidden="true" size={24} /></div>
                <span className="section-kicker">Workspace ready</span>
                <h2>Start with a specific question.</h2>
                <p>Results appear here after a provider returns them. Charts and maps are shown only when the returned data supports them.</p>
                <div className="empty-flow" aria-label="Analysis flow">
                  <span>Question</span><span className="flow-connector" /><span>Provider routing</span><span className="flow-connector" /><span>Sources</span>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
