import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

/**
 * Google Calendar connection: consent handshake, token custody, calendar list.
 *
 * All four routes live in one function so the token helpers below are shared
 * rather than copied. `verify_jwt` is off because Google redirects a browser
 * straight to /callback with no Authorization header -- every other route does
 * its own bearer check via requireUser().
 *
 * See docs/ARCHITECTURE.md §6. The single most important setting is not in this
 * file: the OAuth consent screen must be published to "In Production", or every
 * refresh token issued here expires after 7 days.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
const APP_URL = Deno.env.get('APP_URL') ?? 'http://localhost:5173'

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/google-calendar/callback`

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ')

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const CALENDAR_LIST = 'https://www.googleapis.com/calendar/v3/users/me/calendarList'

/** Refresh this early so a request never races the expiry it just checked. */
const EXPIRY_MARGIN_SECONDS = 60

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const admin = (): SupabaseClient =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// ---------------------------------------------------------------- helpers --

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

/** The id_token arrives over TLS straight from Google, so the claims are read, not verified. */
function readIdTokenClaims(idToken: string | undefined): { sub?: string; email?: string } {
  if (!idToken) return {}
  const payload = idToken.split('.')[1]
  if (!payload) return {}
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '=')))
  } catch {
    return {}
  }
}

async function requireUser(req: Request): Promise<{ id: string } | null> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return null
  return { id: data.user.id }
}

// ------------------------------------------------------------ token custody --

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  id_token?: string
  error?: string
  error_description?: string
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  return (await res.json()) as TokenResponse
}

/**
 * Returns a usable access token, refreshing only when the cached one is inside
 * the expiry margin. An `invalid_grant` here is terminal: the refresh token is
 * gone and only the user can fix it, so the connection is flagged rather than
 * retried.
 */
