import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GameSession, SaveMeta } from '@wax-museum/shared';

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`未找到存档 ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class SaveStore {
  constructor(private readonly saveDir: string) {}

  async ensureReady() {
    await mkdir(this.saveDir, { recursive: true });
  }

  async write(session: GameSession) {
    await this.ensureReady();
    await writeFile(this.resolvePath(session.sessionId), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  }

  async read(sessionId: string) {
    await this.ensureReady();
    try {
      const raw = await readFile(this.resolvePath(sessionId), 'utf8');
      return JSON.parse(raw) as GameSession;
    } catch {
      throw new SessionNotFoundError(sessionId);
    }
  }

  async list() {
    await this.ensureReady();
    const files = await readdir(this.saveDir);
    const saves: SaveMeta[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const raw = await readFile(path.join(this.saveDir, file), 'utf8');
      const parsed = JSON.parse(raw) as GameSession;
      saves.push(parsed.saveMeta);
    }

    return saves.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private resolvePath(sessionId: string) {
    return path.join(this.saveDir, `${sessionId}.json`);
  }
}
