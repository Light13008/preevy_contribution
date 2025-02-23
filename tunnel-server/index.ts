import { inspect, promisify } from 'util'
import { app as createApp } from './src/app'
import { inMemoryPreviewEnvStore } from './src/preview-env'
import { sshServer as createSshServer } from './src/ssh-server'
import { getSSHKeys } from './src/ssh-keys'
import url from 'url'
import path from 'path'
import { isProxyRequest, proxyHandlers } from './src/proxy'
import { appLoggerFromEnv } from './src/logging'
import pino from 'pino'
import { tunnelsGauge } from './src/metrics'
import { runMetricsServer } from './src/metrics'
import { numberFromEnv, requiredEnv } from './src/env'
import { replaceHostname } from './src/url'
import { createPublicKey } from 'crypto'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const { sshPrivateKey } = await getSSHKeys({
  defaultKeyLocation: path.join(__dirname, "./ssh/ssh_host_key")
})

const PORT = numberFromEnv('PORT') || 3000
const SSH_PORT = numberFromEnv('SSH_PORT') || 2222
const LISTEN_HOST = '0.0.0.0'
const BASE_URL = (() => {
  const result = new URL(requiredEnv('BASE_URL'))
  if (result.pathname !== '/' || result.search || result.username || result.password || result.hash) {
    throw new Error(`Invalid URL: ${result} - cannot specify path, search, username, password, or hash`)
  }
  return result
})()

const envStore = inMemoryPreviewEnvStore()

const logger = pino(appLoggerFromEnv())
const app = createApp({
  isProxyRequest: isProxyRequest(BASE_URL.hostname),
  proxyHandlers: proxyHandlers({envStore, logger}),
  logger,
})
const sshLogger = logger.child({ name: 'ssh_server' })

const tunnelName = (clientId: string, remotePath: string) => {
  const serviceName = remotePath.replace(/^\//, '')
  return `${serviceName}-${clientId}`.toLowerCase()
}

const tunnelUrl = (
  rootUrl: URL,
  clientId: string,
  tunnel: string,
) => replaceHostname(rootUrl, `${tunnelName(clientId, tunnel)}.${rootUrl.hostname}`).toString()

const sshServer = createSshServer({
  log: sshLogger,
  sshPrivateKey,
  socketDir: '/tmp', // TODO
})
  .on('client', client => {
    const { clientId, publicKey } = client
    const tunnels = new Map<string, string>()
    client
      .on('forward', async (requestId, { path: remotePath, access }, accept, reject) => {
        const key = tunnelName(clientId, remotePath)
        if (await envStore.has(key)) {
          reject(new Error(`duplicate path: ${key}`))
          return
        }
        const forward = await accept()
        sshLogger.debug('creating tunnel %s for localSocket %s', key, forward.localSocketPath)
        await envStore.set(key, {
          target: forward.localSocketPath,
          clientId,
          publicKey: createPublicKey(publicKey.getPublicPEM()),
          access,
        })
        tunnels.set(requestId, tunnelUrl(BASE_URL, clientId, remotePath))
        tunnelsGauge.inc({clientId})

        forward.on('close', () => {
          sshLogger.debug('deleting tunnel %s', key)
          tunnels.delete(requestId)
          void envStore.delete(key)
          tunnelsGauge.dec({clientId})
        })
      })
      .on('error', err => { sshLogger.warn('client error %j: %j', clientId, inspect(err)) })
      .on('hello', channel => {
        channel.stdout.write(JSON.stringify({
          clientId,
          // TODO: backwards compat, remove when we drop support for CLI v0.0.35
          baseUrl: { hostname: BASE_URL.hostname, port: BASE_URL.port, protocol: BASE_URL.protocol },
          rootUrl: BASE_URL.toString(),
          tunnels: Object.fromEntries(tunnels.entries()),
        }) + '\r\n')
        channel.exit(0)
      })
  })
  .listen(SSH_PORT, LISTEN_HOST, () => {
    app.log.debug('ssh server listening on port %j', SSH_PORT)
  })
  .on('error', (err: unknown) => {
    app.log.error('ssh server error: %j', err)
  })

app.listen({ host: LISTEN_HOST, port: PORT }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})

runMetricsServer(8888).catch((err) => {
  app.log.error(err)
})

;['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.once(signal, () => {
    app.log.info(`shutting down on ${signal}`)
    Promise.all([promisify(sshServer.close).call(sshServer), app.close()])
      .catch((err) => {
        app.log.error(err)
        process.exit(1)
      })
      .finally(() => {
        process.exit(0)
      })
  })
})
