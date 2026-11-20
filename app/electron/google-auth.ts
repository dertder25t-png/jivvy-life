// Google sign-in for the desktop app: OAuth code flow with PKCE over a one-shot loopback server.
// The code and verifier are never logged; they go straight back to the renderer, which sends them to our API.
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { shell } from 'electron';
import { GOOGLE_CLIENT_ID, type GoogleAuthResult } from '../shared/google';

const TIMEOUT_MS = 3 * 60 * 1000;
const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Jivvy Life</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#09090b;color:#e4e4e7;font:16px system-ui,sans-serif"><p>${msg}</p></body>`;

let cancelCurrent: ((reason: string) => void) | null = null;

export function googleSignIn(): Promise<GoogleAuthResult> {
  if (!GOOGLE_CLIENT_ID) {
    return Promise.reject(new Error('Google sign-in is not set up yet: add the OAuth client ID to shared/google.ts.'));
  }
  cancelCurrent?.('Cancelled by a newer sign-in attempt.');

  const codeVerifier = crypto.randomBytes(48).toString('base64url'); // 64 chars
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('base64url');

  return new Promise<GoogleAuthResult>((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout;
    const server = http.createServer();
    const finish = (err: Error | null, value?: GoogleAuthResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (cancelCurrent === cancel) cancelCurrent = null;
      server.close();
      server.closeAllConnections();
      if (err) reject(err);
      else resolve(value as GoogleAuthResult);
    };
    const cancel = (reason: string) => finish(new Error(reason));
    cancelCurrent = cancel;

    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const reply = (status: number, msg: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
        res.end(PAGE(msg));
      };
      if (url.searchParams.get('state') !== state) {
        reply(400, 'Sign-in failed: state mismatch. Close this tab and try again.');
        finish(new Error('Google sign-in failed: state mismatch.'));
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        reply(400, 'Sign-in was cancelled or failed. You can close this tab.');
        finish(new Error(`Google sign-in failed: ${error.slice(0, 80)}`));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        reply(400, 'Sign-in failed: no code received. You can close this tab.');
        finish(new Error('Google sign-in failed: no code received.'));
        return;
      }
      reply(200, 'Signed in. You can close this tab and return to Jivvy Life.');
      finish(null, { code, codeVerifier, redirectUri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback` });
    });
    server.on('error', (e) => finish(new Error(`Google sign-in could not start: ${e.message}`)));

    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      const q = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        prompt: 'select_account',
      });
      timer = setTimeout(() => finish(new Error('Google sign-in timed out. Try again.')), TIMEOUT_MS);
      shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${q.toString().replace(/\+/g, '%20')}`).catch(() => finish(new Error('Could not open your browser.')));
    });
  });
}
