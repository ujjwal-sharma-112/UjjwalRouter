export type OpenAIErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error'
  | 'service_unavailable_error'
  | 'free_policy_violation'
  | 'context_length_exceeded';

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: OpenAIErrorType;
    param: string | null;
    code: string;
  };
}

export class OpenAIErrorResponse extends Error {
  public readonly statusCode: number;
  public readonly body: OpenAIErrorBody;

  constructor(
    statusCode: number,
    type: OpenAIErrorType,
    code: string,
    message: string,
    param: string | null = null
  ) {
    super(message);
    this.name = 'OpenAIErrorResponse';
    this.statusCode = statusCode;
    this.body = {
      error: {
        message,
        type,
        param,
        code,
      },
    };
  }

  static badRequest(message: string, param: string | null = null, code = 'invalid_request'): OpenAIErrorResponse {
    return new OpenAIErrorResponse(400, 'invalid_request_error', code, message, param);
  }

  static unauthorized(message: string): OpenAIErrorResponse {
    return new OpenAIErrorResponse(401, 'authentication_error', 'invalid_api_key', message, null);
  }

  static forbidden(message: string, code = 'free_policy_violation'): OpenAIErrorResponse {
    return new OpenAIErrorResponse(403, 'free_policy_violation', code, message, 'model');
  }

  static notFound(message: string, param: string | null = 'model'): OpenAIErrorResponse {
    return new OpenAIErrorResponse(404, 'not_found_error', 'model_not_found', message, param);
  }

  static contextLengthExceeded(message: string): OpenAIErrorResponse {
    return new OpenAIErrorResponse(
      400,
      'context_length_exceeded',
      'context_length_exceeded',
      message,
      'messages'
    );
  }

  static payloadTooLarge(message: string): OpenAIErrorResponse {
    return new OpenAIErrorResponse(413, 'invalid_request_error', 'payload_too_large', message, null);
  }

  static rateLimited(message: string): OpenAIErrorResponse {
    return new OpenAIErrorResponse(429, 'rate_limit_error', 'rate_limit_exceeded', message, null);
  }

  static noFreeModelsAvailable(message: string): OpenAIErrorResponse {
    return new OpenAIErrorResponse(
      503,
      'service_unavailable_error',
      'no_eligible_free_models',
      message,
      'model'
    );
  }

  static upstreamError(statusCode: number, message: string, code = 'upstream_error'): OpenAIErrorResponse {
    return new OpenAIErrorResponse(
      statusCode >= 500 && statusCode <= 599 ? statusCode : 502,
      'server_error',
      code,
      message,
      null
    );
  }
}
