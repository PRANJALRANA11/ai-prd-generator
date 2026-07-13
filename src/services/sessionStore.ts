import { Pool } from "pg";
import type { BotSession } from "./meetBot.js";

export interface PRDVersion {
  sessionId: string;
  version: number;
  prd: string;
  roadmapNotes?: string;
  changeSummary?: string;
  createdAt: Date;
}

export class PostgresSessionStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id UUID PRIMARY KEY,
        meet_url TEXT NOT NULL,
        status TEXT NOT NULL,
        transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
        prd TEXT,
        roadmap TEXT,
        audio_file_path TEXT,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS bot_sessions_prd_started_at_idx
      ON bot_sessions (started_at DESC)
      WHERE prd IS NOT NULL
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS prd_versions (
        session_id UUID NOT NULL REFERENCES bot_sessions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        prd TEXT NOT NULL,
        roadmap_notes TEXT,
        change_summary TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, version)
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS prd_versions_session_created_idx
      ON prd_versions (session_id, created_at DESC)
    `);

    await this.pool.query(`
      INSERT INTO prd_versions (
        session_id,
        version,
        prd,
        change_summary,
        created_at
      )
      SELECT id, 1, prd, 'Initial generated PRD', COALESCE(ended_at, updated_at, started_at)
      FROM bot_sessions
      WHERE prd IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM prd_versions
          WHERE prd_versions.session_id = bot_sessions.id
        )
    `);
  }

  async markInterruptedActiveSessions(): Promise<void> {
    await this.pool.query(
      `
        UPDATE bot_sessions
        SET
          status = 'error',
          error = COALESCE(error, 'Server restarted before session completed.'),
          ended_at = COALESCE(ended_at, NOW()),
          updated_at = NOW()
        WHERE status IN ('joining', 'in-meeting', 'processing')
      `,
    );
  }

  async upsertSession(session: BotSession): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO bot_sessions (
          id,
          meet_url,
          status,
          transcript,
          prd,
          roadmap,
          audio_file_path,
          error,
          started_at,
          ended_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (id) DO UPDATE SET
          meet_url = EXCLUDED.meet_url,
          status = EXCLUDED.status,
          transcript = EXCLUDED.transcript,
          prd = EXCLUDED.prd,
          roadmap = EXCLUDED.roadmap,
          audio_file_path = EXCLUDED.audio_file_path,
          error = EXCLUDED.error,
          started_at = EXCLUDED.started_at,
          ended_at = EXCLUDED.ended_at,
          updated_at = NOW()
      `,
      [
        session.id,
        session.meetUrl,
        session.status,
        JSON.stringify(session.transcript),
        session.prd ?? null,
        session.roadmap ?? null,
        session.audioFilePath ?? null,
        session.error ?? null,
        session.startedAt,
        session.endedAt ?? null,
      ],
    );
  }

  async getSession(sessionId: string): Promise<BotSession | null> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM bot_sessions
        WHERE id::text = $1
      `,
      [sessionId],
    );

    return result.rows[0] ? rowToSession(result.rows[0]) : null;
  }

  async getLatestPRDSession(): Promise<BotSession | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM bot_sessions
      WHERE prd IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 1
    `);

    return result.rows[0] ? rowToSession(result.rows[0]) : null;
  }

  async createPRDVersion(
    session: BotSession,
    options: {
      roadmapNotes?: string;
      changeSummary?: string;
    } = {},
  ): Promise<PRDVersion> {
    if (!session.prd) {
      throw new Error("Cannot create a PRD version without PRD content.");
    }

    await this.upsertSession(session);

    const result = await this.pool.query(
      `
        WITH next_version AS (
          SELECT COALESCE(MAX(version), 0) + 1 AS version
          FROM prd_versions
          WHERE session_id = $1
        )
        INSERT INTO prd_versions (
          session_id,
          version,
          prd,
          roadmap_notes,
          change_summary
        )
        SELECT $1, next_version.version, $2, $3, $4
        FROM next_version
        RETURNING *
      `,
      [
        session.id,
        session.prd,
        options.roadmapNotes ?? null,
        options.changeSummary ?? null,
      ],
    );

    return rowToPRDVersion(result.rows[0]);
  }

  async listPRDVersions(sessionId: string): Promise<PRDVersion[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM prd_versions
        WHERE session_id::text = $1
        ORDER BY version DESC
      `,
      [sessionId],
    );

    return result.rows.map(rowToPRDVersion);
  }

  async getPRDVersion(sessionId: string, version: number): Promise<PRDVersion | null> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM prd_versions
        WHERE session_id::text = $1 AND version = $2
      `,
      [sessionId, version],
    );

    return result.rows[0] ? rowToPRDVersion(result.rows[0]) : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToPRDVersion(row: Record<string, unknown>): PRDVersion {
  return {
    sessionId: String(row.session_id),
    version: Number(row.version),
    prd: String(row.prd),
    roadmapNotes: typeof row.roadmap_notes === "string" ? row.roadmap_notes : undefined,
    changeSummary: typeof row.change_summary === "string" ? row.change_summary : undefined,
    createdAt: new Date(row.created_at as string | Date),
  };
}

function rowToSession(row: Record<string, unknown>): BotSession {
  return {
    id: String(row.id),
    meetUrl: String(row.meet_url),
    status: row.status as BotSession["status"],
    transcript: Array.isArray(row.transcript) ? row.transcript as BotSession["transcript"] : [],
    prd: typeof row.prd === "string" ? row.prd : undefined,
    roadmap: typeof row.roadmap === "string" ? row.roadmap : undefined,
    audioFilePath: typeof row.audio_file_path === "string" ? row.audio_file_path : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
    startedAt: new Date(row.started_at as string | Date),
    endedAt: row.ended_at ? new Date(row.ended_at as string | Date) : undefined,
    _stopRequested: false,
  };
}
