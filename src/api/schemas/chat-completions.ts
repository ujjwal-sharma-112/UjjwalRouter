import { z } from 'zod';

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imagePartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

const contentPartSchema = z.union([textPartSchema, imagePartSchema]);

const toolCallSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal('function'),
    function: z
      .object({
        name: z.string().min(1),
        arguments: z.string(),
      })
      .passthrough(),
    thought_signature: z.string().optional(),
    extra_content: z.record(z.unknown()).optional(),
  })
  .passthrough();

const chatMessageSchema = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional().default(null),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
    reasoning_content: z.string().nullable().optional(),
  })
  .passthrough();

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const responseFormatSchema = z.union([
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      schema: z.record(z.unknown()).optional(),
      strict: z.boolean().optional(),
    }),
  }),
]);

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().trim().min(1),
    messages: z.array(chatMessageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().min(1).max(1_048_576).optional(),
    max_completion_tokens: z.number().int().min(1).max(1_048_576).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(8)]).optional(),
    stream: z.boolean().optional(),
    stream_options: z
      .object({
        include_usage: z.boolean().optional(),
      })
      .optional(),
    tools: z.array(toolDefinitionSchema).optional(),
    tool_choice: toolChoiceSchema.optional(),
    parallel_tool_calls: z.boolean().optional(),
    response_format: responseFormatSchema.optional(),
    reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    seed: z.number().int().optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    user: z.string().optional(),
  })
  .passthrough();

export type ValidatedChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
