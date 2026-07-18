import { Pool } from "pg";
import crypto from "crypto";
import type { BotSession } from "./meetBot.js";

export interface PRDVersion {
  sessionId: string;
  version: number;
  prd: string;
  roadmapNotes?: string;
  changeSummary?: string;
  createdAt: Date;
}

export interface LinearIssueRecord {
  sessionId: string;
  linearId: string;
  identifier?: string;
  title: string;
  url?: string;
  createdAt: Date;
}

export interface LinearIssueBatch {
  sessionId: string;
  status: "creating" | "created" | "error";
  approvedBy?: string;
  approvedAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CodingAutomationStatus =
  | "pending_github_issue"
  | "github_issue_created"
  | "codex_running"
  | "pr_open"
  | "merged"
  | "closed"
  | "error";

export interface CodingAutomationRecord {
  id: string;
  sessionId: string;
  linearId: string;
  linearIdentifier?: string;
  linearTitle: string;
  linearUrl?: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  githubPrNumber?: number;
  githubPrUrl?: string;
  branchName?: string;
  prdItem?: string;
  status: CodingAutomationStatus;
  codexSummary?: string;
  error?: string;
  approvedBy?: string;
  mergedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
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
        slack_webhook_url TEXT,
        audio_file_path TEXT,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      ALTER TABLE bot_sessions
      ADD COLUMN IF NOT EXISTS slack_webhook_url TEXT
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

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS linear_issue_batches (
        session_id UUID PRIMARY KEY REFERENCES bot_sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        approved_by TEXT,
        approved_at TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS linear_issues (
        session_id UUID NOT NULL REFERENCES bot_sessions(id) ON DELETE CASCADE,
        linear_id TEXT NOT NULL,
        identifier TEXT,
        title TEXT NOT NULL,
        url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, linear_id)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS coding_automation_tasks (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES bot_sessions(id) ON DELETE CASCADE,
        linear_id TEXT NOT NULL,
        linear_identifier TEXT,
        linear_title TEXT NOT NULL,
        linear_url TEXT,
        github_issue_number INTEGER,
        github_issue_url TEXT,
        github_pr_number INTEGER,
        github_pr_url TEXT,
        branch_name TEXT,
        preview_url TEXT,
        prd_item TEXT,
        status TEXT NOT NULL,
        codex_summary TEXT,
        test_summary TEXT,
        error TEXT,
        approved_by TEXT,
        merged_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (linear_id)
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS coding_automation_tasks_status_idx
      ON coding_automation_tasks (status, updated_at ASC)
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
          slack_webhook_url,
          audio_file_path,
          error,
          started_at,
          ended_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (id) DO UPDATE SET
          meet_url = EXCLUDED.meet_url,
          status = EXCLUDED.status,
          transcript = EXCLUDED.transcript,
          prd = EXCLUDED.prd,
          roadmap = EXCLUDED.roadmap,
          slack_webhook_url = EXCLUDED.slack_webhook_url,
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
        session.slackWebhookUrl ?? null,
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

  async getLinearIssueBatch(sessionId: string): Promise<LinearIssueBatch | null> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM linear_issue_batches
        WHERE session_id::text = $1
      `,
      [sessionId],
    );

    return result.rows[0] ? rowToLinearIssueBatch(result.rows[0]) : null;
  }

  async markLinearIssueBatch(
    sessionId: string,
    status: LinearIssueBatch["status"],
    options: {
      approvedBy?: string;
      approvedAt?: Date;
      error?: string;
    } = {},
  ): Promise<LinearIssueBatch> {
    const result = await this.pool.query(
      `
        INSERT INTO linear_issue_batches (
          session_id,
          status,
          approved_by,
          approved_at,
          error,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (session_id) DO UPDATE SET
          status = EXCLUDED.status,
          approved_by = COALESCE(EXCLUDED.approved_by, linear_issue_batches.approved_by),
          approved_at = COALESCE(EXCLUDED.approved_at, linear_issue_batches.approved_at),
          error = EXCLUDED.error,
          updated_at = NOW()
        RETURNING *
      `,
      [
        sessionId,
        status,
        options.approvedBy ?? null,
        options.approvedAt ?? null,
        options.error ?? null,
      ],
    );

    return rowToLinearIssueBatch(result.rows[0]);
  }

  async getLinearIssues(sessionId: string): Promise<LinearIssueRecord[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM linear_issues
        WHERE session_id::text = $1
        ORDER BY created_at ASC
      `,
      [sessionId],
    );

    return result.rows.map(rowToLinearIssueRecord);
  }

  async saveLinearIssues(sessionId: string, issues: Array<{
    id: string;
    identifier?: string;
    title: string;
    url?: string;
  }>): Promise<LinearIssueRecord[]> {
    if (issues.length === 0) {
      return [];
    }

    const saved: LinearIssueRecord[] = [];
    for (const issue of issues) {
      const result = await this.pool.query(
        `
          INSERT INTO linear_issues (
            session_id,
            linear_id,
            identifier,
            title,
            url
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (session_id, linear_id) DO UPDATE SET
            identifier = EXCLUDED.identifier,
            title = EXCLUDED.title,
            url = EXCLUDED.url
          RETURNING *
        `,
        [
          sessionId,
          issue.id,
          issue.identifier ?? null,
          issue.title,
          issue.url ?? null,
        ],
      );
      saved.push(rowToLinearIssueRecord(result.rows[0]));
    }

    return saved;
  }

  async createCodingAutomationTask(
    sessionId: string,
    issue: LinearIssueRecord,
    options: {
      prdItem?: string;
    } = {},
  ): Promise<CodingAutomationRecord> {
    const result = await this.pool.query(
      `
        INSERT INTO coding_automation_tasks (
          id,
          session_id,
          linear_id,
          linear_identifier,
          linear_title,
          linear_url,
          prd_item,
          status,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_github_issue', NOW())
        ON CONFLICT (linear_id) DO UPDATE SET
          session_id = EXCLUDED.session_id,
          linear_identifier = EXCLUDED.linear_identifier,
          linear_title = EXCLUDED.linear_title,
          linear_url = EXCLUDED.linear_url,
          prd_item = COALESCE(coding_automation_tasks.prd_item, EXCLUDED.prd_item),
          updated_at = NOW()
        RETURNING *
      `,
      [
        crypto.randomUUID(),
        sessionId,
        issue.linearId,
        issue.identifier ?? null,
        issue.title,
        issue.url ?? null,
        options.prdItem ?? issue.title,
      ],
    );

    return rowToCodingAutomationRecord(result.rows[0]);
  }

  async getCodingAutomationTask(id: string): Promise<CodingAutomationRecord | null> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM coding_automation_tasks
        WHERE id::text = $1
      `,
      [id],
    );

    return result.rows[0] ? rowToCodingAutomationRecord(result.rows[0]) : null;
  }

  async listCodingAutomationTasks(
    statuses: CodingAutomationStatus[],
    limit = 5,
  ): Promise<CodingAutomationRecord[]> {
    if (statuses.length === 0) return [];
    const result = await this.pool.query(
      `
        SELECT *
        FROM coding_automation_tasks
        WHERE status = ANY($1::text[])
        ORDER BY updated_at ASC
        LIMIT $2
      `,
      [statuses, limit],
    );

    return result.rows.map(rowToCodingAutomationRecord);
  }

  async listRecentCodingAutomationTasks(limit = 20): Promise<CodingAutomationRecord[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM coding_automation_tasks
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [limit],
    );

    return result.rows.map(rowToCodingAutomationRecord);
  }

  async updateCodingAutomationTask(
    id: string,
    status: CodingAutomationStatus,
    fields: Partial<{
      githubIssueNumber: number;
      githubIssueUrl: string;
      githubPrNumber: number;
      githubPrUrl: string;
      branchName: string;
      codexSummary: string;
      error: string;
      approvedBy: string;
      mergedAt: Date;
    }> = {},
  ): Promise<CodingAutomationRecord> {
    const result = await this.pool.query(
      `
        UPDATE coding_automation_tasks
        SET
          status = $2,
          github_issue_number = COALESCE($3, github_issue_number),
          github_issue_url = COALESCE($4, github_issue_url),
          github_pr_number = COALESCE($5, github_pr_number),
          github_pr_url = COALESCE($6, github_pr_url),
          branch_name = COALESCE($7, branch_name),
          codex_summary = COALESCE($8, codex_summary),
          error = $9,
          approved_by = COALESCE($10, approved_by),
          merged_at = COALESCE($11, merged_at),
          updated_at = NOW()
        WHERE id::text = $1
        RETURNING *
      `,
      [
        id,
        status,
        fields.githubIssueNumber ?? null,
        fields.githubIssueUrl ?? null,
        fields.githubPrNumber ?? null,
        fields.githubPrUrl ?? null,
        fields.branchName ?? null,
        fields.codexSummary ?? null,
        fields.error ?? null,
        fields.approvedBy ?? null,
        fields.mergedAt ?? null,
      ],
    );

    if (!result.rows[0]) {
      throw new Error(`Coding automation task not found: ${id}`);
    }

    return rowToCodingAutomationRecord(result.rows[0]);
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

function rowToLinearIssueBatch(row: Record<string, unknown>): LinearIssueBatch {
  return {
    sessionId: String(row.session_id),
    status: row.status as LinearIssueBatch["status"],
    approvedBy: typeof row.approved_by === "string" ? row.approved_by : undefined,
    approvedAt: row.approved_at ? new Date(row.approved_at as string | Date) : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

function rowToLinearIssueRecord(row: Record<string, unknown>): LinearIssueRecord {
  return {
    sessionId: String(row.session_id),
    linearId: String(row.linear_id),
    identifier: typeof row.identifier === "string" ? row.identifier : undefined,
    title: String(row.title),
    url: typeof row.url === "string" ? row.url : undefined,
    createdAt: new Date(row.created_at as string | Date),
  };
}

function rowToCodingAutomationRecord(row: Record<string, unknown>): CodingAutomationRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    linearId: String(row.linear_id),
    linearIdentifier: typeof row.linear_identifier === "string" ? row.linear_identifier : undefined,
    linearTitle: String(row.linear_title),
    linearUrl: typeof row.linear_url === "string" ? row.linear_url : undefined,
    githubIssueNumber: row.github_issue_number === null || row.github_issue_number === undefined
      ? undefined
      : Number(row.github_issue_number),
    githubIssueUrl: typeof row.github_issue_url === "string" ? row.github_issue_url : undefined,
    githubPrNumber: row.github_pr_number === null || row.github_pr_number === undefined
      ? undefined
      : Number(row.github_pr_number),
    githubPrUrl: typeof row.github_pr_url === "string" ? row.github_pr_url : undefined,
    branchName: typeof row.branch_name === "string" ? row.branch_name : undefined,
    prdItem: typeof row.prd_item === "string" ? row.prd_item : undefined,
    status: row.status as CodingAutomationStatus,
    codexSummary: typeof row.codex_summary === "string" ? row.codex_summary : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
    approvedBy: typeof row.approved_by === "string" ? row.approved_by : undefined,
    mergedAt: row.merged_at ? new Date(row.merged_at as string | Date) : undefined,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
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
    slackWebhookUrl: typeof row.slack_webhook_url === "string" ? row.slack_webhook_url : undefined,
    audioFilePath: typeof row.audio_file_path === "string" ? row.audio_file_path : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
    startedAt: new Date(row.started_at as string | Date),
    endedAt: row.ended_at ? new Date(row.ended_at as string | Date) : undefined,
    _stopRequested: false,
  };
}
