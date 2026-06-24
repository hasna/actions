import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActionAuditEvent, ActionManifest, ActionRun } from "./types.js";

export const HASNA_ACTIONS_DIR_ENV = "HASNA_ACTIONS_DIR";
export const HASNA_ACTIONS_HOME_ENV = "HASNA_ACTIONS_HOME";

export function getActionsDataDir(override?: string): string {
  return override || process.env[HASNA_ACTIONS_DIR_ENV] || process.env[HASNA_ACTIONS_HOME_ENV] || join(homedir(), ".hasna", "actions");
}

export function getActiveActionsDirEnv(): typeof HASNA_ACTIONS_DIR_ENV | typeof HASNA_ACTIONS_HOME_ENV | null {
  if (process.env[HASNA_ACTIONS_DIR_ENV]) return HASNA_ACTIONS_DIR_ENV;
  if (process.env[HASNA_ACTIONS_HOME_ENV]) return HASNA_ACTIONS_HOME_ENV;
  return null;
}

export interface ActionsStatus {
  service: "actions";
  schemaVersion: "1.0";
  dataDir: string;
  env: {
    primary: typeof HASNA_ACTIONS_DIR_ENV;
    fallback: typeof HASNA_ACTIONS_HOME_ENV;
    active: typeof HASNA_ACTIONS_DIR_ENV | typeof HASNA_ACTIONS_HOME_ENV | null;
  };
  files: {
    manifests: { path: string; exists: boolean; records: number };
    runs: { path: string; exists: boolean; records: number };
    auditEvents: { path: string; exists: boolean; records: number };
  };
  counts: {
    manifests: number;
    runs: number;
    auditEvents: number;
  };
}

export interface ActionsStore {
  dataDir: string;
  init(): Promise<void>;
  saveManifest(manifest: ActionManifest): Promise<ActionManifest>;
  listManifests(): Promise<ActionManifest[]>;
  getManifest(id: string): Promise<ActionManifest | undefined>;
  createRun(run: ActionRun): Promise<ActionRun>;
  updateRun(run: ActionRun): Promise<ActionRun>;
  getRun(id: string): Promise<ActionRun | undefined>;
  listRuns(options?: { actionId?: string; status?: string; limit?: number }): Promise<ActionRun[]>;
  findRunByIdempotencyKey(actionId: string, idempotencyKey: string): Promise<ActionRun | undefined>;
  appendAuditEvent(event: ActionAuditEvent): Promise<ActionAuditEvent>;
  listAuditEvents(options?: { runId?: string; actionId?: string; limit?: number }): Promise<ActionAuditEvent[]>;
}

export class JsonActionsStore implements ActionsStore {
  dataDir: string;
  private manifestsPath: string;
  private runsPath: string;
  private eventsPath: string;

