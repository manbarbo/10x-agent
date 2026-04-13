import type { DbClient } from "./client";
import { decrypt, encrypt } from "./crypto";
import { upsertIntegration } from "./queries/integrations";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleCalendarTokenBundle {
  refresh_token: string;
  access_token: string;
  expires_at: number;
}

export function mergeGoogleTokenResponse(
  existingDecrypted: string | null,
  tokenData: {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  }
): GoogleCalendarTokenBundle | null {
  const expiresIn = tokenData.expires_in ?? 3600;
  const expires_at = Date.now() + expiresIn * 1000;
  let refresh_token = tokenData.refresh_token;
  if (!refresh_token && existingDecrypted) {
    try {
      const prev = JSON.parse(existingDecrypted) as Partial<GoogleCalendarTokenBundle>;
      if (prev.refresh_token) refresh_token = prev.refresh_token;
    } catch {
      // ignore
    }
  }
  if (!refresh_token) return null;
  return {
    refresh_token,
    access_token: tokenData.access_token,
    expires_at,
  };
}

async function refreshAccessToken(refresh_token: string): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth client not configured");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Google token refresh failed: ${data.error ?? res.status} ${JSON.stringify(data)}`
    );
  }
  return {
    access_token: data.access_token,
    expires_in: data.expires_in ?? 3600,
    refresh_token: data.refresh_token,
  };
}

/**
 * Returns a valid Google Calendar API access token for the user, refreshing and persisting if needed.
 */
export async function getGoogleCalendarAccessToken(
  db: DbClient,
  userId: string
): Promise<string | undefined> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;

  const { data: row, error } = await db
    .from("user_integrations")
    .select("encrypted_tokens, scopes")
    .eq("user_id", userId)
    .eq("provider", "google_calendar")
    .eq("status", "active")
    .maybeSingle();
  if (error || !row?.encrypted_tokens) return undefined;

  let bundle: GoogleCalendarTokenBundle;
  try {
    bundle = JSON.parse(decrypt(row.encrypted_tokens as string)) as GoogleCalendarTokenBundle;
  } catch {
    return undefined;
  }

  if (!bundle.access_token || !bundle.refresh_token) return undefined;

  const bufferMs = 5 * 60 * 1000;
  if (bundle.expires_at > Date.now() + bufferMs) {
    return bundle.access_token;
  }

  const refreshed = await refreshAccessToken(bundle.refresh_token);
  const merged: GoogleCalendarTokenBundle = {
    refresh_token: refreshed.refresh_token ?? bundle.refresh_token,
    access_token: refreshed.access_token,
    expires_at: Date.now() + refreshed.expires_in * 1000,
  };

  const scopes = (row.scopes as string[]) ?? [];
  await upsertIntegration(
    db,
    userId,
    "google_calendar",
    scopes,
    encrypt(JSON.stringify(merged))
  );

  return merged.access_token;
}
