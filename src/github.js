const JSON_HEADERS = {
  Accept: "application/vnd.github+json"
};

async function githubRequest(path, config) {
  const response = await fetch(`${config.githubApiBaseUrl}${path}`, {
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${config.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status} on ${path}: ${body}`);
  }

  return response.json();
}

export async function listOwnerRepos(config) {
  const repos = await githubRequest(`/users/${config.githubOwner}/repos?per_page=${config.githubRepoScanLimit}&sort=updated`, config)
    .catch(async () => githubRequest(`/orgs/${config.githubOwner}/repos?per_page=${config.githubRepoScanLimit}&sort=updated`, config));

  return repos.map((repo) => ({
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description || "",
    defaultBranch: repo.default_branch,
    language: repo.language || "unknown",
    visibility: repo.private ? "private" : "public",
    archived: repo.archived
  }));
}

async function getFileContent(owner, repo, path, ref, config) {
  const encodedPath = encodeURIComponent(path);
  const response = await fetch(`${config.githubApiBaseUrl}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, {
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${config.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub file fetch error ${response.status} for ${owner}/${repo}/${path}: ${body}`);
  }

  const data = await response.json();
  if (data.encoding !== "base64" || !data.content) {
    return null;
  }

  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function inspectRepository(targetRepo, config) {
  const [owner, repo] = targetRepo.split("/");
  if (!owner || !repo) {
    throw new Error("targetRepo must be in owner/repo format");
  }

  const repoMeta = await githubRequest(`/repos/${owner}/${repo}`, config);

  const readme = await getFileContent(owner, repo, "README.md", repoMeta.default_branch, config);
  const agents = await getFileContent(owner, repo, "AGENTS.md", repoMeta.default_branch, config);
  const pkg = await getFileContent(owner, repo, "package.json", repoMeta.default_branch, config);
  const pyproject = await getFileContent(owner, repo, "pyproject.toml", repoMeta.default_branch, config);

  return {
    targetRepo,
    defaultBranch: repoMeta.default_branch,
    language: repoMeta.language || "unknown",
    description: repoMeta.description || "",
    readmeSnippet: snippet(readme),
    agentsSnippet: snippet(agents),
    packageSnippet: snippet(pkg),
    pyprojectSnippet: snippet(pyproject)
  };
}

function snippet(value) {
  if (!value) return "not found";
  return value.slice(0, 900).trim();
}
