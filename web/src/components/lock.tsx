import { useCallback, useEffect, useState } from 'react'
import { KeyRoundIcon, LockIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type State = 'checking' | 'setup' | 'locked' | 'open'
const SKIP_KEY = 'ledger:touch-id-skipped'
const HIDDEN_LOCK_MS = 60_000 // hidden (another tab, minimized) longer than this → locked
const IDLE_LOCK_MS = 5 * 60_000 // no mouse or keyboard this long → locked
const SLEEP_GAP_MS = 30_000 // the 5 s check skipped this much time → the Mac slept → locked

const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error)
  return data
}

// manual = the lock button. Auto-locks (idle, sleep) do nothing until a passkey is set up; the button offers setup.
export async function lockNow(manual = false) {
  await post('/api/auth/lock').catch(() => {})
  dispatchEvent(new CustomEvent('ledger:locked', { detail: { manual } }))
}

// Passkey (WebAuthn): Touch ID, Windows Hello, a phone or a security key. The server checks the signature and hands out a session cookie it requires on every
// /api call, so this is a real lock, not a cover over the page. While locked the app isn't even mounted.
async function register() {
  // The server's options, with the binary fields as base64url strings.
  type Options = Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> & {
    challenge: string; user: { id: string; name: string; displayName: string }; excludeCredentials: { type: 'public-key'; id: string }[]
  }
  const o = await post<Options>('/api/auth/register/options')
  const cred = await navigator.credentials.create({
    publicKey: { ...o, challenge: fromB64(o.challenge), user: { ...o.user, id: fromB64(o.user.id) }, excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: fromB64(c.id) })) },
  }) as PublicKeyCredential
  const r = cred.response as AuthenticatorAttestationResponse
  const publicKey = r.getPublicKey()
  if (!publicKey) throw new Error('this browser did not return the key; use Safari or Chrome')
  await post('/api/auth/register', {
    id: cred.id, publicKey: toB64(publicKey), alg: r.getPublicKeyAlgorithm(),
    clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.getAuthenticatorData()),
  })
}

async function unlock() {
  const o = await post<{ challenge: string; rpId: string; allowCredentials: { type: 'public-key'; id: string }[]; timeout: number }>('/api/auth/login/options')
  const cred = await navigator.credentials.get({
    publicKey: { challenge: fromB64(o.challenge), rpId: o.rpId, allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: fromB64(c.id) })), userVerification: 'required', timeout: o.timeout },
  }) as PublicKeyCredential
  const r = cred.response as AuthenticatorAssertionResponse
  await post('/api/auth/login', { id: cred.id, clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData), signature: toB64(r.signature) })
}

export function LockGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>('checking')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [blurred, setBlurred] = useState(false)

  // The passkey is optional: "Not now" is remembered per browser (the lock button offers setup again), and the demo
  // never asks. Without a passkey the server doesn't lock the API either.
  const skipped = () => { try { return localStorage.getItem(SKIP_KEY) === '1' } catch { return false } }
  const check = useCallback(async () => {
    const s = await (await fetch('/api/auth/status')).json()
    setState(s.demo ? 'open' : !s.registered ? (skipped() ? 'open' : 'setup') : s.unlocked ? 'open' : 'locked')
  }, [])

  useEffect(() => {
    // Passkeys belong to the site "localhost"; at 127.0.0.1 a passkey could never unlock.
    if (location.hostname === '127.0.0.1') return location.replace(location.href.replace('127.0.0.1', 'localhost'))
    check().catch((e: Error) => setError(e.message))
    // The lock button with no passkey yet means "set one up now".
    const onLocked = (e: Event) => fetch('/api/auth/status').then((r) => r.json()).then((s) => {
      if (s.demo) return
      if (s.registered) return setState('locked')
      if (!(e as CustomEvent).detail?.manual) return
      try { localStorage.removeItem(SKIP_KEY) } catch { /* ignore */ }
      setState('setup')
    })
    addEventListener('ledger:locked', onLocked)
    return () => removeEventListener('ledger:locked', onLocked)
  }, [check])

  // Auto-lock, judged by the wall clock: browsers pause timers in the background and during sleep, so a plain
  // setTimeout would never fire for a closed lid. Locks after 5 idle minutes, right after the Mac wakes from sleep,
  // and on coming back after more than a minute hidden.
  useEffect(() => {
    if (state !== 'open') return
    let lastInput = Date.now(), lastTick = Date.now(), hiddenAt = 0
    const input = () => { lastInput = Date.now() }
    const tick = setInterval(() => {
      const now = Date.now()
      if (now - lastTick > SLEEP_GAP_MS || now - lastInput > IDLE_LOCK_MS) lockNow()
      lastTick = now
    }, 5000)
    const onVisibility = () => {
      if (document.hidden) hiddenAt = Date.now()
      else if (hiddenAt && Date.now() - hiddenAt > HIDDEN_LOCK_MS) lockNow()
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const
    for (const e of events) addEventListener(e, input, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(tick)
      for (const e of events) removeEventListener(e, input)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [state])

  // Copilot-style privacy blur whenever the window isn't the one in front.
  useEffect(() => {
    const on = () => setBlurred(false), off = () => setBlurred(true)
    addEventListener('focus', on)
    addEventListener('blur', off)
    return () => { removeEventListener('focus', on); removeEventListener('blur', off) }
  }, [])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
      setState('open')
    } catch (e) {
      // Cancelling the passkey prompt is not an error worth shouting about.
      const err = e as Error
      setError(err.name === 'NotAllowedError' ? 'The passkey request was cancelled or timed out. Try again.' : err.message)
    } finally {
      setBusy(false)
    }
  }

  // An overlay rather than a filter on the app, so sheets, popovers and menus (portaled to <body>) blur too.
  if (state === 'open') {
    return (
      <>
        {children}
        {blurred && <div className="bg-background/40 fixed inset-0 z-[100] backdrop-blur-2xl" aria-hidden />}
      </>
    )
  }

  const setup = state === 'setup'
  return (
    <div className="bg-background grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center text-center">
          <div className="bg-muted mb-2 grid size-12 place-items-center rounded-full">
            {setup ? <KeyRoundIcon className="size-6" aria-hidden /> : <LockIcon className="size-6" aria-hidden />}
          </div>
          <CardTitle>{setup ? 'Protect Moneta with a passkey' : 'Moneta is locked'}</CardTitle>
          <CardDescription>
            {setup
              ? 'Your finances stay hidden until you unlock with a passkey: Touch ID, Windows Hello, your phone or a security key. It locks again after 5 idle minutes, when the computer sleeps, after a minute hidden, and on restart.'
              : 'Unlock with your passkey to see your finances.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {state !== 'checking' && (
            <Button autoFocus disabled={busy} onClick={() => run(setup ? register : unlock)}>
              <KeyRoundIcon /> {busy ? 'Waiting for your passkey…' : setup ? 'Create a passkey' : 'Unlock with passkey'}
            </Button>
          )}
          {setup && (
            <Button variant="ghost" onClick={() => { try { localStorage.setItem(SKIP_KEY, '1') } catch { /* this session only */ } setState('open') }}>
              Not now
            </Button>
          )}
          {error && <p className="text-destructive text-center text-sm">{error}</p>}
        </CardContent>
      </Card>
    </div>
  )
}
