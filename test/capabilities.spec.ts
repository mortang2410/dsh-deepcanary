import { describe, expect, it, vi } from 'vitest'
import { API_BASE_PATH, installWebRoutes } from '../src/web.js'
import { PLUGIN_ENDPOINT_SUFFIXES, rendererCapabilities } from '../src/client/capabilities.js'

function registeredPaths(): string[] {
  const paths: string[] = []
  const ctx = {
    inject: (_services: string[], callback: (context: unknown) => void) => callback({
      connection: { fetch: { register: (route: { path: string }) => { paths.push(route.path) } } },
    }),
  }
  installWebRoutes(ctx, {} as never)
  return paths.sort()
}

describe('renderer endpoint boundary', () => {
  it('admits exactly the routes the host registers', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const paths = registeredPaths()
      expect(paths).toEqual(PLUGIN_ENDPOINT_SUFFIXES.map(suffix => `${API_BASE_PATH}/${suffix}`).sort())
      for (const path of paths) {
        await expect(rendererCapabilities.request(path, { method: 'POST' })).resolves.toBeInstanceOf(Response)
      }
      expect(fetchMock).toHaveBeenCalledTimes(paths.length)
      await expect(rendererCapabilities.request(`${API_BASE_PATH}/decision/unknown`)).rejects.toThrow('Invalid plugin endpoint')
      expect(fetchMock).toHaveBeenCalledTimes(paths.length)
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects absolute, protocol-relative and normalized traversal requests before fetch', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      for (const path of ['https://untrusted.example/api/dsh-deepcanary/state', '//untrusted.example/api/dsh-deepcanary/state',
        '/api/dsh-deepcanary/../credentials', '/api/dsh-deepcanary/%2e%2e/state', '/api/dsh-deepcanary/state/extra']) {
        await expect(rendererCapabilities.request(path)).rejects.toThrow('Invalid plugin endpoint')
      }
      expect(fetchMock).not.toHaveBeenCalled()
      await rendererCapabilities.request('/api/dsh-deepcanary/state?revision=1')
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally { vi.unstubAllGlobals() }
  })
})
