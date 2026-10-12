import { json } from 'express'
import { join } from 'node:path'
import { officeBridge, startApplication } from '@yikart/common'
import cookieParser from 'cookie-parser'
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
    app.use(cookieParser())

    app.setViewEngine('ejs')
    app.setBaseViewsDir(join(__dirname, 'views'))
    app.useStaticAssets(join(__dirname, 'public'))
  },
})
