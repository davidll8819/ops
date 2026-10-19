import { z } from 'zod'

export const videoFormatSchema = z
  .object({
    ratio: z.enum(['9:16', '16:9', '1:1']),
    resolution: z.enum(['720p', '1080p']),
  })
  .strict()
