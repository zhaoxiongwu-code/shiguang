// GitHub REST / Git Data API 的最小封装。
// 用 Git Data API（blob → tree → commit → ref）一次提交多文件，
// 相比逐文件 Contents API 更省请求、也不会产生一堆中间提交。

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function makeClient({ token, owner, repo, branch = 'main' }, fetchImpl = globalThis.fetch) {
  async function request(path, { method = 'GET', body, accept = 'application/vnd.github+json', raw = false } = {}) {
    const url = path.startsWith('http') ? path : API + path;
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j.message || '';
      } catch { /* ignore */ }
      const hint = res.status === 401 ? '令牌无效或已过期'
        : res.status === 403 ? '权限不足（需 Contents: Read and write）或触发了速率限制'
        : res.status === 404 ? '仓库不存在，或令牌没有访问该仓库的权限'
        : res.status === 409 ? '分支内容冲突，请重试'
        : res.status === 422 ? '请求被拒绝（分支保护或内容非法）'
        : '';
      throw new GitHubError(`GitHub ${res.status}：${detail || hint || res.statusText}`, {
        status: res.status, body: detail, url,
      });
    }
    if (raw) return res;
    if (res.status === 204) return null;
    return res.json();
  }

  const base = `/repos/${owner}/${repo}`;

  return {
    request,
    /** 仓库元信息，用于「测试连接」 */
    async getRepo() {
      return request(base);
    },
    /**
     * 取分支最新提交；分支不存在时退回默认分支；空仓库返回 null。
     */
    async getBranchSha(b) {
      try {
        const ref = await request(`${base}/git/ref/heads/${encodeURIComponent(b)}`);
        return ref.object.sha;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      const repoInfo = await request(base);
      const def = repoInfo.default_branch || 'main';
      if (def === b) return null;
      try {
        const ref = await request(`${base}/git/ref/heads/${encodeURIComponent(def)}`);
        return ref.object.sha;
      } catch (e) {
        if (e.status !== 404) throw e;
        return null;
      }
    },
    async getRepoInfo() {
      return request(base);
    },
    async createBlob(text) {
      const r = await request(`${base}/git/blobs`, {
        method: 'POST',
        body: { content: bytesToUtf8Base64(text), encoding: 'base64' },
      });
      return r.sha;
    },
    async createBlobFromBase64(b64) {
      const r = await request(`${base}/git/blobs`, {
        method: 'POST',
        body: { content: b64, encoding: 'base64' },
      });
      return r.sha;
    },
    async createTree(baseTree, entries) {
      const r = await request(`${base}/git/trees`, {
        method: 'POST',
        body: { base_tree: baseTree || undefined, tree: entries },
      });
      return r.sha;
    },
    async createCommit({ message, tree, parents }) {
      const r = await request(`${base}/git/commits`, {
        method: 'POST',
        body: { message, tree, parents },
      });
      return r.sha;
    },
    async updateRef(b, sha) {
      return request(`${base}/git/refs/heads/${encodeURIComponent(b)}`, {
        method: 'PATCH',
        body: { sha, force: false },
      });
    },
    async createRef(b, sha) {
      return request(`${base}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${b}`, sha },
      });
    },
    /** 读单个文件内容（用于去重 / 自检） */
    async getFile(path, b) {
      try {
        const encoded = path.split('/').map(encodeURIComponent).join('/');
        const r = await request(`${base}/contents/${encoded}?ref=${encodeURIComponent(b)}`);
        return { sha: r.sha, size: r.size };
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },
  };
}

export async function commitFiles(client, { branch, message, files }) {
  if (!files.length) throw new Error('没有要提交的文件');
  const headSha = await client.getBranchSha(branch);

  // 并行上传 blob（图片可能很多，限制并发避免被限流）
  const entries = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const slice = files.slice(i, i + CONCURRENCY);
    const shas = await Promise.all(slice.map((f) =>
      typeof f.content === 'string' ? client.createBlob(f.content) : client.createBlobFromBase64(f.content.base64)
    ));
    slice.forEach((f, k) => {
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: shas[k] });
    });
  }

  const treeSha = await client.createTree(headSha, entries);
  const commitSha = await client.createCommit({ message, tree: treeSha, parents: headSha ? [headSha] : [] });

  if (!headSha) {
    // 空仓库：没有任何 ref，直接创建分支
    await client.createRef(branch, commitSha);
    return { commitSha, branch, count: files.length };
  }
  try {
    await client.updateRef(branch, commitSha);
  } catch (e) {
    if (e.status === 404 || e.status === 422) {
      await client.createRef(branch, commitSha);
    } else {
      throw e;
    }
  }
  return { commitSha, branch, count: files.length };
}

/** 把字符串按 UTF-8 编码成 base64，不依赖 Node 的 Buffer */
export function bytesToUtf8Base64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
