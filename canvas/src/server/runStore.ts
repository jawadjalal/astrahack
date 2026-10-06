import { createHmac, randomUUID } from "node:crypto";
import { get, list, put, BlobPreconditionFailedError } from "@vercel/blob";
import { z } from "zod";
import { RunSchema, WorkerIdSchema, UpdateRunSchema, isTerminalRun, normalizeRunUrl, type Run, type RunUpdate } from "../lib/runs";

export class RunError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RunError";
    this.status = status;
    this.code = code;
  }
}

const StoredRunSchema = z.object({ run: RunSchema, workerId: WorkerIdSchema.optional(), clientHash: z.string().max(64) });
const DocumentSchema = z.object({ version: z.literal(1), records: z.array(StoredRunSchema).max(200) });
type RunDocument = z.infer<typeof DocumentSchema>;
type Snapshot = { document: RunDocument; etag?: string };

/** write returns false when another process changed the snapshot first. */
export interface RunBackend {
  read(): Promise<Snapshot>;
  write(document: RunDocument, etag?: string): Promise<boolean>;
}

const emptyDocument = (): RunDocument => ({ version: 1, records: [] });
const MAX_ACTIVE = 20;
const MAX_PER_CLIENT_HOUR = 5;
const MAX_PER_HOUR = 60;
const HOUR = 60 * 60 * 1000;
const RETENTION = 7 * 24 * HOUR;

export function createMemoryRunBackend(): RunBackend {
  let document = emptyDocument();
  let revision = 0;
  return {
    async read() { return { document: structuredClone(document), etag: String(revision) }; },
    async write(next, etag) {
      if (etag !== String(revision)) return false;
      document = structuredClone(next);
      revision += 1;
      return true;
    },
  };
}

function blobSettings() {
  const token = process.env.ASTRAHACK_RUN_BLOB_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new RunError(503, "storage_unconfigured", "Run storage is not configured yet.");
  const access = process.env.ASTRAHACK_RUN_BLOB_ACCESS === "private" ? "private" as const : "public" as const;
  // The existing canvas Blob store is public. Keep its queue URL opaque and
  // server-only; a separate private store can be selected with the env above.
  // Derive from the storage token so rotating the worker token preserves jobs.
  const namespace = createHmac("sha256", token).update("astrahack-run-queue-v1").digest("hex");
  return { token, access, pathname: `runs/${namespace}/queue.json`, prefix: `runs/${namespace}/snapshots/` };
}

type BlobSettings = ReturnType<typeof blobSettings>;
type BlobIO = { get: typeof get; list: typeof list; put: typeof put };

export function createBlobRunBackend(settings: BlobSettings, io: BlobIO = { get, list, put }): RunBackend {
  const { pathname, prefix, token, access } = settings;
  return {
    async read() {
      let source = pathname;
      let revision: string | undefined;
      if (access === "public") {
        // Public Blob cannot bypass its CDN for mutable objects. List through
        // the authenticated storage API, then read a never-overwritten URL.
        let cursor: string | undefined;
        let latest = 0;
        do {
          const page = await io.list({ prefix, token, cursor, limit: 1000 });
          for (const blob of page.blobs) {
            const name = blob.pathname.slice(prefix.length);
            if (!/^\d{16}\.json$/.test(name)) continue;
            const number = Number(name.slice(0, -5));
            if (number > latest) { latest = number; source = blob.url; }
          }
          cursor = page.hasMore ? page.cursor : undefined;
        } while (cursor);
        if (!latest) return { document: emptyDocument() };
        revision = String(latest);
      }
      const result = await io.get(source, { token, access, useCache: false });
      if (!result && access === "private") return { document: emptyDocument() };
      if (!result || result.statusCode !== 200 || result.blob.size > 1024 * 1024 || (access === "private" && !result.blob.etag)) {
        throw new RunError(503, "storage_unavailable", "Run storage is temporarily unavailable.");
      }
      const document = DocumentSchema.parse(await new Response(result.stream).json());
      return { document, etag: revision ?? result.blob.etag };
    },
    async write(document, etag) {
      const immutable = access === "public";
      // Never delete or reuse public revision paths: their create-only writes
      // are the compare-and-swap guard, including for delayed old readers.
      const target = immutable ? `${prefix}${String(Number(etag || 0) + 1).padStart(16, "0")}.json` : pathname;
      try {
        await io.put(target, JSON.stringify(document), {
          token, access,
          addRandomSuffix: false,
          allowOverwrite: !immutable && Boolean(etag),
          ...(!immutable && etag ? { ifMatch: etag } : {}),
          contentType: "application/json",
          cacheControlMaxAge: 60,
        });
        return true;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError ||
            ((immutable || !etag) && error instanceof Error && /already exists|precondition/i.test(error.message))) return false;
        throw error;
      }
    },
  };
}

const blobBackend: RunBackend = {
  read: () => createBlobRunBackend(blobSettings()).read(),
  write: (document, etag) => createBlobRunBackend(blobSettings()).write(document, etag),
};

