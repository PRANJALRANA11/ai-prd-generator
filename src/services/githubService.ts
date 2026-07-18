export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  htmlUrl: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  htmlUrl: string;
  merged: boolean;
  state: string;
}

export interface GitHubConfig {
  token: string;
  repo: GitHubRepoRef;
}

const GITHUB_API_ROOT = "https://api.github.com";

export function parseGitHubRepo(value: string): GitHubRepoRef {
  const normalized = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const match = normalized.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) {
    throw new Error("GitHub repository must be owner/repo or a github.com repository URL.");
  }
  return {
    owner: match[1],
    repo: match[2],
  };
}

export function repoToString(repo: GitHubRepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

export async function ensureGitHubLabels(config: GitHubConfig, labels: string[]): Promise<void> {
  for (const label of labels) {
    await githubRequest(config, `/repos/${repoToString(config.repo)}/labels/${encodeURIComponent(label)}`, {
      method: "GET",
      allowNotFound: true,
    }).then(async (result) => {
      if (result.status !== 404) return;
      await githubRequest(config, `/repos/${repoToString(config.repo)}/labels`, {
        method: "POST",
        body: {
          name: label,
          color: label.startsWith("linear-") ? "70d6ff" : "ffe45c",
          description: label.startsWith("linear-")
            ? "Mirrored from a Linear ticket"
            : "Created by AI PRD Generator automation",
        },
      });
    });
  }
}

export async function createGitHubIssue(
  config: GitHubConfig,
  input: {
    title: string;
    body: string;
    labels: string[];
  },
): Promise<GitHubIssue> {
  await ensureGitHubLabels(config, input.labels);

  const result = await githubRequest(config, `/repos/${repoToString(config.repo)}/issues`, {
    method: "POST",
    body: input,
  });

  return rowToGitHubIssue(result.body);
}

export async function createGitHubIssueComment(
  config: GitHubConfig,
  issueNumber: number,
  body: string,
): Promise<void> {
  await githubRequest(config, `/repos/${repoToString(config.repo)}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: { body },
  });
}

export async function closeGitHubIssue(
  config: GitHubConfig,
  issueNumber: number,
  comment?: string,
): Promise<void> {
  if (comment) {
    await createGitHubIssueComment(config, issueNumber, comment);
  }

  await githubRequest(config, `/repos/${repoToString(config.repo)}/issues/${issueNumber}`, {
    method: "PATCH",
    body: {
      state: "closed",
      state_reason: "completed",
    },
  });
}

export async function createGitHubPullRequest(
  config: GitHubConfig,
  input: {
    title: string;
    body: string;
    head: string;
    base: string;
  },
): Promise<GitHubPullRequest> {
  const result = await githubRequest(config, `/repos/${repoToString(config.repo)}/pulls`, {
    method: "POST",
    body: input,
  });

  return rowToGitHubPullRequest(result.body);
}

export async function getGitHubPullRequest(
  config: GitHubConfig,
  prNumber: number,
): Promise<GitHubPullRequest> {
  const result = await githubRequest(config, `/repos/${repoToString(config.repo)}/pulls/${prNumber}`, {
    method: "GET",
  });

  return rowToGitHubPullRequest(result.body);
}

export async function mergeGitHubPullRequest(
  config: GitHubConfig,
  prNumber: number,
  commitTitle: string,
): Promise<void> {
  await githubRequest(config, `/repos/${repoToString(config.repo)}/pulls/${prNumber}/merge`, {
    method: "PUT",
    body: {
      commit_title: commitTitle,
      merge_method: "squash",
    },
  });
}

interface GitHubRequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT";
  body?: unknown;
  allowNotFound?: boolean;
}

async function githubRequest(
  config: GitHubConfig,
  path: string,
  options: GitHubRequestOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${GITHUB_API_ROOT}${path}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};

  if (!response.ok && !(options.allowNotFound && response.status === 404)) {
    const message = typeof body.message === "string" ? body.message : text;
    throw new Error(`GitHub API failed (${response.status} ${options.method} ${path}): ${message}`);
  }

  return { status: response.status, body };
}

function rowToGitHubIssue(row: Record<string, unknown>): GitHubIssue {
  return {
    number: Number(row.number),
    title: String(row.title),
    htmlUrl: String(row.html_url),
  };
}

function rowToGitHubPullRequest(row: Record<string, unknown>): GitHubPullRequest {
  return {
    number: Number(row.number),
    title: String(row.title),
    htmlUrl: String(row.html_url),
    merged: Boolean(row.merged),
    state: String(row.state),
  };
}
