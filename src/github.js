const JSON_HEADERS = {
  Accept: "application/vnd.github+json"
};

async function githubRequest(path, config, options = {}) {
  const url = `${config.githubApiBaseUrl}${path}`;
  const response = await fetch(url, {
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${config.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    ...options
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} on ${path}: ${body}`);
  }

  return response.json();
}

export async function listOwnerRepos(config) {
  try {
    const repos = await githubRequest(
      `/users/${config.githubOwner}/repos?per_page=${config.githubRepoScanLimit}&sort=updated`,
      config
    ).catch(() =>
      githubRequest(
        `/orgs/${config.githubOwner}/repos?per_page=${config.githubRepoScanLimit}&sort=updated`,
        config
      )
    );

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
    return [
      {
        name: config.githubOwner,
        fullName: `${config.githubOwner}/(repo-list-unavailable)`,
        description: `Repository listing unavailable: ${error.message}`,
        defaultBranch: "unknown",
        language: "unknown",
        visibility: "unknown",
        archived: false
      }
    ];
  }
}

async function getFileContent(owner, repo, filePath, ref, config) {
  const encoded = encodeURIComponent(filePath);
  const response = await fetch(
    `${config.githubApiBaseUrl}/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${config.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );

  if (response.status === 404) return null;

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub file fetch ${response.status} for ${owner}/${repo}/${filePath}: ${body}`);
  }

  const data = await response.json();
  if (data.encoding !== "base64" || !data.content) return null;

  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function inspectRepository(targetRepo, config) {
  const [owner, repo] = targetRepo.split("/");
  if (!owner || !repo) {
    throw new Error("targetRepo must be in owner/repo format");
  }

  try {
    const meta = await githubRequest(`/repos/${owner}/${repo}`, config);

    const [readme, agents, pkg, pyproject] = await Promise.all([
      getFileContent(owner, repo, "README.md", meta.default_branch, config),
      getFileContent(owner, repo, "AGENTS.md", meta.default_branch, config),
      getFileContent(owner, repo, "package.json", meta.default_branch, config),
      getFileContent(owner, repo, "pyproject.toml", meta.default_branch, config)
    ]);

    return {
      targetRepo,
      defaultBranch: meta.default_branch,
      language: meta.language || "unknown",
      description: meta.description || "",
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
      description: `Audit fallback: ${error.message}`,
      readmeSnippet: "not found",
      agentsSnippet: "not found",
      packageSnippet: "not found",
      pyprojectSnippet: "not found",
      auditSource: "fallback"
    };
  }
}

export async function getBranchSha(owner, repo, branch, config) {
  const data = await githubRequest(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    config
  );
  return data.object.sha;
}

export async function createBranch(owner, repo, branchName, baseSha, config) {
  return githubRequest(`/repos/${owner}/${repo}/git/refs`, config, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha })
  });
}

export async function commitFile(owner, repo, filePath, content, message, branch, config) {
  const encoded = Buffer.from(content, "utf8").toString("base64");

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

  return githubRequest(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
    config,
    { method: "PUT", body: JSON.stringify(body) }
  );
}

export async function createPullRequest(owner, repo, branch, base, title, body, config) {
  const data = await githubRequest(`/repos/${owner}/${repo}/pulls`, config, {
    method: "POST",
    body: JSON.stringify({ title, body, head: branch, base })
  });
  return { url: data.html_url, number: data.number };
}

export async function deleteBranch(owner, repo, branchName, config) {
  const url = `${config.githubApiBaseUrl}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${config.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok && response.status !== 422) {
    const text = await response.text();
    throw new Error(`Branch delete failed ${response.status}: ${text}`);
  }
}

export async function listRepoBranches(owner, repo, config, prefix = "") {
  const data = await githubRequest(
    `/repos/${owner}/${repo}/branches?per_page=100`,
    config
  );
  const branches = data.map((b) => b.name);
  return prefix ? branches.filter((b) => b.startsWith(prefix)) : branches;
}

function snippet(value) {
  if (!value) return "not found";
  return value.slice(0, 900).trim();
}
