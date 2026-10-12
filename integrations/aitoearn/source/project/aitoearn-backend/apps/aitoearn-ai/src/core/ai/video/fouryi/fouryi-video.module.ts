import { Module } from '@nestjs/common'
import { FourYiVideoService } from './fouryi-video.service'

@Module({
  providers: [FourYiVideoService],
  exports: [FourYiVideoService],
})
export class FourYiVideoModule {}
