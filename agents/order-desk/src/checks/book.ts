// agents/order-desk/src/checks/book.ts
// The order book of the Order Desk: one entry for each purchase order number of a tenant. The second statement of the claim of the Order Desk says that the agent places one order for each purchase order
// number, so the agent keeps the record, and the fourth check of its own reads it. The job records an order after the supplier portal took it.
//
// The supplier portal takes one order for each number without regard to case, so the book keys each number by `poNumberKey` of the kit (the number in lower case): `PO-7` and `po-7` are one purchase
// order. The tenant is part of the key, because the portal keeps one list of orders for each tenant. The key is the JSON text of the tenant and the key of the number, so no pair of texts reads as another pair.
//
//   MemoryOrderBook   the entries in memory
//   FileOrderBook     the entries in one JSON file on the state volume of the service
//
// A book that cannot answer rejects. The check of the Order Desk turns the rejection into `check_unavailable`, and a book never answers "no order" for a source that it could not read. The first start has no
// file, so the constructor of the file book writes the empty book then. A file that goes missing after the start is an error and never an empty book: a book that was deleted gives no go for a number that was
// recorded. A file that is there and is damaged is an error too.
//
// A book holds at most ORDER_BOOK_LIMIT orders. It never drops an order to make room, because a dropped order reads as a new one. The record of a number that the book holds is a no-op for the same order id,
// and an error for another order id: the portal never places two orders for one number. A book that is full cannot take a new order, so `has` rejects with a RangeError for a number that the book lacks, and it
// never answers false: a false gives a go, the service claims the escrow, and the record of that order fails. A number that the book holds still answers true.
import { randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { poNumberKey } from '@vsa/usecase-kit/inventory';
import { isPlainObject } from '@vsa/usecase-kit/protocol';

/** The orders that the Order Desk placed, by purchase order number. */
export interface OrderBook {
  /**
   * Is there an order for the purchase order number of this tenant? The number counts without regard to case. A book that cannot answer rejects. A book that is full and has no order for the number rejects too
   * (a RangeError): the job could not record a new order, so the book must not read the number as new. A number that the book holds is true also when the book is full.
   */
  has(tenant: string, poNumber: string): Promise<boolean>;
  /** Records the order that the supplier portal placed for the number. It resolves when the record is stored. */
  record(tenant: string, poNumber: string, orderId: string): Promise<void>;
}

/** The most orders that a book holds. */
export const ORDER_BOOK_LIMIT = 10_000;

/** The most characters of a tenant, of a purchase order number and of an order id. */
const MAX_TEXT = 64;

/** The version of the file. */
const FILE_SCHEMA = 'order-desk.orders.v1';

interface OrderEntry {
  readonly tenant: string;
  readonly po_number: string;
  readonly order_id: string;
}

/** The entries by key, in the order of the records. */
type Orders = Map<string, OrderEntry>;

/** A text of 1 to MAX_TEXT characters. Anything else is a TypeError, and the message never repeats the value. */
function textOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TEXT) throw new TypeError(`${name} must be a text of 1 to ${MAX_TEXT} characters`);
  return value;
}

const keyOf = (tenant: string, poNumber: string): string => JSON.stringify([tenant, poNumberKey(poNumber)]);

/** The error of a book that is full. It names the book and the limit, and never a purchase order number. */
const full = (): RangeError => new RangeError(`the order book holds ${ORDER_BOOK_LIMIT} orders and is full`);

/**
 * Does the book hold the key? A book that is full and lacks the key rejects, and never answers false: the job could not record an order for that number, so the book must not read it as new. A key that the book
 * holds is true also when the book is full.
 */
function holds(orders: Orders, key: string): boolean {
  if (orders.has(key)) return true;
  if (orders.size >= ORDER_BOOK_LIMIT) throw full();
  return false;
}

/**
 * Decides what the record of an entry does. It is true when the entry is new and the caller stores it. It is false when the book holds the same order already. It throws for another order id of a number that the
 * book holds, and for a book that is full.
 */
