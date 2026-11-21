/**
 * CLOSE THE POINT RESERVATIONS LEFT OPEN BY THE LOCAL WALLET - step 7.8 (1).
 * Run once in the cutover window, with the service STOPPED, before the four
 * wallet tables are frozen (REVOKE) and before shared-user's backfill (6.12).
 *
 * Why: a reservation made by the local wallet (before 7.7d) has no key on its
 * order (order_tbl.points_reservation_key_column, migration v4.0.0-06), and
 * shared-user confirms / cancels a reservation by key (6.7). After the 7.7d
 * deploy nothing can reach such a reservation: once backfilled it would hold
 * the customer's points on the shared ledger forever. So every one of them is
 * closed here, on the local wallet, the way the local code closed it:
 *
 *   - order `pending` (not deleted): CANCEL - points back on the accumulated
 *     point row, reservation `cancelled`, a `refund` history row, and the
 *     order gets its subtotal back (accumulated_points_to_use = 0), like
 *     POST /accumulated-point/order/:slug/cancel-reservation did. The customer
 *     applies points again after the cutover.
 *   - order `paid` / `shipping` / `completed`: the customer paid the reduced
 *     price and only the confirmation was lost - CONFIRM, like
 *     confirmPointsUsage: reservation `confirmed` + a `use` history row
 *     (the points were already taken off when the reservation was made).
 *   - order `cancel`, soft deleted or missing: CANCEL and refund, like
 *     handleCancelReservation on cancel / expiry; the order is left as it is.
 *
 * Unlike handleCancelReservation it does not skip owners that are no longer
 * customers or are the default customer: those guards stop a reservation from
 * being made, this one exists, its points were taken from that row, and an
 * open reservation is what must not survive. Such rows are flagged.
 *
 * A reservation whose order already carries a key is left alone and listed
 * (the 7.7d build never writes this table, so there should be none).
 *
 * Dry run by default. --execute writes, one transaction per reservation that
 * locks the reservation and the accumulated point row (SELECT ... FOR UPDATE)
 * and checks again that it is still open. Running it again writes nothing.
 *
 * ## How to run (from trend/app/order-api, reads .env here)
 *
 *   npx ts-node -r tsconfig-paths/register \
 *     src/scripts/close-legacy-point-reservations.ts [--db=trend_db] [--execute]
 *
 * The database is DATABASE_NAME of .env unless --db= is given; the account
 * is DATABASE_USERNAME / PASSWORD (it needs write access to the wallet
 * tables: run it BEFORE the REVOKE). terminal's database has the same tables:
 * --db=terminal_db works the same way.
 *
 * Output: one line per open reservation (planned action, reservation id,
 * order slug, order status, points, owner slug, role, flags), then
 * `SUMMARY {json}`. Exit 0 when no keyless reservation is left open after
 * --execute (a dry run exits 0), 1 otherwise.
 *
 * ## Names (rule 2)
 * accumulated_point_transaction_history_tbl, accumulated_point_tbl and
 * user_tbl.accumulated_point_column are looked up as `X` or `_deprecated_X`
 * in information_schema; finding both or neither stops the run. The key
 * column is optional: in the cutover window this runs BEFORE migration
 * v4.0.0-06 (the order of the prod window), when it does not exist yet and
 * every open reservation is keyless. No migration has to run first.
 */
import { randomUUID } from 'crypto';
import { config as dotenvConfig } from 'dotenv';
import { Connection, createConnection, RowDataPacket } from 'mysql2/promise';

dotenvConfig({ path: '.env' });

type Value = string | null;
type Row = Record<string, Value>;

const HISTORY_TABLE = 'accumulated_point_transaction_history_tbl';
const POINTS_TABLE = 'accumulated_point_tbl';
const USER_TABLE = 'user_tbl';
const ORDER_TABLE = 'order_tbl';
const POINTS_LINK = 'accumulated_point_column';
const KEY_COLUMN = 'points_reservation_key_column';
const PERCENTAGE_KEY = 'ACCUMULATED_POINTS_PERCENTAGE';
const PAID_STATUSES = ['paid', 'shipping', 'completed'];
const CUSTOMER_ROLE = 'CUSTOMER'; // role_tbl.name_column (RoleEnum.Customer)

type Action = 'cancel+order' | 'cancel' | 'confirm' | 'keyed';

interface Names {
  history: string;
  points: string;
  link: string;
  hasKey: boolean;
}

interface Reservation {
  id: string;
  points: number;
  lastPoints: number;
  accumulatedPoint: Value;
  orderId: Value;
  orderSlug: Value;
  orderStatus: Value;
  orderDeleted: boolean;
  orderKey: Value;
  orderPayment: Value;
  owner: Value;
  role: Value;
  action: Action;
  flags: string[];
}

const argValue = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
};

