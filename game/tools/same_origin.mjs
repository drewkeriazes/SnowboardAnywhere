// BUG-110: the one same-origin test for every dev POST route that writes a file or starts a download
// (/__compare/save, /__attract/save, /__attract/shot, /__packs/get). A browser puts the page's Origin on a
// cross-site POST, so a request whose Origin is present and is not this server's own host (the Host header, so it
// holds under `npm run host` too) is refused. No Origin (curl, a same-origin fetch in some browsers) passes.

/** true when the request is from this server's own page, or carries no Origin at all */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; } // "null" or junk
}

/** Answer 403 and return true when the request is cross-origin; the route then stops. */
export function refuseForeignOrigin(req, res) {
  if (isSameOrigin(req)) return false;
  res.statusCode = 403;
  res.setHeader('content-type', 'text/plain');
  res.end('same-origin only');
  return true;
}
