/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as NodeUtil from "node:util";

import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

/**
 * SqliteClient - Effect service tag for the sqlite SQL client.
 */
export const SqliteClient = Context.Service<Client.SqlClient>("t3/persistence/NodeSqliteClient");

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      `Node.js ${process.versions.node} is missing required node:sqlite APIs ` +
        `(StatementSync.columns). Upgrade to Node.js >=22.16, >=23.11, or >=24.`,
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`. Copy it across so busy, locked and
 * constraint failures get their own reasons instead of `UnknownError`.
 * Upstream t3code 0fe4fa40fe.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

/**
 * SQLite keeps its copy of a statement's text and blob parameters until the
 * statement is bound again or finalized, and `node:sqlite` cannot clear them.
 * A cached statement would hold its last payload (a multi-MB tool output, an
 * attachment) for as long as it stays cached, so executions binding more than
 * this many string code units and blob bytes, or a named parameter behind a
 * getter, get a throwaway statement instead. Upstream t3code 4cd0076ec6.
 */
export const LARGE_BINDING_SIZE = 64 * 1024;

// `node:sqlite` binds both buffer views and raw buffers as blobs.
const isBlob = (value: unknown): value is ArrayBufferView | ArrayBufferLike =>
  ArrayBuffer.isView(value) || NodeUtil.types.isAnyArrayBuffer(value);

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") {
    return value.length;
  }
  return isBlob(value) ? value.byteLength : 0;
};

export const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !isBlob(param)
      ) {
        // `node:sqlite` takes named parameters as one object, callable or not.
        // Read data properties only: calling a getter here would run it twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    // A parameter that cannot be measured is left for the statement to report.
    return true;
  }
};

/**
 * Prepared statements by SQL text: least recently used first, each kept for
 * `ttlMs` after it was prepared, failures never kept.
 *
 * Synchronous on purpose. It replaces `effect/Cache`, whose `get` publishes a
 * pending slot for the key before it starts the lookup: a fiber interrupted
 * in between (suspended at the scheduler's periodic yield, then interrupted by
 * a timeout or a closed request) leaves the slot pending forever, and every
 * later use of that SQL waits on it — inside a transaction, while holding the
 * connection's only permit, so the whole database stops answering. Box 395
 * on 11.11 looked exactly like that: HTTP up, every database call hanging for
 * 3 hours, the daemon idle. Preparing a statement is synchronous anyway, so
 * the cache needs no pending state at all.
 */
export class StatementCache<S> {
  private readonly entries = new Map<
    string,
    { readonly statement: S; readonly expiresAt: number }
  >();

  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(capacity: number, ttlMs: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The cached statement for `sql`, or a fresh one from `prepare` (which may throw). */
  get(sql: string, prepare: (sql: string) => S): S {
    const now = this.now();
    const cached = this.entries.get(sql);
    if (cached !== undefined) {
      this.entries.delete(sql);
      if (cached.expiresAt > now) {
        this.entries.set(sql, cached);
        return cached.statement;
      }
    }
    const statement = prepare(sql);
    this.entries.set(sql, { statement, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return statement;
  }
}

/**
 * The connection's one lock: a transaction holds it from BEGIN to COMMIT, a
 * plain statement waits until no transaction holds it (it would otherwise
 * run inside someone else's transaction).
 *
 * It replaces `effect/Semaphore` (4.0.0-beta.59), whose `take` counts the
 * permit as taken one step before the caller can register its release: a
 * fiber suspended right there (the scheduler yields every 2048 steps) and
 * then interrupted — a timeout, a closed request — leaves the permit taken
 * forever, and every database call after it waits. The regression test in
 * NodeSqliteClient.test.ts wedges the old client that way in a few hundred
 * interrupted queries. Here a waiter's ticket is registered for release
 * before it starts waiting, so an interruption at any point gives the lock
 * back (or passes it on).
 */
export class ConnectionLock {
  private holder: object | null = null;
  private readonly queue: Array<{ readonly ticket: object; readonly wake: () => void }> = [];

  get held(): boolean {
    return this.holder !== null;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** A ticket: holds the lock at once when it is free, else waits in line. */
  private enqueue(): { readonly ticket: object; readonly wait: Effect.Effect<void> } {
    const ticket = {};
    if (this.holder === null) {
      this.holder = ticket;
      return { ticket, wait: Effect.void };
    }
    const wait = Effect.callback<void>((resume) => {
      if (this.holder === ticket) return resume(Effect.void);
      this.queue.push({ ticket, wake: () => resume(Effect.void) });
    });
    return { ticket, wait };
  }

  /** Gives the lock back (or to the next in line), or leaves the line. */
  private done(ticket: object): void {
    const queued = this.queue.findIndex((entry) => entry.ticket === ticket);
    if (queued !== -1) this.queue.splice(queued, 1);
    if (this.holder !== ticket) return;
    const next = this.queue.shift();
    this.holder = next?.ticket ?? null;
    next?.wake();
  }

  /** Runs `self` holding the lock; the wait for it can be interrupted. */
  withLock<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const { ticket, wait } = this.enqueue();
        return Effect.ensuring(
          Effect.flatMap(restore(wait), () => restore(self)),
          Effect.sync(() => this.done(ticket)),
        );
      }),
    );
  }

  /**
   * Takes the lock until `scope` closes. The release is added to the scope
   * before the wait starts.
   */
  acquireFor(
    scope: Scope.Scope,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const { ticket, wait } = this.enqueue();
      return Effect.flatMap(
        Scope.addFinalizer(
          scope,
          Effect.sync(() => this.done(ticket)),
        ),
        () => restore(wait),
      );
    });
  }
}

const makeWithDatabase = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = openDatabase();
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => db.close()),
    );

    const statementReaderCache = new WeakMap<StatementSync, boolean>();
    const hasRows = (statement: StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepareCache = new StatementCache<StatementSync>(
      options.prepareCacheSize ?? 200,
      Duration.toMillis(Duration.fromInputUnsafe(options.prepareCacheTTL ?? Duration.minutes(10))),
    );

    const runStatement = (statement: StatementSync, params: ReadonlyArray<unknown>, raw: boolean) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
        try {
          if (hasRows(statement)) {
            return Effect.succeed(statement.all(...(params as any)));
          }
          // FTS5 writes its shadow tables with 64-bit rowids, which can reach
          // last_insert_rowid; as a number that would throw after the write
          // already committed. A statement without rows returns nothing else.
          statement.setReadBigInts(true);
          const result = statement.run(...(params as any));
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifyError(cause, "Failed to execute statement", "execute"),
            }),
          );
        }
      });

    const prepareUncached = (sql: string) =>
      Effect.try({
        try: () => db.prepare(sql),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const prepareCached = (sql: string) =>
      Effect.try({
        try: () => prepareCache.get(sql, (text) => db.prepare(text)),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
      hasLargeBinding(params) ? prepareUncached(sql) : prepareCached(sql);

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(statementFor(sql, params), (s) => runStatement(s, params, raw));

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.acquireUseRelease(
        statementFor(sql, params),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(true);
                // Safe to cast to array after we've setReturnArrays(true)
                return statement.all(...(params as any)) as unknown as ReadonlyArray<
                  ReadonlyArray<unknown>
                >;
              }
              statement.setReadBigInts(true);
              statement.run(...(params as any));
              return [];
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
          }),
        (statement) =>
          Effect.sync(() => {
            if (hasRows(statement)) {
              statement.setReturnArrays(false);
            }
          }),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = runStatement(db.prepare(sql), params ?? [], false);
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die("executeStream not implemented");
      },
    });
  });

  const lock = new ConnectionLock();
  const connection = yield* makeConnection;

  const acquirer = lock.withLock(Effect.succeed(connection));
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(lock.acquireFor(scope, restore), connection);
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out. Taking
    // the lock up front makes it wait instead. Read-only connections cannot
    // write, so they keep the deferred BEGIN. Upstream t3code 0fe4fa40fe.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    options,
    () =>
      new DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
      }),
  );

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    {
      ...config,
      filename: ":memory:",
      readonly: false,
    },
    () => {
      const database = new DatabaseSync(":memory:", {
        allowExtension: config.allowExtension ?? false,
      });
      return database;
    },
  );

export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>,
): Layer.Layer<Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(config)
      .asEffect()
      .pipe(
        Effect.flatMap(make),
        Effect.map((client) =>
          Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
        ),
      ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (config: SqliteMemoryClientConfig = {}): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(makeMemory(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
