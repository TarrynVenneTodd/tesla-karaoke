/*
 * OPTIONAL. Only needed if the app's Listen button says it can't reach AudD.
 *
 * A tiny Cloudflare Worker that forwards the recorded clip to AudD and adds
 * your AudD token on the server side, so the token never sits in the browser.
 *
 * Setup (no command line needed), see README step 5:
 *   1. Cloudflare dashboard → Workers & Pages → Create → Worker → Deploy.
 *   2. Edit code → replace everything with this file → Deploy.
 *   3. Settings → Variables and Secrets:
 *        AUDD_TOKEN      (type: Secret)  = your AudD API token
 *        ALLOWED_ORIGIN  (type: Text)    = https://YOUR-GITHUB-NAME.github.io
 *   4. Copy the worker's address (https://….workers.dev) into the app's
 *      Settings → Listen → Proxy URL.
 */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '*').replace(/\/+$/, '');

    const cors = {
      'Access-Control-Allow-Origin': allowed === '*' ? '*' : allowed,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reply({ status: 'error', error: { error_code: 0, error_message: 'POST a "file" field' } }, 405, cors);
    if (allowed !== '*' && origin !== allowed) return reply({ status: 'error', error: { error_code: 0, error_message: 'Origin not allowed' } }, 403, cors);
    if (!env.AUDD_TOKEN) return reply({ status: 'error', error: { error_code: 0, error_message: 'AUDD_TOKEN secret is not set on the worker' } }, 500, cors);

    let form;
    try { form = await request.formData(); }
    catch (e) { return reply({ status: 'error', error: { error_code: 700, error_message: 'Send the clip as multipart/form-data' } }, 400, cors); }

    const file = form.get('file');
    if (!file || typeof file === 'string') return reply({ status: 'error', error: { error_code: 700, error_message: 'No file received' } }, 400, cors);
    if (file.size > 10 * 1024 * 1024) return reply({ status: 'error', error: { error_code: 400, error_message: 'Clip is larger than 10 MB' } }, 413, cors);

    const out = new FormData();
    out.append('api_token', env.AUDD_TOKEN);
    out.append('file', file, file.name || 'clip.webm');

    const upstream = await fetch('https://api.audd.io/', { method: 'POST', body: out });
    const body = await upstream.text();
    return new Response(body, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};

function reply(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
