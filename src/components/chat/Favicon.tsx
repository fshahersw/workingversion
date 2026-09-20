import { FileText, Landmark } from "lucide-react";
import { useState } from "react";

import {
  faviconProxyUrl,
  isInstitutionalHost,
  rememberFaviconMiss,
  shouldSkipFaviconFetch,
} from "@/lib/favicon-policy";

/**
 * Site favicon with a graceful fallback; internal sources get a document glyph.
 * Prefers a provider-supplied favicon URL, else DuckDuckGo's icon proxy. Hosts
 * known to have no icon there (courts, agencies) and hosts that already failed
 * this session are never requested, so a long answer does not spam 404s; they
 * render a landmark glyph (government / court) or a monogram instead.
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

  const proxy = faviconProxyUrl(host);
  const skipProxy = shouldSkipFaviconFetch(host);
  const url = src && !failed ? src : proxy;
  const noIcon = (!src || failed) && (proxyFailed || skipProxy);

  if (noIcon) {
    if (isInstitutionalHost(host)) {
      return (
        <span
          style={{ width: px, height: px }}
          className={`grid shrink-0 place-items-center rounded-[4px] bg-brand-navy/10 ${className}`}
          title={host}
        >
          <Landmark className="h-2.5 w-2.5 text-brand-navy/80" />
        </span>
      );
    }
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
      onError={() => {
        if (url === proxy) {
          rememberFaviconMiss(host);
          setProxyFailed(true);
        } else {
          setFailed(true);
        }
      }}
      style={{ width: px, height: px }}
      className={`shrink-0 rounded-[4px] bg-white object-contain ring-1 ring-border/50 ${className}`}
    />
  );
}
