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
          children: [],
        };

        // Analyze import statements
        const importMatches = content.match(
          /import\s+(\w+|\{[^}]+\})\s+from\s+['"]([^'"]+)['"]/g
        );
        if (importMatches) {
          importMatches.forEach((match) => {
            const [, importedComponent, importPath] =
              match.match(
                /import\s+(\w+|\{[^}]+\})\s+from\s+['"]([^'"]+)['"]/
              ) || [];
            if (importedComponent) {
              const cleanedImport = importedComponent
                .replace(/[{}]/g, "")
                .trim();
              const resolvedPath = path.join(
                currentPath,
                path.dirname(importPath),
                cleanedImport
              );
              components[componentPath].imports.push(resolvedPath);
            }
          });
        }
      } else if (item.type === "dir") {
        const subContents = isLocal
          ? await fetchLocalRepoContents(item.path)
          : await fetchGitHubRepoContents(
              item.owner || "",
              item.repo || "",
              item.path
            );

        await processContents(subContents, path.join(currentPath, item.name));
      }
    }
  }

  await processContents(contents);

  // Build component hierarchy
  const rootComponents: ComponentInfo[] = [];
  Object.values(components).forEach((component) => {
    component.imports.forEach((importPath) => {
      if (components[importPath]) {
        components[importPath].children.push(component);
      }
    });
    if (component.imports.length === 0) {
      rootComponents.push(component);
    }
  });

  return JSON.stringify(rootComponents, null, 2);
}

function getComponentType(
  componentPath: string
): "page" | "layout" | "component" {
  if (componentPath.includes("pages")) {
    return "page";
  } else if (componentPath.includes("layouts")) {
    return "layout";
  } else {
    return "component";
  }
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.log("[MCP] Listing available tools");
  return {
    tools: [
      {
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
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.log("[MCP] Received tool request:", request.params.name);

  if (request.params.name !== "generate_ui_flow") {
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Unknown tool: ${request.params.name}`
    );
  }

  const args = request.params.arguments as {
    repoPath: string;
    isLocal: boolean;
    owner?: string;
    repo?: string;
    fileExtensions?: string[];
  };
  const { repoPath, isLocal, owner, repo, fileExtensions } = args;

  try {
    let contents: RepoContents[];
    if (isLocal) {
      contents = await fetchLocalRepoContents(repoPath);
    } else {
      if (!owner || !repo) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Owner and repo are required for GitHub repositories"
        );
      }
      contents = await fetchGitHubRepoContents(owner, repo);
    }

    const uiFlowJson = await parseUIFlow(contents, isLocal, fileExtensions);

    return {
      content: [
        {
          type: "text",
          text: uiFlowJson,
        },
      ],
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to generate UI flow: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});

// Handle resource access
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  console.log("[MCP] Received resource request:", request.params.uri);

  const match = request.params.uri.match(/^ui-flow:\/\/([^\/]+)\/([^\/]+)$/);
  if (!match) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Invalid resource URI format: ${request.params.uri}`
    );
  }

  const [, owner, repo] = match;
  try {
    const contents = await fetchGitHubRepoContents(owner, repo);
    const uiFlowJson = await parseUIFlow(contents, false);

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: uiFlowJson,
        },
      ],
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read UI flow resource: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("[MCP] UI Flow Chart Creator server running on stdio");
}

run().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});

// Export to make it a proper ES module
export { server, run };
