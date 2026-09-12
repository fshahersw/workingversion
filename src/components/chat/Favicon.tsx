import { FileText } from "lucide-react";
import { useState } from "react";

/**
 * Site favicon with a monogram fallback; internal sources get a document glyph.
 * Prefers a provider-supplied favicon URL, else DuckDuckGo's icon service (it
 * returns a 200 default for unknown hosts, so there are no console 404s).
 * Shared by the source list, the citation hover card, and the tool timeline.
 */
export function Favicon({
  host,
  size = 16,
  src,
  className = "",
}: {
  host: string | null;
  size?: number;
  src?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [proxyFailed, setProxyFailed] = useState(false);
  const px = `${size}px`;

  if (!host) {
    return (
      <span
        style={{ width: px, height: px }}
        className={`grid shrink-0 place-items-center rounded-[4px] bg-brand-navy/10 ${className}`}
      >
        <FileText className="h-2.5 w-2.5 text-brand-navy/70" />
      </span>
    );
  }

  const proxy = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
  const url = src && !failed ? src : proxy;

  if ((!src || failed) && proxyFailed) {
    return (
      <span
        style={{ width: px, height: px }}
        className={`grid shrink-0 place-items-center rounded-[4px] bg-muted text-[8px] font-semibold uppercase text-muted-foreground ${className}`}
        title={host}
      >
        {host.charAt(0)}
      </span>
    );
  }

  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      width={size}
      height={size}
      title={host}
      onError={() => (url === proxy ? setProxyFailed(true) : setFailed(true))}
      style={{ width: px, height: px }}
      className={`shrink-0 rounded-[4px] bg-white object-contain ring-1 ring-border/50 ${className}`}
    />
  );
}
