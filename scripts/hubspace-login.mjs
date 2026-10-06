// One-time Hubspace login: creates the refresh-token file the gateway adapter uses (the password is never stored).
// Needs HUBSPACE_USERNAME and HUBSPACE_PASSWORD (e.g. in .env); remove the password from .env afterwards.
// Run: node --env-file=.env scripts/hubspace-login.mjs     Unofficial Afero flow (per aioafero); may change without notice.
import { createInterface } from 'node:readline/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

const HOST = 'accounts.hubspaceconnect.com', REALM = 'thd', CLIENT = 'hubspace_android', REDIRECT = 'hubspace-app://loginredirect';
const base = p => `https://${HOST}/auth/realms/${REALM}/${p}`;
const UA = 'Mozilla/5.0 (Linux; Android 15; openlight Build/test; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.63 Mobile Safari/537.36';
const jar = new Map();
const keep = res => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const req = async (url, init = {}) => { const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'user-agent': UA, cookie: cookie(), ...init.headers } }); keep(res); return res; };
const formParams = (html, id) => {
  const m = html.match(new RegExp(`<form[^>]*id="${id}"[^>]*action="([^"]+)"`)); if (!m) return null;
  const q = new URL(m[1].replaceAll('&amp;', '&')).searchParams;
  return Object.fromEntries(['session_code', 'execution', 'tab_id'].map(k => [k, q.get(k)]));
};
const codeFrom = res => { const loc = res.headers.get('location'); if (!loc) return null; return new URL(loc).searchParams.get('code'); };
const ask = async q => { const rl = createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question(q); rl.close(); return a.trim(); };

const verifier = randomBytes(40).toString('base64url').replace(/[^a-zA-Z0-9]+/g, '');
const challenge = createHash('sha256').update(verifier).digest('base64url');

const user = process.env.HUBSPACE_USERNAME, pass = process.env.HUBSPACE_PASSWORD;
if (!user || !pass) throw new Error('Set HUBSPACE_USERNAME and HUBSPACE_PASSWORD in .env');

const authUrl = base('protocol/openid-connect/auth') + '?' + new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'openid offline_access' });
let res = await req(authUrl);
let code;
if (res.status === 302) code = codeFrom(res);
else if (res.status === 200) {
  const p = formParams(await res.text(), 'kc-form-login'); if (!p) throw new Error('login form not found (page layout changed?)');
  const post = base('login-actions/authenticate') + '?' + new URLSearchParams({ ...p, client_id: CLIENT });
  const hdr = { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'io.afero.partner.hubspace' };
  res = await req(post, { method: 'POST', headers: hdr, body: new URLSearchParams({ username: user, password: pass, credentialId: '' }) });
  const body = res.status === 200 ? await res.text() : '';
  if (body.includes('kc-otp-login-form')) {
    const o = formParams(body, 'kc-otp-login-form'); if (!o) throw new Error('OTP form not found');
    const otpUrl = base('login-actions/authenticate') + '?' + new URLSearchParams({ ...o, client_id: CLIENT });
    res = await req(otpUrl, { method: 'POST', headers: hdr, body: new URLSearchParams({ action: 'submit', flowName: 'doLogIn', emailCode: await ask('Hubspace emailed you a code. Enter it: ') }) });
    if (res.status !== 302) throw new Error('OTP rejected (wrong or expired code)');
  } else if (res.status !== 302) throw new Error(`login rejected (HTTP ${res.status})`);
  code = codeFrom(res);
} else throw new Error(`unexpected auth page status ${res.status}`);
if (!code) throw new Error('no auth code in redirect');

const tok = await (await fetch(base('protocol/openid-connect/token'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: CLIENT }) })).json();
if (!tok.id_token) throw new Error('token exchange failed: ' + JSON.stringify(Object.keys(tok)));
const file = process.env.HUBSPACE_TOKEN_FILE || `${homedir()}/.config/openlight/hubspace-token.json`; mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(file, JSON.stringify({ refresh_token: tok.refresh_token }), { mode: 0o600 });
console.log('login ok; refresh token saved to', file);