export function createRunStore(backend: RunBackend, now = () => Date.now()) {
  async function mutate<T>(change: (document: RunDocument) => T): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await backend.read();
      const result = change(snapshot.document);
      if (await backend.write(snapshot.document, snapshot.etag)) return result;
    }
    throw new RunError(503, "queue_busy", "The exploration queue is busy. Please try again shortly.");
  }

  return {
    async create(inputUrl: string, clientHash: string): Promise<Run> {
      let url: string;
      try { url = normalizeRunUrl(inputUrl); } catch (error) {
        throw new RunError(400, "invalid_url", error instanceof Error ? error.message : "Enter a valid website URL.");
      }
      return mutate((document) => {
        const timestamp = now();
        const recent = document.records.filter(({ run }) => Date.parse(run.createdAt) > timestamp - HOUR);
        if (recent.filter((record) => record.clientHash === clientHash).length >= MAX_PER_CLIENT_HOUR) {
          throw new RunError(429, "rate_limited", "You have reached the limit of five explorations per hour. Please try again later.");
        }
        if (recent.length >= MAX_PER_HOUR || document.records.filter(({ run }) => !isTerminalRun(run.status)).length >= MAX_ACTIVE) {
          throw new RunError(429, "queue_full", "The exploration queue is full. Please try again later.");
        }
        const date = new Date(timestamp).toISOString();
        const run: Run = { id: randomUUID(), url, status: "queued", stage: "queued", message: "Waiting for an exploration worker.", createdAt: date, updatedAt: date };
        document.records = document.records.filter(({ run: old }) => !isTerminalRun(old.status) || Date.parse(old.updatedAt) > timestamp - RETENTION);
        while (document.records.length >= 200) {
          const terminal = document.records.findIndex(({ run: old }) => isTerminalRun(old.status));
          if (terminal < 0) throw new RunError(429, "queue_full", "The exploration queue is full. Please try again later.");
          document.records.splice(terminal, 1);
        }
        document.records.push({ run, clientHash });
        return structuredClone(run);
      });
    },
    async get(id: string): Promise<Run | null> {
      const { document } = await backend.read();
      const record = document.records.find(({ run }) => run.id === id);
      return record ? structuredClone(record.run) : null;
    },
    async queued(): Promise<Run[]> {
      const { document } = await backend.read();
      return document.records.filter(({ run }) => run.status === "queued").map(({ run }) => structuredClone(run));
    },
    async claim(id: string, workerId: string): Promise<Run> {
      if (!WorkerIdSchema.safeParse(workerId).success) throw new RunError(400, "invalid_worker", "Invalid worker ID.");
      return mutate((document) => {
        const record = document.records.find(({ run }) => run.id === id);
        if (!record) throw new RunError(404, "run_not_found", "Exploration not found.");
        if (record.run.status !== "queued") throw new RunError(409, "already_claimed", "This exploration has already been claimed.");
        const date = new Date(now()).toISOString();
        record.workerId = workerId;
        Object.assign(record.run, { status: "running", stage: "starting", message: "A worker is starting your exploration.", startedAt: date, updatedAt: date });
        return structuredClone(record.run);
      });
    },
    async update(id: string, input: RunUpdate): Promise<Run> {
      const parsed = UpdateRunSchema.safeParse(input);
      if (!parsed.success) throw new RunError(400, "invalid_update", "Provide a worker ID and a valid status, stage, or message.");
      const patch = parsed.data;
      return mutate((document) => {
        const record = document.records.find(({ run }) => run.id === id);
        if (!record) throw new RunError(404, "run_not_found", "Exploration not found.");
        if (record.workerId !== patch.workerId || record.run.status === "queued") {
          throw new RunError(409, "worker_mismatch", "Only the worker that claimed this exploration can update it.");
        }
        if (isTerminalRun(record.run.status)) {
          if ((patch.status === undefined || patch.status === record.run.status) &&
              (patch.stage === undefined || patch.stage === record.run.stage) &&
              (patch.message === undefined || patch.message === record.run.message)) return structuredClone(record.run);
          throw new RunError(409, "run_finished", "This exploration has already finished.");
        }
        const date = new Date(now()).toISOString();
        if (patch.status !== undefined) record.run.status = patch.status;
        if (patch.stage !== undefined) record.run.stage = patch.stage;
        if (patch.message !== undefined) record.run.message = patch.message;
        record.run.updatedAt = date;
        if (isTerminalRun(record.run.status)) record.run.finishedAt = date;
        return structuredClone(record.run);
      });
    },
  };
}

const globals = globalThis as unknown as { __astrahackRunBackend?: RunBackend };
const memoryBackend = globals.__astrahackRunBackend ??= createMemoryRunBackend();
const selectedBackend: RunBackend = {
  read: () => (process.env.CANVAS_STORE === "blob" ? blobBackend : memoryBackend).read(),
  write: (document, etag) => (process.env.CANVAS_STORE === "blob" ? blobBackend : memoryBackend).write(document, etag),
};
export const runs = createRunStore(selectedBackend);
