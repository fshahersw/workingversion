/** Keep a real user-clickable link when an async/browser-host download is blocked. */
export function deliverOfficeFile(source: Blob | string, name: string, description = 'Your file is ready. If the download did not start, select the link below.'): void {
  const blob = typeof source !== 'string';
  const url = blob ? URL.createObjectURL(source) : source;
  if (!blob && (!url.startsWith('/') || url.startsWith('//') || new URL(url,location.origin).origin !== location.origin)) throw new Error('Only same-origin document downloads are supported.');
  let region = document.getElementById('office-prepared-downloads');
  if (!region) {
    region = document.createElement('section'); region.id = 'office-prepared-downloads';
    region.setAttribute('role', 'region'); region.setAttribute('aria-label', 'Prepared downloads');
    Object.assign(region.style, { position: 'fixed', bottom: '36px', left: '76px', zIndex: '10000', width: 'min(340px, calc(100vw - 100px))', maxHeight: '35vh', overflow: 'auto', padding: '16px', background: '#fff', color: '#183348', border: '1px solid #cbd5e1', borderRadius: '10px', boxShadow: '0 8px 30px #0002', font: '14px system-ui' });
    document.body.appendChild(region);
  }
  // Bound retained blob memory. Dismissal revokes its URL; no short arbitrary
  // timer invalidates the user's fallback link before they can click it.
  while (region.children.length >= 3) (region.firstElementChild?.querySelector('button') as HTMLButtonElement)?.click();
  const row = document.createElement('div'), text = document.createElement('p'), link = document.createElement('a'), close = document.createElement('button');
  text.textContent = description; text.style.margin = '0 0 8px';
  link.textContent = name; link.href = url; link.download = name; link.style.textDecoration = 'underline';
  close.textContent = 'Dismiss'; close.setAttribute('aria-label', `Dismiss download ${name}`); close.style.marginLeft = '12px';
  close.onclick = () => { if (blob) URL.revokeObjectURL(url); row.remove(); if (!region!.children.length) region!.remove(); };
  row.append(text, link, close); region.appendChild(row);
  link.click();
}
