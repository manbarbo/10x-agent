/**
 * OAuth redirect URI sent to Google (authorize + token exchange).
 * Must match an "Authorized redirect URI" in Google Cloud Console exactly.
 */
export function getGoogleOAuthRedirectUri(requestUrl: string): string {
  const explicit = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const origin = new URL(requestUrl).origin;
  return `${origin}/api/integrations/google/callback`;
}
