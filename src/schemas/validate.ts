import Ajv, { type ErrorObject } from 'ajv';

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

export function createValidator<T>(schema: object): (value: unknown) => ValidationResult<T> {
  const validate = ajv.compile(schema);

  return (value: unknown): ValidationResult<T> => {
    if (validate(value)) {
      return { ok: true, value: value as T };
    }

    return { ok: false, errors: formatValidationErrors(validate.errors) };
  };
}

export function formatValidationErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath,
    message: error.message ?? 'validation failed',
    keyword: error.keyword,
    params: error.params as Record<string, unknown>,
  }));
}
