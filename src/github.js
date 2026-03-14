const JSON_HEADERS = {
  Accept: "application/vnd.github+json"
};

async function githubRequest(path, config, options = {}) {
  const response = await fetch(`${config.githubApiBaseUrl}${path}`, {
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${config.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    ...options
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status} on ${path}: ${body}`);
  }

  return response.json();
}

export async function listOwnerRepos(config) {
  try {
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
  } catch (error) {
    return [{
      name: config.githubOwner,
      fullName: `${config.githubOwner}/(repo-list-unavailable)`,
      description: `Repository listing unavailable: ${error.message}`,
      defaultBranch: "unknown",
      language: "unknown",
      visibility: "unknown",
      archived: false
    }];
  }
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

  try {
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
      pyprojectSnippet: snippet(pyproject),
      auditSource: "github-api"
    };
  } catch (error) {
    return {
      targetRepo,
      defaultBranch: "main",
      language: "unknown",
      description: `Repository audit fallback used: ${error.message}`,
      readmeSnippet: "not found",
      agentsSnippet: "not found",
      packageSnippet: "not found",
      pyprojectSnippet: "not found",
      auditSource: "fallback"
    };
  }
}

/** Get the SHA of the HEAD commit on a branch */
export async function getBranchSha(owner, repo, branch, config) {
  const data = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, config);
  return data.object.sha;
}

/** Create a new branch from a base SHA */
export async function createBranch(owner, repo, branchName, baseSha, config) {
  await githubRequest(`/repos/${owner}/${repo}/git/refs`, config, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha })
  });
}

/** Commit a single file to a branch (create or update) */
export async function commitFile(owner, repo, filePath, content, message, branch, config) {
  const encoded = Buffer.from(content, "utf8").toString("base64");

  // Check if file already exists to get its SHA (needed for update)
  let sha;
  try {
    const existing = await githubRequest(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
      config
    );
    sha = existing.sha;
  } catch {
    sha = undefined;
  }

  const body = { message, content: encoded, branch };
  if (sha) body.sha = sha;

  await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, config, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

/** Create a pull request and return its URL */
export async function createPullRequest(owner, repo, branch, base, title, body, config) {
  const data = await githubRequest(`/repos/${owner}/${repo}/pulls`, config, {
    method: "POST",
    body: JSON.stringify({ title, body, head: branch, base })
  });
  return {
    url: data.html_url,
    number: data.number
  };
}

function snippet(value) {
  if (!value) return "not found";
  return value.slice(0, 900).trim();
}
