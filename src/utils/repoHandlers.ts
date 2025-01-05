import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export interface RepoContents {
  name: string;
  path: string;
  type: string;
  content?: string;
  download_url?: string;
  owner?: string;
  repo?: string;
}

export async function fetchGitHubRepoContents(
  owner: string,
  repo: string,
  repoPath: string = ""
): Promise<RepoContents[]> {
  console.log(
    `[MCP] Fetching GitHub repo contents for ${owner}/${repo}${
      repoPath ? `/${repoPath}` : ""
    }`
  );

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "GitHub token is required. Set GITHUB_TOKEN environment variable."
    );
  }

  try {
    const response = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `token ${githubToken}`,
          "User-Agent": "UIFlowChartCreator-MCP",
        },
      }
    );

    if (!response.data) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `No data returned from GitHub API for ${owner}/${repo}`
      );
    }

    const excludeList = [
      "node_modules",
      ".git",
      "dist",
      "build",
      ".vscode",
      ".idea",
      "test",
      "__tests__",
    ];

    const excludeFiles = [
      ".env",
      ".gitignore",
      "package-lock.json",
      "yarn.lock",
    ];

    return response.data.filter((item: RepoContents) => {
      if (item.type === "dir" && excludeList.includes(item.name)) {
        return false;
      }
      if (item.type === "file" && excludeFiles.includes(item.name)) {
        return false;
      }
      return true;
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `GitHub API error: ${error.response?.data?.message || error.message}`
      );
    }
    throw error;
  }
}

export async function fetchLocalRepoContents(
  repoPath: string
): Promise<RepoContents[]> {
  console.log(`[MCP] Fetching local repo contents from ${repoPath}`);

  try {
    const contents: RepoContents[] = [];
    const items = await fs.readdir(repoPath, { withFileTypes: true });

    const excludeList = [
      "node_modules",
      ".git",
      "dist",
      "build",
      ".vscode",
      ".idea",
      "test",
      "__tests__",
    ];

    const excludeFiles = [
      ".env",
      ".gitignore",
      "package-lock.json",
      "yarn.lock",
    ];

    for (const item of items) {
      if (
        excludeList.includes(item.name) ||
        (item.isFile() && excludeFiles.includes(item.name))
      )
        continue;

      const itemPath = path.join(repoPath, item.name);
      if (item.isDirectory()) {
        contents.push({
          name: item.name,
          path: itemPath,
          type: "dir",
        });
      } else if (item.isFile()) {
        const content = await fs.readFile(itemPath, "utf-8");
        contents.push({
          name: item.name,
          path: itemPath,
          type: "file",
          content,
        });
      }
    }

    return contents;
  } catch (error) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Failed to read local repository: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
