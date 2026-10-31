import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { REPOSITORY } from '../extension/core.mjs';

const exec = promisify(execFile);
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../extension');

export async function githubPR(repository, number) {
  const { stdout } = await exec('gh', ['api', '--hostname', 'github.com', `repos/${repository}/pulls/${number}`], {
    timeout: 12000, maxBuffer: 2 * 1024 * 1024,
  });
  const pr = JSON.parse(stdout);
  return { repository, number: pr.number, url: pr.html_url, state: pr.state, merged: pr.merged === true,
    mergeCommit: pr.merged === true ? pr.merge_commit_sha : null };
}

export function createServer({ repository = 'PDF-magic/opener', extensionId = '', lookup = githubPR, port = 8794 } = {}) {
  if (!REPOSITORY.test(repository)) throw Error('Invalid repository.');
  if (extensionId && !/^[a-p]{32}$/.test(extensionId)) throw Error('Use the extension ID shown by Brave.');
  const origin = extensionId ? `chrome-extension://${extensionId}` : null;
  return http.createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`) return json(403, { error: 'Unexpected host.' });
    if (req.headers.origin) {
      const previewAsset = req.method === 'GET' && req.headers.origin === `http://127.0.0.1:${req.socket.localPort}`;
      if (req.headers.origin !== origin && !previewAsset) return json(403, { error: 'Extension origin is not paired.' });
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (req.headers.origin !== origin || !origin) return json(403, { error: 'Extension is not paired.' });
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204); res.end(); return;
    }
    if (req.method === 'GET' && req.url === '/health') return json(200, { service: 'studio-chat-dispatcher', repository, extensionId, configured: Boolean(origin) });
    if (req.method === 'GET') {
      const name = req.url === '/' ? 'dashboard.html' : req.url?.slice(1);
      if (!['dashboard.html', 'dashboard.css', 'dashboard.js'].includes(name)) return json(404, { error: 'Not found.' });
      try {
        const data = await readFile(resolve(assets, name));
        res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        res.end(data);
      } catch { json(500, { error: 'Dashboard unavailable.' }); }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/verify') return json(404, { error: 'Not found.' });
    if (!origin || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return json(403, { error: 'Paired extension required.' });
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 2048) return json(413, { error: 'Request too large.' });
      }
      const input = JSON.parse(body);
      if (input.repository !== repository || !Number.isSafeInteger(input.number) || input.number < 1) return json(400, { error: 'Invalid repository or PR number.' });
      json(200, await lookup(repository, input.number));
    } catch { json(502, { error: 'GitHub verification failed. Check gh login and network connectivity; no task was advanced.' }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const repository = option('--repo') || 'PDF-magic/opener';
  const extensionId = option('--extension-id') || '';
  const server = createServer({ repository, extensionId });
  server.on('error', error => { console.error(`Dispatcher could not start: ${error.code || 'server error'}`); process.exitCode = 1; });
  server.listen(8794, '127.0.0.1', () => {
    console.log(`Studio Chat Dispatcher: http://127.0.0.1:8794 — ${repository}`);
    console.log(extensionId ? 'GitHub verifier paired to the configured extension.' : 'Preview available. Add --extension-id from brave://extensions to enable verification.');
  });
}
