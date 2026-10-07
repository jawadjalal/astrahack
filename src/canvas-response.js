/** A marketing-site redirect or HTML fallback must never look like an empty canvas API response. */
export async function readCanvasJson(response) {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new Error('Canvas API redirected instead of returning data. Check CANVAS_URL and deployment routing.');
  }
  const contentType = response.headers?.get('content-type') || '';
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(contentType)) {
    throw new Error(`Canvas API returned a non-JSON response (HTTP ${response.status}). Check deployment API routing.`);
  }
  let body;
  try { body = await response.json(); }
  catch { throw new Error('Canvas API returned invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Canvas API returned an invalid response object.');
  return body;
}
