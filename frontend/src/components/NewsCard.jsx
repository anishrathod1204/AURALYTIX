import { ArrowUpRight } from "lucide-react";
import { safeExternalUrl } from "../services/safeUrl";

export default function NewsCard({ article }) {
  const articleUrl = safeExternalUrl(article.url);
  return (
    <article className="news-card">
      <div className="news-source">{article.source || article.site || "News source"}</div>
      <h3>{article.title || "Untitled article"}</h3>
      {article.description && <p>{article.description}</p>}
      <div className="news-card-footer">
        {article.publishedAt && <time dateTime={article.publishedAt}>{new Date(article.publishedAt).toLocaleDateString()}</time>}
        {articleUrl && <a className="text-link" href={articleUrl} target="_blank" rel="noopener noreferrer">Read article <ArrowUpRight aria-hidden="true" size={14} /></a>}
      </div>
    </article>
  );
}
