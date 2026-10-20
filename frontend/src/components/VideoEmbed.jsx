import { useState } from "react";
import { ArrowUpRight, Play } from "lucide-react";
import { safeExternalUrl } from "../services/safeUrl";

export default function VideoEmbed({ video }) {
  const [playerVisible, setPlayerVisible] = useState(false);
  const videoId = typeof video.video_id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(video.video_id) ? video.video_id : "";
  const watchUrl = safeExternalUrl(video.url || (videoId ? "https://www.youtube.com/watch?v=" + videoId : ""));
  const thumbnailUrl = videoId
    ? safeExternalUrl(video.thumbnail || "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg")
    : "";

  return (
    <article className="video-card">
      {videoId && (
        <div className="video-frame">
          {playerVisible ? (
            <iframe
              src={"https://www.youtube-nocookie.com/embed/" + videoId + "?rel=0"}
              title={video.title || "YouTube video"}
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          ) : (
            <button
              className="video-load"
              type="button"
              onClick={() => setPlayerVisible(true)}
              aria-label={"Load video player for " + (video.title || "YouTube video")}
            >
              {thumbnailUrl && <img className="video-thumbnail" src={thumbnailUrl} alt="" loading="lazy" />}
              <span className="play-mark"><Play aria-hidden="true" size={19} fill="currentColor" /></span>
            </button>
          )}
        </div>
      )}
      <div className="video-copy">
        <h3>{video.title || "Untitled video"}</h3>
        {video.channel && <p>{video.channel}</p>}
        {watchUrl && <a className="text-link" href={watchUrl} target="_blank" rel="noopener noreferrer">Open on YouTube <ArrowUpRight aria-hidden="true" size={14} /></a>}
      </div>
    </article>
  );
}
