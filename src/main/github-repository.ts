/** Only GitHub.com remotes are supported. Never accept embedded HTTPS credentials. */
export function githubRepository(remoteUrl: string): string {
  const ssh = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^\s?#]+)$/i.exec(remoteUrl)
  let path = ssh?.[1]
  if (!path) {
    let url: URL
    try { url = new URL(remoteUrl) } catch { throw new Error('The origin push remote must point to a GitHub.com repository.') }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
      throw new Error('Use a GitHub.com HTTPS or SSH origin remote without embedded tokens.')
    }
    path = url.pathname.slice(1)
  }
  const repository = path.replace(/\/$/, '').replace(/\.git$/, '')
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || repository.split('/')[1] === '.' || repository.split('/')[1] === '..') {
    throw new Error('The origin push remote must identify one GitHub owner and repository.')
  }
  return repository
}

export function isGitHubPullRequestUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(value)
}