async function getAccessToken(db: SupabaseClient, userId: string): Promise<string> {
  const { data: row } = await db
    .from('planner_google_tokens')
    .select('access_token, access_token_expires_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (!row) throw new Error('not_connected')

  const expiresAt = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0
  if (row.access_token && expiresAt > Date.now() + EXPIRY_MARGIN_SECONDS * 1000) {
    return row.access_token
  }

  const { data: refreshToken, error: readError } = await db.rpc('planner_read_refresh_token', {
    p_user_id: userId,
  })
  if (readError || !refreshToken) throw new Error('not_connected')

  const token = await postToken({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  if (!token.access_token) {
    const terminal = token.error === 'invalid_grant'
    await db
      .from('planner_google_accounts')
      .update({
        status: terminal ? 'needs_reauth' : 'connected',
        last_error: token.error_description ?? token.error ?? 'refresh failed',
      })
      .eq('user_id', userId)
    throw new Error(terminal ? 'needs_reauth' : 'refresh_failed')
  }

  await db
    .from('planner_google_tokens')
    .update({
      access_token: token.access_token,
      access_token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
    })
    .eq('user_id', userId)

  await db
    .from('planner_google_accounts')
    .update({ status: 'connected', last_error: null, last_health_check_at: new Date().toISOString() })
    .eq('user_id', userId)

  return token.access_token
}

// ------------------------------------------------------------------ routes --

async function handleStart(req: Request): Promise<Response> {
  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)
  if (!GOOGLE_CLIENT_ID) return json({ error: 'google_client_not_configured' }, 503)

  const db = admin()
  const state = randomToken()
  const verifier = randomToken(64)

  const { error } = await db.from('planner_oauth_states').insert({
    state,
    user_id: user.id,
    code_verifier: verifier,
  })
  if (error) return json({ error: 'could_not_start', detail: error.message }, 500)

  // Expired handshakes are cleared opportunistically; there is no cron yet.
  await db.from('planner_oauth_states').delete().lt('expires_at', new Date().toISOString())

  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES)
  // offline + consent together are what guarantee a refresh token comes back,
  // including on a repeat authorisation where Google would otherwise omit it.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', await pkceChallenge(verifier))
  url.searchParams.set('code_challenge_method', 'S256')

  return json({ url: url.toString() })
}

function redirectToApp(status: 'connected' | 'error', detail?: string): Response {
  const target = new URL(APP_URL)
  target.searchParams.set('calendar', status)
  if (detail) target.searchParams.set('detail', detail)
  return new Response(null, { status: 302, headers: { ...CORS, Location: target.toString() } })
}

async function handleCallback(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams
  const code = params.get('code')
  const state = params.get('state')

  if (params.get('error')) return redirectToApp('error', params.get('error')!)
  if (!code || !state) return redirectToApp('error', 'missing_code_or_state')

  const db = admin()

  // Single-use: consumed on read, so a replayed callback cannot re-authorise.
  const { data: handshake } = await db
    .from('planner_oauth_states')
    .select('user_id, code_verifier, expires_at')
    .eq('state', state)
    .maybeSingle()

  if (!handshake) return redirectToApp('error', 'unknown_state')
  await db.from('planner_oauth_states').delete().eq('state', state)

  if (Date.parse(handshake.expires_at) < Date.now()) return redirectToApp('error', 'state_expired')

  const token = await postToken({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code,
    code_verifier: handshake.code_verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  })

  if (!token.access_token) return redirectToApp('error', token.error ?? 'token_exchange_failed')
  if (!token.refresh_token) {
    // Without this the connection would work today and die at the first refresh.
    return redirectToApp('error', 'no_refresh_token')
  }

  const claims = readIdTokenClaims(token.id_token)

  const { error: accountError } = await db.from('planner_google_accounts').upsert(
    {
      user_id: handshake.user_id,
      google_sub: claims.sub ?? 'unknown',
      email: claims.email ?? null,
      scopes: token.scope ?? SCOPES,
      status: 'connected',
      last_error: null,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  )
  if (accountError) return redirectToApp('error', 'account_write_failed')

  const { data: secretId, error: vaultError } = await db.rpc('planner_store_refresh_token', {
    p_user_id: handshake.user_id,
    p_token: token.refresh_token,
  })
  if (vaultError || !secretId) return redirectToApp('error', 'token_store_failed')

  const { error: tokenError } = await db.from('planner_google_tokens').upsert(
    {
      user_id: handshake.user_id,
      refresh_token_secret_id: secretId,
      access_token: token.access_token,
      access_token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
    },
    { onConflict: 'user_id' },
  )
  if (tokenError) return redirectToApp('error', 'token_write_failed')

  return redirectToApp('connected')
}

async function handleCalendars(req: Request): Promise<Response> {
  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)

  const db = admin()
  let accessToken: string
  try {
    accessToken = await getAccessToken(db, user.id)
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown'
    return json({ error: reason }, reason === 'not_connected' ? 404 : 502)
  }

  const res = await fetch(`${CALENDAR_LIST}?minAccessRole=writer&showHidden=false`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return json({ error: 'calendar_api_failed', status: res.status }, 502)

  const body = await res.json()
  const calendars = (body.items ?? []).map((c: Record<string, unknown>) => ({
    id: c.id,
    summary: c.summary,
    primary: c.primary === true,
    timeZone: c.timeZone,
    backgroundColor: c.backgroundColor,
    accessRole: c.accessRole,
  }))

  return json({ calendars })
}

async function handleDisconnect(req: Request): Promise<Response> {
  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)

  const db = admin()
  // Best-effort revoke at Google; local state is cleared either way.
  try {
    const { data: refreshToken } = await db.rpc('planner_read_refresh_token', { p_user_id: user.id })
    if (refreshToken) {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }),
      })
    }
  } catch {
    // A failed revoke must not block disconnecting locally.
  }

  await db.from('planner_google_accounts').delete().eq('user_id', user.id)
  return json({ ok: true })
}

// ----------------------------------------------------------------- router --

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop()

  try {
    switch (route) {
      case 'start':
        return await handleStart(req)
      case 'callback':
        return await handleCallback(req)
      case 'calendars':
        return await handleCalendars(req)
      case 'disconnect':
        return await handleDisconnect(req)
      default:
        return json({ error: 'not_found', route }, 404)
    }
  } catch (e) {
    console.error('google-calendar', route, e)
    return json({ error: 'internal', detail: e instanceof Error ? e.message : 'unknown' }, 500)
  }
})