function isNew(orders: Orders, entry: OrderEntry): boolean {
  const held = orders.get(keyOf(entry.tenant, entry.po_number));
  if (held !== undefined) {
    if (held.order_id === entry.order_id) return false;
    throw new Error('the order book holds another order for this purchase order number');
  }
  if (orders.size >= ORDER_BOOK_LIMIT) throw full();
  return true;
}

/** The entries of an order book in memory. */
export class MemoryOrderBook implements OrderBook {
  readonly #orders: Orders = new Map();

  async has(tenant: string, poNumber: string): Promise<boolean> {
    return holds(this.#orders, keyOf(textOf(tenant, 'tenant'), textOf(poNumber, 'poNumber')));
  }

  async record(tenant: string, poNumber: string, orderId: string): Promise<void> {
    const entry: OrderEntry = { tenant: textOf(tenant, 'tenant'), po_number: textOf(poNumber, 'poNumber'), order_id: textOf(orderId, 'orderId') };
    if (isNew(this.#orders, entry)) this.#orders.set(keyOf(entry.tenant, entry.po_number), entry);
  }
}

// --- The file ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** The file system calls of the file book. The default is the file system of the process. A test gives its own, to make a write fail or to see the order of the calls. */
export interface BookFs {
  /** The text of the file. It rejects when the file is not there or cannot be read. The book reads a file that is not there as an error. */
  readFile(path: string): Promise<string>;
  /** Makes a new file with the text. The name of a temporary file is new, so the call never replaces a file. */
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Returns when the data of the file, or the entries of the folder, are on the disk. */
  fsync(path: string): Promise<void>;
  /** Removes a temporary file after a write that failed. A failure of this call changes nothing. */
  unlink(path: string): Promise<void>;
}

export interface FileOrderBookOptions {
  /** The file system calls. A call that the object leaves out is the call of the file system of the process. */
  readonly fs?: Partial<BookFs>;
}

const NODE_FS: BookFs = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
  rename,
  fsync: async (path) => {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  unlink,
};

/** The path as an absolute path. A path that is not a text, that is empty, that holds a NUL character or that has a `..` segment is refused: the file is the file that the caller named. */
function absolutePath(path: unknown): string {
  if (typeof path !== 'string') throw new TypeError('the path of the order book must be a text');
  if (path === '' || path.includes('\0')) throw new RangeError('the path of the order book must be a path');
  if (path.split(/[\\/]+/).includes('..')) throw new RangeError('the path of the order book must not have a ".." segment');
  return resolve(path);
}

/** The folder is made when it is missing, and it must be a folder that the process can read and write: a service that cannot record an order stops at its start. */
function prepareFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!statSync(folder).isDirectory()) throw new Error('the folder of the order book is not a folder');
  accessSync(folder, constants.R_OK | constants.W_OK | constants.X_OK);
}

/** True for the error of a file that is not there. */
const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const damaged = (): Error => new Error('the order book file is damaged');

/** A member of an entry of the file: a text of 1 to MAX_TEXT characters. Anything else is a damaged file. */
function memberOf(entry: Record<string, unknown>, name: string): string {
  const member = entry[name];
  if (typeof member !== 'string' || member.length < 1 || member.length > MAX_TEXT) throw damaged();
  return member;
}

/** One entry of the file: exactly the three members, each a text of the right size. Anything else is a damaged file. */
function entryOf(value: unknown): OrderEntry {
  if (!isPlainObject(value) || Object.keys(value).length !== 3) throw damaged();
  return { tenant: memberOf(value, 'tenant'), po_number: memberOf(value, 'po_number'), order_id: memberOf(value, 'order_id') };
}

/** The orders of a file. A text that is not JSON, and JSON that is not the file of the book, are errors: the content of the file is never part of the message. */
function parseOrders(text: string): Orders {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw damaged();
  }
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || value.schema !== FILE_SCHEMA) throw damaged();
  const list = value.orders;
  if (!Array.isArray(list) || list.length > ORDER_BOOK_LIMIT) throw damaged();
  const orders: Orders = new Map();
  for (const item of list) {
    const entry = entryOf(item);
    const key = keyOf(entry.tenant, entry.po_number);
    if (orders.has(key)) throw damaged();
    orders.set(key, entry);
  }
  return orders;
}

