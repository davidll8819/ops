import { json } from 'express'
import { officeBridge, startApplication } from '@yikart/common'
import { AppModule } from './app.module'
import { config } from './config'

startApplication(AppModule, config, {
  setupApp: (app) => {
    if (config.officeBridge) {
      app.use(json({ limit: '1mb', verify: (req, _res, buffer) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer)
      } }))
      app.use(officeBridge(config.officeBridge, config.auth.secret))
    }
    app.enableCors()
  },
})
