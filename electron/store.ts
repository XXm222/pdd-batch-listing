import initSqlJs, { type Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Asset, Product, Shop, Task, TaskUpdate } from '../src/types';

export class Store {
  private taskListeners = new Set<(task: TaskUpdate) => void>();
  private constructor(
    private db: Database,
    private file: string,
  ) {}
  static async open(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const SQL = await initSqlJs({
      wasmBinary: Uint8Array.from(fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')))
        .buffer,
    });
    const file = path.join(directory, 'workspace.sqlite');
    const db = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
    db.run(
      'CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS shops (id TEXT PRIMARY KEY, account TEXT UNIQUE NOT NULL, json TEXT NOT NULL, secret TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, json TEXT NOT NULL); PRAGMA user_version = 1;',
    );
    db.run(
      'CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, json TEXT NOT NULL, secret TEXT NOT NULL);',
    );
    const store = new Store(db, file);
    store.flush();
    return store;
  }
  all<T>(table: 'products' | 'shops' | 'tasks' | 'assets'): T[] {
    const s = this.db.prepare(`SELECT json FROM ${table}`);
    const rows: T[] = [];
    try {
      while (s.step()) rows.push(JSON.parse(String(s.get()[0])) as T);
    } finally {
      s.free();
    }
    return rows;
  }
  secret(id: string) {
    const s = this.db.prepare('SELECT secret FROM shops WHERE id=?');
    try {
      s.bind([id]);
      return s.step() ? String(s.get()[0]) : '';
    } finally {
      s.free();
    }
  }
  setting<T>(id: string): { value: T; secret: string } | undefined {
    const s = this.db.prepare('SELECT json,secret FROM settings WHERE id=?');
    try {
      s.bind([id]);
      if (!s.step()) return;
      const row = s.get();
      return { value: JSON.parse(String(row[0])) as T, secret: String(row[1]) };
    } finally {
      s.free();
    }
  }
  saveSetting(id: string, value: unknown, secret: string) {
    this.transaction(() =>
      this.db.run(
        'INSERT INTO settings(id,json,secret) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,secret=excluded.secret',
        [id, JSON.stringify(value), secret],
      ),
    );
  }
  transaction(fn: () => void) {
    const snapshot = this.db.export();
    this.db.run('BEGIN');
    try {
      fn();
      this.db.run('COMMIT');
      this.flush();
    } catch (error) {
      this.db.close();
      const ctor = this.db.constructor as new (data: Uint8Array) => Database;
      this.db = new ctor(snapshot);
      throw error;
    }
  }
  saveProducts(products: Product[]) {
    this.transaction(() => {
      for (const p of products)
        this.db.run(
          'INSERT INTO products(id,code,json) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,json=excluded.json',
          [p.id, p.code, JSON.stringify(p)],
        );
    });
  }
  saveShop(shop: Shop, secret: string) {
    this.transaction(() =>
      this.db.run(
        'INSERT INTO shops(id,account,json,secret) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET account=excluded.account,json=excluded.json,secret=excluded.secret',
        [shop.id, shop.account, JSON.stringify(shop), secret],
      ),
    );
  }
  saveAssets(assets: Asset[]) {
    this.transaction(() => {
      for (const a of assets)
        this.db.run('INSERT OR IGNORE INTO assets(id,json) VALUES (?,?)', [
          a.id,
          JSON.stringify(a),
        ]);
    });
  }
  saveTasks(tasks: Task[]) {
    this.transaction(() => {
      for (const t of tasks)
        this.db.run('INSERT INTO tasks(id,json) VALUES (?,?)', [t.id, JSON.stringify(t)]);
    });
  }
  setTasksCleared(ids: string[], cleared: boolean) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 10000 ||
      ids.some((id) => typeof id !== 'string' || !id) ||
      new Set(ids).size !== ids.length
    )
      throw new Error('请选择有效的执行记录');
    const byId = new Map(this.all<Task>('tasks').map((t) => [t.id, t]));
    const tasks = ids.map((id) => {
      const t = byId.get(id);
      if (!t) throw new Error('执行记录已变化，请刷新后重试');
      return t;
    });
    if (tasks.some((t) => t.status === 'running' || t.agentDiagnosis?.status === 'running'))
      throw new Error('正在执行或诊断的记录不能清理，请先等待结束');
    const stamp = new Date().toISOString();
    const changed = tasks
      .filter((t) => Boolean(t.clearedAt) !== cleared)
      .map((t) => ({ ...t, clearedAt: cleared ? stamp : null, revision: (t.revision || 0) + 1 }));
    if (!changed.length) return;
    this.transaction(() => {
      for (const t of changed)
        this.db.run('UPDATE tasks SET json=? WHERE id=?', [JSON.stringify(t), t.id]);
    });
    for (const t of changed) this.emitTask(t);
  }
  onTaskChanged(listener: (task: TaskUpdate) => void) {
    this.taskListeners.add(listener);
    return () => this.taskListeners.delete(listener);
  }
  updateTask(task: Task) {
    const previous = task.revision;
    task.revision = (task.revision || 0) + 1;
    try {
      this.transaction(() =>
        this.db.run('UPDATE tasks SET json=? WHERE id=?', [JSON.stringify(task), task.id]),
      );
    } catch (error) {
      task.revision = previous;
      throw error;
    }
    this.emitTask(task);
  }
  private emitTask(task: Task) {
    const { productSnapshot, ...update } = task;
    for (const listener of this.taskListeners) {
      try {
        listener(structuredClone(update));
      } catch {
        /* Persisted task remains authoritative. */
      }
    }
  }
  private flush() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.db.export(), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  close() {
    this.db.close();
  }
}
