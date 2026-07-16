export interface LinearTicketSpec {
  title: string;
  description: string;
}

export interface LinearIssue {
  id: string;
  identifier?: string;
  title: string;
  url?: string;
}

export interface LinearCreateConfig {
  apiKey: string;
  teamId: string;
  projectId?: string;
  assigneeId?: string;
  labelIds?: string[];
}

export interface LinearCreateContext {
  sessionId: string;
  meetUrl?: string;
}

interface LinearGraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message?: string;
  }>;
}

interface IssueCreateResponse {
  issueCreate?: {
    success: boolean;
    issue?: LinearIssue;
  };
}

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        title
        url
      }
    }
  }
`;

export async function createLinearIssues(
  config: LinearCreateConfig,
  specs: LinearTicketSpec[],
  context: LinearCreateContext,
): Promise<LinearIssue[]> {
  const issues: LinearIssue[] = [];

  for (const spec of specs) {
    const input: Record<string, unknown> = {
      teamId: config.teamId,
      title: spec.title,
      description: buildIssueDescription(spec.description, context),
    };

    if (config.projectId) input.projectId = config.projectId;
    if (config.assigneeId) input.assigneeId = config.assigneeId;
    if (config.labelIds && config.labelIds.length > 0) input.labelIds = config.labelIds;

    const response = await linearGraphQL<IssueCreateResponse>(config.apiKey, ISSUE_CREATE_MUTATION, {
      input,
    });

    if (!response.issueCreate?.success || !response.issueCreate.issue) {
      throw new Error(`Linear issue creation failed for "${spec.title}".`);
    }

    issues.push(response.issueCreate.issue);
  }

  return issues;
}

function buildIssueDescription(description: string, context: LinearCreateContext): string {
  return [
    description.trim(),
    "---",
    `Source PRD session: ${context.sessionId}`,
    context.meetUrl ? `Meeting: ${context.meetUrl}` : undefined,
    "Coding agent handoff: implement this ticket, open a pull request, and close the Linear issue when delivered.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function linearGraphQL<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const bodyText = await response.text();
  let body: LinearGraphQLResponse<T>;
  try {
    body = JSON.parse(bodyText) as LinearGraphQLResponse<T>;
  } catch {
    throw new Error(`Linear returned a non-JSON response (${response.status}): ${bodyText}`);
  }

  if (!response.ok || body.errors?.length) {
    const errorMessage = body.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(`Linear GraphQL failed (${response.status}): ${errorMessage || bodyText}`);
  }

  if (!body.data) {
    throw new Error("Linear GraphQL response did not include data.");
  }

  return body.data;
}
