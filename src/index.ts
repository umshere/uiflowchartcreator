#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import fs from "fs/promises";
import path from "path";

interface RepoContents {
  name: string;
  path: string;
  type: string;
  content?: string;
  download_url?: string;
  owner?: string;
  repo?: string;
}

interface ComponentInfo {
  name: string;
  type: "page" | "layout" | "component";
  filePath: string;
  imports: string[];
  children: ComponentInfo[];
}

// Initialize MCP server with capabilities
const server = new Server(
  {
    name: "uiflowchartcreator",
    version: "1.0.1",
    capabilities: {
      resources: {
        "ui-flow": {
          name: "UI Flow Resource",
          description: "Access generated UI flow diagrams",
          uriTemplate: "ui-flow://{owner}/{repo}",
        },
      },
      tools: {
        generate_ui_flow: {
          name: "generate_ui_flow",
          description:
            "Generate a UI flow diagram by analyzing React/Angular repositories. This tool scans the codebase to identify components, their relationships, and the overall UI structure.",
          inputSchema: {
            type: "object",
            properties: {
              repoPath: {
                type: "string",
                description:
                  "Path to local repository or empty string for GitHub repos",
              },
              isLocal: {
                type: "boolean",
                description:
                  "Whether to analyze a local repository (true) or GitHub repository (false)",
              },
              owner: {
                type: "string",
                description:
                  "GitHub repository owner (required if isLocal is false)",
              },
              repo: {
                type: "string",
                description:
                  "GitHub repository name (required if isLocal is false)",
              },
              fileExtensions: {
                type: "array",
                items: { type: "string" },
                description:
                  "List of file extensions to analyze (e.g., ['js', 'jsx', 'ts', 'tsx'] for React, ['ts', 'html'] for Angular)",
                default: ["js", "jsx", "ts", "tsx"],
              },
            },
            required: ["repoPath", "isLocal"],
            additionalProperties: false,
          },
        },
      },
    },
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

async function fetchGitHubRepoContents(
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

async function fetchLocalRepoContents(
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

async function parseUIFlow(
  contents: RepoContents[],
  isLocal: boolean,
  fileExtensions: string[] = ["js", "jsx", "ts", "tsx"]
): Promise<string> {
  console.log(
    `[MCP] Parsing UI flow with extensions: ${fileExtensions.join(", ")}`
  );

  const components: { [key: string]: ComponentInfo } = {};

  async function processContents(
    currentContents: RepoContents[],
    currentPath: string = ""
  ) {
    for (const item of currentContents) {
      if (
        item.type === "file" &&
        fileExtensions.some((ext) => item.name.endsWith(`.${ext}`))
      ) {
        let content: string;
        if (isLocal) {
          content = item.content || "";
        } else {
          try {
            const response = await axios.get(item.download_url || "");
            content = response.data;
          } catch (error) {
            console.warn(
              `[MCP] Failed to fetch content for ${item.name}: ${error}`
            );
            continue;
          }
        }

        const componentName = item.name.split(".")[0];
        const componentPath = path.join(currentPath, componentName);
        const componentType = getComponentType(componentPath);

        components[componentPath] = {
          name: componentName,
          type: componentType,
          filePath: path.join(currentPath, item.name),
          imports: [],
          c