/** The text of the file: one line of JSON. */
const fileText = (orders: Orders): string => `${JSON.stringify({ schema: FILE_SCHEMA, orders: [...orders.values()] })}\n`;

/** A temporary file, a sync of it, a rename over `target`, and a sync of the folder. A failure before the rename removes the temporary file, and leaves `target` as it was. */
async function writeDurably(fs: BookFs, folder: string, target: string, text: string): Promise<void> {
  const temporary = join(folder, `.${basename(target)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, text);
    await fs.fsync(temporary);
    await fs.rename(temporary, target);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch {
      // The temporary file stays. Nothing reads it, and the error of the write is the error that counts.
    }
    throw error;
  }
  await fs.fsync(folder);
}

/** Returns when the data of the file, or the entries of the folder, are on the disk. It uses the file system of the process. */
function flushSync(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Makes the file of a book that has none: the empty book. A file that is there stays as it is, whatever it holds. The write is whole or it is not there, as every write of the book is. The constructor cannot wait,
 * so this uses the file system of the process, and not the calls that a test gives.
 */
function startFile(folder: string, file: string): void {
  if (existsSync(file)) return;
  const temporary = join(folder, `.${basename(file)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, fileText(new Map()), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    flushSync(temporary);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file stays. Nothing reads it, and the error of the write is the error that counts.
    }
    throw error;
  }
  flushSync(folder);
}

/**
 * The order book in one JSON file: `{ "schema", "orders": [{ "tenant", "po_number", "order_id" }] }`, in the order of the records, with each number as it was written. The constructor writes the empty book when the
 * file is not there: that is the first start, and a start never writes over a file that is there. The class reads the file at each call, so a file that is damaged after the start is seen, and a file that is missing
 * after the start is an error and never an empty book. A new instance on the same file sees every order: a restart loses nothing. A write is whole or it is not there: it writes a temporary file in the same folder,
 * syncs it, renames it over the file, and syncs the folder. A record resolves only after that. When the sync of the folder fails, the record rejects although the new file may be in place, and the caller reads the
 * rejection as "not stored". The records of one instance run one after the other in the order of the calls. One process owns the file: nothing locks it across processes.
 */
export class FileOrderBook implements OrderBook {
  readonly #file: string;
  readonly #folder: string;
  readonly #fs: BookFs;
  /** The last record that is queued or running. A record waits for the one in front of it, whatever its outcome. */
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, options: FileOrderBookOptions = {}) {
    this.#file = absolutePath(path);
    this.#folder = dirname(this.#file);
    prepareFolder(this.#folder);
    startFile(this.#folder, this.#file);
    const given = options.fs;
    this.#fs = {
      readFile: given?.readFile ?? NODE_FS.readFile,
      writeFile: given?.writeFile ?? NODE_FS.writeFile,
      rename: given?.rename ?? NODE_FS.rename,
      fsync: given?.fsync ?? NODE_FS.fsync,
      unlink: given?.unlink ?? NODE_FS.unlink,
    };
  }

  async has(tenant: string, poNumber: string): Promise<boolean> {
    const key = keyOf(textOf(tenant, 'tenant'), textOf(poNumber, 'poNumber'));
    return holds(await this.#read(), key);
  }

  async record(tenant: string, poNumber: string, orderId: string): Promise<void> {
    const entry: OrderEntry = { tenant: textOf(tenant, 'tenant'), po_number: textOf(poNumber, 'poNumber'), order_id: textOf(orderId, 'orderId') };
    const run = this.#tail.then(() => this.#add(entry));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #add(entry: OrderEntry): Promise<void> {
    const orders = await this.#read();
    if (!isNew(orders, entry)) return;
    orders.set(keyOf(entry.tenant, entry.po_number), entry);
    await writeDurably(this.#fs, this.#folder, this.#file, fileText(orders));
  }

  /** The orders of the file. A file that is not there is an error: the constructor made it at the start. */
  async #read(): Promise<Orders> {
    let text: string;
    try {
      text = await this.#fs.readFile(this.#file);
    } catch (error) {
      if (isMissing(error)) throw new Error('the order book file is missing', { cause: error });
      throw error;
    }
    return parseOrders(text);
  }
}