  constructor(dataDir = getActionsDataDir()) {
    this.dataDir = dataDir;
    this.manifestsPath = join(dataDir, "manifests.json");
    this.runsPath = join(dataDir, "runs.json");
    this.eventsPath = join(dataDir, "audit-events.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700).catch(() => undefined);
    await this.ensureArrayFile(this.manifestsPath);
    await this.ensureArrayFile(this.runsPath);
    await this.ensureArrayFile(this.eventsPath);
  }

  async saveManifest(manifest: ActionManifest): Promise<ActionManifest> {
    await this.init();
    const manifests = await this.readJson<ActionManifest[]>(this.manifestsPath, []);
    const index = manifests.findIndex((item) => item.id === manifest.id);
    if (index >= 0) manifests[index] = manifest;
    else manifests.push(manifest);
    await this.writeJson(this.manifestsPath, manifests);
    return manifest;
  }

  async listManifests(): Promise<ActionManifest[]> {
    await this.init();
    return this.readJson<ActionManifest[]>(this.manifestsPath, []);
  }

  async getManifest(id: string): Promise<ActionManifest | undefined> {
    const manifests = await this.listManifests();
    return manifests.find((manifest) => manifest.id === id);
  }

  async createRun(run: ActionRun): Promise<ActionRun> {
    await this.init();
    const runs = await this.readJson<ActionRun[]>(this.runsPath, []);
    runs.push(run);
    await this.writeJson(this.runsPath, runs);
    return run;
  }

  async updateRun(run: ActionRun): Promise<ActionRun> {
    await this.init();
    const runs = await this.readJson<ActionRun[]>(this.runsPath, []);
    const index = runs.findIndex((item) => item.id === run.id);
    if (index >= 0) runs[index] = run;
    else runs.push(run);
    await this.writeJson(this.runsPath, runs);
    return run;
  }

  async getRun(id: string): Promise<ActionRun | undefined> {
    const runs = await this.listRuns();
    return runs.find((run) => run.id === id);
  }

  async listRuns(options: { actionId?: string; status?: string; limit?: number } = {}): Promise<ActionRun[]> {
    await this.init();
    let runs = await this.readJson<ActionRun[]>(this.runsPath, []);
    if (options.actionId) runs = runs.filter((run) => run.actionId === options.actionId);
    if (options.status) runs = runs.filter((run) => run.status === options.status);
    runs = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return typeof options.limit === "number" ? runs.slice(0, Math.max(0, options.limit)) : runs;
  }

  async findRunByIdempotencyKey(actionId: string, idempotencyKey: string): Promise<ActionRun | undefined> {
    const runs = await this.listRuns({ actionId });
    return runs.find((run) => run.idempotencyKey === idempotencyKey);
  }

  async appendAuditEvent(event: ActionAuditEvent): Promise<ActionAuditEvent> {
    await this.init();
    const events = await this.readJson<ActionAuditEvent[]>(this.eventsPath, []);
    events.push(event);
    await this.writeJson(this.eventsPath, events);
    return event;
  }

  async listAuditEvents(options: { runId?: string; actionId?: string; limit?: number } = {}): Promise<ActionAuditEvent[]> {
    await this.init();
    let events = await this.readJson<ActionAuditEvent[]>(this.eventsPath, []);
    if (options.runId) events = events.filter((event) => event.runId === options.runId);
    if (options.actionId) events = events.filter((event) => event.actionId === options.actionId);
    events = events.sort((a, b) => b.time.localeCompare(a.time));
    return typeof options.limit === "number" ? events.slice(0, Math.max(0, options.limit)) : events;
  }

  private async ensureArrayFile(path: string): Promise<void> {
    if (!existsSync(path)) {
      await writeFile(path, "[]\n", { encoding: "utf-8", mode: 0o600 });
    }
    await chmod(path, 0o600).catch(() => undefined);
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(path, "utf-8");
      if (!raw.trim()) return fallback;
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    await rename(tempPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  }
}

export async function getActionsStatus(dataDir?: string): Promise<ActionsStatus> {
  const store = new JsonActionsStore(dataDir);
  await store.init();
  const [manifests, runs, auditEvents] = await Promise.all([
    store.listManifests(),
    store.listRuns(),
    store.listAuditEvents(),
  ]);

  return {
    service: "actions",
    schemaVersion: "1.0",
    dataDir: store.dataDir,
    env: {
      primary: HASNA_ACTIONS_DIR_ENV,
      fallback: HASNA_ACTIONS_HOME_ENV,
      active: getActiveActionsDirEnv(),
    },
    files: {
      manifests: statusFile(store.dataDir, "manifests.json", manifests.length),
      runs: statusFile(store.dataDir, "runs.json", runs.length),
      auditEvents: statusFile(store.dataDir, "audit-events.json", auditEvents.length),
    },
    counts: {
      manifests: manifests.length,
      runs: runs.length,
      auditEvents: auditEvents.length,
    },
  };
}

function statusFile(dataDir: string, fileName: string, records: number): { path: string; exists: boolean; records: number } {
  const path = join(dataDir, fileName);
  return { path, exists: existsSync(path), records };
}

