import Ajv, { type ErrorObject } from 'ajv';

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

// Cross-field checks that draft-07 JSON Schema cannot express (e.g. "field A must
// reference an id present in array B"). They run on every value, independently of the
// Ajv outcome, so their errors surface alongside any schema errors rather than being
// masked by an earlier structural failure.
export type CrossValidator = (value: unknown) => ValidationError[];

export function createValidator<T>(
  schema: object,
  crossValidators: CrossValidator[] = [],
): (value: unknown) => ValidationResult<T> {
  const validate = ajv.compile(schema);

  return (value: unknown): ValidationResult<T> => {
    const ajvOk = validate(value);
    const crossErrors = crossValidators.flatMap((check) => check(value));

    if (ajvOk && crossErrors.length === 0) {
      return { ok: true, value: value as T };
    }

    return { ok: false, errors: [...formatValidationErrors(validate.errors), ...crossErrors] };
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
