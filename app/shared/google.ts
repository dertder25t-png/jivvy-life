// Google sign-in settings shared by the main process and the renderer.

/**
 * Paste your Google Cloud OAuth client ID here (type: "Desktop app").
 * Create it at console.cloud.google.com -> APIs & Services -> Credentials.
 * It is public, not a secret. Leave empty and "Sign in with Google" shows a clear error.
 */
export const GOOGLE_CLIENT_ID = '589994496212-15pmn480q7qltbevr5dn0jgdsfucp82q.apps.googleusercontent.com';

/** What the main process hands back after the browser round trip; the renderer sends it to the API. */
export interface GoogleAuthResult {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}
