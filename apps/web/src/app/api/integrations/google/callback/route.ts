import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getGoogleOAuthRedirectUri } from "@/lib/google-oauth-redirect";
import {
  createServerClient,
  upsertIntegration,
  encrypt,
  decrypt,
  mergeGoogleTokenResponse,
} from "@agents/db";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const errorParam = searchParams.get("error");

  if (errorParam) {
    return NextResponse.redirect(
      `${origin}/settings?google_calendar=error&reason=${encodeURIComponent(errorParam)}`
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const cookieState = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("google_oauth_state="))
    ?.split("=")[1];

  if (!state || !cookieState || state !== cookieState) {
    return NextResponse.redirect(
      `${origin}/settings?google_calendar=error&reason=state_mismatch`
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${origin}/settings?google_calendar=error&reason=no_code`
    );
  }

  const redirectUri = getGoogleOAuthRedirectUri(request.url);
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      `${origin}/settings?google_calendar=error&reason=not_configured`
    );
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    error?: string;
  };

  if (!tokenRes.ok || !tokenData.access_token) {
    console.error("Google token exchange failed:", tokenData);
    return NextResponse.redirect(
      `${origin}/settings?google_calendar=error&reason=token_exchange`
    );
  }

  const db = createServerClient();
  const { data: existing } = await db
    .from("user_integrations")
    .select("encrypted_tokens")
    .eq("user_id", user.id)
    .eq("provider", "google_calendar")
    .maybeSingle();

  let existingPlain: string | null = null;
  if (existing?.encrypted_tokens) {
    try {
      existingPlain = decrypt(existing.encrypted_tokens as string);
    } catch {
      existingPlain = null;
    }
  }

  const bundle = mergeGoogleTokenResponse(existingPlain, {
    access_token: tokenData.access_token,
    expires_in: tokenData.expires_in,
    refresh_token: tokenData.refresh_token,
  });

  if (!bundle) {
    return NextResponse.redirect(
      `${origin}/settings?google_calendar=error&reason=no_refresh_token`
    );
  }

  const scopes = tokenData.scope
    ? tokenData.scope.split(/\s+/).filter(Boolean)
    : ["https://www.googleapis.com/auth/calendar.events"];

  const encrypted = encrypt(JSON.stringify(bundle));
  await upsertIntegration(db, user.id, "google_calendar", scopes, encrypted);

  const response = NextResponse.redirect(
    `${origin}/settings?google_calendar=connected`
  );
  response.cookies.delete("google_oauth_state");
  return response;
}