const q = (name: string): string => `\`${name}\``;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const select = async (
  conn: Connection,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> => {
  const [rows] = await conn.query<RowDataPacket[]>(sql, params);
  return rows.map((row) => {
    const out: Row = {};
    for (const [column, value] of Object.entries(row)) {
      out[column] =
        value === null || value === undefined ? null : String(value);
    }
    return out;
  });
};

// The name in use, `name` or `_deprecated_name` (rule 2).
const oneOf = (where: string, found: string[], name: string): string => {
  if (found.length !== 1) {
    throw new Error(
      `${where}: expected exactly one of ${name} / _deprecated_${name}, ` +
        `found ${found.length} (${found.join(', ')})`,
    );
  }
  return found[0];
};

const resolveNames = async (
  conn: Connection,
  database: string,
): Promise<Names> => {
  const table = async (name: string) =>
    oneOf(
      database,
      (
        await select(
          conn,
          `SELECT table_name AS name FROM information_schema.tables
            WHERE table_schema = ? AND table_name IN (?)`,
          [database, [name, `_deprecated_${name}`]],
        )
      ).map((row) => row.name),
      name,
    );
  const columns = async (tableName: string, names: string[]) =>
    (
      await select(
        conn,
        `SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ? AND column_name IN (?)`,
        [database, tableName, names],
      )
    ).map((row) => row.name);

  return {
    history: await table(HISTORY_TABLE),
    points: await table(POINTS_TABLE),
    link: oneOf(
      `${database}.${USER_TABLE}`,
      await columns(USER_TABLE, [POINTS_LINK, `_deprecated_${POINTS_LINK}`]),
      POINTS_LINK,
    ),
    hasKey: (await columns(ORDER_TABLE, [KEY_COLUMN])).length === 1,
  };
};

// Open = type reserve, status pending, not soft deleted: exactly what the
// local code looked for (TypeORM leaves soft deleted rows out).
const OPEN = `h.type_column = 'reserve' AND h.status_column = 'pending'
  AND h.deleted_at_column IS NULL`;

const readOpen = async (
  conn: Connection,
  names: Names,
): Promise<Reservation[]> => {
  const rows = await select(
    conn,
    `SELECT h.id_column AS id, h.points_column AS points,
            h.last_points_column AS lastPoints,
            h.accumulated_point_column AS accumulatedPoint,
            h.order_column AS orderId, o.slug_column AS orderSlug,
            o.status_column AS orderStatus,
            o.deleted_at_column AS orderDeleted,
            o.payment_column AS orderPayment,
            ${names.hasKey ? `o.${KEY_COLUMN}` : 'NULL'} AS orderKey,
            u.slug_column AS owner, r.name_column AS role
       FROM ${q(names.history)} h
       LEFT JOIN ${q(ORDER_TABLE)} o ON o.id_column = h.order_column
       LEFT JOIN ${q(USER_TABLE)} u
         ON u.${q(names.link)} = h.accumulated_point_column
       LEFT JOIN role_tbl r ON r.id_column = u.role_column
      WHERE ${OPEN}
      ORDER BY h.created_at_column, h.id_column`,
  );
  return rows.map((row) => {
    const flags: string[] = [];
    let action: Action;
    if (row.orderKey) {
      action = 'keyed';
    } else if (
      row.orderSlug &&
      !row.orderDeleted &&
      PAID_STATUSES.includes(row.orderStatus ?? '')
    ) {
      action = 'confirm';
    } else if (
      row.orderSlug &&
      !row.orderDeleted &&
      row.orderStatus === 'pending'
    ) {
      action = 'cancel+order';
      if (row.orderPayment) flags.push('order-has-payment');
    } else {
      action = 'cancel';
      if (!row.orderSlug) flags.push('order-missing');
      else if (row.orderDeleted) flags.push('order-deleted');
    }
    if (!row.accumulatedPoint) flags.push('no-accumulated-point');
    if (!row.owner) flags.push('no-owner');
    else if (row.role !== CUSTOMER_ROLE) flags.push(`owner-role-${row.role}`);
    return {
      id: row.id,
      points: Number(row.points),
      lastPoints: Number(row.lastPoints),
      accumulatedPoint: row.accumulatedPoint,
      orderId: row.orderId,
      orderSlug: row.orderSlug,
      orderStatus: row.orderStatus,
      orderDeleted: !!row.orderDeleted,
      orderKey: row.orderKey,
      orderPayment: row.orderPayment,
      owner: row.owner,
      role: row.role,
      action,
      flags,
    };
  });
};

// Same as getAccumulatedPointsPercentage + parseInt of the local code.
const readPercentage = async (conn: Connection): Promise<number> => {
  const [row] = await select(
    conn,
    `SELECT value_column AS value FROM system_config_tbl
      WHERE key_column = ? AND deleted_at_column IS NULL LIMIT 1`,
    [PERCENTAGE_KEY],
  );
  const value = parseInt(row?.value || '0', 10);
  return Number.isNaN(value) ? 0 : value;
};

// Slug like getRandomString of src/helper (10 hex characters of a uuid).
const newSlug = (): string => randomUUID().replace(/-/g, '').slice(0, 10);

const insertHistory = async (
  conn: Connection,
  names: Names,
  r: Reservation,
  type: 'refund' | 'use',
  lastPoints: number,
  percentage: number,
): Promise<void> => {
  await conn.query(
    `INSERT INTO ${q(names.history)}
       (id_column, slug_column, type_column, points_column,
        last_points_column, current_points_percentage_column, date_column,
        status_column, order_column, accumulated_point_column,
        created_by_column)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6), 'confirmed', ?, ?, NULL)`,
    [
      randomUUID(),
      newSlug(),
      type,
      r.points,
      lastPoints,
      percentage,
      r.orderId,
      r.accumulatedPoint,
    ],
  );
};

// One reservation, one transaction. Returns false when it is no longer open.
const close = async (
  conn: Connection,
  names: Names,
  r: Reservation,
  percentage: number,
): Promise<boolean> => {
  await conn.beginTransaction();
  try {
    const [still] = await select(
      conn,
      `SELECT h.id_column AS id FROM ${q(names.history)} h
        WHERE h.id_column = ? AND ${OPEN} FOR UPDATE`,
      [r.id],
    );
    if (!still) {
      await conn.rollback();
      return false;
    }
    if (r.action === 'confirm') {
      await conn.query(
        `UPDATE ${q(names.history)} SET status_column = 'confirmed'
          WHERE id_column = ?`,
        [r.id],
      );
      await insertHistory(conn, names, r, 'use', r.lastPoints, percentage);
    } else {
      let total = 0;
      if (r.accumulatedPoint) {
        const [row] = await select(
          conn,
          `SELECT total_points_column AS total FROM ${q(names.points)}
            WHERE id_column = ? FOR UPDATE`,
          [r.accumulatedPoint],
        );
        total = Number(row?.total ?? 0) + r.points;
        await conn.query(
          `UPDATE ${q(names.points)} SET total_points_column = ?
            WHERE id_column = ?`,
          [total, r.accumulatedPoint],
        );
      }
      await conn.query(
        `UPDATE ${q(names.history)} SET status_column = 'cancelled'
          WHERE id_column = ?`,
        [r.id],
      );
      await insertHistory(conn, names, r, 'refund', total, percentage);
      if (r.action === 'cancel+order') {
        await conn.query(
          `UPDATE ${q(ORDER_TABLE)}
              SET subtotal_column = subtotal_column + accumulated_points_to_use_column,
                  accumulated_points_to_use_column = 0
            WHERE id_column = ? AND accumulated_points_to_use_column > 0`,
          [r.orderId],
        );
      }
    }
    await conn.commit();
    return true;
  } catch (error) {
    await conn.rollback();
    throw error;
  }
};

const main = async (): Promise<number> => {
  const execute = process.argv.includes('--execute');
  const database = argValue('db') ?? process.env.DATABASE_NAME;
  if (!database) throw new Error('no database: set DATABASE_NAME or --db=');
  const conn = await createConnection({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database,
  });
  try {
    const names = await resolveNames(conn, database);
    const open = await readOpen(conn, names);
    const percentage = await readPercentage(conn);
    say(
      `# ${database}: history ${names.history}, points ${names.points}, ` +
        `link user_tbl.${names.link}, key column ${names.hasKey ? 'present' : 'absent'}, ` +
        `${execute ? 'EXECUTE' : 'dry run'}`,
    );
    say('action\treservation\torder\torder status\tpoints\towner\trole\tflags');
    for (const r of open) {
      say(
        [
          r.action,
          r.id,
          r.orderSlug ?? '-',
          r.orderStatus ?? '-',
          r.points,
          r.owner ?? '-',
          r.role ?? '-',
          r.flags.join(',') || '-',
        ].join('\t'),
      );
    }

    const count = (action: Action) =>
      open.filter((r) => r.action === action).length;
    const plan = {
      'cancel+order': count('cancel+order'),
      cancel: count('cancel'),
      confirm: count('confirm'),
      keyed: count('keyed'),
    };
    const written: Record<Action | 'gone', number> = {
      'cancel+order': 0,
      cancel: 0,
      confirm: 0,
      keyed: 0,
      gone: 0,
    };
    if (execute) {
      for (const r of open.filter((x) => x.action !== 'keyed')) {
        if (await close(conn, names, r, percentage)) written[r.action] += 1;
        else written.gone += 1;
      }
    }
    const left = (await readOpen(conn, names)).filter(
      (r) => r.action !== 'keyed',
    ).length;
    say(
      `SUMMARY ${JSON.stringify({
        database,
        execute,
        keyColumn: names.hasKey,
        open: open.length,
        plan,
        written: execute ? written : null,
        keylessOpenAfter: left,
        flagged: open.filter((r) => r.flags.length).length,
      })}`,
    );
    return execute && left > 0 ? 1 : 0;
  } finally {
    await conn.end();
  }
};

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(
      `ERROR: ${error instanceof Error ? error.message : error}\n`,
    );
    process.exit(1);
  });
