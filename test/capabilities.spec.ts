import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { rendererCapabilities } from '../src/client/capabilities.js'

const webSource = readFileSync(new URL('../src/web.ts', import.meta.url), 'utf8')
const registeredRoutes = [...webSource.matchAll(/register\('([a-z/-]+)'/g)].map(match => match[1])

describe('renderer endpoint boundary', () => {
  it('accepts every route the host registers so panel writes cannot be rejected locally', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect(registeredRoutes).toContain('decision/answer')
      for (const route of registeredRoutes) {
        await expect(rendererCapabilities.request(`/api/dsh-deepcanary/${route}`, { method: 'POST' })).resolves.toBeInstanceOf(Response)
      }
      expect(fetchMock).toHaveBeenCalledTimes(registeredRoutes.length)
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
