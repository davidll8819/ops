import { z } from 'zod'
export const agentProfile = z
  .object({
    name: z.string().trim().min(1).max(80),
    systemPrompt: z.string().trim().min(8).max(12000),
    modelId: z.string().min(1).max(160),
    maxTokens: z.number().int().min(128).max(8192).default(2048),
    temperature: z.number().min(0).max(1).default(0.4),
    memory: z.boolean().default(true),
  })
  .strict()
export const messageInput = z
  .object({
    prompt: z.string().trim().min(1).max(16000),
    conversationId: z.string().uuid().optional(),
    requestId: z.string().uuid(),
  })
  .strict()
export const tenantInput = z.object({ name: z.string().trim().min(2).max(80) }).strict()
export const inviteInput = z
  .object({
    email: z.email().transform((s) => s.toLowerCase()),
    role: z.enum(['admin', 'member']).default('member'),
  })
  .strict()
