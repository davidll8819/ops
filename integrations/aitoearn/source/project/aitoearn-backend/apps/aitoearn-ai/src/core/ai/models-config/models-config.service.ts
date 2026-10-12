import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { AppConfigRepository } from '@yikart/mongodb'
import { config } from '../../../config'
import { applyFourYiModels, loadFourYiModels } from '../libs/fouryi/fouryi-models.util'
import { ModelsConfigDto } from './models-config.dto'

@Injectable()
export class ModelsConfigService implements OnModuleInit {
  private readonly logger = new Logger(ModelsConfigService.name)
  private modelsConfig = config.ai.models

  constructor(
    private readonly appConfigRepo: AppConfigRepository,
  ) {}

  async onModuleInit() {
    if (config.ai.fouryi.apiKey) {
      applyFourYiModels(config, [])
      try {
        const models = await loadFourYiModels(config.ai.fouryi)
        applyFourYiModels(config, models)
        this.logger.log(`Loaded ${models.length} company 4YI models`)
      }
      catch {
        this.logger.error('4YI model discovery failed. Check the company API key and URL, then restart. Legacy models remain disabled.')
      }
    }
  }

  async saveConfig(_: ModelsConfigDto) {
  }

  get config() {
    return this.modelsConfig
  }
}
