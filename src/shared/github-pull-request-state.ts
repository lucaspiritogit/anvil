/** Confirmed GitHub merge metadata used to approve the matching task revision. */
export interface PullRequestMerged {
  repository: string
  number: number
  headSha: string
  sourceBranch: string
  targetBranch: string
  mergedAt: string
}

export function parsePullRequestMerged(value: unknown): PullRequestMerged {
  if (!value || typeof value !== 'object') throw new Error('Invalid merge event')
  const event = value as Record<string, unknown>
  if (typeof event.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(event.repository) ||
    !Number.isSafeInteger(event.number) || (event.number as number) < 1 ||
    typeof event.headSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(event.headSha) ||
    typeof event.sourceBranch !== 'string' || !event.sourceBranch ||
    typeof event.targetBranch !== 'string' || !event.targetBranch ||
    typeof event.mergedAt !== 'string' || !Number.isFinite(Date.parse(event.mergedAt))) {
    throw new Error('Invalid merge event')
  }
  return {
    repository: event.repository.toLowerCase(), number: event.number as number, headSha: event.headSha,
    sourceBranch: event.sourceBranch, targetBranch: event.targetBranch, mergedAt: event.mergedAt
  }
}
