import { z } from 'zod';

export const embeddingRequestSchema = z
  .object({
    input: z.union([
      z.string().min(1, 'Input string cannot be empty'),
      z.array(z.string().min(1, 'Input item cannot be empty')).min(1, 'Input array cannot be empty'),
      z.array(z.number()),
      z.array(z.array(z.number())),
    ]),
    model: z.string().optional().default('auto'),
    dimensions: z.number().int().positive().optional(),
    encoding_format: z.enum(['float', 'base64']).optional().default('float'),
    user: z.string().optional(),
  })
  .passthrough();

export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;

export interface EmbeddingDataItem {
  object: 'embedding';
  index: number;
  embedding: number[] | string;
}

export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingDataItem[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}
