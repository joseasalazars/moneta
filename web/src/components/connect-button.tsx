import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

type LinkError = { error_code: string; error_message?: string; display_message?: string | null }
declare global {
  interface Window {
    Plaid: {
      create(opts: {
        token: string
        onSuccess: (publicToken: string, meta: { institution: { name: string } | null }) => void
        onExit: (err: LinkError | null) => void
      }): { open(): void }
    }
  }
}

// Every completed bank login uses one of the 10 Trial slots, so the button stays disabled
// for the whole Link session to rule out a second session from a double click.
export function ConnectButton({ onLinked, onStatus }: { onLinked: () => Promise<void>; onStatus: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)

  async function connect() {
    setBusy(true)
    try {
      const { link_token } = await api<{ link_token: string }>('/api/link_token', {})
      window.Plaid.create({
        token: link_token,
        onSuccess: (public_token, meta) => {
          api('/api/exchange', { public_token, institution: meta.institution?.name })
            .then(onLinked)
            .catch((e: Error) => onStatus(`Error saving connection: ${e.message}`))
            .finally(() => setBusy(false))
        },
        onExit: (err) => {
          setBusy(false)
          onStatus(err ? `Link error: ${err.error_code} ${err.display_message ?? err.error_message ?? ''}` : 'Link closed, nothing saved')
        },
      }).open()
    } catch (e) {
      setBusy(false)
      onStatus(`Error: ${(e as Error).message}`)
    }
  }

  return (
    <Button onClick={connect} disabled={busy}>
      {busy ? 'Connecting…' : 'Connect account'}
    </Button>
  )
}
