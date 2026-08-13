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
const EVENTS = (calendarId: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`

/** How far back a full resync reaches. Google keeps the same filter for every
 *  subsequent syncToken request, so this is chosen once and then inherited. */
const FULL_SYNC_LOOKBACK_DAYS = 30

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

interface GoogleEvent {
  id: string
  etag?: string
  status?: string
  summary?: string
  htmlLink?: string
  updated?: string
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  extendedProperties?: { private?: Record<string, string> }
}

/**
 * An all-day event carries `date` rather than `dateTime`. It is stored as the
 * plain calendar date at UTC midnight and flagged, never run through a
 * timezone conversion -- that is the classic off-by-one-day bug.
 */
function eventBounds(e: GoogleEvent): { start: string | null; end: string | null; allDay: boolean } {
  const allDay = Boolean(e.start?.date)
  const start = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null)
  const end = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null)
  return { start, end, allDay }
}

/**
 * Incremental pull. Three things make this survivable rather than merely
 * working: showDeleted so cancellations arrive at all, a 410 handler because
 * Google expires sync tokens as normal operation, and a sync_runs row written
 * either way so a silent failure still leaves a trace.
 */
async function runSync(db: SupabaseClient, userId: string): Promise<Record<string, unknown>> {
  const { data: run } = await db
    .from('planner_sync_runs')
    .insert({ user_id: userId, kind: 'poll' })
    .select('id')
    .single()

  const finish = async (ok: boolean, changed: number, error?: string) => {
    if (run?.id) {
      await db
        .from('planner_sync_runs')
        .update({ finished_at: new Date().toISOString(), ok, changed_count: changed, error: error ?? null })
        .eq('id', run.id)
    }
  }

  try {
    const accessToken = await getAccessToken(db, userId)

    let { data: state } = await db
      .from('planner_sync_state')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (!state) {
      const inserted = await db
        .from('planner_sync_state')
        .insert({ user_id: userId, calendar_id: 'primary' })
        .select('*')
        .single()
      state = inserted.data
    }

    const calendarId: string = state?.calendar_id ?? 'primary'
    let syncToken: string | null = state?.sync_token ?? null
    let wasFull = !syncToken
    let pageToken: string | null = null
    let changed = 0
    let nextSyncToken: string | null = null

    for (let page = 0; page < 40; page++) {
      const params = new URLSearchParams({
        singleEvents: 'true',
        showDeleted: 'true',
        maxResults: '250',
      })
      if (syncToken) params.set('syncToken', syncToken)
      else {
        const since = new Date(Date.now() - FULL_SYNC_LOOKBACK_DAYS * 86_400_000)
        params.set('timeMin', since.toISOString())
      }
      if (pageToken) params.set('pageToken', pageToken)

      const res = await fetch(`${EVENTS(calendarId)}?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      // 410 is routine, not an outage: the cursor aged out and the only cure
      // is a full resync. Restart the loop once with the token cleared.
      if (res.status === 410 && syncToken) {
        await db.from('planner_sync_state').update({ sync_token: null }).eq('user_id', userId)
        syncToken = null
        pageToken = null
        wasFull = true
        continue
      }

      if (!res.ok) throw new Error(`calendar_list_failed_${res.status}`)

      const body = (await res.json()) as {
        items?: GoogleEvent[]
        nextPageToken?: string
        nextSyncToken?: string
      }

      const rows = (body.items ?? []).map((e) => {
        const { start, end, allDay } = eventBounds(e)
        return {
          user_id: userId,
          gcal_event_id: e.id,
          calendar_id: calendarId,
          etag: e.etag ?? null,
          summary: e.summary ?? null,
          start_at: start,
          end_at: end,
          is_all_day: allDay,
          status: e.status ?? 'confirmed',
          html_link: e.htmlLink ?? null,
          remote_updated_at: e.updated ?? null,
          owned_by_app: Boolean(e.extendedProperties?.private?.plannerTaskId),
          raw: e as unknown as Record<string, unknown>,
          synced_at: new Date().toISOString(),
        }
      })

      if (rows.length) {
        const { error } = await db
          .from('planner_calendar_events')
          .upsert(rows, { onConflict: 'user_id,gcal_event_id' })
        if (error) throw new Error(`shadow_write_failed: ${error.message}`)
        changed += rows.length
      }

      pageToken = body.nextPageToken ?? null
      if (body.nextSyncToken) nextSyncToken = body.nextSyncToken
      if (!pageToken) break
    }

    const stamp = new Date().toISOString()
    await db
      .from('planner_sync_state')
      .update({
        sync_token: nextSyncToken,
        last_incremental_at: stamp,
        ...(wasFull ? { last_full_sync_at: stamp } : {}),
        consecutive_failures: 0,
      })
      .eq('user_id', userId)

    await finish(true, changed)
    return { ok: true, full: wasFull, changed }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown'
    await db.rpc('planner_bump_sync_failure', { p_user_id: userId }).then(
      () => undefined,
      () => undefined,
    )
    await finish(false, 0, message)
    throw e
  }
}

