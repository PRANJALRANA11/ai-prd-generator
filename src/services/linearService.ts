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

export interface LinearCloseConfig {
  apiKey: string;
  doneStateId?: string;
  teamId?: string;
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

interface IssueUpdateResponse {
  issueUpdate?: {
    success: boolean;
    issue?: LinearIssue;
  };
}

interface WorkflowStatesResponse {
  workflowStates?: {
    nodes: Array<{
      id: string;
      name: string;
      type?: string;
    }>;
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

const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
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

const WORKFLOW_STATES_QUERY = `
  query WorkflowStates($teamId: ID!) {
    workflowStates(filter: { team: { id: { eq: $teamId } } }) {
      nodes {
        id
        name
        type
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

export async function closeLinearIssue(
  config: LinearCloseConfig,
  linearIssueId: string,
): Promise<LinearIssue> {
  const doneStateId = config.doneStateId ?? await findDoneStateId(config);
  if (!doneStateId) {
    throw new Error("Linear close requires LINEAR_DONE_STATE_ID or a team workflow state named Done/Completed.");
  }

  const response = await linearGraphQL<IssueUpdateResponse>(config.apiKey, ISSUE_UPDATE_MUTATION, {
    id: linearIssueId,
    input: {
      stateId: doneStateId,
    },
  });

  if (!response.issueUpdate?.success || !response.issueUpdate.issue) {
    throw new Error(`Linear issue close failed for "${linearIssueId}".`);
  }

  return response.issueUpdate.issue;
}

async function findDoneStateId(config: LinearCloseConfig): Promise<string | undefined> {
  if (!config.teamId) return undefined;

  const response = await linearGraphQL<WorkflowStatesResponse>(config.apiKey, WORKFLOW_STATES_QUERY, {
    teamId: config.teamId,
  });
  const states = response.workflowStates?.nodes ?? [];
  return states.find((state) => state.type === "completed")?.id
    ?? states.find((state) => /^(done|completed)$/i.test(state.name.trim()))?.id
    ?? states.find((state) => /done|complete|merged|shipped/i.test(state.name))?.id;
}

export function buildLinearTicketBacklink(issue: LinearIssue | { identifier?: string; title: string; url?: string }): string {
  const label = issue.identifier ?? issue.title;
  return issue.url ? `[${label}](${issue.url})` : label;
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
