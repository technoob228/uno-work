import { Schema, SchemaIssue } from "effect";

// ===============================
// Core Persistence Errors
// ===============================

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `SQL error in ${this.operation}: ${this.detail}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedErrorClass<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}

/**
 * Flattens an error chain (message, nested causes, sqlite error codes) into
 * one line. Without this the actual SQLite failure (SQLITE_READONLY, disk
 * full, locked WAL) hides inside `cause` objects that loggers do not
 * serialize, leaving incidents undiagnosable from logs alone.
 */
export function describeSqlCause(error: unknown, depth = 0): string {
  if (depth > 3 || error === null || error === undefined) {
    return "";
  }
  if (typeof error !== "object") {
    return String(error);
  }
  const parts: Array<string> = [];
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && message.length > 0) {
    parts.push(message);
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    parts.push(`code=${String(code)}`);
  }
  const errno = (error as { errno?: unknown }).errno;
  if (typeof errno === "number") {
    parts.push(`errno=${errno}`);
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== error) {
    const nested = describeSqlCause(cause, depth + 1);
    if (nested.length > 0 && !parts.includes(nested)) {
      parts.push(`caused by: ${nested}`);
    }
  }
  return parts.join(" ");
}

export function toPersistenceSqlError(operation: string) {
  return (cause: unknown): PersistenceSqlError => {
    const causeDetail = describeSqlCause(cause);
    return new PersistenceSqlError({
      operation,
      detail:
        causeDetail.length > 0
          ? `Failed to execute ${operation}: ${causeDetail}`
          : `Failed to execute ${operation}`,
      cause,
    });
  };
}

export function toPersistenceDecodeError(operation: string) {
  return (error: Schema.SchemaError): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}

export function toPersistenceDecodeCauseError(operation: string) {
  return (cause: unknown): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: `Failed to execute ${operation}`,
      cause,
    });
}

export const isPersistenceError = (u: unknown) =>
  Schema.is(PersistenceSqlError)(u) || Schema.is(PersistenceDecodeError)(u);

// ===============================
// Provider Session Repository Errors
// ===============================

export class ProviderSessionRepositoryValidationError extends Schema.TaggedErrorClass<ProviderSessionRepositoryValidationError>()(
  "ProviderSessionRepositoryValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository validation failed in ${this.operation}: ${this.issue}`;
  }
}

export class ProviderSessionRepositoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionRepositoryPersistenceError>()(
  "ProviderSessionRepositoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type OrchestrationEventStoreError = PersistenceSqlError | PersistenceDecodeError;

export type ProviderSessionRepositoryError =
  | ProviderSessionRepositoryValidationError
  | ProviderSessionRepositoryPersistenceError;

export type OrchestrationCommandReceiptRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export type ProviderSessionRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type AuthPairingLinkRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type AuthSessionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ProjectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ManagerRepositoryError = PersistenceSqlError | PersistenceDecodeError;
