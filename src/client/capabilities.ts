/** Same-origin transport also works under Desktop's public protocol forwarder. */
export interface ClientCapabilities {
  request(path: string, init?: RequestInit): Promise<Response>
  notify(title: string, options: NotificationOptions): Notification
  focus(): void
}

const API_BASE = '/api/dsh-deepcanary'

/** Every path suffix the host registers; the boundary admits exactly these. */
export const PLUGIN_ENDPOINT_SUFFIXES: readonly string[] = [
  'state', 'settings', 'health', 'action', 'explain', 'dry-run', 'outcomes', 'outcome', 'supervisor',
  'decision/answer', 'decision/review', 'decision/dispute', 'decision/delete', 'outcomes/delete',
]

export const rendererCapabilities: ClientCapabilities = {
  request: (path, init) => {
    const endpoint = path.split('?')[0]
    if (!PLUGIN_ENDPOINT_SUFFIXES.some(name => endpoint === `${API_BASE}/${name}`)) {
      return Promise.reject(new Error('Invalid plugin endpoint'))
    }
    return fetch(path, { cache: 'no-store', ...init })
  },
  notify: (title, options) => new Notification(title, options),
  focus: () => { window.focus() },
}