/**
 * Deterministic Google event id for a task. Google accepts client-supplied ids
 * in base32hex (a-v, 0-9); uuid hex digits plus a 'tsk' prefix fit entirely,
 * so a retried create collides with itself (409) instead of duplicating.
 */
function eventIdForTask(taskId: string): string {
  return 'tsk' + taskId.replace(/-/g, '').toLowerCase()
}

interface OutboxTask {
  id: string
  user_id: string
  title: string
  notes: string | null
  status: string
  scheduled_start: string | null
  scheduled_end: string | null
  gcal_event_id: string | null
}

function eventBodyForTask(task: OutboxTask): Record<string, unknown> {
  return {
    summary: (task.status === 'done' ? '✔ ' : '') + task.title,
    description: task.notes ?? '',
    start: { dateTime: task.scheduled_start },
    end: { dateTime: task.scheduled_end },
    // The marker phase 4's echo suppression and reconcile key off.
    extendedProperties: { private: { plannerTaskId: task.id } },
  }
}

/**
 * Pushes pending outbox rows to Google. Retries back off exponentially and
 * cap at an hour; a row only dies when its task disappears. The drain is
 * invoked opportunistically after user actions now and by cron in phase 4 --
 * a failed nudge is never lost work, only deferred.
 */
async function drainOutbox(db: SupabaseClient): Promise<{ processed: number; failed: number }> {
  const { data: rows } = await db
    .from('planner_outbox')
    .select('*')
    .is('done_at', null)
    .lte('next_attempt_at', new Date().toISOString())
    .order('id', { ascending: true })
    .limit(25)

  if (!rows?.length) return { processed: 0, failed: 0 }

  const tokens = new Map<string, string>()
  let processed = 0
  let failed = 0

  for (const row of rows) {
    try {
      let accessToken = tokens.get(row.user_id)
      if (!accessToken) {
        accessToken = await getAccessToken(db, row.user_id)
        tokens.set(row.user_id, accessToken)
      }

      const { data: task } = await db
        .from('planner_tasks')
        .select('id, user_id, title, notes, status, scheduled_start, scheduled_end, gcal_event_id')
        .eq('id', row.task_id)
        .maybeSingle()

      const markDone = () =>
        db.from('planner_outbox').update({ done_at: new Date().toISOString() }).eq('id', row.id)

      if (row.op === 'delete') {
        const eventId = row.payload?.gcal_event_id ?? task?.gcal_event_id
        if (eventId) {
          const res = await fetch(`${EVENTS('primary')}/${encodeURIComponent(eventId)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          // 404/410 mean already gone -- the desired state, not an error.
          if (!res.ok && res.status !== 404 && res.status !== 410) {
            throw new Error(`delete_failed_${res.status}`)
          }
          await db
            .from('planner_calendar_events')
            .delete()
            .eq('user_id', row.user_id)
            .eq('gcal_event_id', eventId)
        }
        if (task?.gcal_event_id) {
          await db.from('planner_tasks').update({ gcal_event_id: null, gcal_etag: null }).eq('id', task.id)
        }
        await markDone()
        processed++
        continue
      }

      // create/update below need a live, schedulable task; if it vanished or
      // unscheduled since enqueue, the trigger has queued the matching delete.
      if (!task || !task.scheduled_start || !task.scheduled_end) {
        await markDone()
        continue
      }

      const body = eventBodyForTask(task)
      let res: Response

      if (row.op === 'create' || !task.gcal_event_id) {
        res = await fetch(EVENTS('primary'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, id: eventIdForTask(task.id) }),
        })
        // 409: this exact create already succeeded once (retry after a lost
        // response). Converge by patching the same deterministic id.
        if (res.status === 409) {
          res = await fetch(`${EVENTS('primary')}/${eventIdForTask(task.id)}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        }
      } else {
        res = await fetch(`${EVENTS('primary')}/${encodeURIComponent(task.gcal_event_id)}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        // The event died remotely; recreate under the same deterministic id.
        if (res.status === 404 || res.status === 410) {
          res = await fetch(EVENTS('primary'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, id: eventIdForTask(task.id) }),
          })
        }
      }

      if (!res.ok) throw new Error(`${row.op}_failed_${res.status}`)

      const event = (await res.json()) as GoogleEvent & { htmlLink?: string }

      // Bookkeeping write: gcal_* are outside the trigger's relevant-field row,
      // so this does not re-enqueue, and outside bump_local_updated_at's list,
      // so it does not masquerade as a local edit.
      await db
        .from('planner_tasks')
        .update({ gcal_event_id: event.id, gcal_etag: event.etag ?? null })
        .eq('id', task.id)

      // Seed the mirror immediately: the grid shows the event without waiting
      // for the next pull, and the stored etag lets phase 4 drop our own echo.
      const { start, end, allDay } = eventBounds(event)
      await db.from('planner_calendar_events').upsert(
        {
          user_id: row.user_id,
          gcal_event_id: event.id,
          calendar_id: 'primary',
          etag: event.etag ?? null,
          summary: event.summary ?? null,
          start_at: start,
          end_at: end,
          is_all_day: allDay,
          status: event.status ?? 'confirmed',
          html_link: event.htmlLink ?? null,
          remote_updated_at: event.updated ?? null,
          owned_by_app: true,
          raw: event as unknown as Record<string, unknown>,
          synced_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,gcal_event_id' },
      )

      await markDone()
      processed++
    } catch (e) {
      failed++
      const message = e instanceof Error ? e.message : 'unknown'
      const attempts = (row.attempts ?? 0) + 1
      const backoffMinutes = Math.min(2 ** attempts, 60)
      await db
        .from('planner_outbox')
        .update({
          attempts,
          last_error: message,
          next_attempt_at: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
        })
        .eq('id', row.id)
    }
  }

  return { processed, failed }
}

async function handleDrain(req: Request): Promise<Response> {
  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)
  const db = admin()
  const result = await drainOutbox(db)
  await db.from('planner_sync_runs').insert({
    user_id: user.id,
    kind: 'outbox',
    finished_at: new Date().toISOString(),
    ok: result.failed === 0,
    changed_count: result.processed,
    error: result.failed ? `${result.failed} rows failed` : null,
  })
  return json(result)
}

async function handleSync(req: Request): Promise<Response> {
  const user = await requireUser(req)
  if (!user) return json({ error: 'unauthorized' }, 401)
  try {
    return json(await runSync(admin(), user.id))
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown'
    return json({ error: reason }, reason === 'not_connected' ? 404 : 502)
  }
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
      case 'sync':
        return await handleSync(req)
      case 'drain':
        return await handleDrain(req)
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
